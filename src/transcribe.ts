/* Handwriting in, Markdown out.
 *
 * The pad renders its ink to a PNG; this sends it to a vision model together
 * with the note text around the cursor, and returns Markdown to insert there.
 * Nothing about the ink survives the trip: what lands in the vault is ordinary
 * Markdown, LaTeX and Mermaid, readable without this plugin.
 */

import Anthropic from "@anthropic-ai/sdk";
import { requestUrl } from "obsidian";
import { t } from "./i18n";

export type Provider = "anthropic" | "openai";

export interface Engine {
	provider: Provider;
	model: string;
	apiKey: string;
	/** OpenAI-compatible only: the API's base address, usually ending in /v1 */
	baseUrl: string;
	/** Claude only: redraw maths figures with Python and send them back */
	figures: boolean;
	/** Point out what looks wrong, in a callout after the transcription */
	check: boolean;
}

/** The note the result goes into, and what is on either side of the cursor */
export interface Surroundings {
	title: string;
	before: string;
	after: string;
	/** The page carries notes to the model, written with the AI pen */
	notes?: boolean;
}

export interface Reading {
	markdown: string;
	/** For the diagnostics panel: which model answered, and the token counts */
	detail: string;
	/** Figures the model redrew, each to be saved as an attachment and put
	 *  where `{{figure:name}}` stands in the Markdown */
	figures: Figure[];
}

export interface Figure { name: string; ext: string; data: ArrayBuffer }

/** A failure worth showing the user as is: its message is already readable */
export class RecognitionError extends Error {}

export const CLAUDE_MODELS = [
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", recommended: true },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", recommended: false },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", recommended: false },
];

export const DEFAULT_OPENAI_MODEL = "gpt-6-astra";
export const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

/** Long edge of the image sent, in pixels. Both APIs scale anything larger
 *  down on arrival, so more would only cost upload time. */
export const IMAGE_EDGE = 1568;

/** How much of the note goes along as context, in characters */
export const CONTEXT_BEFORE = 3000;
export const CONTEXT_AFTER = 1000;

const SYSTEM = `You turn a picture of handwriting into Markdown for an Obsidian note. The user wrote this on a tablet instead of typing it, and what you return is inserted into their note at the cursor, exactly as you return it.

Return only the Markdown to insert: no preamble, no explanation, no code fence around the whole answer.

Transcribe; don't edit. Keep the writer's language (Chinese stays Chinese, a mix stays a mix), their wording, their order and their line structure. Don't translate, summarise, correct mistakes, finish a proof or add steps that are not on the page. Where a symbol is ambiguous, pick the reading that makes sense in context. Leave out anything crossed out.

Formatting, in Obsidian's dialect:
- Mathematics in LaTeX: $...$ inline, and $$...$$ on lines of their own for displayed equations. A derivation over several lines is one $$ block using \\begin{aligned} ... \\end{aligned}, aligned the way it is written, usually at the = signs.
- Lists, numbered steps, headings and tables only where the handwriting clearly has that structure.
- A flowchart, tree, state diagram, sequence or any other boxes-and-arrows drawing becomes a \`\`\`mermaid block.
{{DRAWINGS}}

The note text around the cursor is context, not something to work on: use it to match notation, terminology and language, and to see where the insertion sits. Never repeat or rewrite it.{{NOTES}}{{CHECK}}{{TOOL}}`;

/** The AI pen. Only mentioned when the page has some: a model told to look for
 *  violet writing on a page without any starts seeing it. */
const NOTES = `

Writing in violet is not part of the note. It is the user's notes to you, made with a separate pen: never transcribe it. Follow what it says about this page -- leave out what it marks to be left out, format something the way it asks, read a symbol the way it says. A violet arrow, bracket or circle shows what a note is about. If a note asks you a question, answer it briefly at the very end in an Obsidian callout, written in the language of the note (of the handwriting, if the note has no text yet), for example in a Chinese note:

> [!info] AI
> 这一步用的是分部积分……

Otherwise a note leaves no trace in what you return.`;

