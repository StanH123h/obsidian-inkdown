/* The spline, on input with digitiser-like noise (clean synthetic strokes hide
 * exactly the problems this is about; see docs/rendering.md).
 *
 * Measures what "no corners when zoomed in" means in numbers: how far the
 * worst corner of the drawn outline sticks out, with and without the spline. Also checks
 * the spline passes through every sample, never strays far from them, and never
 * produces NaN on coincident points.
 *
 * What this cannot see: cracks, which only show once the geometry is
 * rasterised -- test/pad.e2e.mjs renders noisy strokes and looks for them --
 * nor how it looks or performs on the iPad itself. The pad reports draw times
 * in the diagnostics panel for that. */
const { build, erasePrecise } = require('../.test-build/ink.cjs');

let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('FAIL ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

// Seeded noise, so a failure reproduces
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = (s) => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) * s / Math.sqrt(0.5); };

const opt = (curve) => ({ smooth: 0.55, thin: 0.7, taper: 0, filter: 1, curve });
const noisy = (pts, s = 0.15) => pts.map(([x, y], i) => ({ x: x + gauss(s), y: y + gauss(s), p: 0.5 + 0.15 * Math.sin(i / 7) + gauss(0.03) }));

/** The biggest corner, as how far a joint sticks out from the straight line
 *  through its two neighbours, in page units. Angle alone misleads: a spline
 *  tracing a small wiggle the noise left in the path turns sharply over a
 *  quarter of a unit, which no one can see, while a straight edge meeting
 *  another at a mild angle over a whole unit shows as a facet. */
function kink(pts) {
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const dx = c.x - a.x, dy = c.y - a.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    worst = Math.max(worst, Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / L);
  }
  return worst;
}
/** Total turning along a path, in degrees, ignoring chords too short to have a direction */
function turning(pts) {
  let sum = 0, px = 0, py = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    if (px || py) sum += Math.acos(Math.max(-1, Math.min(1, (dx * px + dy * py) / L)));
    px = dx / L; py = dy / L;
  }
  return sum * 180 / Math.PI;
}
/** Pixels per page unit at the pad's maximum zoom on an upright iPad Air */
const MAX_ZOOM_PX = 0.68 * 8;
const distToSeg = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};
const strays = (curve, poly) => Math.max(...curve.map((p) => Math.min(...poly.slice(1).map((b, i) => distToSeg(p, poly[i], b)))));

function check(name, raw) {
  const stroke = { c: '#000', s: 8, pts: raw };
  const line = build(stroke, opt(0));
  const curve = build(stroke, opt(1));
  ok(curve.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r)), `${name}: no NaN`);
  ok(curve[0].x === line[0].x && curve.at(-1).y === line.at(-1).y, `${name}: same end points`);
  const passes = line.every((q) => curve.some((p) => p.x === q.x && p.y === q.y));
  ok(passes, `${name}: the spline passes through every sample`);
  let gap = 0;
  for (let i = 1; i < curve.length; i++) gap = Math.max(gap, Math.hypot(curve[i].x - curve[i - 1].x, curve[i].y - curve[i - 1].y));
  ok(gap <= 3.6, `${name}: no drawn chord much over 3 units, got ${gap.toFixed(3)}`);
  const s = strays(curve, line);
  ok(s < 0.25, `${name}: the spline stays within 0.25 units of the samples, strays ${s.toFixed(3)}`);
  const before = kink(line), after = kink(curve);
  console.log(`  ${name}: biggest corner ${before.toFixed(3)} -> ${after.toFixed(3)} units, ${(before * MAX_ZOOM_PX).toFixed(2)} -> ${(after * MAX_ZOOM_PX).toFixed(2)} px at max zoom; ${line.length} -> ${curve.length} points`);
  return { before, after };
}

// A circle of radius 20 units written at about 240Hz: a sample every ~0.8 units
const circle = noisy(Array.from({ length: 160 }, (_, i) => [100 + 20 * Math.cos(i / 159 * 2 * Math.PI), 100 + 20 * Math.sin(i / 159 * 2 * Math.PI)]));
const c = check('noisy circle', circle);
ok(c.after < c.before / 3, `on a curve the spline's corners are under a third of the straight ones (${c.before.toFixed(3)} -> ${c.after.toFixed(3)})`);
ok(c.after * MAX_ZOOM_PX < 0.5, `on a curve no corner shows even at max zoom: ${(c.after * MAX_ZOOM_PX).toFixed(2)} px`);

