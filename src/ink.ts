/* Ink model and rendering engine.
 * All coordinates are "page units" (the page is always PAGE_W wide),
 * independent of device resolution and window size, so the same note looks
 * identical on an iPad and on a desktop. */

export const PAGE_W = 1000;
/** Page height. A4 is 210x297mm, a ratio of 1.414. The document is one
 *  continuous vertical coordinate space where page k occupies
 *  y in [k*PAGE_H, (k+1)*PAGE_H), so a stroke crossing a page break stays whole. */
export const PAGE_H = 1414;

export interface Pt { x: number; y: number; p: number }
export interface Stroke { c: string; s: number; pts: Pt[] }

export interface InkOpts {
	smooth: number;   // 0..0.9  smoothing strength
	thin: number;     // 0..1    how much pressure affects width
	taper: number;    // 0 = off, 1 = subtle
	filter: number;   // 0 = exponential smoothing, 1 = one-euro filter
}

/** Nominal sample rate. Saved ink carries no timestamps, so a fixed value keeps
 *  rendering reproducible. */
const RATE = 120;

const TAPER_PX = [0, 3];
const TAU = Math.PI * 2;
const ease = (t: number) => t * t * (3 - 2 * t);

interface RPt { x: number; y: number; r: number }

/** Turn raw samples into render points carrying a radius. Recomputed on every
 *  render, so a settings change immediately affects existing ink. */
export function build(stroke: Stroke, opt: InkOpts, done: boolean): RPt[] {
	const clean = cleanRaw(stroke.pts);
	if (!clean.length) return [];

	// Pressure at touch-down and lift-off is fake: the digitiser has not read it
	// yet and iPad reports 0 or something tiny. Backfill from the first and last
	// trustworthy sample instead of hiding it behind a fabricated taper.
	let head = 0;
	while (head < clean.length && head < 6 && !(clean[head].p > 0.02)) head++;
	const pHead = head < clean.length ? clean[head].p : 0.25;
	let tail = clean.length - 1;
	while (tail > head && clean.length - 1 - tail < 6 && !(clean[tail].p > 0.02)) tail--;
	const pTail = clean[tail] ? clean[tail].p : pHead;

	const k = 1 - opt.smooth;
	const smooth = opt.filter === 1 ? oneEuro(clean, opt.smooth) : null;
	const out: (RPt & { p: number; d: number })[] = [];
	let prev: (RPt & { p: number; d: number }) | null = null;
	let dist = 0;

	for (let i = 0; i < clean.length; i++) {
		const q = clean[i];
		const rawP = i < head ? pHead : i > tail ? pTail : (q.p > 0 ? q.p : (prev ? prev.p : pHead));
		const x = smooth ? smooth[i][0] : prev ? prev.x + (q.x - prev.x) * k : q.x;
		const y = smooth ? smooth[i][1] : prev ? prev.y + (q.y - prev.y) * k : q.y;
		const p = prev ? prev.p + (rawP - prev.p) * 0.35 : rawP;
		if (prev) dist += Math.hypot(x - prev.x, y - prev.y);
		const pt: RPt & { p: number; d: number } = { x, y, p, d: dist, r: 0 };
		out.push(pt);
		prev = pt;
	}

	const total = dist;
	const tp = TAPER_PX[opt.taper] ?? 0;
	for (const pt of out) {
		let r = stroke.s / 2 * (1 - opt.thin * (1 - pt.p));
		if (tp && total > 0) {
			// A taper spans at most 15% of the stroke; otherwise short strokes (the dot
	// or a short horizontal in a Chinese character) get eaten into a grain of rice
			const T = Math.min(tp, total * 0.15) || 1;
			r *= ease(Math.min(pt.d / T, 1));
			if (done) r *= ease(Math.min((total - pt.d) / T, 1));
		}
		pt.r = Math.max(r, 0.2);
	}
	return out;
}

/** Clean the raw samples. This has to happen before smoothing: once a duplicate
 *  point enters the smoothing chain it has already pulled the smoothed position
 *  off course, even if it is discarded afterwards.
 *
 *  On iPadOS the getCoalescedEvents() windows of two consecutive pointermove
 *  events overlap: samples already delivered last time are delivered again
 *  verbatim. The point sequence then jumps backwards, the outline crosses
 *  itself, nonzero winding cancels, and the stroke shows a row of cracks.
 *
 *  The test is not based on direction -- real strokes do turn sharply -- but on
 *  duplication: a new point landing in a tiny neighbourhood of one of the last
 *  few accepted points is the one that was re-sent. */
