import { EditorView } from "@codemirror/view";

/* The note beside the pad, as the Pencil and a finger use it.
 *
 * A Pencil tap on the note only moves its caret: the note is not focused,
 * so the keyboard stays down, and the stand-in caret (see ghost.ts) shows
 * where the next page goes. A finger tap is left to the note, which brings
 * the keyboard up for typing. iPadOS focuses the note on a tap of its own,
 * once the touch ends, so the Pencil's tap is kept from it there: its
 * touchend is cancelled, and in a browser that sends the mousedown first,
 * that too.
 *
 * Someone who goes from the pad to the note with a finger, moves the caret,
 * types nothing and comes back to the pad came only to move the caret: the
 * keyboard came up for nothing. That is the moment to show that the Pencil
 * does it without the keyboard (see InkPad.showCaretHint).
 *
 * With Scribble on, once the Pencil has touched text, iPadOS gives only its
 * compact bar for typing, however the note is tapped after, and no plugin
 * can lift that. It is seen in the keyboard Obsidian reports, short and with
 * no keyboard attached: the moment to say what it is. */

/** How far a tap may wander, in css px, and how long it may be held, in ms */
const TAP_MOVE = 12;
const TAP_HOLD = 600;
/** The tallest a keyboard Obsidian reports can be and still be Scribble's
 *  compact bar, about 70 on an iPad, in css px; the full keyboard is over 300 */
const COMPACT_BAR = 150;

/** Things on a note's page a tap is meant for, rather than the text: left alone */
const ACTIVE = "a, button, input, select, textarea, label, [contenteditable='false'], " +
	".cm-hmd-internal-link, .cm-link, .cm-url, .internal-link, .external-link, " +
	".task-list-item-checkbox, .cm-fold-indicator, .collapse-indicator, .markdown-embed, .cm-embed-block, .math, " +
	".inline-title, .metadata-container, .cm-gutters, .embedded-backlinks";

/** The editor whose page an element is on: its text, or the space around
 *  it, as below the last line, where a tap goes to the end
 *  @param page  what a note's scrolling page is, in this host */
export function editorAt(el: Element, page: string): EditorView | null {
	const text = el.closest(page)?.querySelector(".cm-content");
	return text instanceof HTMLElement ? EditorView.findFromDOM(text) : null;
}

export interface NoteTapsHost {
	/** Whether the pad is beside a note now, on a touch screen */
	active(): boolean;
	/** The pad's pane: a touch there is a return to the pad */
	pad(): HTMLElement | null;
	/** The note's editor an element is on the page of, if any (see editorAt) */
	noteAt(el: Element): EditorView | null;
	/** The editor of the note the next page goes into */
	target(): EditorView | null;
	/** Make this editor's note the one the next page goes into */
	retarget(view: EditorView): void;
	/** A trip to the note made only to move the caret, by finger */
	cameForCaret(): void;
	/** The note focused, and Scribble's compact bar up instead of the keyboard */
	keyboardStuck(): void;
}

export class NoteTaps {
	/** The Pencil down on a note, for telling a tap from a scroll. Kept until
	 *  the next press: iOS sends the touchend and the pointerup in either
	 *  order, and both want it. */
	private pen: { view: EditorView; x: number; y: number; t: number; touched: boolean; tapped: number | null } | null = null;
	/** Whether the last press anywhere was on the pad */
	private onPad = false;
	/** A finger gone from the pad to the note: where the page was going
	 *  before, and whether anything has been typed since */
	private away: { view: EditorView | null; anchor: number; head: number; typed: boolean } | null = null;

	constructor(private host: NoteTapsHost) {}

	/** For every note's editor: typing on the trip means it was for typing */
	readonly extension = EditorView.updateListener.of((u) => {
		if (u.docChanged && this.away) this.away.typed = true;
	});

	/** Listen on the whole document, ahead of the note and the pad.
	 *  Returns the way to stop. */
	attach(doc: Document): () => void {
		const opts = { capture: true, passive: false };
		const on: [string, EventListener][] = [
			["pointerdown", (e) => this.down(e as PointerEvent)],
			["mousedown", (e) => this.mouseDown(e as MouseEvent)],
			["touchend", (e) => this.touchEnd(e as TouchEvent)],
			["pointerup", (e) => this.up(e as PointerEvent)],
			["focusin", (e) => this.focusIn(e as FocusEvent)],
		];
		for (const [type, fn] of on) doc.addEventListener(type, fn, opts);
		// Obsidian's own, on the window, as the keyboard comes up
		const win = doc.defaultView, kb = (e: Event) => this.keyboard(e, doc);
		win?.addEventListener("keyboardWillShow", kb);
		return () => {
			for (const [type, fn] of on) doc.removeEventListener(type, fn, opts);
			win?.removeEventListener("keyboardWillShow", kb);
		};
	}

