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

What you wrote stays as you wrote it; a warning under it says what looks wrong
and why.

![(a + b)² = a² + b², transcribed as written, with a warning that the cross term 2ab is missing](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/check.png)

### Two pens: one for your content, one for talking to the AI

![The pad's tool bar has two pens: the Pen, for content the AI transcribes, and the AI pen, for instructions and questions written to the AI, never transcribed](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/two-pens.png)

What you write with the **Pen** is your content, and the AI transcribes it.
What you write with the **AI pen** (violet) the AI knows is written to it, so
you can annotate the page freely and none of it is mistaken for your content.
There are two ways to use it.

**Tell it what to do with what you wrote**, such as "make this a table",
"skip this" or "this symbol is ξ":

![Values with "make this a table" written under them with the AI pen, and the Markdown table they became](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/ai-pen.png)

**Ask a question on the side**: write "btw, ..." and the answer comes back in
a callout under the result.

![f(x) = (x − 2)² − 1, with "btw, why does this mean the minimum is −1?" written with the AI pen; the note gets the formula, and the answer in a callout under it](https://raw.githubusercontent.com/StanH123h/obsidian-inkdown/main/docs/images/question.png)

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
