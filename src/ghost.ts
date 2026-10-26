import { StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { S } from "./styles";

/* A stand-in caret, for the note the pad beside it writes into.
 *
 * Writing on the pad takes the focus, and a note without the focus hides its
 * caret. The position is still there in its selection, and that is where the
 * next page goes in, so while the pad is open beside the note this draws a
 * caret of its own there. Clicking back into the note brings the real one
 * back and this one goes. */

/** Carries no change; dispatched only to have the editor look again */
const look = StateEffect.define<null>();

class Ghost extends WidgetType {
	eq() { return true; }
	toDOM() {
		const el = document.createElement("span");
		// Named for themes and tests; the look itself is inline, as everywhere
		el.className = "inkdown-ghost-caret";
		el.setAttribute("style", S.ghostCaret);
		return el;
	}
	ignoreEvent() { return true; }
}
const GHOST = Decoration.widget({ widget: new Ghost(), side: 1 });

interface Shown { view: EditorView; at: number | null; where(): number | null }
/** Every editor with the extension, to look again when the pad opens or
 *  closes, or the note it writes into changes: nothing in the editor itself
 *  changes then */
const editors = new Set<Shown>();

/** @param wanted  whether this editor is the one the pad writes into */
export function ghostCaret(wanted: (view: EditorView) => boolean) {
	return ViewPlugin.fromClass(class implements Shown {
		decorations: DecorationSet = Decoration.none;
		at: number | null = null;
		constructor(readonly view: EditorView) {
			editors.add(this);
			this.place();
		}
		// Focus, selection and text all change where it goes or whether it shows
		update() { this.place(); }
		destroy() { editors.delete(this); }
		/** The end of the selection, where the page goes in; nowhere while the
		 *  note has its own caret */
		where() {
			return !this.view.hasFocus && wanted(this.view) ? this.view.state.selection.main.to : null;
		}
		place() {
			this.at = this.where();
			this.decorations = this.at == null ? Decoration.none : Decoration.set([GHOST.range(this.at)]);
		}
	}, { decorations: (p) => p.decorations });
}

let queued = false;
/** Have every editor look again, after whatever is happening now: these come
 *  from workspace events, which can fire in the middle of an editor update */
export function refreshGhosts() {
	if (queued) return;
	queued = true;
	queueMicrotask(() => {
		queued = false;
		for (const e of editors) if (e.where() !== e.at) e.view.dispatch({ effects: look.of(null) });
	});
}