/** What to do with a drawing, when there is no way to redraw it */
const DESCRIBE = `- A drawing none of the above can express, such as a sketch, the graph of a function or a geometric figure, becomes one line in italics describing it, in the language of the note.`;

/** ...and when Claude can run Python to redraw it */
const REDRAW = `- A mathematical figure -- the graph of a function, a geometric figure, a coordinate sketch, a vector or force diagram, a number line -- is redrawn cleanly with matplotlib using the code_execution tool. Draw what the handwriting shows, faithfully: the same curves, points, labels, marked angles and annotations, nothing added and nothing left out; where the handwriting gives a formula, plot the formula. Save each figure as an SVG with a white background into the output directory, for example plt.savefig(os.path.join(os.environ["OUTPUT_DIR"], "figure-1.svg"), facecolor="white", bbox_inches="tight"), and run ls "$OUTPUT_DIR" in the same command to confirm it is there. Labels inside a figure use only mathematical notation and Latin letters, because the sandbox has no Chinese font; put any Chinese caption in the Markdown. In the Markdown, write {{figure:figure-1.svg}} on a line of its own where the figure belongs.
- Any other drawing, such as a sketch of an object, becomes one line in italics describing it, in the language of the note.`;

/** Checking the work. The transcription itself never changes: the user wrote
 *  it, and a silently corrected step is worse than a wrong one they can see. */
const CHECK = `

Then check the work. If something in the handwriting looks wrong -- an arithmetic or algebra slip, a sign error, a step that does not follow from the one before, a misremembered formula or theorem, units that do not match -- the transcription still stays exactly as written. Instead, end your answer with a blank line and an Obsidian callout, title and all written in the language of the note (of the handwriting, if the note has no text yet), for example in a Chinese note:

> [!warning] 可能有误
> - 第 2 行 $(a+b)^2 = a^2 + b^2$：展开时漏了 $2ab$ 这一项。

In an English note that is "Possible mistakes", with the bullets in English. One bullet per problem: where it is (quote the step), what looks off and why, in a sentence or two. You may say what it should be, but never rewrite the work. Flag only what you are fairly sure is a mistake, and say so in the bullet when you are not. Unfinished work, unusual notation and style are not mistakes, and the surrounding note is not yours to check. If nothing looks wrong, add no callout at all.`;

/** What the code_execution tool may be used for, when it is offered */
function toolRule(figures: boolean, check: boolean): string {
	const uses = [figures && "to redraw mathematical figures", check && "to check a calculation with sympy when it is not obvious whether it is right"]
		.filter(Boolean).join(" and ");
	return `\n\nUse the code_execution tool only ${uses}. A page that needs neither needs no code at all.`;
}

/** Whether the code_execution tool is offered: only to Claude, and only when
 *  there is something for it to do */
const wantsTool = (e: Engine) => e.provider === "anthropic" && (e.figures || e.check);

const system = (e: Pick<Engine, "figures" | "check">, tool: boolean, notes = false) => SYSTEM
	.replace("{{DRAWINGS}}", e.figures && tool ? REDRAW : DESCRIBE)
	.replace("{{NOTES}}", notes ? NOTES : "")
	.replace("{{CHECK}}", e.check ? CHECK : "")
	.replace("{{TOOL}}", tool ? toolRule(e.figures, e.check) : "");

/** Put the saved figures where the model placed them. `embeds` maps the name
 *  the model gave a figure to the embed that now shows it. A figure the model
 *  saved but never placed goes at the end, and a placeholder with no figure
 *  behind it is dropped, along with its line if it had one of its own. */