	private down(e: PointerEvent) {
		this.pen = null;
		if (!this.host.active()) { this.onPad = false; this.away = null; return; }
		const el = e.target instanceof Element ? e.target : null;
		const wasOnPad = this.onPad;
		this.onPad = false;
		if (!el) return;
		if (this.host.pad()?.contains(el)) { this.back(); this.onPad = true; return; }
		const view = this.host.noteAt(el);
		// Anywhere else, the keyboard's own bar say, a trip goes on
		if (!view) return;
		if (e.pointerType === "pen") {
			if (!el.closest(ACTIVE)) this.pen = { view, x: e.clientX, y: e.clientY, t: e.timeStamp, touched: false, tapped: null };
			return;
		}
		if (wasOnPad && !this.away) {
			const to = this.host.target(), sel = to?.state.selection.main;
			this.away = { view: to, anchor: sel?.anchor ?? -1, head: sel?.head ?? -1, typed: false };
		}
	}

	/** Where the mousedown comes before the Pencil lifts, it would focus the
	 *  note: kept from it. On iOS it comes after the touchend, if at all. */
	private mouseDown(e: MouseEvent) {
		const p = this.pen;
		if (p && !p.touched && e.target instanceof Node && p.view.scrollDOM.contains(e.target)) e.preventDefault();
	}

	private touchEnd(e: TouchEvent) {
		const p = this.pen, t = e.changedTouches[0];
		if (!p || !t) return;
		p.touched = true;
		if (this.isTap(p, t.clientX, t.clientY, e.timeStamp)) e.preventDefault();
	}

	private up(e: PointerEvent) {
		const p = this.pen;
		if (!p || e.pointerType !== "pen" || !this.isTap(p, e.clientX, e.clientY, e.timeStamp)) return;
		const view = p.view, pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos == null) return;
		p.tapped = e.timeStamp;
		// The keyboard goes with the focus, if the note had it
		if (view.hasFocus) view.contentDOM.blur();
		// The editor puts its selection on the page too, and a browser may
		// focus the note for that, when the page's selection is already in
		// the note or the change comes from a pointer: neither, then
		const sel = view.dom.ownerDocument.getSelection();
		if (sel?.anchorNode && view.contentDOM.contains(sel.anchorNode)) sel.removeAllRanges();
		view.dispatch({ selection: { anchor: pos }, userEvent: "select" });
		if (this.host.target() !== view) this.host.retarget(view);
		this.away = null;
	}

	/** Should anything focus the note on the Pencil's tap all the same, it
	 *  is let go of at once, keyboard and all */
	private focusIn(e: FocusEvent) {
		const p = this.pen;
		if (p?.tapped != null && e.target === p.view.contentDOM && e.timeStamp - p.tapped < 500) p.view.contentDOM.blur();
	}

	/** The keyboard coming up, as Obsidian reports it: only the compact bar,
	 *  with none attached, for the note beside the pad. Not a trip to move
	 *  the caret then: there was no keyboard to come up for nothing. */
	private keyboard(e: Event, doc: Document) {
		const k = e as Event & { keyboardHeight?: unknown; hasPhysicalKeyboard?: unknown };
		const h = typeof k.keyboardHeight === "number" ? k.keyboardHeight : 0;
		if (!this.host.active() || k.hasPhysicalKeyboard === true || h <= 0 || h >= COMPACT_BAR) return;
		const at = doc.activeElement;
		const view = at ? this.host.noteAt(at) : null;
		if (!view || at !== view.contentDOM) return;
		this.away = null;
		this.host.keyboardStuck();
	}

	private isTap(p: { x: number; y: number; t: number }, x: number, y: number, t: number) {
		return Math.hypot(x - p.x, y - p.y) <= TAP_MOVE && t - p.t <= TAP_HOLD;
	}

	/** Back on the pad from a trip to the note: was it only to move the caret? */
	private back() {
		const a = this.away;
		this.away = null;
		if (!a || a.typed) return;
		const to = this.host.target(), sel = to?.state.selection.main;
		if (!to || !sel) return;
		if (to === a.view && sel.anchor === a.anchor && sel.head === a.head) return;
		this.host.cameForCaret();
	}
}
