# Inkdown

Write by hand on an iPad; get Markdown in your note.

Tap the pen in a note's header and a full-screen sheet of paper opens. Write a
proof, a formula, a little diagram. Tap **Convert**: the sheet closes, a
placeholder holds your spot at the cursor, and a few seconds later it is
replaced by what you wrote, as ordinary Markdown -- text in your own language,
maths as LaTeX (`$...$`, `$$...$$`), boxes-and-arrows drawings as Mermaid.

The ink itself is not kept. That is the point. Obsidian's strength is plain
text that every part of it understands -- search, links, backlinks, the graph,
sync, and every other app that opens the folder. A handwriting format of its
own, however carefully designed, sits outside all of that. Here handwriting is
only a way of typing: what reaches the vault is exactly what you would have
typed, had typing maths on a tablet not been so slow.

## Status

Used daily on one iPad with an Apple Pencil. Expect the interface to keep
moving.

| | |
|---|---|
| input | built around iPad and Apple Pencil. A mouse works on desktop. Other styluses go through standard Pointer Events and ought to work; none has been tried. |
| recognition | as good as the model reading it. Untidy handwriting and unusual notation can come back wrong, so read what lands before moving on. |
| reading view | has no cursor, so the result is added at the end of the note |

## Setting up

1. Install the plugin (below) and enable **Inkdown**.
2. In its settings, pick a service: **Claude** (the default), or
   **OpenAI-compatible**, which covers OpenAI and any service that speaks the
   same API -- give its address under *API address*.
3. Under *API key*, choose **Link...**, then **Add secret...**: give the secret
   any ID, such as `anthropic`, and paste your key as its value.

The key is kept in Obsidian's keychain on the device, not in the vault, so it
never travels with your notes through sync or into a backup. Each device that
converts needs the key once.

## Using it

- **Open the pad** from the pen button in the note's header, the editor's
  right-click / long-press menu, or the command *Handwrite at the cursor*.
  On an iPad the command can also go on the mobile toolbar
  (Settings -> Mobile).
- **Pen** writes, **a finger** scrolls and pinch-zooms. Zoomed all the way out
  the whole page is on screen; the page is one A4 sheet and does not grow.
- **Eraser**: the dial in the corner. Tap its centre to switch between eraser
  and pen; the upper half picks whole-stroke or precise erasing, the lower arc
  sets its size. Drag the dial anywhere.
- **Lasso**: circle ink to move it. Tap the ring for a delete button. A stroke
  only partly inside counts as inside.
- **Maths figures** -- the graph of a function, a geometric figure, a vector
  diagram -- are redrawn by Claude in Python (matplotlib) and inserted as an
  SVG, saved where Obsidian puts attachments and linked the way your vault
  links. Labels inside a figure stay in Latin letters and maths notation; the
  sandbox has no Chinese font. Flowcharts and other boxes-and-arrows drawings
  become Mermaid instead, and any other drawing a one-line description. With an
  OpenAI-compatible service every drawing is described. *Redraw maths figures*
  in the settings turns this off.
- **The AI pen**, under the pen, writes in violet: notes to the AI, never
  transcribed. Circle a part and write "skip this", ask for a table, say
  how to read a symbol, or ask a question, which is answered in a
  `> [!info]` callout at the end.
- **Mistakes are pointed out, never fixed.** What you wrote is transcribed as
  written, errors included. If a step looks wrong -- a slip in arithmetic, a
  sign, a step that does not follow -- a `> [!warning]` callout after the
  transcription says where and why. Nothing wrong, no callout. *Check for
  mistakes* in the settings turns this off.
- **Close** keeps what you wrote for the next time you open the pad, as does a
  conversion that fails. It is kept in memory only, so quitting Obsidian
  throws it away: it is scratch paper, not a file.
- **Convert** (Cmd+Enter on desktop) sends the page off and closes the pad. The
  note stays usable meanwhile: keep typing, switch notes, even close it -- the
  result goes wherever the placeholder has got to. If you deleted the
  placeholder, the result is shown in a window to copy instead of being lost.

## What is sent, and what it costs

Each conversion sends one PNG of the ink, cropped to what you wrote, plus up to
3,000 characters of the note before the cursor and 1,000 after it, so the model
can match your notation and language. Nothing else leaves the device, and
nothing is sent until you press Convert. A redrawn figure is drawn in
Anthropic's code-execution sandbox and downloaded from there; at personal-use
volumes that stays inside the free monthly hours.

With Claude Opus 5.5 a conversion costs on the order of one to three US cents;
Haiku is far cheaper and quicker, at some cost in accuracy on untidy writing.
Requests go to the provider directly with your own key.

## Installing

In Obsidian, open Settings -> Community plugins -> Browse, search for
**Inkdown**, then install and enable it.

To install by hand instead, take `main.js` and `manifest.json` from a
[release](../../releases) and drop them in
`<vault>/.obsidian/plugins/inkdown/`.

Requires Obsidian 1.11.4 or later, for the keychain.

**Coming from 0.16 or earlier**, which had a handwriting note type: those notes
are ordinary Markdown files and still open as such, with their text intact.
Their ink sat in an Obsidian comment (`%%ink ... %%`), which never renders, and
this version no longer draws it.

## Languages

English and Chinese, following Obsidian's display language, falling back to
the browser locale; anything that is not Chinese gets English. The setting can
also pin one. The diagnostics panel is deliberately left in English. The prompt
sent to the model is English either way and tells it to keep the language the
handwriting is in.

## Development

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
(see `docs/rendering.md`):

1. **Winding must not cancel** — every subpath is wound the same way, so nonzero
   fill produces a union rather than an xor; otherwise the stroke grows holes
2. **Subpaths must not self-intersect** — a trapezoid is built from its own
   segment's normal, which makes it convex; using each endpoint's normal twists
   it into a bowtie at sharp turns, and the two lobes wind in opposite
   directions
3. **Coverage must equal the true stroke region** — a disc goes at every sample
   point; adding them only at large turns leaves visible wedge notches, because
   noise makes consecutive segment directions differ by more than 90 degrees

## License

MIT, see [LICENSE](LICENSE).
