# Obsidian Handwriting

A handwriting system for Obsidian. The goal is not "write by hand inside
Obsidian" but to make handwritten content **live inside Obsidian's semantics** —
wiki links, backlinks, the graph, global search and block references all keep
working on it.

## File format

A handwriting note is an **ordinary `.md` file**, identified by the
`handwriting` key in its frontmatter. Ink hides inside `%%ink ... %%`
(Obsidian's comment syntax, which never renders).

```markdown
---
handwriting: v1
---
# Organic Chemistry, Lecture 5

## regions
### reaction mechanism

## links
- [[SN2 reaction]]

%%ink
{"v":1,"w":1000,"strokes":[...],"items":[...],"regions":[...]}
%%
```

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

- Pressure-sensitive ink (Apple Pencil), one-euro filter and tip prediction to
  cut perceived latency
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

MIT
