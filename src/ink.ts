/* Ink model and rendering engine.
 * All coordinates are "page units" (the page is always PAGE_W wide),
 * independent of device resolution and window size, so the same ink looks
 * identical on an iPad and on a desktop. */

export const PAGE_W = 1000;
/** Page height. A4 is 210x297mm, a ratio of 1.414. The pad is exactly one
 *  page: a scratch sheet, not a document that grows. */
export const PAGE_H = 1414;

/** A pen sample. `t` is when it was taken, in ms, when known: rounded input is
 *  reconstructed against time, which is what a pen moves smoothly in. */
export interface Pt { x: number; y: number; p: number; t?: number }
export interface Stroke {
	c: string;
	s: number;
	pts: Pt[];
	/** Half the step the input was rounded to, in page units: each sample is
	 *  only known to within this on either axis. 0 or absent for precise
	 *  input. See dequantize(). */
	q?: number;
	/** Written with the AI pen: a note to the model, never transcribed */
	ai?: boolean;
}

/** The AI pen's colour, on the pad and in the image the model reads. A vivid
 *  violet, far enough from black that a vision model tells them apart at a
 *  glance, and the prompt names it. */
export const NOTE_INK = "#7c3aed";

export interface InkOpts {
	smooth: number;   // 0..0.9  smoothing strength
	thin: number;     // 0..1    how much pressure affects width
	taper: number;    // 0 = off, 1 = subtle
	filter: number;   // 0 = exponential smoothing, 1 = one-euro filter
	curve: number;    // 0 = straight between samples, 1 = a spline through them
}

/** How far the spline may turn across one drawn chord, in radians (3 degrees).
 *  A chord of length L turning by that much strays from the true curve by
 *  about L * 0.0065, which stays under a pixel at any zoom the pad allows.
 *
 *  Subdividing by turn rather than by distance is what makes the spline
 *  affordable: a straight stretch needs no extra points at all, and only the
 *  curves -- where facets would actually show -- get them. Measured on a full
 *  page, a fixed 0.3-unit step made repaints 17 times slower. */
const TURN_STEP = (3 * Math.PI) / 180;

/** A chord never longer than this, in page units, so the width still follows
 *  pressure smoothly along a long, straight, fast stroke */
const MAX_CHORD = 3;

/** Device pixels per page unit from which the spline is worth drawing. Below
 *  it a 240Hz polyline's chords are already about a pixel long, so straight
 *  segments look the same and cost a third as much. On an upright iPad Air,
 *  zoom 1 is about 1.4, so the whole page is drawn straight and anything
 *  zoomed in gets the spline. */
export const SPLINE_FROM = 2;

/* How far the smoothing filter remembers, in page units.
 *
 * Swept against digitiser noise and circle-radius loss: the knee sits just under
 * 1. At L = 1 noise drops by about 60% and a 4-unit circle loses 4% of its
 * radius; past that, noise reduction flattens out while the shrinkage keeps
 * climbing -- L = 2.85 buys another 6% of noise for 16% of the radius. The old
 * per-sample filter sat around an effective L of 2, well past the knee, which is
 * why tight curves visibly shrank. */
const SMOOTH_MIN_L = 0.15;
const SMOOTH_L_RANGE = 1.55;

const TAPER_PX = [0, 3];
const TAU = Math.PI * 2;
const ease = (t: number) => t * t * (3 - 2 * t);

interface RPt { x: number; y: number; r: number }

/** Turn raw samples into render points carrying a radius. Recomputed whenever
 *  the settings change, so a change immediately affects existing ink.
 *
 *  The stroke under the pen and the finished stroke go through exactly this,
 *  from exactly the same samples, so lifting the pen changes nothing about
 *  what is already drawn. It used to: settling a stroke dropped samples first,
 *  and the finished stroke visibly shifted the moment the pen came up.
 *
 *  @param ahead  frames of tip prediction to draw past the last sample, for
 *    the stroke still under the pen; 0 for a finished one
 *  @param reach  how much of that prediction to draw, 0..1, so that on lift
 *    it can shrink back instead of vanishing in one frame */