// A fast, sparse curve: the case where straight lines facet worst
const fast = noisy(Array.from({ length: 30 }, (_, i) => [50 + i * 4, 50 + 25 * Math.sin(i / 5)]), 0.1);
const f = check('fast sparse curve', fast);
ok(f.after < f.before / 3, `on a fast curve the spline's corners are under a third of the straight ones (${f.before.toFixed(3)} -> ${f.after.toFixed(3)})`);
ok(f.after * MAX_ZOOM_PX < 0.5, `on a fast curve no corner shows even at max zoom: ${(f.after * MAX_ZOOM_PX).toFixed(2)} px`);

// 横折: across, slowing into the corner so samples bunch up, then down. The
// corner must stay a corner: the spline may not bulge past it.
const across = Array.from({ length: 40 }, (_, i) => [200 + 40 * (1 - Math.pow(1 - i / 39, 2)), 300]);
const down = Array.from({ length: 40 }, (_, i) => [240, 300 + 40 * Math.pow(i / 39, 2)]);
const corner = noisy([...across, ...down], 0.12);
check('横折 corner', corner);
const cv = build({ c: '#000', s: 8, pts: corner }, opt(1));
const maxX = Math.max(...cv.map((p) => p.x)), minY = Math.min(...cv.map((p) => p.y));
const lv = build({ c: '#000', s: 8, pts: corner }, opt(0));
ok(maxX <= Math.max(...lv.map((p) => p.x)) + 0.2 && minY >= Math.min(...lv.map((p) => p.y)) - 0.2, `横折: no overshoot past the corner (x ${maxX.toFixed(2)}, y ${minY.toFixed(2)})`);

// Coincident and near-coincident samples must not produce NaN
const dup = [{ x: 10, y: 10, p: 0.5 }, { x: 10, y: 10, p: 0.5 }, { x: 10.0001, y: 10, p: 0.5 }, { x: 14, y: 12, p: 0.5 }, { x: 14, y: 12, p: 0.5 }, { x: 20, y: 15, p: 0.5 }];
const d = build({ c: '#000', s: 8, pts: dup }, opt(1));
ok(d.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), 'coincident samples: no NaN');
ok(build({ c: '#000', s: 8, pts: [{ x: 1, y: 1, p: 0.5 }] }, opt(1)).length === 1, 'a dot stays one point');

/* ---- input rounded to whole pixels ----
 * What an iPad screenshot showed: positions arriving as whole CSS pixels, so a
 * slanted line comes out as a staircase. Reproduced here at the scale of the
 * landscape whole-page view, 0.53 px per unit, so one pixel is ~1.9 units. */
