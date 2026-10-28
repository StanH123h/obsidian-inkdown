import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, editorInfoField } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { InkPad, PadMode, PadModal, ToolbarSide } from "./pad";
import { PAD_VIEW, PadView } from "./padview";
import { ghostCaret, refreshGhosts } from "./ghost";
import { InkOpts, Stroke, rasterize } from "./ink";
import {
	CLAUDE_MODELS, CONTEXT_AFTER, CONTEXT_BEFORE, DEFAULT_OPENAI_BASE, DEFAULT_OPENAI_MODEL, Engine, IMAGE_EDGE,
	Figure, Provider, Surroundings, cursorAfter, fitInsertion, placeFigures, recognize,
} from "./transcribe";
import { detectLang, setLang, t } from "./i18n";
import { SIZE_MAX, SIZE_MIN } from "./dial";

/** Injected by esbuild at build time; see esbuild.config.mjs */
declare const __HW_BUILD__: string;

export interface HandwritingSettings {
	language: string;    // "auto", "en" or "zh"
	provider: Provider;
	/** Keychain entries, by id. The keys themselves never enter data.json, which
	 *  sits in the vault and travels wherever the vault is synced. */
	anthropicSecret: string;
	openaiSecret: string;
	anthropicModel: string;
	openaiModel: string;
	openaiBaseUrl: string;
	/** Claude redraws maths figures with Python; see transcribe.ts */
	redrawFigures: boolean;
	/** Point out what looks wrong, in a callout after the transcription */
	checkWork: boolean;
	sizes: number[];     // the three pen widths on the toolbar, in page units
	eraserMode: string;  // "stroke" removes a whole stroke, "precise" only what it touches
	eraserSize: number;  // eraser radius in page units
	smooth: number;      // input streamlining, 0..0.9
	thin: number;        // how much pressure affects width, 0..1
	taper: number;       // 0 = off, 1 = subtle
	filter: number;      // 0 = exponential smoothing, 1 = one-euro filter
	curve: number;       // 0 = straight between samples, 1 = spline
	predict: number;     // frames of tip prediction, 0 = off
	lowLatency: boolean; // desynchronized canvas hint
	allowFinger: boolean;
	/** Where the eraser dial sits on the canvas, in pixels; -1 = never moved */
	dialX: number;
	dialY: number;
	/** How the pad opens: the way it was last used, set by its own button.
	 *  Beside the note until changed; a phone always has it full screen. */
	padMode: PadMode;
	/** Which edge the tool bar floats by, wherever the pad is shown. A narrow
	 *  pad has room for a row only: top stays top, the rest go to the foot. */
	toolbarSide: ToolbarSide;
	/** Whether the hint on moving the tool bar has done its job: shown until
	 *  the tool bar has been moved, or the hint tapped */
	toolbarHintSeen: boolean;
	/** Whether the two-finger tap for undo, and the three-finger one for redo,
	 *  have been shown: once each, on the first press of the button by hand.
	 *  Not skipped for having used the tap, which a stray touch also does. */
	undoTapShown: boolean;
	redoTapShown: boolean;
}

const DEFAULT_SETTINGS: HandwritingSettings = {
	language: "auto",
	provider: "anthropic",
	anthropicSecret: "",
	openaiSecret: "",
	anthropicModel: CLAUDE_MODELS[0].id,
	openaiModel: DEFAULT_OPENAI_MODEL,
	openaiBaseUrl: DEFAULT_OPENAI_BASE,
	redrawFigures: true,
	checkWork: true,
	sizes: [4, 8, 14],
	eraserMode: "stroke",
	eraserSize: 14,
	smooth: 0.85,
	thin: 0.70,
	taper: 0,
	filter: 1,
	curve: 1,
	predict: 1,
	lowLatency: true,
	allowFinger: false,
	dialX: -1,
	dialY: -1,
	padMode: "split",
	toolbarSide: "right",
	toolbarHintSeen: false,
	undoTapShown: false,
	redoTapShown: false,
};

export default class HandwritingPlugin extends Plugin {
	settings: HandwritingSettings = DEFAULT_SETTINGS;

