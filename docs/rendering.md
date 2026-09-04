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