export function cleanRaw(raw: Pt[]): Pt[] {
	const MIN_STEP = 0.5;    // page units; a smaller move counts as jitter in place
	const DUP_R = 0.35;      // within this radius counts as "the same sample"
	const HIST = 16;         // how many accepted points to look back over (~65ms at 240Hz)
	const out: Pt[] = [];
	let dirX = 0, dirY = 0;

	for (let i = 0; i < raw.length; i++) {
		const q = raw[i];
		if (out.length && i < raw.length - 1) {
			const last = out[out.length - 1];
			const sx = q.x - last.x, sy = q.y - last.y;
			const step = Math.hypot(sx, sy);

			// The pen is slowest and sampling densest at a corner, which is exactly
			// where thinning cuts hardest -- yet those points are what give a
			// Chinese horizontal-turn-vertical its shape. So loosen the threshold
			// as soon as direction changes: better to keep too many points than to
			// round the corner off.
			const turn = step > 0 && (dirX || dirY)
				? (sx * dirX + sy * dirY) / step
				: 1;
			const minStep = turn < 0.97 ? DUP_R : MIN_STEP;
			if (step < minStep) continue;

			let dup = false;
			for (let j = out.length - 1, n = 0; j >= 0 && n < HIST; j--, n++) {
				if (Math.hypot(q.x - out[j].x, q.y - out[j].y) < DUP_R) { dup = true; break; }
			}
			if (dup) continue;
			// Direction updates only after a point is actually accepted, otherwise a
			// point rejected as a duplicate would drag it off course
			if (step > 0) { dirX = sx / step; dirY = sy / step; }
		}
		out.push(q);
	}
	return out;
}

/** Render one stroke: trapezoid segments plus a disc at every point, all wound
 * the same way, in a single path filled once.
 *
 * Same-winding subpaths under the nonzero rule form a union -- winding only
 * accumulates, never cancels -- so a hole is structurally impossible. A
 * trapezoid is convex and cannot self-intersect (using each endpoint's own
 * normal twists it into a bowtie at sharp turns). Discs at every point make the
 * covered area coincide exactly with the true stroke region, the union of discs
 * swept along the centreline. Adding discs only at large turns is not enough:
 * noise makes consecutive segment directions differ by more than 90 degrees,
 * leaving wedge notches up to 1.9 units deep on the outside -- at 100% zoom
 * they pass for antialiasing, zoomed in they are obvious cracks.
 *
 * Microsoft's Win2D builds ink geometry the same way, out of circles and
 * connecting quads, but then calls Outline() to boolean-union it into a single
 * outline. Canvas 2D has no such API, so we rely on nonzero union semantics. */
export function drawStroke(cx: CanvasRenderingContext2D, stroke: Stroke, opt: InkOpts, done: boolean) {
	const pts = build(stroke, opt, done);
	if (!pts.length) return;
	cx.fillStyle = stroke.c;
	cx.beginPath();
	if (pts.length === 1) { disc(cx, pts[0]); cx.fill(); return; }

	if (pts.length === 1) {
		disc(cx, pts[0]);
		cx.fill();
		return;
	}

	// Each trapezoid uses that segment's own normal, which makes it convex and
	// therefore mathematically incapable of self-intersecting.
	//
	// The previous version used each endpoint's own normal: once the two normals
	// differed by more than 90 degrees the quad twisted into a bowtie, whose two
	// lobes wind in opposite directions -- one lobe at -1 cancels the +1 around
	// it, and that is a hole. At a sharp turn the points are only a fraction of a
	// unit apart, so a direction taken from immediate neighbours is mostly noise
	// and easily swings past 90 degrees, which is why Chinese corner strokes and
	// English cursive suffered most. Measured with realistic noise: 2.1% of
	// segments twisted on a sharp 45-degree turn.
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i], b = pts[i + 1];
		let ux = b.x - a.x, uy = b.y - a.y;
		const len = Math.hypot(ux, uy);
		if (len < 1e-9) continue;
		ux /= len; uy /= len;
		const nx = -uy, ny = ux;
		cx.moveTo(a.x + nx * a.r, a.y + ny * a.r);
		cx.lineTo(a.x - nx * a.r, a.y - ny * a.r);
		cx.lineTo(b.x - nx * b.r, b.y - ny * b.r);
		cx.lineTo(b.x + nx * b.r, b.y + ny * b.r);
		cx.closePath();
	}

	// A disc at every sample point.
	//
	// A trapezoid only covers the perpendicular offset between two points, which
	// falls short of the true stroke region: the union of discs swept along the
	// centreline bulges out further on the outside of a turn and wherever the
	// radius changes. Adding discs only above a 5.7-degree turn came from
	// estimating the notch depth with a small-angle formula; sampling noise
	// routinely makes consecutive segment directions differ by more than 90
	// degrees, and the notches measured up to 1.9 page units deep -- about 1.5px
	// at 100% zoom, where they pass for antialiasing, but a 9px gouge at 600%.
	// Those were the "cracks in bread crust".
	//
	// Discs are cheap (one moveTo and one arc). Measured over a page of 300
	// strokes they add 60% more subpaths with no change in path-building time,
	// and with them the rendered area coincides exactly with the mathematically
	// correct stroke region.
	for (const p of pts) disc(cx, p);

	cx.fill();
}