	/** The pad as it was last closed without converting, with its page, undo
	 *  history and view, to carry on with where it was left; or one holding a
	 *  failed conversion's page. Memory only: it is scratch paper, not a
	 *  document, and keeping it out of the vault is the whole idea. */
	private parked: InkPad | null = null;
	private inFlight = 0;
	/** The placeholders of conversions still out. An answer finds its own by
	 *  its text, so no two may read the same, as two sent within one second
	 *  otherwise would. */
	private markers = new Set<string>();
	/** The last conversion, for the diagnostics panel */
	private last: Record<string, string> = {};
	/** What the pad measured the last time it was open */
	padReport: Record<string, string> = {};
	/** The Markdown note last worked in: where a page from the pane goes */
	private lastNote: MarkdownView | null = null;
	/** A pad on its way into a pane */
	private handoff: InkPad | null = null;
	/** The pad on screen, in either host, for a failed conversion to come
	 *  back to. There is never more than one. */
	private shown: InkPad | null = null;
	/** Whether that pad is in a pane, beside the note it writes into */
	private inPane = false;

	/** The pen button in each note's header, per view. A view can re-render
	 *  its header and drop the button without saying so. */
	private headerBtns = new Map<MarkdownView, HTMLElement>();

	async onload() {
		await this.loadSettings();
		this.applyLang();

		this.addCommand({
			id: "open-pad",
			name: t("cmd.open"),
			icon: "pen-tool",
			editorCallback: (_editor, ctx) => {
				if (ctx instanceof MarkdownView) this.openPad(ctx);
			},
		});

		this.addCommand({
			id: "diagnostics",
			name: t("cmd.diagnostics"),
			callback: () => {
				// The panel has to open even when gathering the state is what broke:
				// a command that silently does nothing is the worst outcome here
				let data: Record<string, string>;
				try { data = this.collectDiagnostics(); }
				catch (e) { data = { "collect failed": (e as Error)?.stack ?? String(e) }; }
				new DiagModal(this.app, data).open();
			},
		});

		this.addRibbonIcon("pen-tool", t("cmd.open"), () => {
			// With the pane active, the note beside it is the one meant
			const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.target();
			if (view) this.openPad(view);
			else new Notice(t("notice.noNote"));
		});

		this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, view) => {
			if (!(view instanceof MarkdownView)) return;
			menu.addItem((item) => item
				.setTitle(t("cmd.open"))
				.setIcon("pen-tool")
				.onClick(() => this.openPad(view)));
		}));

		// On an iPad the ribbon is tucked away in a drawer and the command palette
		// is a keyboard affair, so every note gets a pen in its header too
		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncHeaderButtons()));

		this.registerView(PAD_VIEW, (leaf) => new PadView(leaf, this));
		// A page from the pane goes into the note last worked in. Tapping the
		// pane itself, or any view that is not a note, leaves that unchanged.
		const noteChanged = () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) this.lastNote = view;
			this.showTargets();
		};
		this.registerEvent(this.app.workspace.on("active-leaf-change", noteChanged));
		this.registerEvent(this.app.workspace.on("file-open", noteChanged));
		this.registerEditorExtension(ghostCaret((view) => this.writesInto(view)));

		this.app.workspace.onLayoutReady(() => { this.syncHeaderButtons(); noteChanged(); });

		this.addSettingTab(new HandwritingSettingTab(this.app, this));
	}

	onunload() {
		for (const btn of this.headerBtns.values()) btn.remove();
		this.headerBtns.clear();
	}

	private syncHeaderButtons() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			if (this.headerBtns.get(view)?.isConnected) continue;
			this.headerBtns.set(view, view.addAction("pen-tool", t("cmd.open"), () => this.openPad(view)));
		}
		for (const [view, btn] of this.headerBtns)
			if (!view.containerEl?.isConnected) { btn.remove(); this.headerBtns.delete(view); }
	}

	/* ============ The pad ============ */

	private openPad(view: MarkdownView) {
		if (!view.file) { new Notice(t("notice.noNote")); return; }
		this.lastNote = view;
		this.showTargets();
		// One pad at a time: a pane already open is brought forward
		const open = this.app.workspace.getLeavesOfType(PAD_VIEW)[0];
		if (open) { void this.app.workspace.revealLeaf(open); return; }
		const pad = this.takePad();
		if (this.settings.padMode === "split" && !Platform.isPhone) this.showSplit(pad);
		else this.showFull(pad);
	}

	/** The pad over the whole screen. Its page goes into the note it opens
	 *  over, the one last worked in. A phone gets no button to move it to a
	 *  pane: it has no split view. */
	showFull(pad: InkPad) {
		const view = this.target(), file = view?.file;
		this.shown = pad;
		this.inPane = false;
		this.showTargets();
		const toPane = Platform.isPhone ? undefined : () => {
			this.settings.padMode = "split";
			void this.saveSettings();
			this.showSplit(pad);
		};
		new PadModal(this.app, pad, (exit) => {
			this.shown = null;
			if (!exit.convert) this.parked = pad;
			else if (view && file) void this.convert(view, file, exit.strokes);
			else { this.parked = pad; new Notice(t("notice.noNote")); }
		}, toPane).open();
	}

	/** The pad in a pane beside the active note. The pane takes it up through
	 *  receivePad() once Obsidian has made it. */
	private showSplit(pad: InkPad) {
		this.handoff = pad;
		this.shown = pad;
		void this.app.workspace.getLeaf("split", "vertical").setViewState({ type: PAD_VIEW, active: true });
	}

	/** The pad for a pane that is opening: the one being moved into it, or the
	 *  parked one when Obsidian reopens the pane by itself, as it does at
	 *  startup when the pane was open before */
	receivePad(): InkPad {
		const pad = this.handoff ?? this.takePad();
		this.handoff = null;
		this.shown = pad;
		this.inPane = true;
		this.showTargets();
		return pad;
	}

	/** A pane was closed: its pad is parked, for next time */
	padClosed(pad: InkPad) {
		this.shown = null;
		this.inPane = false;
		this.parked = pad;
		this.showTargets();
	}

	/** The pad to open: the one left parked, back to the pen, or a clean one */
	private takePad(): InkPad {
		const pad = this.parked ?? new InkPad(this, []);
		this.parked = null;
		pad.takeUpPen();
		return pad;
	}

	/** Where a page from the pane goes: the Markdown note last worked in, as
	 *  long as it is still open */
	target(): MarkdownView | null {
		const view = this.lastNote;
		return view?.file && view.containerEl.isConnected ? view : null;
	}

	/** Whether a note's editor is the one the pane's page goes into, and so
	 *  shows where it goes in (see ghost.ts) */
	private writesInto(view: EditorView): boolean {
		return this.inPane && view.state.field(editorInfoField, false) === this.target();
	}

	/** Show where the pane's page goes: on the pane, by name, and in the note,
	 *  with the stand-in caret */
	private showTargets() {
		for (const leaf of this.app.workspace.getLeavesOfType(PAD_VIEW))
			if (leaf.view instanceof PadView) leaf.view.showTarget();
		refreshGhosts();
	}

	/** Why converting cannot start, or null when it can */
	convertBlocker(): string | null {
		return this.apiKey() ? null : t("notice.noKey");
	}

	private apiKey(): string {
		const s = this.settings;
		const id = s.provider === "openai" ? s.openaiSecret : s.anthropicSecret;
		return id ? this.app.secretStorage.getSecret(id) ?? "" : "";
	}

	private engine(): Engine {
		const s = this.settings;
		return s.provider === "openai"
			? { provider: "openai", model: s.openaiModel.trim() || DEFAULT_OPENAI_MODEL, apiKey: this.apiKey(), baseUrl: s.openaiBaseUrl, figures: false, check: s.checkWork }
			: { provider: "anthropic", model: s.anthropicModel, apiKey: this.apiKey(), baseUrl: "", figures: s.redrawFigures, check: s.checkWork };
	}

	opts(): InkOpts {
		const s = this.settings;
		return { smooth: s.smooth, thin: s.thin, taper: s.taper, filter: s.filter, curve: s.curve };
	}

	/** The request takes a few seconds, and the note stays usable meanwhile: a
	 *  placeholder holds the spot, and the result replaces it wherever it has
	 *  moved to by then. Typing above it, switching notes or closing this one
	 *  are all fine. */
	async convert(view: MarkdownView, file: TFile, strokes: Stroke[]) {
		const cv = rasterize(strokes, this.opts(), IMAGE_EDGE);
		if (!cv) return;
		const png = cv.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
		const d = new Date();
		const two = (n: number) => String(n).padStart(2, "0");
		const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
		let marker = t("notice.pending", time);
		for (let k = 2; this.markers.has(marker); k++) marker = t("notice.pending", `${time} #${k}`);
		this.markers.add(marker);
		const engine = this.engine();
		const t0 = performance.now();
		this.inFlight++;
		this.last = { "started": d.toLocaleTimeString(), "engine": `${engine.provider} / ${engine.model}`, "image": `${cv.width} x ${cv.height}, ${Math.round(png.length * 0.75 / 1024)} KB`, "state": "waiting" };
		try {
			const around = { ...(await this.placeMarker(view, file, marker)), notes: strokes.some((st) => st.ai) };
			const r = await recognize(png, around, engine);
			this.last["detail"] = r.detail;
			const md = r.figures.length ? placeFigures(r.markdown, await this.saveFigures(file, r.figures)) : r.markdown;
			if (engine.check) this.last["check"] = /^> \[!warning\]/m.test(md) ? "flagged something" : "nothing flagged";
			if (!(await this.settle(file, marker, md))) new ResultModal(this.app, md).open();
			this.last["state"] = `done, ${r.markdown.length} chars`;
		} catch (e) {
			const msg = (e as Error)?.message ?? String(e);
			this.last["state"] = "failed: " + msg;
			await this.settle(file, marker, "").catch(() => { /* the note may be gone; nothing to tidy */ });
			// The writing goes back in the pad: the one on screen, or the one
			// parked, or a new parked one. Unless something new has been started
			// there since -- the two pages would land on top of each other.
			const pad = this.shown ?? this.parked;
			if (pad && !pad.empty) new Notice(t("notice.failedNotRestored", msg), 12000);
			else {
				if (pad) pad.setPage(strokes);
				else this.parked = new InkPad(this, strokes);
				new Notice(t("notice.failed", msg), 12000);
			}
		} finally {
			this.markers.delete(marker);
			this.inFlight--;
			this.last["took"] = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
		}
	}

	/** Redrawn figures go where Obsidian puts attachments, as the user has set
	 *  it up, and are linked the way the user links. Returns the embed for each
	 *  figure, by the name the model gave it. */
	private async saveFigures(note: TFile, figures: Figure[]): Promise<Map<string, string>> {
		const embeds = new Map<string, string>();
		for (const [i, f] of figures.entries()) {
			const path = await this.app.fileManager.getAvailablePathForAttachment(`${note.basename} figure ${i + 1}.${f.ext}`, note.path);
			const saved = await this.app.vault.createBinary(path, f.data);
			embeds.set(f.name, "!" + this.app.fileManager.generateMarkdownLink(saved, note.path));
		}
		return embeds;
	}

	/** Put the placeholder in at the cursor, and read the note on either side of
	 *  it to send along as context */
	private async placeMarker(view: MarkdownView, file: TFile, marker: string): Promise<Surroundings> {
		const title = file.basename;
		if (view.file === file && view.getMode() === "source") {
			const ed = view.editor;
			const at = ed.getCursor("to");
			const off = ed.posToOffset(at);
			const text = ed.getValue();
			ed.replaceRange(marker, at);
			// Anything typed while waiting goes after the placeholder, so the
			// result ends up ahead of it, in the order it was written
			ed.setCursor(ed.offsetToPos(off + marker.length));
			return { title, before: text.slice(Math.max(0, off - CONTEXT_BEFORE), off), after: text.slice(off, off + CONTEXT_AFTER) };
		}
		// Reading view has no cursor, so the result goes at the end of the note
		let before = "";
		await this.app.vault.process(file, (data) => {
			before = data.slice(-CONTEXT_BEFORE);
			return data + (!data ? "" : data.endsWith("\n") ? "\n" : "\n\n") + marker;
		});
		return { title, before, after: "" };
	}

	/** Replace the placeholder with the result, or with nothing on failure.
	 *  False when the placeholder is gone. */
	private async settle(file: TFile, marker: string, md: string): Promise<boolean> {
		// Through an open editor if there is one: that keeps its undo history,
		// and writing to the file underneath it would fight with unsaved edits
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (!(v instanceof MarkdownView) || v.file !== file || v.getMode() !== "source") continue;
			const ed = v.editor;
			const i = ed.getValue().indexOf(marker);
			if (i < 0) continue;
			const from = ed.offsetToPos(i), to = ed.offsetToPos(i + marker.length);
			const next = to.line + 1 < ed.lineCount() ? ed.getLine(to.line + 1) : "";
			const fitted = md ? fitInsertion(md, ed.getLine(from.line).slice(0, from.ch), ed.getLine(to.line).slice(to.ch), next) : "";
			// A cursor still waiting at the placeholder moves past the result, so
			// writing carries on after it and the result renders; one that has
			// gone elsewhere stays put
			const { ins, cursor } = cursorAfter(ed.getValue(), i, marker.length, fitted, ed.posToOffset(ed.getCursor()));
			ed.replaceRange(ins, from, to);
			if (cursor != null) ed.setCursor(ed.offsetToPos(cursor));
			return true;
		}
		let found = false;
		await this.app.vault.process(file, (data) => {
			const i = data.indexOf(marker);
			if (i < 0) return data;
			found = true;
			const ls = data.lastIndexOf("\n", i - 1) + 1;
			let le = data.indexOf("\n", i + marker.length);
			if (le < 0) le = data.length;
			let ne = data.indexOf("\n", le + 1);
			if (ne < 0) ne = data.length;
			const ins = md ? fitInsertion(md, data.slice(ls, i), data.slice(i + marker.length, le), le < data.length ? data.slice(le + 1, ne) : "") : "";
			return data.slice(0, i) + ins + data.slice(i + marker.length);
		});
		return found;
	}

	/* ============ Diagnostics ============ */

	/** No devtools on mobile, so the plugin has to report its own state. Never
	 *  the key itself: only whether one is linked. */
	collectDiagnostics(): Record<string, string> {
		const s = this.settings;
		const secret = s.provider === "openai" ? s.openaiSecret : s.anthropicSecret;
		const out: Record<string, string> = {
			"plugin version": __HW_BUILD__ ? `${this.manifest.version}, built ${__HW_BUILD__}` : this.manifest.version,
			"platform": Platform.isMobile ? (Platform.isPhone ? "phone" : "tablet") : "desktop",
			"viewport": `${window.innerWidth} x ${window.innerHeight} @${window.devicePixelRatio}x`,
			"service": s.provider === "openai" ? `openai-compatible, ${s.openaiBaseUrl}` : "anthropic",
			"model": s.provider === "openai" ? s.openaiModel : s.anthropicModel,
			"api key": !secret ? "not linked" : this.apiKey() ? `linked (${secret})` : `linked to "${secret}", which is empty on this device`,
			"draft strokes": String(this.parked?.strokeCount ?? 0),
			"pad": `opens ${this.settings.padMode === "split" && !Platform.isPhone ? "beside the note" : "full screen"}${this.shown ? ", open now" : ""}`,
			"in flight": String(this.inFlight),
		};
		for (const [k, v] of Object.entries(this.last)) out["last: " + k] = v;
		if (!Object.keys(this.last).length) out["last"] = "nothing converted yet";
		for (const [k, v] of Object.entries(this.padReport)) out["pad: " + k] = v;
		if (!Object.keys(this.padReport).length) out["pad"] = "not opened yet";
		return out;
	}

	/* ============ Settings ============ */

	/** "auto" follows Obsidian's display language; anything not Chinese gets English */
	applyLang() {
		const l = this.settings.language;
		setLang(l === "en" || l === "zh" ? l : detectLang());
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<HandwritingSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...stored };
		// Copy the array rather than sharing DEFAULT_SETTINGS' one, which editing a
		// width would otherwise mutate. Also guard against a damaged data.json.
		const s = this.settings;
		const n = Number(s.eraserSize);
		s.eraserSize = Number.isFinite(n) && n >= SIZE_MIN && n <= SIZE_MAX ? n : DEFAULT_SETTINGS.eraserSize;
		if (s.eraserMode !== "precise") s.eraserMode = "stroke";
		if (s.padMode !== "full") s.padMode = "split";
		if (!["left", "right", "top", "bottom"].includes(s.toolbarSide)) s.toolbarSide = "right";
		if (typeof s.toolbarHintSeen !== "boolean") s.toolbarHintSeen = false;
		if (typeof s.undoTapShown !== "boolean") s.undoTapShown = false;
		if (typeof s.redoTapShown !== "boolean") s.redoTapShown = false;
		const saved = Array.isArray(s.sizes) ? s.sizes : [];
		s.sizes = DEFAULT_SETTINGS.sizes.map((d, i) => {
			const v = Number(saved[i]);
			return Number.isFinite(v) && v >= 1 && v <= 28 ? v : d;
		});
		if (s.provider !== "openai") s.provider = "anthropic";
		if (s.curve !== 0) s.curve = 1;
		if (!CLAUDE_MODELS.some((m) => m.id === s.anthropicModel)) s.anthropicModel = DEFAULT_SETTINGS.anthropicModel;
		for (const k of ["anthropicSecret", "openaiSecret", "openaiModel", "openaiBaseUrl"] as const)
			if (typeof s[k] !== "string") s[k] = DEFAULT_SETTINGS[k];
		if (typeof s.redrawFigures !== "boolean") s.redrawFigures = DEFAULT_SETTINGS.redrawFigures;
		if (typeof s.checkWork !== "boolean") s.checkWork = DEFAULT_SETTINGS.checkWork;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class HandwritingSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: HandwritingPlugin) { super(app, plugin); }

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("set.language"))
			.setDesc(t("set.languageDesc"))
			.addDropdown((d) => d
				.addOption("auto", t("set.langAuto"))
				.addOption("en", "English")
				.addOption("zh", "中文")
				.setValue(s.language)
				.onChange(async (v) => {
					s.language = v;
					this.plugin.applyLang();
					await save();
					this.display();   // redraw this tab in the new language
				}));

		/* ---- recognition ---- */

		new Setting(containerEl).setName(t("set.aiHeading")).setHeading();

		new Setting(containerEl)
			.setName(t("set.provider"))
			.setDesc(t("set.providerDesc"))
			.addDropdown((d) => d
				.addOption("anthropic", t("set.providerAnthropic"))
				.addOption("openai", t("set.providerOpenAI"))
				.setValue(s.provider)
				.onChange(async (v) => {
					s.provider = v === "openai" ? "openai" : "anthropic";
					await save();
					this.display();   // the key and model rows belong to the service
				}));

		// Each service keeps its own key, so switching back and forth loses neither
		const openai = s.provider === "openai";
		new Setting(containerEl)
			.setName(t("set.key"))
			.setDesc(t("set.keyDesc", openai ? "openai" : "anthropic"))
			.addComponent((el) => new SecretComponent(this.app, el)
				.setValue(openai ? s.openaiSecret : s.anthropicSecret)
				.onChange(async (v) => {
					// null when the link is removed
					if (openai) s.openaiSecret = v ?? ""; else s.anthropicSecret = v ?? "";
					await save();
				}));

		if (!openai) {
			new Setting(containerEl)
				.setName(t("set.model"))
				.setDesc(t("set.modelDesc"))
				.addDropdown((d) => {
					for (const m of CLAUDE_MODELS)
						d.addOption(m.id, m.recommended ? `${m.name} (${t("set.recommended")})` : m.name);
					d.setValue(s.anthropicModel).onChange(async (v) => { s.anthropicModel = v; await save(); });
				});
			new Setting(containerEl)
				.setName(t("set.figures"))
				.setDesc(t("set.figuresDesc"))
				.addToggle((tg) => tg
					.setValue(s.redrawFigures)
					.onChange(async (v) => { s.redrawFigures = v; await save(); }));
		} else {
			new Setting(containerEl)
				.setName(t("set.model"))
				.setDesc(t("set.openaiModelDesc"))
				.addText((txt) => txt
					.setPlaceholder(DEFAULT_OPENAI_MODEL)
					.setValue(s.openaiModel)
					.onChange(async (v) => { s.openaiModel = v.trim(); await save(); }));
			new Setting(containerEl)
				.setName(t("set.baseUrl"))
				.setDesc(t("set.baseUrlDesc"))
				.addText((txt) => txt
					.setPlaceholder(DEFAULT_OPENAI_BASE)
					.setValue(s.openaiBaseUrl)
					.onChange(async (v) => { s.openaiBaseUrl = v.trim() || DEFAULT_OPENAI_BASE; await save(); }));
		}

		new Setting(containerEl)
			.setName(t("set.check"))
			.setDesc(t("set.checkDesc"))
			.addToggle((tg) => tg
				.setValue(s.checkWork)
				.onChange(async (v) => { s.checkWork = v; await save(); }));

		/* ---- writing ---- */

		new Setting(containerEl).setName(t("set.writingHeading")).setHeading();

		new Setting(containerEl)
			.setName(t("set.taper"))
			.setDesc(t("set.taperDesc"))
			.addDropdown((d) => d
				.addOption("0", t("set.off"))
				.addOption("1", t("set.subtle"))
				.setValue(String(s.taper))
				.onChange(async (v) => { s.taper = Number(v); await save(); }));

		new Setting(containerEl)
			.setName(t("set.lowLatency"))
			.setDesc(t("set.lowLatencyDesc"))
			.addToggle((tg) => tg
				.setValue(s.lowLatency)
				.onChange(async (v) => { s.lowLatency = v; await save(); }));

		new Setting(containerEl)
			.setName(t("set.renderer"))
			.setDesc(t("set.rendererDesc"))
			.addDropdown((d) => d
				.addOption("1", t("set.oneEuro"))
				.addOption("0", t("set.exponential"))
				.setValue(String(s.filter))
				.onChange(async (v) => { s.filter = Number(v); await save(); }));

		new Setting(containerEl)
			.setName(t("set.curve"))
			.setDesc(t("set.curveDesc"))
			.addToggle((tg) => tg
				.setValue(s.curve === 1)
				.onChange(async (v) => { s.curve = v ? 1 : 0; await save(); }));

		new Setting(containerEl)
			.setName(t("set.predict"))
			.setDesc(t("set.predictDesc"))
			.addSlider((sl) => sl
				.setLimits(0, 4, 1)
				.setValue(s.predict)
				.setDynamicTooltip()
				.onChange(async (v) => { s.predict = v; await save(); }));

		new Setting(containerEl)
			.setName(t("set.smooth"))
			.setDesc(t("set.smoothDesc"))
			.addSlider((sl) => sl
				.setLimits(0, 0.9, 0.05)
				.setValue(s.smooth)
				.setDynamicTooltip()
				.onChange(async (v) => { s.smooth = v; await save(); }));

		new Setting(containerEl)
			.setName(t("set.thin"))
			.setDesc(t("set.thinDesc"))
			.addSlider((sl) => sl
				.setLimits(0, 1, 0.05)
				.setValue(s.thin)
				.setDynamicTooltip()
				.onChange(async (v) => { s.thin = v; await save(); }));

		new Setting(containerEl)
			.setName(t("set.finger"))
			.setDesc(t("set.fingerDesc"))
			.addToggle((tg) => tg
				.setValue(s.allowFinger)
				.onChange(async (v) => { s.allowFinger = v; await save(); }));
	}
}