export function build(stroke: Stroke, opt: InkOpts, ahead = 0, reach = 1): RPt[] {
	// Rounded input is reconstructed first, from every sample: a run of samples
	// on one pixel is exactly what says how long the pen took to cross it,
	// and cleanRaw would drop all but the first as standing still
	let clean = cleanRaw(dequantize(stroke.pts, stroke.q ?? 0));
	if (!clean.length) return [];
	// Predict from the reconstructed path, not the raw samples: extrapolating
	// from three samples on a pixel grid points the tip in a grid direction,
	// and it flickered about with every new sample
	if (ahead > 0 && reach > 0) {
		const last = clean[clean.length - 1];
		const tip = predictTip(clean, ahead);
		if (tip.length) clean = clean.concat(tip.map((p) => ({
			x: last.x + (p.x - last.x) * reach, y: last.y + (p.y - last.y) * reach, p: p.p,
		})));
	}

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
	const smooth = opt.filter === 1 ? spatialSmooth(clean, opt.smooth) : null;
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
			// The end tapers while the stroke is still being drawn too. Tapered
			// only once finished, the end shrank the moment the pen lifted.
			r *= ease(Math.min((total - pt.d) / T, 1));
		}
		pt.r = Math.max(r, 0.2);
	}
	return opt.curve ? densify(out) : out;
}

/* ============ Spline ============
 *
 * Joining samples with straight lines shows every sample as a corner once you
 * zoom in: at 240Hz a stroke is a polyline of sub-unit segments, but slow
 * curves and the turns of a character still come out faceted. A centripetal
 * Catmull-Rom spline passes through every sample and is smooth between them.
 * Centripetal (alpha 0.5) rather than uniform, because uniform Catmull-Rom
 * overshoots and can loop where sample spacing changes abruptly -- which is
 * exactly what a pen slowing into a corner does.
 *
 * The radius is interpolated linearly, not along the spline: a spline through
 * noisy pressure overshoots too, and a width that dips below both neighbours
 * reads as a nick in the edge.
 *
 * None of the three rendering invariants is touched: the output is still a
 * sequence of points, each segment still gets its own convex trapezoid and
 * each point its own disc. There are just more of them -- about three times
 * as many -- which is why the pad only draws the spline once you zoom in
 * (SPLINE_FROM), where it can be seen. */

/** Knot spacing for centripetal parameterisation: the square root of the chord.
 *  Never zero, or coincident points would divide by zero below. */
const knot = (a: RPt, b: RPt) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);

/** Angle between two directions, in radians, 0 when either is degenerate */
function turnOf(ax: number, ay: number, bx: number, by: number): number {
	const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
	if (la < 1e-9 || lb < 1e-9) return 0;
	return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
}

function densify(pts: RPt[]): RPt[] {
	if (pts.length < 3) return pts;   // through two points the spline is the line
	const out: RPt[] = [pts[0]];
	for (let i = 0; i < pts.length - 1; i++) {
		const p1 = pts[i], p2 = pts[i + 1];
		// Mirror an end point to make a phantom neighbour, so the first and last
		// segments leave and arrive in the direction the stroke is travelling
		const p0 = i > 0 ? pts[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y, r: p1.r };
		const p3 = i + 2 < pts.length ? pts[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y, r: p2.r };
		// The spline leaves p1 parallel to p0->p2 and arrives at p2 parallel to
		// p1->p3. How far each of those strays from the chord is how much it
		// bends on the way. Comparing the two tangents directly would miss an
		// S-bend, which leaves and arrives the same way and wiggles in between.
		const cxd = p2.x - p1.x, cyd = p2.y - p1.y;
		const bend = turnOf(p2.x - p0.x, p2.y - p0.y, cxd, cyd) + turnOf(cxd, cyd, p3.x - p1.x, p3.y - p1.y);
		const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
		const n = Math.min(Math.max(Math.ceil(bend / TURN_STEP), Math.ceil(len / MAX_CHORD), 1), 32);
		const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
		for (let j = 1; j < n; j++) {
			const u = j / n;
			const t = t1 + (t2 - t1) * u;
			// Barry and Goldman's pyramid: three lerps, two, then one
			const ax1 = (t1 - t) / t1 * p0.x + t / t1 * p1.x;
			const ay1 = (t1 - t) / t1 * p0.y + t / t1 * p1.y;
			const ax2 = (t2 - t) / (t2 - t1) * p1.x + (t - t1) / (t2 - t1) * p2.x;
			const ay2 = (t2 - t) / (t2 - t1) * p1.y + (t - t1) / (t2 - t1) * p2.y;
			const ax3 = (t3 - t) / (t3 - t2) * p2.x + (t - t2) / (t3 - t2) * p3.x;
			const ay3 = (t3 - t) / (t3 - t2) * p2.y + (t - t2) / (t3 - t2) * p3.y;
			const bx1 = (t2 - t) / t2 * ax1 + t / t2 * ax2;
			const by1 = (t2 - t) / t2 * ay1 + t / t2 * ay2;
			const bx2 = (t3 - t) / (t3 - t1) * ax2 + (t - t1) / (t3 - t1) * ax3;
			const by2 = (t3 - t) / (t3 - t1) * ay2 + (t - t1) / (t3 - t1) * ay3;
			out.push({
				x: (t2 - t) / (t2 - t1) * bx1 + (t - t1) / (t2 - t1) * bx2,
				y: (t2 - t) / (t2 - t1) * by1 + (t - t1) / (t2 - t1) * by2,
				r: p1.r + (p2.r - p1.r) * u,
			});
		}
		out.push(p2);
	}
	return out;
}

