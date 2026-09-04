import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { HandwritingView, VIEW_TYPE } from "./view";
import { emptyDoc, isHandwritingData, isHandwritingFile } from "./format";
import { embedProcessor } from "./embed";

export interface HandwritingSettings {
	sizes: number[];     // the three pen widths on the toolbar, in page units
	smooth: number;      // input streamlining, 0..0.9
	thin: number;        // how much pressure affects width, 0..1
	taper: number;       // 0 = off, 1 = subtle
	filter: number;      // 0 = exponential smoothing, 1 = one-euro filter
	predict: number;     // frames of tip prediction, 0 = off
	lowLatency: boolean; // desynchronized canvas hint
	allowFinger: boolean;
}

const DEFAULT_SETTINGS: HandwritingSettings = {
	sizes: [4, 8, 14],
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
			name: "新建手写笔记",
			callback: () => this.createNote(),
		});

		this.addCommand({
			id: "toggle-source",
			name: "手写视图 / Markdown 源码 切换",
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
			name: "迁移：把 .hw.md 重命名为 .md",
			callback: async () => {
				const old = this.app.vault.getMarkdownFiles().filter((f) => f.path.endsWith(".hw.md"));
				if (!old.length) { new Notice("没有 .hw.md 文件需要迁移"); return; }
				let done = 0;
				for (const f of old) {
					// fileManager.renameFile also updates every link pointing at the file
					const to = f.path.replace(/\.hw\.md$/, ".md");
					if (this.app.vault.getAbstractFileByPath(to)) continue;   // skip name collisions
					try { await this.app.fileManager.renameFile(f, to); done++; } catch (e) { /* skip */ }
				}
				new Notice(`已迁移 ${done} / ${old.length} 个文件`);
			},
		});

		this.addCommand({
			id: "diagnostics",
			name: "诊断信息（移动端排查用）",
			callback: () => new DiagModal(this.app, this.collectDiagnostics()).open(),
		});

		this.addRibbonIcon("pen-tool", "新建手写笔记", () => this.createNote());
		this.addSettingTab(new HandwritingSettingTab(this.app, this));
	}

	onunload() {
		this.bypass.clear();
	}

	/** No devtools on mobile, so the plugin has to report its own state */
	collectDiagnostics(): Record<string, string> {
		const out: Record<string, string> = {
			"插件版本": this.manifest.version,
			"平台": Platform.isMobile ? (Platform.isPhone ? "手机" : "平板") : "桌面",
			"Obsidian": (this.app as unknown as { appId?: string }).appId ? "已加载" : "?",
			"视口": `${window.innerWidth} x ${window.innerHeight} @${window.devicePixelRatio}x`,
			"手写视图数": String(this.app.workspace.getLeavesOfType(VIEW_TYPE).length),
		};
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (leaf) Object.assign(out, (leaf.view as HandwritingView).diagnostics());
		else out["提示"] = "没有打开的手写笔记，先新建一个再运行本命令";
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

	private async createNote() {
		const active = this.app.workspace.getActiveFile();
		const folder = active?.parent?.path && active.parent.path !== "/" ? active.parent.path + "/" : "";
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const title = `手写 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
		const path = `${folder}${title}.md`;

		try {
			const file = await this.app.vault.create(path, emptyDoc(title));
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} catch (e) {
			new Notice("新建失败：" + (e as Error).message);
		}
	}

	/* ============ Settings ============ */

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Copy the array rather than sharing DEFAULT_SETTINGS' one, which editing a
		// width would otherwise mutate. Also guard against a damaged data.json.
		const saved = Array.isArray(this.settings.sizes) ? this.settings.sizes : [];
		this.settings.sizes = DEFAULT_SETTINGS.sizes.map((d, i) => {
			const v = Number(saved[i]);
			return Number.isFinite(v) && v >= 1 && v <= 28 ? v : d;
		});
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
			.setName("起收笔锋")
			.setDesc("关：粗细完全由真实压力决定。轻微：额外加 3px 的过渡，起笔边缘更柔和。")
			.addDropdown((d) => d
				.addOption("0", "关")
				.addOption("1", "轻微")
				.setValue(String(this.plugin.settings.taper))
				.onChange(async (v) => { this.plugin.settings.taper = Number(v); await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("低延迟画布")
			.setDesc("desynchronized 提示。关掉走常规合成路径 —— 如果裂纹只在写字那一层出现，关掉它能排除是这个引起的。")
			.addToggle((t) => t
				.setValue(this.plugin.settings.lowLatency)
				.onChange(async (v) => { this.plugin.settings.lowLatency = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("平滑算法")
			.setDesc("1€ 滤波：慢写时压抖动、快写时放开跟手，同样的平滑度下延迟更小（CHI 2012 的做法）。指数平滑是固定强度，只能在抖和拖之间二选一。")
			.addDropdown((d) => d
				.addOption("1", "1€ 滤波（推荐）")
				.addOption("0", "指数平滑（旧）")
				.setValue(String(this.plugin.settings.filter))
				.onChange(async (v) => { this.plugin.settings.filter = Number(v); await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("笔尖预测")
			.setDesc("往笔尖前方多画几帧，抵消感知延迟 —— Notability 这类原生应用靠系统的 predictedTouches 做这件事，WebKit 没有这个 API，只能自己外推。调大更跟手，但转弯时可能轻微过冲。")
			.addSlider((s2) => s2
				.setLimits(0, 4, 1)
				.setValue(this.plugin.settings.predict)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.predict = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("平滑强度")
			.setDesc("越高越顺滑，但跟手感会变差。")
			.addSlider((s) => s
				.setLimits(0, 0.9, 0.05)
				.setValue(this.plugin.settings.smooth)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.smooth = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("压感强度")
			.setDesc("0 = 恒定粗细，1 = 粗细完全跟着压力走。")
			.addSlider((s) => s
				.setLimits(0, 1, 0.05)
				.setValue(this.plugin.settings.thin)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.thin = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("允许手指绘制")
			.setDesc("关闭时只认 Apple Pencil 和鼠标，手掌搭在屏幕上不会画出杂线。")
			.addToggle((t) => t
				.setValue(this.plugin.settings.allowFinger)
				.onChange(async (v) => { this.plugin.settings.allowFinger = v; await this.plugin.saveSettings(); }));
	}
}

class DiagModal extends Modal {
	constructor(app: App, private data: Record<string, string>) { super(app); }

	onOpen() {
		this.titleEl.setText("Handwriting 诊断");
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
