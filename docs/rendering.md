# Stroke rendering: the landmines and the tests that cover them

Rendering a variable-width stroke looks simple. In practice there are several
traps that **only show up under realistic input noise**. This records what
causes them and how to verify a fix, so the same ground is not walked twice.

## Sampling

**iPadOS returns overlapping `getCoalescedEvents()` windows** — samples already
delivered by the previous `pointermove` are delivered again verbatim. The point
sequence then jumps backwards, the outline crosses itself, nonzero winding
cancels, and the stroke shows a row of cracks. (The API only landed in Safari
with iOS 18.2 and is incomplete; the coalesced events even lack `pointerId` and
`target`.)

Two defences: on input, deduplicate by strictly increasing event timestamp; on
render, `cleanRaw()` checks for duplication (a new point landing within 0.35
units of one of the last 16 accepted points is a re-send). The test is
duplication rather than direction reversal, because real strokes do turn
sharply and do retrace.

**Pressure at touch-down and lift-off is fake** — the digitiser has not read it
yet and iPad reports 0. Backfill from the first and last trustworthy sample
rather than hiding it behind a fabricated taper.

## Geometry

Three hard invariants, each with a specific visual symptom when violated:

| Invariant | Symptom | How it is held |
|---|---|---|
| All subpaths wound the same way | **holes** in the stroke | trapezoids and discs all have positive signed area |
| Subpaths never self-intersect | holes and **spurs** | a trapezoid uses its own segment's normal, so it is convex |
| Coverage equals the true stroke region | **wedge notches** on the edge, only visible zoomed in | a disc at every sample point |

The second one is easy to miss. Building a quad from each endpoint's own normal
turns it into a bowtie as soon as the two normals differ by more than 90
degrees; the two lobes wind in opposite directions, one of them at −1, and that
is a hole. At a sharp turn the points are a fraction of a unit apart, so a
direction taken from immediate neighbours is mostly noise and swings past 90
degrees easily.

The third one was estimated with a small-angle formula, which put the notch
depth at thousandths of a unit and made it look safe to skip. Noise routinely
makes consecutive segment directions differ by more than 90 degrees, where the
depth is `r(1 − cos(θ/2))`; measured, it reached 1.9 page units — about 1.5px at
100% zoom, where it passes for antialiasing, but a 9px gouge at 600%.

## Writing the tests

**Test data must carry realistic noise.** None of these problems appear on
clean synthetic strokes.

- *Winding consistency*: record the path through a fake canvas context and check
  the signed area of every subpath has the same sign
- *Self-intersection*: for each quad, check whether its two diagonals cross
- *Coverage*: rasterise the rendered area and compare it point by point against
  the mathematically correct stroke region (the union of discs swept along the
  centreline), reporting missed points and the deepest notch

**Also be clear about what a test cannot see.** All three above check geometry
only. They say nothing about the rasteriser — conflation artifacts, for
instance (see Linebender/vello #49).

## Roads not taken

- **Single outline** (left offset, end cap, right offset reversed): only one
  subpath, so conflation artifacts are structurally impossible, but the outline
  self-intersects at sharp turns and produces perfect-freehand's well-known
  "hot elbows". Measured geometric error 2.1%; visually it looks like a
  hedgehog. Unusable.
- **Native constant-width stroke**: hand the centreline to the browser's own
  stroker. Perfectly clean, but no pressure-driven width at all.
- **Boolean union to an outline**: what Microsoft's Win2D does when it calls
  `Outline()` after `CanvasGeometry.CreateInk()`. Canvas 2D has no such API.

## The spline, and why every point still gets its disc

Since v0.16 the pad is a single page, so rendering can spend more per stroke.
Two things that once kept a long notebook small are gone, because zoomed in
they showed: finished strokes are no longer thinned, and no longer rounded to a
tenth of a unit (half a pixel of wobble along every edge at maximum zoom).

Zoomed in, a centripetal Catmull-Rom spline is drawn through the samples
instead of straight lines between them. It subdivides by how much the curve
turns, not by distance, so straight stretches cost nothing extra; the bend
estimate adds the turn on the way out of a sample to the turn on the way in,
because comparing the two end tangents alone misses an S-bend. On noisy input
the worst corner at maximum zoom drops from 1.5-2.9px to under 0.5px
(`test/ink.test.js`).

Zoomed out it is not drawn at all: at about 1.4 device pixels per unit a 240Hz
polyline is already as fine as the screen, and the spline costs about three
times as much (`SPLINE_FROM`). Both outlines are built once, when the pen lifts.

**Wedges instead of discs do not work.** To save the arcs, the joints between
spline points were closed with the exact wedge triangle instead of a disc. The
geometry was right, and a rasterised crack test still found half-covered pixels
in the middle of strokes: in Chrome, where two subpaths of one path meet edge
to edge, a pixel on the seam can come out half covered. A disc overlaps the
seam and no rasteriser can leave it open. `npm run test:pad` renders noisy
strokes at 10px per unit and checks every interior pixel is solid; it caught
this, where the geometry checks could not.

## Input rounded to whole pixels

An iPad screenshot showed a nearly vertical line drawn as a staircase: long
straight runs, then a step sideways, at regular intervals. Rendering cannot fix
that; the samples themselves are the staircase. The positions arrive rounded to
whole CSS pixels, so a slightly slanted line keeps its x for a dozen samples
and then jumps. Thin pens and the small landscape page (about 2 units per
pixel) made it obvious. `npm run test:pad` with `ONLY=stairs` reproduces it.

The pad counts, per stroke, how many samples land on whole (or half) pixels;
when nine in ten do, the stroke carries `q`, half the rounding step in page
units, and `dequantize()` reconstructs it before anything else runs:

1. Per axis, anchors: where the rounded value steps from one pixel to the next,
   the true value crossed the half-pixel line right there; where it turns back,
   the turn is in the middle of that run. A monotone cubic through the anchors,
   parameterised by sample time.
2. One fit over the whole stroke: the path that bends least while staying near
   that estimate and inside every sample's rounding box (a Whittaker smoother,
   with the boxes enforced by ADMM).

Measured on rounded synthetic strokes (`test/ink.test.js`), the extra turning
the staircase adds drops from hundreds or thousands of degrees to a few, and
every stroke ends up closer to the true path than its rounded samples were.

Approaches that failed, so they are not tried again:

- A Gaussian, then clamping each point back into its box, repeated: shrinks
  every curve onto the inner edge of its boxes, worse than the staircase.
- Anchors joined piecewise-linearly: curves stay faintly polygonal.
- The whole-stroke fit with points pinned to their box edge and re-solved:
  a pin set while the curve is still far off is never released, and the
  result zig-zags. ADMM does not have that problem.
- Too much smoothing in the fit (lambda 600 and up): rounds off a 横折.