/* ============ De-quantisation ============
 *
 * iPadOS can hand over pen positions rounded to whole CSS pixels. Drawn, a
 * line that is nearly but not quite vertical keeps the same x for a dozen
 * samples and then jumps a pixel: a staircase. Zoomed in, or with a thin pen,
 * it is the first thing you see, and no amount of drawing the samples more
 * smoothly helps, because the samples themselves are the staircase.
 *
 * Smoothing it away does not work either. A Gaussian wide enough to flatten
 * the long steps of a shallow line shrinks every curve, and clamping each point
 * back inside its rounding box just parks the curves on the inner edge of their
 * boxes; tried, it made circles and corners worse than the staircase.
 *
 * What does work is reading the staircase for what it is, as pixel-art
 * vectorisers do. Take each axis on its own. Where the rounded x steps from one
 * pixel to the next, the pen's true x crossed the half-pixel line between them
 * right there: an exact anchor. Where x turns back -- the top of a curve, a
 * peak -- the turn happened somewhere in that run, so anchor its middle. In
 * between, the true x went smoothly from one anchor to the next, and a monotone
 * cubic through the anchors follows it to well under a pixel. A slanted line
 * comes out as the line through the middles of its steps, which is where it
 * was.
 *
 * Every anchor is within half a pixel of the truth, so no point ever moves
 * further than the rounding already put it. */

export function dequantize(pts: Pt[], h: number): Pt[] {
	const n = pts.length;
	if (!(h > 0) || n < 3) return pts;
	// When each sample was taken, for placing the anchors: the pen moves
	// smoothly in time. Distance along the rounded path is the fallback, and a
	// poorer one, since the staircase itself distorts it.
	const t = new Float64Array(n);
	const timed = pts.every((p) => typeof p.t === "number");
	for (let i = 1; i < n; i++) {
		const step = timed ? (pts[i].t! - pts[i - 1].t!) : Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
		t[i] = t[i - 1] + Math.max(step, 1e-6);
	}
	const qx = pts.map((p) => p.x), qy = pts.map((p) => p.y);
	const x = tube(destep(qx, t, h), qx, h);
	const y = tube(destep(qy, t, h), qy, h);
	return pts.map((p, i) => ({ x: x[i], y: y[i], p: p.p, t: p.t }));
}

/* The anchors are right where they are, but joined up one stretch at a time
 * they still leave the line faintly wavy: each stretch is fitted on its own.
 * So, last, one fit over the whole stroke: the path that bends least overall
 * while staying near the anchors' estimate, and never leaves a sample's
 * rounding box. A straight line fits inside every box and bends not at all,
 * so a straight stroke comes out exactly straight.
 *
 * "Bends least" is the sum of squared second differences; with a pull towards
 * the estimate that is a Whittaker smoother, a five-band linear system solved
 * directly in linear time. The boxes make it a constrained problem, solved by
 * ADMM: alternately smooth, and put every point back in its box, until the two
 * agree. Pinning points that strayed to their box edge and solving again was
 * tried first and zig-zagged: a pin set early, when the curve was still far
 * off, is never released. */

/** Smoothing weight against the pull towards the estimate. Its fourth root is
 *  roughly the span smoothed over, in samples: about 3.5. Kept light: the
 *  anchors already undo the long steps, this only takes out the wobble joining
 *  them leaves. Swept in test/ink.test.js: from 60 to 300 everything passes;
 *  at 600 and above a 横折's corner is rounded off beyond what the rounding
 *  itself allows. */
