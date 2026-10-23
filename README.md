# Inkdown

Write by hand on an iPad; get Markdown in your note.

![A derivation written by hand on the pad; after Convert it is in the note as LaTeX](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/hero.gif)

What lands is plain Markdown: text in your language, maths as LaTeX, drawings
as Mermaid or SVG. The ink is not kept.

## How to use

![1. Tap the pen at the top right of the note. 2. Write, then tap Convert at the bottom of the tool bar. 3. The Markdown appears at your cursor.](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/how-to.png)

The pad also opens from the editor's right-click / long-press menu and the
command *Handwrite at the cursor*.

## What it reads

### Graphs become an SVG

![A parabola sketched by hand, and the SVG it became](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/graph.png)

### Diagrams become Mermaid

![A small neural network drawn by hand, and the Mermaid diagram it became](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/diagram.png)

### Mistakes are flagged, never fixed

![(a + b)² = a² + b², transcribed as written, with a warning that the cross term 2ab is missing](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/check.png)

### The AI pen talks to the AI

Write in violet to ask for a table, say what to skip, or ask a question. It is
never transcribed.

![A row of values with "make this a table" written under it in violet, and the Markdown table it became](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/ai-pen.png)

## Setting up

1. Settings -> Community plugins -> Browse: install and enable **Inkdown**.
2. In its settings, pick **Claude** or an **OpenAI-compatible** service.
3. Under *API key*: **Link...** -> **Add secret...**, and paste your key.

The key stays in Obsidian's keychain on the device, never in the vault.
Requires Obsidian 1.11.4 or later.

## Privacy and cost

- Only when you tap Convert, one image of the ink and a little of the note
  around the cursor go to the provider, with your own key.
- With Claude Opus 5.5 a page costs one to three US cents.
- The only clipboard use is a Copy button, shown if you delete a placeholder
  before its result arrives.

## Good to know

- Built for the iPad and Apple Pencil; a mouse works on desktop.
- Recognition is as good as the model, so read what lands.
- With an OpenAI-compatible service, drawings are described in words.
- English and Chinese, following Obsidian's language.

[Development notes](docs/development.md) · MIT [license](LICENSE)