/** Shown when the placeholder was deleted while the request was out, so a
 *  result that was paid for is not simply dropped */
class ResultModal extends Modal {
	constructor(app: App, private text: string) { super(app); }

	onOpen() {
		this.titleEl.setText(t("result.title"));
		this.contentEl.createEl("p", { text: t("result.desc"), attr: { style: "font-size:13px;opacity:.7;margin:0 0 10px;" } });
		this.contentEl.createEl("textarea", {
			text: this.text,
			attr: { readonly: "true", rows: "12", style: "width:100%;font-family:var(--font-monospace);font-size:13px;" },
		});
		new Setting(this.contentEl).addButton((b) => b.setCta().setButtonText(t("result.copy")).onClick(async () => {
			await navigator.clipboard.writeText(this.text);
			b.setButtonText(t("result.copied"));
		}));
	}

	onClose() { this.contentEl.empty(); }
}

class DiagModal extends Modal {
	constructor(app: App, private data: Record<string, string>) { super(app); }

	onOpen() {
		this.titleEl.setText("Inkdown diagnostics");
		const box = this.contentEl.createDiv({
			attr: { style: "font-size:13px;line-height:1.7;-webkit-user-select:text;user-select:text;" },
		});
		for (const [k, v] of Object.entries(this.data)) {
			const row = box.createDiv({ attr: { style: "display:flex;gap:10px;" } });
			row.createSpan({ text: k, attr: { style: "flex:0 0 130px;opacity:.65;" } });
			row.createSpan({ text: v, attr: { style: "flex:1 1 auto;font-weight:600;word-break:break-all;" } });
		}
	}

	onClose() { this.contentEl.empty(); }
}
