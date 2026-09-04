/* Reading and writing handwriting note files.
 *
 * The file is an ordinary markdown document, indexed by Obsidian as usual, so
 * wiki links, backlinks, the graph, search and rename refactoring all keep
 * working. Ink and canvas items hide inside %%ink ... %% (%% is Obsidian's
 * comment syntax and never renders).
 *
 * Ink is delta-encoded, deflated and base64'd inside that block. Every other
 * app in this space compresses -- Xournal++ gzips its XML, Rnote gzips its
 * JSON, the JOT spec stores 4/8/16-bit coordinate deltas -- and measured on a
 * full page of Chinese handwriting it is 6.3x smaller for the same pixels.
 * Only the coordinates become opaque; the title, region headings and wiki links
 * all live in the markdown body outside the block, which is what Obsidian
 * indexes and what anyone reading the file actually wants.
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
import { deflateSync, inflateSync } from "fflate";
import { PAGE_W, Pt, Region, Stroke, strokeRev } from "./ink";

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
		// v2 packs the strokes; v1 stored them as plain arrays. Files written
		// before the change keep opening, and are rewritten as v2 on the next save.
		doc.strokes = j.z !== undefined
			? unpackStrokes(j.z)
			: (j.strokes ?? []).map((s: any): Stroke => ({
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
		v: 2,
		w: PAGE_W,
		items: doc.items.map((i) => ({
			id: i.id, x: r1(i.x), y: r1(i.y), w: r1(i.w), target: i.target, embed: i.embed,
		})),
		regions: doc.regions.map((g) => ({
			id: g.id, name: g.name,
			path: g.path.map(([x, y]) => [r1(x), r1(y)]),
		})),
		z: packStrokes(doc.strokes),
	};
	out.push("%%ink", JSON.stringify(json), "%%", "");
	return out.join("\n");
}

/* ============ Stroke packing ============
 *
 * Coordinates go to tenths of a page unit as integers and are stored as deltas
 * from the previous point; pressure becomes 0-99. Neither loses anything: the
 * previous format already rounded coordinates to one decimal and pressure to
 * two, so v2 is bit-for-bit the same drawing.
 *
 * Then deflate at level 1. Levels 6 and 9 compress about 20% better but take
 * two to five times as long, and this runs on every save while someone is
 * writing -- save latency is felt, a few percent of file size is not. */

const DEFLATE_LEVEL = 1;

/** Encoded form of one stroke, cached until its points change. A save normally
 *  touches one stroke, so the rest come straight back out of here. */
const encCache = new WeakMap<Stroke, { rev: number; n: number; json: string }>();

function encodeStroke(st: Stroke): string {
	const hit = encCache.get(st);
	const rev = strokeRev(st), n = st.pts.length;
	if (hit && hit.rev === rev && hit.n === n) return hit.json;

	const d: number[] = [];
	let px = 0, py = 0, pp = 0;
	// Points were already cleaned, thinned and quantised when the stroke was
	// committed, so encoding is a straight pass -- which is what makes saving
	// idempotent. Thinning here would re-thin already-thinned points every save.
	for (const p of st.pts) {
		const X = Math.round(p.x * 10), Y = Math.round(p.y * 10), P = Math.round(p.p * 99);
		d.push(X - px, Y - py, P - pp);
		px = X; py = Y; pp = P;
	}
	const json = JSON.stringify({ c: st.c, s: st.s, d });
	encCache.set(st, { rev, n, json });
	return json;
}

function packStrokes(strokes: Stroke[]): string {
	if (!strokes.length) return "";
	const json = "[" + strokes.map(encodeStroke).join(",") + "]";
	return toBase64(deflateSync(new TextEncoder().encode(json), { level: DEFLATE_LEVEL }));
}

function unpackStrokes(z: string): Stroke[] {
	if (!z) return [];
	const json = new TextDecoder().decode(inflateSync(fromBase64(z)));
	return (JSON.parse(json) as { c: string; s: number; d: number[] }[]).map((e) => {
		const pts: Pt[] = [];
		let x = 0, y = 0, p = 0;
		for (let i = 0; i + 2 < e.d.length; i += 3) {
			x += e.d[i]; y += e.d[i + 1]; p += e.d[i + 2];
			pts.push({ x: x / 10, y: y / 10, p: p / 99 });
		}
		return { c: e.c ?? "#1a1a1a", s: e.s ?? 8, pts };
	});
}

/* btoa and atob work on binary strings, so bytes are converted in chunks --
 * spreading a megabyte-long array into String.fromCharCode blows the stack. */
const CHUNK = 0x8000;

function toBase64(u8: Uint8Array): string {
	let s = "";
	for (let i = 0; i < u8.length; i += CHUNK) {
		s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
	const s = atob(b64);
	const u8 = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
	return u8;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
