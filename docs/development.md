# Developing Inkdown

To install a release by hand, put its `main.js` and `manifest.json` in
`<vault>/.obsidian/plugins/inkdown/`.

```bash
npm install
npm run dev        # esbuild watch; output is deployed per .dev-targets
npm run build
npm test           # request wiring with a stubbed network, translations
npm run test:pad   # the pad in headless Chrome, with real pen/finger input
```

`.dev-targets` holds one Obsidian plugin directory per line and is not tracked.
After cloning on a new machine, recreate it, otherwise `npm run build` will
build without deploying.

`npm test` replaces Obsidian's `requestUrl` with a recorder, so it checks what
would be sent to each service and how answers are handled without calling
anything or spending anything. It cannot tell whether the services accept those
requests today, or how well a model reads real handwriting.

`npm run test:pad` drives the pad in headless Chrome through the DevTools
protocol, so pointer capture, coalesced events and pressure behave as on real
hardware, and leaves screenshots in `.test-build/`. It uses a stand-in for
Obsidian's modal, so Obsidian's own stylesheet, iPadOS WebKit and the Pencil
are not covered.

There are no devtools on mobile, so the pad prints the version at the bottom of
its tool bar, and *Inkdown: Diagnostics* reports the plugin's state, including
the last conversion and how it went.

## Three hard invariants in the renderer

Stroke rendering has stepped on three landmines, each with a test
(see [rendering.md](rendering.md)):

1. **Winding must not cancel** — every subpath is wound the same way, so nonzero
   fill produces a union rather than an xor; otherwise the stroke grows holes
2. **Subpaths must not self-intersect** — a trapezoid is built from its own
   segment's normal, which makes it convex; using each endpoint's normal twists
   it into a bowtie at sharp turns, and the two lobes wind in opposite
   directions
3. **Coverage must equal the true stroke region** — a disc goes at every sample
   point; adding them only at large turns leaves visible wedge notches, because
   noise makes consecutive segment directions differ by more than 90 degrees
