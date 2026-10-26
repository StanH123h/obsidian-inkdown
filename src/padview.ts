import { ItemView, Notice, Scope, WorkspaceLeaf } from "obsidian";
import { InkPad } from "./pad";
import { PANE, S } from "./styles";
import { t } from "./i18n";
import type HandwritingPlugin from "./main";

export const PAD_VIEW = "inkdown-pad";

/** The pad in a pane beside the note, so the note stays in view while writing.
 *
 *  Converting leaves it open: the page goes into the note last worked in, at
 *  its cursor, and a clean page takes its place. Closing the pane keeps the
 *  page as a draft; swapping hands the pad itself on, to be shown over the
 *  whole screen. */
export class PadView extends ItemView {
	/** This pane's own layer of shortcuts. Obsidian puts it on top while the
	 *  pane is the active one, so undo here undoes ink, and in the note, typing. */
	private shortcuts: Scope;
	private pad: InkPad | null = null;
	private label: HTMLDivElement | null = null;
	private swapping = false;

	constructor(leaf: WorkspaceLeaf, private plugin: HandwritingPlugin) {
		super(leaf);
		this.shortcuts = this.scope = new Scope(this.app.scope);
	}

	getViewType() { return PAD_VIEW; }
	getDisplayText() { return t("view.title"); }
	getIcon() { return "pen-tool"; }

	async onOpen() {
		const el = this.contentEl;
		el.empty();
		for (const [k, v] of Object.entries(PANE)) el.style.setProperty(k, v, "important");
		const pad = this.pad = this.plugin.receivePad();
		pad.mount(el, {
			scope: this.shortcuts,
			close: () => this.leaf.detach(),
			convert: () => {
				const note = this.plugin.target();
				// Nowhere to put it: the page stays, nothing is lost
				if (!note?.file) { new Notice(t("notice.noNote")); return; }
				void this.plugin.convert(note, note.file, pad.takePage());
			},
			swap: {
				to: "full",
				go: () => { this.swapping = true; this.leaf.detach(); },
			},
		});
		this.label = el.createDiv({ attr: { style: S.target } });
		this.showTarget();
	}

	async onClose() {
		const pad = this.pad;
		if (!pad) return;
		this.pad = null;
		const strokes = pad.unmount();
		if (!this.swapping) { this.plugin.padClosed(strokes); return; }
		this.plugin.settings.padMode = "full";
		void this.plugin.saveSettings();
		this.plugin.showFull(pad);
	}

	/** Which note the page will go into. The plugin calls this when that changes. */
	showTarget() {
		const note = this.plugin.target();
		this.label?.setText(note?.file ? t("view.target", note.file.basename) : t("view.noTarget"));
	}
}