const TUBE_LAMBDA = 150;
const TUBE_RHO = 2 * Math.sqrt(TUBE_LAMBDA);
const TUBE_ROUNDS = 80;

function tube(est: number[], q: number[], h: number): number[] {
	const n = q.length;
	if (n < 4) return est;
	const solve = pentaSolver(n, TUBE_LAMBDA, 1 + TUBE_RHO / 2);
	const z = Float64Array.from(est), u = new Float64Array(n), rhs = new Float64Array(n);
	let x: Float64Array = z;
	for (let round = 0; round < TUBE_ROUNDS; round++) {
		for (let i = 0; i < n; i++) rhs[i] = est[i] + (TUBE_RHO / 2) * (z[i] - u[i]);
		x = solve(rhs);
		let moved = 0;
		for (let i = 0; i < n; i++) {
			const v = Math.min(Math.max(x[i] + u[i], q[i] - h), q[i] + h);
			moved = Math.max(moved, Math.abs(v - z[i]));
			z[i] = v;
			u[i] += x[i] - v;
		}
		if (moved < h * 1e-3) break;
	}
	return Array.from(z);
}

/** A solver for (L*D'D + c*I) x = r, D the second-difference operator: banded
 *  LDL' factorisation done once, then O(n) per solve */
function pentaSolver(n: number, L: number, c: number): (r: Float64Array) => Float64Array {
	const a0 = new Float64Array(n).fill(c), a1 = new Float64Array(n), a2 = new Float64Array(n);
	for (let i = 0; i < n - 2; i++) {
		a0[i] += L; a0[i + 1] += 4 * L; a0[i + 2] += L;
		a1[i] -= 2 * L; a1[i + 1] -= 2 * L;
		a2[i] += L;
	}
	const d = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		l2[i] = i >= 2 ? a2[i - 2] / d[i - 2] : 0;
		l1[i] = i >= 1 ? (a1[i - 1] - (i >= 2 ? l2[i] * l1[i - 1] * d[i - 2] : 0)) / d[i - 1] : 0;
		d[i] = a0[i] - (i >= 1 ? l1[i] * l1[i] * d[i - 1] : 0) - (i >= 2 ? l2[i] * l2[i] * d[i - 2] : 0);
	}
	return (r) => {
		const y = new Float64Array(n), x = new Float64Array(n);
		for (let i = 0; i < n; i++) y[i] = r[i] - (i >= 1 ? l1[i] * y[i - 1] : 0) - (i >= 2 ? l2[i] * y[i - 2] : 0);
		for (let i = n - 1; i >= 0; i--) x[i] = y[i] / d[i] - (i + 1 < n ? l1[i + 1] * x[i + 1] : 0) - (i + 2 < n ? l2[i + 2] * x[i + 2] : 0);
		return x;
	};
}