/** One disc subpath, wound the same way as the trapezoids (both have positive
 *  signed area). That is what makes the result a union rather than an xor: with
 *  the winding reversed, overlaps would cancel and leave holes. */
function disc(cx: CanvasRenderingContext2D, p: { x: number; y: number; r: number }) {
	cx.moveTo(p.x + p.r, p.y);
	cx.arc(p.x, p.y, p.r, 0, TAU);
}

/** Hit test for the eraser: is this point on the stroke? */
export function hitStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
	const r = radius + stroke.s / 2;
	for (const p of stroke.pts) if (Math.hypot(p.x - x, p.y - y) <= r) return true;
	return false;
}

/* ============ Regions: closed polygons drawn with the lasso ============ */

export interface Region {
	id: string;
	name: string;          // user-given name; becomes a heading in the markdown
	path: [number, number][];
}

export interface Box { x: number; y: number; w: number; h: number }

export function polyBounds(path: [number, number][]): Box {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of path) {
		if (x < x0) x0 = x; if (x > x1) x1 = x;
		if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Ray casting: is the point inside the polygon? */
export function pointInPoly(path: [number, number][], px: number, py: number): boolean {
	let inside = false;
	for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
		const [xi, yi] = path[i], [xj, yj] = path[j];
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Polygon area, shoelace formula, absolute value. Used to decide which of two
 *  nested regions is the inner one -- not bounding-box area, because hand-drawn
 *  rings are irregular and bounding boxes lie. */
export function polyArea(path: [number, number][]): number {
	let s = 0;
	for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
		s += path[j][0] * path[i][1] - path[i][0] * path[j][1];
	}
	return Math.abs(s) / 2;
}

/** Shortest distance from a point to the polygon boundary, so "tapped the ring"
 *  gets some tolerance -- demanding a hit on the thin dashed line is too strict. */
export function distToPoly(path: [number, number][], px: number, py: number): number {
	let best = Infinity;
	for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
		const [x1, y1] = path[j], [x2, y2] = path[i];
		const dx = x2 - x1, dy = y2 - y1;
		const L2 = dx * dx + dy * dy;
		let t = L2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
		t = Math.max(0, Math.min(1, t));
		const d = Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
		if (d < best) best = d;
	}
	return best;
}

/** Does the stroke intersect the region? One sample inside the polygon counts. */
export function strokeInRegion(stroke: Stroke, region: Region): boolean {
	for (const p of stroke.pts) if (pointInPoly(region.path, p.x, p.y)) return true;
	return false;
}

export function pathToCanvas(cx: CanvasRenderingContext2D, path: [number, number][]) {
	if (!path.length) return;
	cx.beginPath();
	cx.moveTo(path[0][0], path[0][1]);
	for (let i = 1; i < path.length; i++) cx.lineTo(path[i][0], path[i][1]);
	cx.closePath();
}

/** Paint ink into a standalone canvas, used for region embeds and for ![[...]]
 *  rendered inside other notes. `box` is the page-coordinate range to show; when
 *  `clip` is given, only what is inside the polygon appears. */
