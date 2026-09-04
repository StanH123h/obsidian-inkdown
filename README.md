# Inklink

Handwriting for Obsidian, built around one idea: **ink should be addressable.**
Lasso any part of a page, give it a name, and `[[note#that name]]` now points at
it — from another handwriting note, from an ordinary document, from anywhere.
`![[note#that name]]` draws it.

The goal is not "write by hand inside Obsidian" but to make handwritten content
**live inside Obsidian's semantics** — wiki links, backlinks, the graph, global
search and block references all keep working on it. Several plugins already let
you draw in Obsidian; the point here is that what you drew participates in the
vault rather than sitting on top of it.

## Status: beta

This is a **public beta**, not a finished release. It is used daily on an iPad
with an Apple Pencil and the features below all work, but it has not been
through Obsidian's community plugin review, and it has been tested by one
person on one device.

What that means in practice:

- **The notes stay readable without this plugin.** A handwriting note is an
  ordinary markdown file: frontmatter, title, region headings and links are all
  plain text, and only the ink is a compressed blob inside an Obsidian comment.
  Nothing is locked inside a proprietary container.
- **The ink format may still change.** It is versioned and older files are
  migrated when opened -- v1 files already are -- but that path has not been
  stress-tested across many versions yet. Back up a vault you care about before
  putting a term's notes into it.
- **Expect bugs, and expect the interface to keep moving.**

Known limitations in this release:

| | |
|---|---|
| memory | the whole note stays resident; past roughly twenty dense pages it gets heavy. Split long notes for now. |
| text boxes | designed for, not implemented |
| lasso | selecting, dragging and deleting work; resizing does not |
| input | built around iPad and Apple Pencil. A mouse works on desktop. |
| other styluses | should work and are unverified: input goes entirely through standard Pointer Events (`pointerType`, `pressure`, `getCoalescedEvents`), with no platform check anywhere in the path. Surface Pen, Wacom and S Pen ought to behave; none has been tried. |
| platform | tested on iPadOS only |

## Installing the beta

It is not in the community plugin list yet, so install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Settings -> Community plugins.
2. Run the command *BRAT: Add a beta plugin for testing* and paste this
   repository's path, `OWNER/obsidian-inklink`.
3. Enable **Handwriting** under Community plugins.

BRAT picks up later beta releases on its own.

To install by hand instead, take `main.js` and `manifest.json` from a
[release](../../releases) and drop them in
`<vault>/.obsidian/plugins/inklink/`.

## File format

A handwriting note is an **ordinary `.md` file**, identified by the
`handwriting` key in its frontmatter. Ink hides inside `%%ink ... %%`
(Obsidian's comment syntax, which never renders).

```markdown
---
handwriting: v1
---
# Organic Chemistry, Lecture 5

## Regions
### reaction mechanism

## Links
- [[SN2 reaction]]

%%ink
{"v":2,"w":1000,"items":[...],"regions":[...],"z":"eJx1kMFqw..."}
%%
```

Ink sits in `z`: coordinates quantised to tenths of a page unit, stored as deltas
from the previous point, deflated and base64'd. Measured on a full page of dense
Chinese handwriting that is **6.3x smaller** than storing the numbers as text,
with no loss -- the previous format already rounded to the same grid.

Everything else stays plain: the title, the region headings that `[[note#area]]`
resolves against, and the links. That is what Obsidian indexes and what anyone
reading the file is actually after; nobody reads two megabytes of coordinates.
Every other app in this space compresses too -- Xournal++ gzips its XML, Rnote
gzips its JSON, the JOT spec stores 4/8/16-bit coordinate deltas.

The frontmatter key is `handwriting`, not `inklink`, and stays that way. It
records **what the file is**, not which plugin wrote it — a note keeps meaning
the same thing if this plugin is renamed again, or if something else learns to
read the format.

Files in the older unpacked format still open, and are rewritten packed on the
next save.

The `## regions` and `## links` sections are generated on save. They translate
what is on the canvas into a form Obsidian understands: regions become headings
(so `[[this file#region name]]` resolves, autocompletes and shows up in
backlinks), and canvas links become real links (so backlinks and the graph pick
them up).

Plain `.md` rather than a compound `.hw.md` suffix, because Obsidian reads such
a file's basename as `BBB.hw` — only the final `.md` counts as the extension.
The damage is not limited to `[[BBB]]` failing to resolve: `BBB.hw` then shows
up throughout the file list, link autocomplete, search results and graph nodes.
Worse, `BBB.md` and `BBB.hw.md` can coexist as two distinct files, and
"filenames are unique" is exactly the guarantee the `[[file#region]]` addressing
scheme rests on. Staying native has a second benefit: whatever Obsidian adds
later works here without adapting anything to a custom suffix.

Older `.hw.md` files are still recognised by path. The command palette has
*migrate: rename .hw.md to .md*, which goes through `fileManager.renameFile` so
links to those files are updated automatically.

## Design principle: no nesting

**Own content renders, references do not. One level deep.**

Embedding a region (`![[note#region name]]`) renders only that note's **own
content**:

| | |
|---|---|
| ink | rendered |
| text boxes (planned) | rendered |
| regions nested inside it | not rendered |
| wiki links pointing elsewhere | not rendered |

The line is not "text vs graphics" but **"is this the note's own content, or a
reference to somewhere else"**. A text box will be its own content and gets
rendered; a wiki link is a reference and does not, whatever it happens to
display.

**A wiki link on the canvas may only point at handwriting** — another
handwriting note, or one of its regions — never at an ordinary markdown
document. The canvas then always shows things that were drawn, and never
becomes a container that nests rendered documents.

The direction is deliberately asymmetric:

- ordinary document → handwriting: **allowed** (`![[note#region]]`, rendered by
  the markdown post-processor)
- handwriting canvas → handwriting: **allowed** (canvas wiki-link items)
- handwriting canvas → ordinary document: **not allowed**

Handwriting-to-handwriting references cannot form chains either: an embed
renders only the target's ink, not the wiki-link items on the target's own
canvas. Every reference expands exactly one level.

Together this keeps references from forming chains or cycles, and stops a
distant edit from silently changing what is displayed here. A region is a
**leaf** on the canvas, not a branch.

## Languages

English and Chinese. Which one is used follows Obsidian's display language,
falling back to the browser locale; anything that is not Chinese gets English.
The setting can also pin one explicitly.

Two things deliberately do not follow the UI language: the diagnostics panel,
which is a debugging tool rather than a feature, and the `## Regions` /
`## Links` sections generated into notes, which stay in English so a file means
the same thing whoever opens it.

## Features

- Pressure-sensitive ink (Apple Pencil), distance-domain smoothing and tip
  prediction to cut perceived latency
- Lasso a piece of content and name it; elsewhere `![[note#region name]]` embeds
  that ink directly
- Wiki-link items on the canvas that can display the target handwriting inline
- Multiple pages (one blank page is always kept), scrolling, pinch zoom
- Pen writes, finger manipulates; palm contact is ignored while the pen is down

## Development

```bash
npm install
npm run dev     # esbuild watch; output is deployed per .dev-targets
npm run build
npm test
```

`.dev-targets` holds one Obsidian plugin directory per line and is not tracked.
After cloning on a new machine, recreate it, otherwise `npm run build` will
build without deploying.

There are no devtools on mobile, so: **bump the version in `manifest.json` on
every change** — the toolbar prints `v0.x.y` at the bottom — and use the
*Handwriting: diagnostics* command, which reports runtime state.

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
