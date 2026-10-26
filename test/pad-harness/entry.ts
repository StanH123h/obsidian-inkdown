import { Scope } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ghostCaret, refreshGhosts } from "../../src/ghost";
import { InkPad, PadModal } from "../../src/pad";
import { InkOpts, Stroke, build, drawStroke, rasterize } from "../../src/ink";

const settings = {
	sizes: [4, 8, 14], eraserMode: "stroke", eraserSize: 14, smooth: 0.55, thin: 0.7, taper: 1, filter: 1,
	predict: 2, lowLatency: true, allowFinger: false, dialX: -1, dialY: -1, curve: 1,
};
const plugin = {
	settings,
	saveSettings: async () => {},
	opts: () => ({ smooth: settings.smooth, thin: settings.thin, taper: settings.taper, filter: settings.filter, curve: settings.curve }),
	convertBlocker: () => (window as any).__blocker ?? null,
};
const w = window as any;
/* The pad itself, not its host, goes in __pad: the tests read its state
 * directly. The hosts' shortcut layers go in __modalScope and __paneScope. */
const showFull = (pad: InkPad, paneSize?: [number, number]) => {
	const modal = new PadModal({} as any, pad, (x) => { w.__exit = x; },
		paneSize && (() => showPane(pad, ...paneSize)));
	modal.open();
	w.__modalScope = modal.scope;
	w.__pad = pad;
};

/* A stand-in for the pane: a box of the given size at the left of the screen,
 * hosting the pad the way PadView does, so moving between hosts and
 * converting in place can be tested here. PadView itself needs Obsidian's
 * workspace, and is tried on the device. */
let pane: HTMLElement | null = null;
const showPane = (pad: InkPad, width: number, height: number) => {
	pane = document.body.createDiv({ attr: { style: `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:flex;overflow:hidden;` } });
	const scope = new Scope();
	const leave = () => { const strokes = pad.unmount(); pane?.remove(); pane = null; return strokes; };
	pad.mount(pane, {
		scope,
		close: () => { w.__exit = { strokes: leave(), convert: false }; },
		convert: () => { w.__sent = pad.takePage(); },
		swap: { to: "full", go: () => { leave(); showFull(pad, [width, height]); } },
	});
	w.__paneScope = scope;
	w.__pad = pad;
};

w.openPad = (strokes: unknown[] = []) => {
	w.__exit = null;
	showFull(new InkPad(plugin as any, strokes as any));
};
/** Full screen with the button to move into a pane of this size, as on a tablet */
w.openSwappable = (width: number, height: number, strokes: unknown[] = []) => {
	w.__exit = null;
	w.__sent = null;
	showFull(new InkPad(plugin as any, strokes as any), [width, height]);
};
w.resizePane = (width: number, height: number) => pane?.setCssProps({ width: width + "px", height: height + "px" });

/* A plain CodeMirror editor with the stand-in caret, as a note has it. It
 * counts as the note the pad writes into while __wanted is set. */
w.__wanted = true;
w.ghostEditor = (doc: string, at: number) => {
	const parent = document.body.createDiv({ attr: { style: "position:fixed;left:0;top:0;width:500px;height:300px;background:#fff;font:16px sans-serif;" } });
	w.__editor = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: at }, extensions: [ghostCaret(() => !!w.__wanted)] }) });
	w.__editorEl = parent;
};
w.refreshGhosts = refreshGhosts;
w.settings = settings;
w.rasterize = (strokes: any[]) => rasterize(strokes, plugin.opts(), 1568)?.toDataURL("image/png") ?? null;

/* Crack test. Renders strokes with digitiser-like noise -- corners, a
 * retraced zigzag, wobbling pressure -- at 10px per unit, then checks every
 * pixel that lies well inside the true stroke region is solid. The true region
 * is computed independently of the renderer: the union of capsules swept
 * between consecutive render points, radius varying linearly. A crack, however
 * thin, shows as a pale pixel in there.
 *
 * Returns the number of interior pixels checked and how many were not solid. */