/** One axis: the rounded values v at positions t, back to a continuous path */
function destep(v: number[], t: Float64Array, h: number): number[] {
	const n = v.length;
	const same = (a: number, b: number) => Math.abs(a - b) < h;   // the same pixel
	const at: number[] = [t[0]], val: number[] = [v[0]];
	for (let i = 0; i < n;) {
		let j = i;
		while (j + 1 < n && same(v[j + 1], v[i])) j++;
		// Run i..j sits on one pixel. If the values on both sides of it lie
		// the same way, the axis turned back inside it.
		if (i > 0 && j + 1 < n && Math.sign(v[i] - v[i - 1]) !== Math.sign(v[j + 1] - v[i])) {
			at.push((t[i] + t[j]) / 2); val.push(v[i]);
		}
		// The crossing into the next pixel
		if (j + 1 < n) { at.push((t[j] + t[j + 1]) / 2); val.push((v[j] + v[j + 1]) / 2); }
		i = j + 1;
	}
	at.push(t[n - 1]); val.push(v[n - 1]);

	// Monotone cubic (Fritsch-Carlson) through the anchors rather than straight
	// lines between them, which left a curve faintly polygonal. Monotone, so it
	// never overshoots an anchor: where the axis turns back the slope is zero
	// and the turn stays exactly where the staircase put it.
	const m = at.length;
	const d: number[] = [], slope: number[] = new Array<number>(m).fill(0);
	for (let k = 0; k < m - 1; k++) {
		const span = at[k + 1] - at[k];
		d.push(span > 1e-12 ? (val[k + 1] - val[k]) / span : 0);
	}
	if (m > 1) { slope[0] = d[0]; slope[m - 1] = d[m - 2]; }
	for (let k = 1; k < m - 1; k++) {
		if (d[k - 1] * d[k] <= 0) continue;
		const h0 = at[k] - at[k - 1], h1 = at[k + 1] - at[k];
		const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
		slope[k] = (w0 + w1) / (w0 / d[k - 1] + w1 / d[k]);
	}

	const out = new Array<number>(n);
	let k = 0;
	for (let i = 0; i < n; i++) {
		while (k < m - 2 && at[k + 1] < t[i]) k++;
		const span = at[k + 1] - at[k];
		if (!(span > 1e-12)) { out[i] = val[k]; continue; }
		const u = Math.min(Math.max((t[i] - at[k]) / span, 0), 1), u2 = u * u, u3 = u2 * u;
		out[i] = (2 * u3 - 3 * u2 + 1) * val[k] + (u3 - 2 * u2 + u) * span * slope[k]
			+ (-2 * u3 + 3 * u2) * val[k + 1] + (u3 - u2) * span * slope[k + 1];
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
export function drawStroke(cx: CanvasRenderingContext2D, stroke: Stroke, opt: InkOpts, ahead = 0, reach = 1) {
	const pts = build(stroke, opt, ahead, reach);
	if (!pts.length) return;
	cx.fillStyle = stroke.c;
	cx.beginPath();
	trace(cx, pts);
	cx.fill();
}

/** The same geometry as drawStroke, as a Path2D in page units. Finished strokes
 *  never change, so the pad builds this once per stroke and refills it on every
 *  repaint -- the spline and the thousands of subpaths it brings are then paid
 *  for once, not on every frame of a pinch. Null for a stroke with no points. */
export function strokePath(stroke: Stroke, opt: InkOpts): Path2D | null {
	const pts = build(stroke, opt);
	if (!pts.length) return null;
	const path = new Path2D();
	trace(path, pts);
	return path;
}

function trace(cx: CanvasPath, pts: RPt[]) {
	if (pts.length === 1) { disc(cx, pts[0]); return; }

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

	// A disc at every point, spline points included.
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
	// The discs do a second job, too: they overlap every seam where one
	// trapezoid meets the next. Closing those joints with exact wedge triangles
	// instead was tried, to save the cost of the arcs, and failed a rasterised
	// crack test in Chrome: where two subpaths meet edge to edge, a pixel on the
	// seam can come out half covered. A disc covers the seam outright, whatever
	// the rasteriser's rules.
	for (const p of pts) disc(cx, p);
}

/** One disc subpath, wound the same way as the trapezoids (both have positive
 *  signed area). That is what makes the result a union rather than an xor: with
 *  the winding reversed, overlaps would cancel and leave holes. */
function disc(cx: CanvasPath, p: { x: number; y: number; r: number }) {
	cx.moveTo(p.x + p.r, p.y);
	cx.arc(p.x, p.y, p.r, 0, TAU);
}

/** Precise erase: drop the samples under the eraser and split what is left into
 *  separate strokes, instead of removing the whole stroke. Returns a new array;
 *  strokes that were not touched are passed through by reference, so the caller
 *  can tell whether anything changed by identity. */
export function erasePrecise(strokes: Stroke[], x: number, y: number, r: number): Stroke[] {
	const out: Stroke[] = [];
	for (const st of strokes) {
		let hit = false;
		const segs: Pt[][] = [];
		let cur: Pt[] = [];
		for (const p of st.pts) {
			if (Math.hypot(p.x - x, p.y - y) <= r) {
				hit = true;
				if (cur.length >= 2) segs.push(cur);
				cur = [];
			} else cur.push(p);
		}
		if (cur.length >= 2) segs.push(cur);
		if (!hit) { out.push(st); continue; }
		for (const pts of segs) out.push({ c: st.c, s: st.s, pts });
	}
	return out;
}

/** Hit test for the eraser: is this point on the stroke? */
export function hitStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
	const r = radius + stroke.s / 2;
	for (const p of stroke.pts) if (Math.hypot(p.x - x, p.y - y) <= r) return true;
	return false;
}

/* ============ Lasso geometry ============ */

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

/** Does the stroke intersect the ring? One sample inside counts, so a stroke
 *  only partly inside is still picked up whole. */
export function strokeInPoly(stroke: Stroke, path: [number, number][]): boolean {
	for (const p of stroke.pts) if (pointInPoly(path, p.x, p.y)) return true;
	return false;
}

export function pathToCanvas(cx: CanvasRenderingContext2D, path: [number, number][]) {
	if (!path.length) return;
	cx.beginPath();
	cx.moveTo(path[0][0], path[0][1]);
	for (let i = 1; i < path.length; i++) cx.lineTo(path[i][0], path[i][1]);
	cx.closePath();
}

/* ============ Export ============ */

/** Page-unit bounds of everything written, widened by each stroke's own
 *  radius so the outermost ink is not shaved off. Null for an empty page. */
export function inkBounds(strokes: Stroke[]): Box | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const st of strokes) {
		const r = st.s / 2;
		for (const p of st.pts) {
			if (p.x - r < x0) x0 = p.x - r; if (p.x + r > x1) x1 = p.x + r;
			if (p.y - r < y0) y0 = p.y - r; if (p.y + r > y1) y1 = p.y + r;
		}
	}
	if (!isFinite(x0)) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Render the ink on white, cropped to what was written, for a vision model to
 *  read: the content black, the AI pen's notes in NOTE_INK.
 *
 *  Cropping matters more than it looks: a few lines in the corner of a page
 *  would otherwise arrive as a small smudge in a large white image, at a
 *  fraction of the resolution the model could have had for them. The long
 *  edge is capped at `maxEdge` because the APIs downscale anything larger
 *  themselves, and a 2x cap keeps a single word from being blown up into a
 *  blur of interpolated pixels. Always black on white, whatever the theme. */