export function paintInk(
	canvas: HTMLCanvasElement,
	strokes: Stroke[],
	opt: InkOpts,
	box: Box,
	cssWidth: number,
	clip?: [number, number][],
) {
	const pad = 6;
	const w = Math.max(box.w + pad * 2, 1), h = Math.max(box.h + pad * 2, 1);
	const scale = cssWidth / w;
	const cssHeight = h * scale;
	const dpr = window.devicePixelRatio || 1;

	canvas.width = Math.max(1, Math.round(cssWidth * dpr));
	canvas.height = Math.max(1, Math.round(cssHeight * dpr));
	canvas.style.width = cssWidth + "px";
	canvas.style.height = cssHeight + "px";

	const cx = canvas.getContext("2d")!;
	cx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
	cx.translate(-box.x + pad, -box.y + pad);
	cx.lineCap = "round";
	cx.lineJoin = "round";
	if (clip) { pathToCanvas(cx, clip); cx.clip(); }
	for (const st of strokes) drawStroke(cx, st, opt, true);
	return cssHeight;
}


/* ============ One-euro filter (Casiez et al., CHI 2012) ============
 * Fixed-strength smoothing forces a choice between jitter and lag. The one-euro
 * insight is that people notice jitter but not latency when moving slowly, and
 * the reverse when moving fast. So the cutoff frequency follows speed: clamp
 * hard when slow (no jitter), open up when fast (no lag). For the same amount
 * of jitter suppression the lag is far lower than a fixed low-pass. */
function oneEuro(pts: Pt[], smooth: number): [number, number][] {
	const te = 1 / RATE;
	const alphaOf = (cutoff: number) => {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / te);
	};
	// The smooth slider maps to the minimum cutoff: smoother means a lower cutoff,
	// which clamps harder at low speed
	const minCutoff = 0.6 + (1 - smooth) * 7;
	const beta = 0.05;   // speed coefficient. From a parameter sweep: less jitter
	                     // than exponential smoothing when slow, 73% less lag when fast
	const aD = alphaOf(1);   // the derivative needs its own low-pass, or the speed
	                         // estimate itself jitters

	const out: [number, number][] = [];
	if (!pts.length) return out;
	let fx = pts[0].x, fy = pts[0].y, px = fx, py = fy, edx = 0, edy = 0;
	out.push([fx, fy]);

	for (let i = 1; i < pts.length; i++) {
		const { x, y } = pts[i];
		const dx = (x - px) * RATE, dy = (y - py) * RATE;
		edx += aD * (dx - edx);
		edy += aD * (dy - edy);
		const a = alphaOf(minCutoff + beta * Math.hypot(edx, edy));
		fx += a * (x - fx);
		fy += a * (y - fy);
		px = x; py = y;
		out.push([fx, fy]);
	}
	return out;
}

/* ============ Tip prediction ============
 * Native apps like Notability use UIKit's predictedTouches to draw ink ahead of
 * the pen tip, which is the main source of that "sticks to the nib" feeling.
 * WebKit does not implement getPredictedEvents(), so we extrapolate ourselves.
 * Only when moving fast: at low speed people notice jitter rather than latency,
 * and prediction would add jitter. */
export function predictTip(pts: Pt[], frames: number): Pt[] {
	const n = pts.length;
	if (n < 3 || frames <= 0) return [];
	const a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
	const vx = (c.x - a.x) / 2, vy = (c.y - a.y) / 2;
	const sp = Math.hypot(vx, vy);
	if (sp < 0.4) return [];

	// Damp the prediction through a turn, or the tip flies off along the tangent
	const d1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	const d2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
	const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (d1 * d2);
	const damp = Math.max(0, Math.min(1, (dot - 0.2) / 0.8));
	if (damp <= 0) return [];

	const steps = Math.round(frames * damp);
	const out: Pt[] = [];
	let x = c.x, y = c.y, moved = 0;
	for (let i = 0; i < steps; i++) {
		const f = damp * (1 - i / (steps + 1));
		if (moved + sp * f > 16) break;   // cap the predicted distance; better to
		                                  // under-predict than to overshoot
		x += vx * f; y += vy * f; moved += sp * f;
		out.push({ x, y, p: c.p });
	}
	return out;
}