w.crackCheck = (curve: number) => {
	let seed = 11;
	const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
	const g = (sd: number) => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) * sd / Math.sqrt(0.5); };
	const paths: [number, number][][] = [];
	// a slow 横折 corner, a fast loop, and a zigzag that doubles back on itself
	paths.push([...Array.from({ length: 50 }, (_, i) => [10 + 30 * i / 49, 10] as [number, number]),
		...Array.from({ length: 50 }, (_, i) => [40, 10 + 30 * i / 49] as [number, number])]);
	paths.push(Array.from({ length: 90 }, (_, i) => { const a = i / 89 * 2 * Math.PI * 1.5; return [70 + 12 * Math.cos(a) + i * 0.15, 25 + 12 * Math.sin(a)] as [number, number]; }));
	paths.push(Array.from({ length: 120 }, (_, i) => [10 + i * 0.6, 60 + ((Math.floor(i / 15) % 2) ? 15 - (i % 15) : (i % 15))] as [number, number]));
	const opt: InkOpts = { ...plugin.opts(), curve };
	let checked = 0, holes = 0, worst = 255;
	const where: { path: number; x: number; y: number; nearest: number; at: string }[] = [];
	const S = 10;
	for (const [pi, path] of paths.entries()) {
		const st: Stroke = { c: "#000", s: 8, pts: path.map(([x, y], i) => ({ x: x + g(0.15), y: y + g(0.15), p: 0.5 + 0.25 * Math.sin(i / 6) + g(0.05) })) };
		const pts = build(st, opt);
		(w.crackCheck.lastPts ??= [])[pi] = pts;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const p of pts) { x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r); }
		const W = Math.ceil((x1 - x0) * S) + 4, H = Math.ceil((y1 - y0) * S) + 4;
		const cv = document.createElement("canvas");
		cv.width = W; cv.height = H;
		const cx = cv.getContext("2d")!;
		cx.setTransform(S, 0, 0, S, (2 - x0 * S), (2 - y0 * S));
		drawStroke(cx, st, opt);
		const px = cx.getImageData(0, 0, W, H).data;
		// Interior mask: well inside some capsule, by 0.8px
		const inside = new Uint8Array(W * H);
		const margin = 0.8 / S;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
			const rmax = Math.max(a.r, b.r);
			const bx0 = Math.floor((Math.min(a.x, b.x) - rmax - x0) * S) + 2, bx1 = Math.ceil((Math.max(a.x, b.x) + rmax - x0) * S) + 2;
			const by0 = Math.floor((Math.min(a.y, b.y) - rmax - y0) * S) + 2, by1 = Math.ceil((Math.max(a.y, b.y) + rmax - y0) * S) + 2;
			const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
			for (let yy = Math.max(0, by0); yy < Math.min(H, by1); yy++) for (let xx = Math.max(0, bx0); xx < Math.min(W, bx1); xx++) {
				const qx = (xx + 0.5 - 2) / S + x0, qy = (yy + 0.5 - 2) / S + y0;
				const t = L2 ? Math.max(0, Math.min(1, ((qx - a.x) * dx + (qy - a.y) * dy) / L2)) : 0;
				const d = Math.hypot(qx - a.x - dx * t, qy - a.y - dy * t);
				if (d < a.r + (b.r - a.r) * t - margin) inside[yy * W + xx] = 1;
			}
		}
		for (let k = 0; k < W * H; k++) {
			if (!inside[k]) continue;
			checked++;
			const alpha = px[k * 4 + 3];
			if (alpha < worst) worst = alpha;
			if (alpha < 250) {
				holes++;
				if (where.length < 40) {
					// Where is it, relative to the render points?
					const qx = ((k % W) + 0.5 - 2) / S + x0, qy = (Math.floor(k / W) + 0.5 - 2) / S + y0;
					let best = -1, bd = Infinity;
					pts.forEach((p, i) => { const d = Math.hypot(p.x - qx, p.y - qy); if (d < bd) { bd = d; best = i; } });
					const p = pts[best];
					where.push({ path: pi, x: +qx.toFixed(2), y: +qy.toFixed(2), nearest: best,
						at: `pt (${p.x.toFixed(2)},${p.y.toFixed(2)}) r ${p.r.toFixed(2)}, dist ${bd.toFixed(2)}, of ${pts.length}` });
				}
			}
		}
	}
	return { checked, holes, worst, where };
};

/** The render points of crack-test path `pi` from index i0 to i1, for debugging */
w.crackPoints = (curve: number, pi: number, i0: number, i1: number) => {
	const r = w.crackCheck.lastPts?.[pi];
	return r ? r.slice(i0, i1).map((p: any, k: number) => `${i0 + k}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) r ${p.r.toFixed(3)}`) : null;
};

/* The staircase from the iPad screenshot, reproduced: strokes written at the
 * landscape whole-page scale with positions rounded to whole pixels, shown
 * zoomed in as the screenshot was. `fix` turns de-quantisation on. */
w.showStairs = (fix: boolean, timed = true) => {
	const SCALE = 0.53, H = 0.5 / SCALE;
	const round = (pts: [number, number][]) => pts.map(([x, y], i) => ({
		x: Math.round(x * SCALE) / SCALE, y: Math.round(y * SCALE) / SCALE, p: 0.6 + 0.1 * Math.sin(i / 9), ...(timed ? { t: i * 1000 / 240 } : {}),
	}));
	const paths: [number, number][][] = [
		Array.from({ length: 200 }, (_, i) => [480 + 14 * i / 199, 200 + 380 * i / 199] as [number, number]),
		Array.from({ length: 160 }, (_, i) => { const a = i / 159 * 2 * Math.PI; return [560 + 45 * Math.cos(a), 300 + 45 * Math.sin(a)] as [number, number]; }),
		Array.from({ length: 120 }, (_, i) => [700 - 60 * i / 119, 260 + 280 * i / 119] as [number, number]),
		[...Array.from({ length: 70 }, (_, i) => [530 + 90 * i / 69, 420 + 3 * i / 69] as [number, number]),
			...Array.from({ length: 70 }, (_, i) => [620 - 2 * i / 69, 423 + 110 * i / 69] as [number, number])],
	];
	const p = w.__pad;
	p.strokes = paths.map((pts) => ({ c: "#1a1a1a", s: 8, pts: round(pts), q: fix ? H : 0 }));
	const r = p.live.getBoundingClientRect();
	p.zoom = 2.0 / p.fitScale;   // the screenshot's 2 css px per unit
	p.panX = 470; p.panY = 250;
	p.clampPan();
	p.redrawAll();
};
