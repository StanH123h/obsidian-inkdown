import { t } from "./i18n";
/* Resolve [[target]] / ![[target#region]] and render what it points at.
 * Shared by two callers: embed items on the handwriting canvas, and
 * ![[note#region]] inside ordinary markdown notes. */

import { App, MarkdownRenderChild, parseLinktext, resolveSubpath, TFile } from "obsidian";
import { Box, InkOpts, Region, Stroke, paintInk, polyBounds, strokeInRegion } from "./ink";
import { isHandwritingData, isHandwritingFile, parse } from "./format";

export type Resolved =
	| { kind: "missing"; label: string }
	| { kind: "md"; file: TFile; text: string }
	| { kind: "ink"; file: TFile; strokes: Stroke[]; box: Box; clip?: [number, number][] };

export async function resolveTarget(app: App, target: string, sourcePath: string): Promise<Resolved> {
	const { path, subpath } = parseLinktext(target);
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	if (!file) return { kind: "missing", label: target };

	// Read the contents before deciding, rather than trusting the metadata cache:
	// an embed can render before the cache has caught up
	const raw = await app.vault.cachedRead(file);
	if (isHandwritingData(raw)) {
		const doc = parse(raw);
		if (subpath) {
			// Ink only: other regions and the canvas's own wiki-link items are
			// ignored. Design principle: own content renders, references do not,
			// one level deep (see README). A region reference therefore cannot
			// form a chain or a cycle, and cannot change because some distant
			// note was edited.
			const name = subpath.replace(/^#+/, "").trim();
			// Duplicate names resolve to the first match, matching how Obsidian
			// resolves duplicate headings
			const region: Region | undefined = doc.regions.find((r) => r.name === name);
			if (!region || region.path.length < 3) return { kind: "missing", label: target };
			return {
				kind: "ink",
				file,
				strokes: doc.strokes.filter((s) => strokeInRegion(s, region)),
				box: polyBounds(region.path),
				clip: region.path,
			};
		}
		return { kind: "ink", file, strokes: doc.strokes, box: strokesBox(doc.strokes) };
	}

	// Ordinary markdown: with a subpath, slice out the matching heading or block
	let text = raw;
	if (subpath) {
		const cache = app.metadataCache.getFileCache(file);
		const res = cache ? resolveSubpath(cache, subpath) : null;
		if (res) text = text.slice(res.start.offset, res.end ? res.end.offset : undefined);
	}
	return { kind: "md", file, text };
}

function strokesBox(strokes: Stroke[]): Box {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of strokes) for (const p of s.pts) {
		if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
	}
	if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Paint a resolved target into an embed box on the canvas.
 *
 *  Handwriting only. A wiki link on the canvas may point at another handwriting
 *  note or one of its regions, never at an ordinary markdown document, so the
 *  canvas always shows things that were drawn and never becomes a container
 *  that nests rendered documents (see "no nesting" in the README). */
export function renderResolved(
	container: HTMLElement, r: Resolved, cssWidth: number, opt: InkOpts,
): void {
	container.empty();
	const warn = (text: string) => container.createSpan({
		text,
		attr: { style: "color:var(--text-error,#c0392b);font-size:15px;" },
	});
	if (r.kind === "missing") { warn(t("embed.missing", r.label)); return; }
	if (r.kind === "md") { warn(t("embed.handwritingOnly")); return; }
	const cv = container.createEl("canvas", { attr: { style: "display:block;max-width:100%;" } });
	paintInk(cv, r.strokes, opt, r.box, cssWidth, r.clip);
}

/* ============ ![[handwriting note]] inside ordinary notes ============ */

class InkEmbed extends MarkdownRenderChild {
	constructor(
		el: HTMLElement,
		private app: App,
		private target: string,
		private sourcePath: string,
		private opt: InkOpts,
	) { super(el); }

	async onload() {
		const el = this.containerEl;
		el.empty();
		const r = await resolveTarget(this.app, this.target, this.sourcePath);
		if (r.kind !== "ink") { el.createSpan({ text: t("embed.missing", this.target) }); return; }
		const width = Math.max(el.clientWidth || el.parentElement?.clientWidth || 600, 120);
		const cv = el.createEl("canvas", { attr: { style: "display:block;max-width:100%;" } });
		paintInk(cv, r.strokes, this.opt, r.box, width, r.clip);
	}
}

/** Makes ![[note#region]] in an ordinary markdown note actually show that ink */
export function embedProcessor(app: App, getOpt: () => InkOpts) {
	return (el: HTMLElement, ctx: { sourcePath: string; addChild(c: MarkdownRenderChild): void }) => {
		el.querySelectorAll<HTMLElement>(".internal-embed").forEach((node) => {
			const src = node.getAttribute("src");
			if (!src) return;
			const { path } = parseLinktext(src);
			const f = app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!isHandwritingFile(app, f)) return;
			node.empty();
			node.addClass("hw-embed");
			node.setAttribute("style", "display:block;");
			ctx.addChild(new InkEmbed(node, app, src, ctx.sourcePath, getOpt()));
		});
	};
}
