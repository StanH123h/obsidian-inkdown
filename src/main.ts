import { App, MarkdownView, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { HandwritingView, VIEW_TYPE } from "./view";
import { emptyDoc, isHandwritingData, isHandwritingFile } from "./format";
import { embedProcessor } from "./embed";
import { Lang, detectLang, setLang, t } from "./i18n";

export interface HandwritingSettings {
	language: string;    // "auto", "en" or "zh"
	sizes: number[];     // the three pen widths on the toolbar, in page units
	eraserMode: string;  // "stroke" removes a whole stroke, "precise" only what it touches
	eraserSize: number;  // eraser radius in page units
	smooth: number;      // input streamlining, 0..0.9
	thin: number;        // how much pressure affects width, 0..1
	taper: number;       // 0 = off, 1 = subtle
	filter: number;      // 0 = exponential smoothing, 1 = one-euro filter
	predict: number;     // frames of tip prediction, 0 = off
	lowLatency: boolean; // desynchronized canvas hint
	allowFinger: boolean;
}

const DEFAULT_SETTINGS: HandwritingSettings = {
	language: "auto",
	sizes: [4, 8, 14],
	eraserMode: "stroke",
	eraserSize: 14,
	smooth: 0.55,
	thin: 0.70,
	taper: 1,
	filter: 1,
	predict: 2,
	lowLatency: true,
	allowFinger: false,
};

export default class HandwritingPlugin extends Plugin {
	settings: HandwritingSettings = DEFAULT_SETTINGS;

	/** Files the user explicitly asked to see as source; do not grab them back */
	private bypass = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.applyLang();

		this.registerView(VIEW_TYPE, (leaf) => new HandwritingView(leaf, this));

		// Make ![[note#region]] inside ordinary markdown notes actually show that ink
		this.registerMarkdownPostProcessor(
			embedProcessor(this.app, () => ({
				smooth: this.settings.smooth,
				thin: this.settings.thin,
				taper: this.settings.taper,
				filter: this.settings.filter,
			})),
		);

		// A handwriting note is ordinary markdown, so Obsidian opens it in a
		// MarkdownView. Swap that for the handwriting view once the layout settles.
		// This is the one place in the whole design that leans on undocumented
		// behaviour (Excalidraw does the same).
		this.registerEvent(this.app.workspace.on("layout-change", () => this.claimLeaves()));
		// Detection reads frontmatter, so re-scan once the cache resolves: on startup
		// a file can be opened before the cache is populated
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.claimLeaves()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.claimLeaves()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.claimLeaves()));
		this.app.workspace.onLayoutReady(() => this.claimLeaves());

		this.addCommand({
			id: "new-note",
			name: t("cmd.newNote"),
			callback: () => this.createNote(),
		});

		this.addCommand({
			id: "toggle-source",
			name: t("cmd.toggleSource"),
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!leaf) return false;
				if (leaf.view.getViewType() === VIEW_TYPE) {
					if (!checking) this.toMarkdown(leaf);
					return true;
				}
				const file = this.isHandwritingLeaf(leaf);
				if (!file) return false;
				if (!checking) this.toHandwriting(leaf, file);
				return true;
			},
		});

		this.addCommand({
			id: "migrate-hw-md",
			name: t("cmd.migrate"),
			callback: async () => {
				const old = this.app.vault.getMarkdownFiles().filter((f) => f.path.endsWith(".hw.md"));
				if (!old.length) { new Notice(t("notice.nothingToMigrate")); return; }
				let done = 0;
				for (const f of old) {
					// fileManager.renameFile also updates every link pointing at the file
					const to = f.path.replace(/\.hw\.md$/, ".md");
					if (this.app.vault.getAbstractFileByPath(to)) continue;   // skip name collisions
					try { await this.app.fileManager.renameFile(f, to); done++; } catch (e) { /* skip */ }
				}
				new Notice(t("notice.migrated", done, old.length));
			},
		});

		this.addCommand({
			id: "diagnostics",
			name: t("cmd.diagnostics"),
			callback: () => new DiagModal(this.app, this.collectDiagnostics()).open(),
		});

		// Right-click a folder on desktop, long-press it on mobile.
		// "action-primary" is the section holding New note and New folder, which
		// is also where the Canvas and Bases core plugins put theirs.
		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, f: TAbstractFile, source: string) => {
			if (source !== "file-explorer-context-menu" || !(f instanceof TFolder)) return;
			menu.addItem((item) => item
				.setSection("action-primary")
				.setTitle(t("cmd.newNoteHere"))
				.setIcon("pen-tool")
				.onClick(() => this.createNote(f)));
			this.sitUnderNewNote(menu);
		}));

		this.addRibbonIcon("pen-tool", t("cmd.newNote"), () => this.createNote());
		this.addSettingTab(new HandwritingSettingTab(this.app, this));
	}

	onunload() {
		this.bypass.clear();
	}

	/** No devtools on mobile, so the plugin has to report its own state */
	collectDiagnostics(): Record<string, string> {
		const out: Record<string, string> = {
			"plugin version": this.manifest.version,
			"platform": Platform.isMobile ? (Platform.isPhone ? "phone" : "tablet") : "desktop",
			"obsidian": (this.app as unknown as { appId?: string }).appId ? "loaded" : "?",
			"viewport": `${window.innerWidth} x ${window.innerHeight} @${window.devicePixelRatio}x`,
			"handwriting views": String(this.app.workspace.getLeavesOfType(VIEW_TYPE).length),
		};
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (leaf) Object.assign(out, (leaf.view as HandwritingView).diagnostics());
		else out["hint"] = "no handwriting note open; create one, then run this again";
		return out;
	}


	/* ============ View takeover ============ */

	private currentFile(leaf: WorkspaceLeaf | null): TFile | null {
		const v = leaf?.view as { file?: TFile } | undefined;
		return v?.file ?? null;
	}

	/** A MarkdownView already holds the file contents, so besides querying the
	 *  metadata cache we can just look at the text. The cache updates
	 *  asynchronously: renamed files, externally synced files and freshly created
	 *  ones may not be in it yet, and a cache-only check misses all of those. */
	isHandwritingLeaf(leaf: WorkspaceLeaf): TFile | null {
		const view = leaf.view as MarkdownView;
		const file = view?.file;
		if (!file) return null;
		if (isHandwritingFile(this.app, file)) return file;
		return isHandwritingData(view.data ?? "") ? file : null;
	}

	private claimLeaves() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const file = this.isHandwritingLeaf(leaf);
			if (file && !this.bypass.has(file.path)) this.toHandwriting(leaf, file);
		}
	}

	private toHandwriting(leaf: WorkspaceLeaf, file: TFile) {
		this.bypass.delete(file.path);
		leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
	}

	/** The toolbar's "view source": go back to a MarkdownView and stay there */
	toMarkdown(leaf: WorkspaceLeaf) {
		const file = this.currentFile(leaf);
		if (!file) return;
		this.bypass.add(file.path);
		leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source" } });
	}

	/* ============ Creating notes ============ */

	/** Move the item just added to sit immediately below "New note".
	 *
	 *  Menu.sort buckets items by section and keeps insertion order inside each
	 *  bucket, so landing in "action-primary" alone puts us last in that group,
	 *  below New folder and whatever Canvas and Bases added. Being adjacent to
	 *  New note means being adjacent in the items array.
	 *
	 *  `items` is not in the public API, hence the shape checks: if any of this
	 *  stops holding, the item simply stays where addItem left it, which is the
	 *  right section but the wrong row -- never an exception during a menu open.
	 */
	private sitUnderNewNote(menu: Menu) {
		const items = (menu as unknown as { items?: { section?: string }[] }).items;
		if (!Array.isArray(items) || items.length < 2) return;
		const mine = items[items.length - 1];
		if (mine?.section !== "action-primary") return;
		// Core adds New note first, so it is the first item of this section
		const first = items.findIndex((it) => it?.section === "action-primary");
		if (first < 0 || first + 1 >= items.length - 1) return;
		items.pop();
		items.splice(first + 1, 0, mine);
	}

	/** @param into  the folder to create in. Without one, Obsidian's own
	 *  "Default location for new notes" decides. */
	private async createNote(into?: TFolder) {
		// Obsidian already asks where new notes go, under Files and links ->
		// "Default location for new notes". Following that setting means the
		// answer to "where did this end up" is one the user has already given,
		// and is visible in a place they can change. Picking a folder in the
		// file explorer says it outright, and wins.
		const active = this.app.workspace.getActiveFile();
		const parent = into ?? this.app.fileManager.getNewFileParent(active?.path ?? "");
		const dir = parent.isRoot() ? "" : parent.path + "/";

		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const title = `${t("view.newNotePrefix")} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;

		// Two notes made inside the same minute would collide, and vault.create
		// throws rather than picking another name
		let path = `${dir}${title}.md`;
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++)
			path = `${dir}${title} ${n}.md`;

		try {
			const file = await this.app.vault.create(path, emptyDoc(title));
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			new Notice(t("notice.created", parent.isRoot() ? "/" : parent.path));
		} catch (e) {
			new Notice(t("notice.createFailed", (e as Error).message));
		}
	}

	/* ============ Settings ============ */

	/** "auto" follows Obsidian's display language; anything not Chinese gets English */
	applyLang() {
		const l = this.settings.language;
		setLang(l === "en" || l === "zh" ? (l as Lang) : detectLang());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Copy the array rather than sharing DEFAULT_SETTINGS' one, which editing a
		// width would otherwise mutate. Also guard against a damaged data.json.
		const n = Number(this.settings.eraserSize);
		this.settings.eraserSize = Number.isFinite(n) && n >= 3 && n <= 60 ? n : DEFAULT_SETTINGS.eraserSize;
		if (this.settings.eraserMode !== "precise") this.settings.eraserMode = "stroke";
		const saved = Array.isArray(this.settings.sizes) ? this.settings.sizes : [];
		this.settings.sizes = DEFAULT_SETTINGS.sizes.map((d, i) => {
			const v = Number(saved[i]);
			return Number.isFinite(v) && v >= 1 && v <= 28 ? v : d;
		});
	}

	relocalizeViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			(leaf.view as HandwritingView).relocalize();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			(leaf.view as HandwritingView).refresh();
		}
	}
}

class HandwritingSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: HandwritingPlugin) { super(app, plugin); }

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("set.language"))
			.setDesc(t("set.languageDesc"))
			.addDropdown((d) => d
				.addOption("auto", t("set.langAuto"))
				.addOption("en", "English")
				.addOption("zh", "中文")
				.setValue(this.plugin.settings.language)
				.onChange(async (v) => {
					this.plugin.settings.language = v;
					this.plugin.applyLang();
					await this.plugin.saveSettings();
					this.plugin.relocalizeViews();
					this.display();   // redraw this tab in the new language
				}));

		new Setting(containerEl)
			.setName(t("set.taper"))
			.setDesc(t("set.taperDesc"))
			.addDropdown((d) => d
				.addOption("0", t("set.off"))
				.addOption("1", t("set.subtle"))
				.setValue(String(this.plugin.settings.taper))
				.onChange(async (v) => { this.plugin.settings.taper = Number(v); await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.lowLatency"))
			.setDesc(t("set.lowLatencyDesc"))
			.addToggle((t) => t
				.setValue(this.plugin.settings.lowLatency)
				.onChange(async (v) => { this.plugin.settings.lowLatency = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.renderer"))
			.setDesc(t("set.rendererDesc"))
			.addDropdown((d) => d
				.addOption("1", t("set.oneEuro"))
				.addOption("0", t("set.exponential"))
				.setValue(String(this.plugin.settings.filter))
				.onChange(async (v) => { this.plugin.settings.filter = Number(v); await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.predict"))
			.setDesc(t("set.predictDesc"))
			.addSlider((s2) => s2
				.setLimits(0, 4, 1)
				.setValue(this.plugin.settings.predict)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.predict = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.smooth"))
			.setDesc(t("set.smoothDesc"))
			.addSlider((s) => s
				.setLimits(0, 0.9, 0.05)
				.setValue(this.plugin.settings.smooth)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.smooth = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.thin"))
			.setDesc(t("set.thinDesc"))
			.addSlider((s) => s
				.setLimits(0, 1, 0.05)
				.setValue(this.plugin.settings.thin)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.thin = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.finger"))
			.setDesc(t("set.fingerDesc"))
			.addToggle((t) => t
				.setValue(this.plugin.settings.allowFinger)
				.onChange(async (v) => { this.plugin.settings.allowFinger = v; await this.plugin.saveSettings(); }));
	}
}

class DiagModal extends Modal {
	constructor(app: App, private data: Record<string, string>) { super(app); }

	onOpen() {
		this.titleEl.setText("Inklink diagnostics");
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
