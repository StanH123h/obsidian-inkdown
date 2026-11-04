import { t } from "./i18n";
import { S } from "./styles";

/* The cards that tell of the Pencil on the note beside the pad: in the
 * hints' turned-round colours, a picture, a title and a line under it, and a
 * button. They stay until put away, a tap anywhere on them, as there is more
 * to read than in a passing hint.
 *
 * One is shown by the pad, on moving the note's caret with a finger (see
 * InkPad.showCaretHint); the other over the note, when Scribble keeps the
 * keyboard down (see scribbleHint). */

const NS = "http://www.w3.org/2000/svg";

function svgPart(tag: string, attrs: Record<string, string>, to: Element): Element {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	to.appendChild(e);
	return e;
}

/** The Pencil, its tip at the bottom left of a 24 box (the lucide icon) */
function pencil(svg: Element, transform: string) {
	const pen = svgPart("g", { transform, style: "fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;" }, svg);
	svgPart("path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", style: "fill:var(--text-normal, #222);" }, pen);
	svgPart("path", { d: "m15 5 4 4" }, pen);
}

/** The caret card's picture: lines of a note, its caret, and the Pencil's tip
 *  on it. In the card's colours, the caret in the stand-in caret's. */
export function caretPicture(parent: HTMLElement) {
	const svg = svgPart("svg", { width: "60", height: "60", viewBox: "0 0 60 60", style: "flex:0 0 auto;" }, parent);
	for (const [y, w] of [[12, 40], [26, 22], [40, 34]])
		svgPart("rect", { x: "4", y: String(y), width: String(w), height: "5", rx: "2.5", style: "fill:currentColor;opacity:.4;" }, svg);
	svgPart("rect", { x: "29", y: "22", width: "2.6", height: "13", rx: "1", style: "fill:var(--interactive-accent, #8a6cf0);" }, svg);
	pencil(svg, "translate(29.5 3) scale(1.3)");
}

/** The Scribble card's picture: a keyboard struck out, the Pencil on it */
export function keyboardPicture(parent: HTMLElement) {
	const svg = svgPart("svg", { width: "60", height: "60", viewBox: "0 0 60 60", style: "flex:0 0 auto;" }, parent);
	svgPart("rect", { x: "5", y: "20", width: "44", height: "24", rx: "4", style: "fill:none;stroke:currentColor;stroke-width:2.2;opacity:.4;" }, svg);
	for (const x of [10, 18, 26, 34])
		svgPart("rect", { x: String(x), y: "25", width: "5", height: "4", rx: "1", style: "fill:currentColor;opacity:.4;" }, svg);
	svgPart("rect", { x: "15", y: "35", width: "24", height: "4", rx: "1", style: "fill:currentColor;opacity:.4;" }, svg);
	svgPart("line", { x1: "7", y1: "48", x2: "47", y2: "16", style: "stroke:var(--text-error, #d64545);stroke-width:3;stroke-linecap:round;" }, svg);
	pencil(svg, "translate(31 1) scale(1.15)");
}

export interface HintCard {
	picture(parent: HTMLElement): void;
	title: string;
	sub: string;
	/** What to do, in bold beside the button, under a rule */
	line?: string;
	button: string;
	/** Put away, by a tap on it */
	onClose?(): void;
	/** Added to the card's look: where it sits, for one */
	style?: string;
}

/** A card in `parent`, which places it */
export function hintCard(parent: HTMLElement, c: HintCard): HTMLElement {
	const card = parent.createDiv({ attr: { style: S.card + (c.style ?? "") } });
	const head = card.createDiv({ attr: { style: S.cardHead } });
	c.picture(head);
	const words = head.createDiv();
	words.createDiv({ text: c.title, attr: { style: S.cardTitle } });
	words.createDiv({ text: c.sub, attr: { style: S.cardSub } });
	if (c.line) card.createDiv({ attr: { style: S.cardRule } });
	const foot = card.createDiv({ attr: { style: c.line ? S.cardFootRuled : S.cardFoot } });
	if (c.line) foot.createDiv({ text: c.line, attr: { style: S.cardLine } });
	foot.createEl("button", { text: c.button, attr: { style: S.cardOk } });
	card.addEventListener("pointerdown", (e: PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		card.remove();
		c.onClose?.();
	});
	return card;
}

/** Once: a finger tap on the note beside the pad brought up only Scribble's
 *  compact bar (see notetaps.ts). A card over the note, at its foot, says
 *  what it is and where to turn it off: just above Obsidian's tool bar and
 *  the compact bar under it, pointing down at them, and following the
 *  keyboard Obsidian reports, should that change. Returns the card, or null
 *  when it has been shown before.
 *  @param note  the note's leaf, on screen */
export function scribbleHint(plugin: { settings: { scribbleHintShown: boolean }; saveSettings(): Promise<void> }, doc: Document, note: DOMRect): HTMLElement | null {
	const s = plugin.settings;
	if (s.scribbleHintShown) return null;
	s.scribbleHintShown = true;
	void plugin.saveSettings();
	const card = hintCard(doc.body, {
		picture: keyboardPicture, title: t("hint.scribbleTitle"), sub: t("hint.scribbleSub"), line: t("hint.scribbleOff"), button: t("hint.gotIt"),
		style: S.scribbleCard,
	});
	card.prepend(card.createDiv({ attr: { style: S.cardNotchDown } }));
	const width = Math.min(400, note.width - 32);
	card.setCssProps({ width: width + "px", left: note.left + (note.width - width) / 2 + "px" });
	return card;
}