const SCALE = 0.53, H = 0.5 / SCALE;
const roundTo = (truth, timed = true) => truth.map(([x, y], i) => ({
  x: Math.round(x * SCALE) / SCALE, y: Math.round(y * SCALE) / SCALE, p: 0.5, ...(timed ? { t: i * 1000 / 240 } : {}),
}));
/** How far the drawn centreline strays from where the pen really was */
const offTruth = (pts, truth) => Math.max(...pts.map((p) => Math.min(...truth.slice(1).map((b, i) => distToSeg(p, { x: truth[i][0], y: truth[i][1] }, { x: b[0], y: b[1] })))));
/** The rounding alone can put a sample anywhere in its pixel: this far off on the diagonal */
const INHERENT = H * Math.SQRT2;
function stairs(name, truth) {
  const raw = roundTo(truth);
  const plain = build({ c: '#000', s: 8, pts: raw }, opt(1));
  const fixed = build({ c: '#000', s: 8, pts: raw, q: H }, opt(1));
  const a = offTruth(plain, truth), b = offTruth(fixed, truth);
  // Each step of a staircase is two small turns, one into it and one out, so
  // how much the drawn path turns beyond what the pen really turned counts them
  const real = turning(truth.map(([x, y]) => ({ x, y })));
  const ta = turning(plain) - real, tb = turning(fixed) - real;
  console.log(`  ${name}: turns ${ta.toFixed(0)}° -> ${tb.toFixed(0)}° more than the pen did, strays from the true path ${(a * SCALE).toFixed(2)} -> ${(b * SCALE).toFixed(2)} px (as written; the rounding alone allows ${(INHERENT * SCALE).toFixed(2)})`);
  ok(fixed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `${name}: no NaN`);
  ok(tb < ta / 3, `${name}: the staircase's extra turning falls to under a third (${ta.toFixed(0)}° -> ${tb.toFixed(0)}°)`);
  ok(b < a, `${name}: closer to the true path than the rounded input (${(a * SCALE).toFixed(2)} -> ${(b * SCALE).toFixed(2)} px)`);
  // And getting rid of them must never move the line further than the input
  // itself was uncertain about
  ok(b <= INHERENT, `${name}: within the rounding's own uncertainty of the true path (${(b * SCALE).toFixed(2)} px, allowed ${(INHERENT * SCALE).toFixed(2)})`);
  return { a, b, fixed };
}
// A long, nearly vertical line, the screenshot's case
const shallow = Array.from({ length: 160 }, (_, i) => [500 + 9 * i / 159, 100 + 300 * i / 159]);
stairs('nearly vertical line', shallow);
// The same, drawn the other way and steeper
stairs('slanted line', Array.from({ length: 120 }, (_, i) => [700 - 40 * i / 119, 100 + 200 * i / 119]));
// A circle the size of a small letter
const ring = Array.from({ length: 140 }, (_, i) => [300 + 25 * Math.cos(i / 139 * 2 * Math.PI), 300 + 25 * Math.sin(i / 139 * 2 * Math.PI)]);
stairs('letter-sized circle', ring);
// 横折, with the slight slant a real hand gives it
const hz = [...Array.from({ length: 60 }, (_, i) => [200 + 60 * i / 59, 400 + 2 * i / 59]), ...Array.from({ length: 60 }, (_, i) => [260 - 1.5 * i / 59, 402 + 60 * i / 59])];
const c2 = stairs('横折', hz);
const cornerGap = Math.min(...c2.fixed.map((p) => Math.hypot(p.x - 260, p.y - 402)));
ok(cornerGap <= INHERENT, `横折: the corner stays a corner, within ${(cornerGap * SCALE).toFixed(2)} px of the true one`);
// Precise input is left exactly as it was
const exact = [{ x: 1.3, y: 2.7, p: 0.5 }, { x: 5.1, y: 3.3, p: 0.5 }, { x: 9.7, y: 4.9, p: 0.5 }, { x: 14.2, y: 7.1, p: 0.5 }];
eq(build({ c: '#000', s: 8, pts: exact, q: 0 }, opt(0)).length, build({ c: '#000', s: 8, pts: exact }, opt(0)).length, 'q = 0 changes nothing');

/* ---- lifting the pen ----
 * The stroke under the pen and the finished one must be the same stroke: any
 * difference shows as the ink jumping the moment the pen comes up. Once that
 * difference was a settling step that dropped samples; and the predicted tip,
 * computed from raw samples, flickered about. */
{
  const raw = roundTo(Array.from({ length: 200 }, (_, i) => { const a = i / 199 * 2.2; return [400 + 60 * Math.sin(a) + i * 0.18, 300 + 70 * (1 - Math.cos(a))]; }));
  const st = { c: '#000', s: 8, pts: raw, q: H };
  const finished = build(st, opt(1));
  eq(build(st, opt(1), 2, 0), finished, 'the tip shrunk to nothing is exactly the finished stroke');
  const live = build(st, opt(1), 2, 1);
  // Only the last stretch may differ: the spline's final segment now has a
  // neighbour past it. Everything before is drawn identically.
  const keep = Math.floor(finished.length * 0.95);
  ok(finished.slice(0, keep).every((p, i) => p.x === live[i].x && p.y === live[i].y && p.r === live[i].r),
    'the predicted tip changes nothing already drawn');
  ok(live.length > finished.length, 'and does reach past the last sample');
  // Taper on: the end is tapered under the pen as well, so lifting does not
  // suddenly thin it
  const taper = { ...opt(1), taper: 1 };
  eq(build(st, taper, 2, 0), build(st, taper), 'with taper on, the lifted stroke is still the one drawn');
}

/* The precise eraser cutting an AI-pen note in two. The pieces are drawn in
 * their colour on the pad, but the image for the model is coloured by `ai`:
 * a piece without it goes in black and is read as part of the note. */
{
  const note = { c: '#7c3aed', s: 5, pts: noisy(Array.from({ length: 60 }, (_, i) => [i * 0.5, 10])), q: 0.25, ai: true };
  const parts = erasePrecise([note], 15, 10, 3);
  eq(parts.length, 2, 'erasing the middle of a stroke leaves two pieces');
  for (const [i, { pts, ...rest }] of parts.entries())
    eq(rest, { c: note.c, s: note.s, q: note.q, ai: true }, `piece ${i + 1} keeps everything but its points`);
  ok(note.pts.length === 60, 'the stroke itself is left as it was, for undo');
}

console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS ink: ${n} checks`);
process.exit(bad ? 1 : 0);