export function placeFigures(md: string, embeds: Map<string, string>): string {
	const used = new Set<string>();
	let out = md.replace(/^[ \t]*\{\{figure:([^}\n]+)\}\}[ \t]*$\n?|\{\{figure:([^}\n]+)\}\}/gm, (whole: string, own: string | undefined, inline: string | undefined) => {
		const name = (own ?? inline ?? "").trim();
		const embed = embeds.get(name);
		if (!embed) return "";
		used.add(name);
		return own ? embed + (whole.endsWith("\n") ? "\n" : "") : embed;
	});
	const rest = [...embeds].filter(([name]) => !used.has(name)).map(([, embed]) => embed);
	if (rest.length) out = out.replace(/\s*$/, "") + "\n\n" + rest.join("\n\n");
	return out.trim();
}

export function describeSurroundings(s: Surroundings): string {
	const parts = [`Note title: ${s.title}`];
	parts.push(s.before.trim()
		? `<before_cursor>\n${s.before}\n</before_cursor>`
		: "The cursor is at the start of the note.");
	if (s.after.trim()) parts.push(`<after_cursor>\n${s.after}\n</after_cursor>`);
	parts.push("Transcribe the handwriting in the image. What you return goes in at the cursor.");
	return parts.join("\n\n");
}

/** Models sometimes wrap the whole answer in a markdown fence despite being
 *  told not to. Only a fence around everything is removed, and only one
 *  labelled markdown or not labelled at all: a lone mermaid block is content. */
export function unwrapFence(s: string): string {
	const trimmed = s.trim();
	const m = /^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```$/i.exec(trimmed);
	if (!m || /^```/m.test(m[1])) return trimmed;
	return m[1].trim();
}