export function rasterize(strokes: Stroke[], opt: InkOpts, maxEdge: number): HTMLCanvasElement | null {
	const b = inkBounds(strokes);
	if (!b) return null;
	const pad = 24;
	const w = b.w + pad * 2, h = b.h + pad * 2;
	const scale = Math.min(maxEdge / Math.max(w, h), 2);
	const cv = document.createElement("canvas");
	cv.width = Math.max(1, Math.round(w * scale));
	cv.height = Math.max(1, Math.round(h * scale));
	const cx = cv.getContext("2d")!;
	cx.fillStyle = "#ffffff";
	cx.fillRect(0, 0, cv.width, cv.height);
	cx.setTransform(scale, 0, 0, scale, (pad - b.x) * scale, (pad - b.y) * scale);
	for (const st of strokes) drawStroke(cx, { ...st, c: st.ai ? NOTE_INK : "#000000" }, opt);
	return cv;
}


/* ============ Smoothing ============
 *
 * The filter works per unit of distance travelled, not per sample. That is the
 * whole point: a stroke thinned to half its samples then smoothed comes out the
 * same shape as one smoothed at full density. The previous filter stepped once
 * per sample and assumed a fixed 120Hz, so thinning a stroke before smoothing it
 * made the filter cut corners roughly twice as hard -- a small circle lost 11% of
 * its radius instead of 6%, which is what "my handwriting keeps getting altered"
 * turned out to be.
 *
 * L is how far the filter remembers, in page units. Everything else follows from
 * it: over a stretch of path of length L the output catches up to within 1/e of
 * the input, whether that stretch holds three samples or thirty. */
function spatialSmooth(pts: Pt[], smooth: number): [number, number][] {
	const L = SMOOTH_MIN_L + smooth * SMOOTH_L_RANGE;
	const out: [number, number][] = [];
	if (!pts.length) return out;
	let fx = pts[0].x, fy = pts[0].y;
	out.push([fx, fy]);
	for (let i = 1; i < pts.length; i++) {
		const ds = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
		const a = ds / (L + ds);
		fx += a * (pts[i].x - fx);
		fy += a * (pts[i].y - fy);
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

/* ============ Stroke revision ============
 * Caches keyed on a stroke (its bounding box) need to know
 * when its points change. Appending during a draw is covered by the point
 * count; this counter covers edits that keep the count the same, such as
 * moving a lasso selection. */

export function strokeChanged(st: Stroke) {
	const m = st as Stroke & { _rev?: number };
	m._rev = (m._rev ?? 0) + 1;
}

export function strokeRev(st: Stroke): number {
	return (st as Stroke & { _rev?: number })._rev ?? 0;
}
