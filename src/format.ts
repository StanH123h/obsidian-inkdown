/* Reading and writing handwriting note files.
 *
 * The file is an ordinary markdown document, indexed by Obsidian as usual, so
 * wiki links, backlinks, the graph, search and rename refactoring all keep
 * working. Ink and canvas items hide inside %%ink ... %% (%% is Obsidian's
 * comment syntax and never renders).
 *
 * Two sections in the body are *generated*; they translate what is on the
 * canvas into a form Obsidian understands:
 *   ## regions  each ### heading under it is one lasso region, so
 *               [[this file#region name]] resolves, autocompletes and shows up
 *               in backlinks
 *   ## links    mirrors the canvas wiki links as real links, so backlinks and
 *               the graph pick them up.
 *
 *   ---
 *   handwriting: v1
 *   ---
 *   # Title
 *
 *   ## regions
 *   ### reaction mechanism
 *
 *   ## links
 *   - [[SN2 reaction]]
 *   - ![[energy diagram]]
 *
 *   %%ink
 *   {"v":1,"w":1000,"strokes":[...],"items":[...],"regions":[...]}
 *   %%
 */

import { App, TFile } from "obsidian";
import { PAGE_W, Region, Stroke, cleanRaw } from "./ink";

/** One wiki-link item on the canvas */
export interface LinkItem {
	id: string;
	x: number;          // page units
	y: number;
	w: number;          // display width when embedding
	target: string;     // what goes inside [[ ]], may carry #region
	embed: boolean;     // true = ![[ ]], render the content inline
}

export interface HwDoc {
	title: string;
	strokes: Stroke[];
	items: LinkItem[];
	regions: Region[];
}

const INK_RE = /%%ink\n([\s\S]*?)\n%%/;

/* A handwriting note is an ordinary .md file, identified by the handwriting key
 * in its frontmatter.
 *
 * Early versions used a compound .hw.md suffix, but Obsidian reads such a
 * file's basename as "BBB.hw" (only the final .md counts as the extension), so
 * [[BBB]] does not resolve and "BBB.hw" shows up throughout the file list,
 * search and graph. Plain .md restores native link behaviour. Older files are
 * still recognised by path, so nothing has to be migrated. */

export function isLegacyHandwritingPath(path: string): boolean {
	return path.endsWith(".hw.md");
}

// Declared as a type guard so callers do not need a separate null check
export function isHandwritingFile(app: App, file: TFile | null): file is TFile {
	if (!file || file.extension !== "md") return false;
	if (isLegacyHandwritingPath(file.path)) return true;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm && fm.handwriting != null;
}

/** Decide straight from the contents, for when the metadata cache is not ready
 *  yet or no TFile is available. */
export function isHandwritingData(data: string): boolean {
	return /^---[\s\S]*?^handwriting:/m.test(data.slice(0, 800)) || data.includes("%%ink\n");
}

export const newId = () => Math.random().toString(36).slice(2, 8);

/** Region names become markdown headings; these characters would break link syntax */
export function sanitizeName(name: string): string {
	return name.replace(/[#\[\]|^\n\r]/g, "").trim();
}

export function emptyDoc(title: string): string {
	return serialize({ title, strokes: [], items: [], regions: [] });
}

export function parse(data: string): HwDoc {
	const title = data.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
	const doc: HwDoc = { title, strokes: [], items: [], regions: [] };
	const m = data.match(INK_RE);
	if (!m) return doc;
	try {
		const j = JSON.parse(m[1]);
		doc.strokes = (j.strokes ?? []).map((s: any): Stroke => ({
			c: s.c ?? "#1a1a1a",
			s: s.s ?? 8,
			pts: (s.pts ?? []).map((p: number[]) => ({ x: p[0], y: p[1], p: p[2] })),
		}));
		doc.items = (j.items ?? []).map((it: any): LinkItem => ({
			id: it.id ?? newId(),
			x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 360,
			target: it.target ?? "", embed: !!it.embed,
		}));
		doc.regions = (j.regions ?? []).map((r: any): Region => ({
			id: r.id ?? newId(),
			name: r.name ?? "",
			path: r.path ?? [],
		}));
	} catch (e) {
		// A corrupt data block must not take the rest of the note down with it
		console.error("[handwriting] failed to parse ink data", e);
	}
	return doc;
}

export function serialize(doc: HwDoc): string {
	const out: string[] = ["---", "handwriting: v1", "---", ""];
	if (doc.title) out.push(`# ${doc.title}`, "");

	// These section names stay in English rather than following the UI language,
	// so a file means the same thing whoever opens it.
	if (doc.regions.length) {
		out.push("## Regions", "");
		for (const r of doc.regions) if (r.name) out.push(`### ${r.name}`, "");
	}

	const links = doc.items.filter((i) => i.target.trim());
	if (links.length) {
		out.push("## Links", "");
		for (const i of links) out.push(`- ${i.embed ? "!" : ""}[[${i.target}]]`);
		out.push("");
	}

	const json = {
		v: 1,
		w: PAGE_W,
		strokes: doc.strokes.map((s) => ({
			c: s.c, s: s.s,
			pts: decimate(cleanRaw(s.pts)).map((p) => [r1(p.x), r1(p.y), r2(p.p)]),
		})),
		items: doc.items.map((i) => ({
			id: i.id, x: r1(i.x), y: r1(i.y), w: r1(i.w), target: i.target, embed: i.embed,
		})),
		regions: doc.regions.map((g) => ({
			id: g.id, name: g.name,
			path: g.path.map(([x, y]) => [r1(x), r1(y)]),
		})),
	};
	out.push("%%ink", JSON.stringify(json), "%%", "");
	return out.join("\n");
}

/** Thin out samples: coalesced events produce very dense points, so drop any
 * closer than 0.6 page units to the previous one. No visible difference, much
 * smaller files. cleanRaw() runs first, which also permanently removes the
 * duplicate points that versions before 0.0.5 wrote. */
function decimate(pts: { x: number; y: number; p: number }[]) {
	if (pts.length < 3) return pts;
	const out = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const last = out[out.length - 1];
		if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) >= 0.6) out.push(pts[i]);
	}
	out.push(pts[pts.length - 1]);
	return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