/** Whether the result is block content rather than a few inline words */
const isBlock = (md: string) => md.includes("\n") || /^(\$\$|```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(md);

/** Where the cursor should go once the result is in.
 *
 *  Live Preview shows a block's source, not its rendering, while the cursor is
 *  on it. A cursor still waiting at the placeholder would land on the last line
 *  of what was inserted -- the closing $$, the warning callout -- and the user
 *  would see code. So it moves to the start of the line after the block,
 *  adding that line at the end of the note if there is none. After a few
 *  inline words it stays just past them, to carry on writing.
 *
 *  @param doc  the note before the placeholder is replaced
 *  @param at, len  where the placeholder is
 *  @param ins  what replaces it, already fitted
 *  @param cur  the cursor, as an offset in `doc`
 *  @returns the text to insert, with the added line if there is one, and the
 *    cursor as an offset in the note afterwards; null to leave it alone, which
 *    is what happens when it had moved elsewhere in the meantime */
export function cursorAfter(doc: string, at: number, len: number, ins: string, cur: number): { ins: string; cursor: number | null } {
	if (cur < at || cur > at + len) return { ins, cursor: null };
	if (!isBlock(ins.trim())) return { ins, cursor: at + ins.length };
	// Already ends at the start of a line: the rest of the cursor's line, or
	// the blank line kept after a callout
	if (ins.endsWith("\n")) return { ins, cursor: at + ins.length };
	const nl = doc.indexOf("\n", at + len);
	if (nl < 0) return { ins: ins + "\n", cursor: at + ins.length + 1 };
	return { ins, cursor: at + ins.length + (nl - (at + len)) + 1 };
}

/** Block content -- displayed maths, a list, a diagram -- has to start and end
 *  on a line of its own, or Obsidian reads it as part of the paragraph around
 *  it. A short inline transcription goes in exactly where the cursor was.
 *
 *  A callout, quote, list or table at the end of the insertion needs a blank
 *  line after it as well: Markdown carries a line of plain text straight after
 *  one on as part of it, so the note's next line would end up inside the
 *  "possible mistakes" callout.
 *
 *  @param nextLine  the line after the cursor's, for that case */
export function fitInsertion(md: string, lineBefore: string, lineAfter: string, nextLine = ""): string {
	if (!isBlock(md)) return md;
	const last = md.slice(md.lastIndexOf("\n") + 1);
	const absorbs = /^\s*(>|[-*+]\s|\d+[.)]\s|\|)/.test(last);
	let out = md;
	if (lineBefore.trim()) out = "\n" + out;
	if (lineAfter.trim()) out += absorbs ? "\n\n" : "\n";
	else if (absorbs && nextLine.trim()) out += "\n";
	return out;
}

export async function recognize(png: string, around: Surroundings, e: Engine): Promise<Reading> {
	const text = describeSurroundings(around);
	const notes = !!around.notes;
	const r = e.provider === "openai" ? await viaOpenAI(png, text, e, notes) : await viaAnthropic(png, text, e, notes);
	const markdown = unwrapFence(r.markdown);
	if (!markdown && !r.figures.length) throw new RecognitionError(t("notice.noText"));
	return { markdown, detail: r.detail, figures: r.figures };
}

/* ============ Transport ============ */

/** fetch on top of Obsidian's requestUrl.
 *
 *  A plugin runs inside a web view, so a plain fetch to an API is subject to
 *  CORS, and on an iPad there is nothing to inspect when it fails. requestUrl
 *  goes through the native layer on every platform. It hands back the whole
 *  body at once, which is all this needs: nothing here streams. */
export async function obsidianFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
	const body = init?.body;
	const res = await requestUrl({
		url,
		method: init?.method ?? "GET",
		headers,
		contentType: headers["content-type"],
		body: typeof body === "string" || body instanceof ArrayBuffer ? body : undefined,
		throw: false,
	});
	return new Response(res.arrayBuffer, { status: res.status, headers: res.headers });
}

/* ============ Claude ============ */

/** Haiku has no server-side fallback, and the API asks that it not be sent one */
const fallbackOk = (model: string) => !model.includes("haiku");

/** @param tool  offer code execution; off for the retry after it was refused */
async function viaAnthropic(png: string, text: string, e: Engine, notes: boolean, tool = wantsTool(e)): Promise<Reading> {
	const client = new Anthropic({
		apiKey: e.apiKey,
		fetch: obsidianFetch,
		// To the SDK, Obsidian looks like a browser. The key is the user's own,
		// read from their own keychain, and goes nowhere but to Anthropic --
		// the case this switch exists for.
		dangerouslyAllowBrowser: true,
	});
	const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{
		role: "user",
		content: [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: png } },
			{ type: "text", text },
		],
	}];
	const fileIds: string[] = [];
	let msg: Anthropic.Beta.Messages.BetaMessage | null = null;
	let tokensIn = 0, tokensOut = 0;
	try {
		// Code execution runs in a loop on Anthropic's side, which can pause a
		// long turn; handing the answer so far back resumes it
		for (let turn = 0; turn < 4; turn++) {
			msg = await client.beta.messages.create({
				model: e.model,
				max_tokens: 16000,
				system: system(e, tool, notes),
				// Medium rather than low: telling a handwritten ν from a v, or a 1
				// from an l, often comes down to reading the context, and that is
				// worth the extra seconds
				output_config: { effort: "medium" },
				// If a safety classifier declines, retry on the model Anthropic
				// recommends for that case rather than failing outright
				...(fallbackOk(e.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
				...(tool ? { tools: [{ type: "code_execution_20260521" as const, name: "code_execution" as const }] } : {}),
				messages,
			});
			tokensIn += msg.usage.input_tokens;
			tokensOut += msg.usage.output_tokens;
			for (const b of msg.content) {
				if (b.type !== "bash_code_execution_tool_result" || b.content.type !== "bash_code_execution_result") continue;
				for (const f of b.content.content) fileIds.push(f.file_id);
			}
			if (msg.stop_reason !== "pause_turn") break;
			messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
		}
	} catch (err) {
		// Code execution is an extra. If the request with it is refused, the
		// handwriting should still come through, as text with a description
		// where a figure was, and a check made without running anything.
		if (tool && err instanceof Anthropic.BadRequestError) {
			const r = await viaAnthropic(png, text, e, notes, false);
			return { ...r, detail: `${r.detail}; code execution off after: ${(explain(err) as Error).message}` };
		}
		throw explain(err);
	}
	if (!msg) throw new RecognitionError(t("notice.noText"));
	if (msg.stop_reason === "refusal") throw new RecognitionError(t("notice.refused"));

	// The answer is the text after the last tool call: anything said before
	// one, while drawing, is not for the note
	let markdown = "";
	for (const b of msg.content) {
		if (b.type === "text") markdown += b.text;
		else if (b.type === "server_tool_use" || b.type === "bash_code_execution_tool_result") markdown = "";
	}

	const figures: Figure[] = [];
	try {
		for (const id of fileIds) {
			const meta = await client.files.retrieveMetadata(id);
			const ext = /\.(svg|png)$/i.exec(meta.filename)?.[1]?.toLowerCase();
			if (!ext) continue;   // only figures belong in a note
			const res = await client.files.download(id);
			figures.push({ name: meta.filename, ext, data: await res.arrayBuffer() });
		}
	} catch (err) {
		throw explain(err);
	}
	return {
		markdown,
		figures,
		detail: `${msg.model}, ${tokensIn} in / ${tokensOut} out, stop ${msg.stop_reason}` + (figures.length ? `, ${figures.length} figure(s)` : ""),
	};
}

/** The SDK's errors, as something worth showing */
function explain(err: unknown): unknown {
	if (err instanceof Anthropic.AuthenticationError) return new RecognitionError(t("err.auth"));
	if (err instanceof Anthropic.RateLimitError) return new RecognitionError(t("err.rate"));
	if (err instanceof Anthropic.APIConnectionError) return new RecognitionError(t("err.network", err.message));
	if (err instanceof Anthropic.APIError) {
		const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
		return new RecognitionError(`${err.status ?? "?"} ${detail ?? err.message}`);
	}
	return err;
}

/* ============ OpenAI and compatible services ============ */

/** The parts of a Chat Completions reply read here, all optional: a
 *  compatible service may leave any of them out */
interface ChatReply {
	model?: string;
	error?: { message?: string };
	choices?: { finish_reason?: string; message?: { content?: unknown } }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Chat Completions rather than the newer Responses API: it is the shape every
 *  OpenAI-compatible service implements, which is the point of offering this. */
async function viaOpenAI(png: string, text: string, e: Engine, notes: boolean): Promise<Reading> {
	const base = (e.baseUrl.trim() || DEFAULT_OPENAI_BASE).replace(/\/+$/, "");
	let res;
	try {
		res = await requestUrl({
			url: `${base}/chat/completions`,
			method: "POST",
			contentType: "application/json",
			headers: { Authorization: `Bearer ${e.apiKey}` },
			body: JSON.stringify({
				model: e.model,
				messages: [
					{ role: "system", content: system(e, false, notes) },
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
							{ type: "text", text },
						],
					},
				],
			}),
			throw: false,
		});
	} catch (err) {
		throw new RecognitionError(t("err.network", (err as Error)?.message ?? String(err)));
	}
	let body: ChatReply | null = null;
	try { body = JSON.parse(res.text) as ChatReply; } catch { /* not JSON: report the status */ }
	if (res.status === 401) throw new RecognitionError(t("err.auth"));
	if (res.status === 429) throw new RecognitionError(t("err.rate"));
	if (res.status >= 400) {
		throw new RecognitionError(`${res.status} ${body?.error?.message ?? res.text.slice(0, 200)}`);
	}
	const choice = body?.choices?.[0];
	if (choice?.finish_reason === "content_filter") throw new RecognitionError(t("notice.refused"));
	const content = choice?.message?.content;
	const u = body?.usage;
	return {
		markdown: typeof content === "string" ? content : "",
		figures: [],
		detail: `${body?.model ?? e.model}, ${u?.prompt_tokens ?? "?"} in / ${u?.completion_tokens ?? "?"} out, finish ${choice?.finish_reason ?? "?"}`,
	};
}
