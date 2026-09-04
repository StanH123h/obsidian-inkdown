import { App, Modal, Notice, Setting } from "obsidian";
import { isHandwritingFile, parse, sanitizeName } from "./format";

/* ================= 给区域命名 ================= */

export class NameRegionModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private taken: string[],
		private onDone: (name: string) => void,
		private onCancel: () => void,
	) { super(app); }

	onOpen() {
		this.titleEl.setText("给这块内容命名");
		this.contentEl.createEl("p", {
			text: "命名后就能在别处用 [[本文件#名字]] 引用它，加 ! 会直接显示这块手写内容。",
			attr: { style: "font-size:13px;opacity:.7;margin:0 0 12px;" },
		});

		let input: HTMLInputElement;
		new Setting(this.contentEl).setName("名字").addText((t) => {
			input = t.inputEl;
			t.setPlaceholder("例如：反应机理图").onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
		});
		setTimeout(() => input?.focus(), 30);

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("取消").onClick(() => { this.cancelled = true; this.close(); }))
			.addButton((b) => b.setCta().setButtonText("确定").onClick(() => this.submit()));
	}

	private cancelled = false;

	private submit() {
		const name = sanitizeName(this.value);
		if (!name) { new Notice("名字不能为空"); return; }
		// 同名标题在 Obsidian 里是"第一个赢、后面的静默失效"，太隐蔽了，这里直接拒绝
		if (this.taken.includes(name)) { new Notice(`已经有一个区域叫「${name}」了`); return; }
		this.cancelled = false;
		this.onDone(name);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		if (this.cancelled) this.onCancel();
	}
}

/* ================= 编辑一个 wiki link ================= */

export interface LinkEdit { target: string; embed: boolean }

export class LinkModal extends Modal {
	private target: string;
	private embed: boolean;
	private listEl!: HTMLElement;

	constructor(
		app: App,
		init: LinkEdit,
		private onDone: (v: LinkEdit) => void,
		private onDelete: () => void,
	) {
		super(app);
		this.target = init.target;
		this.embed = init.embed;
	}

	onOpen() {
		this.titleEl.setText("Wiki 链接");

		let input: HTMLInputElement;
		new Setting(this.contentEl).setName("目标").addText((t) => {
			input = t.inputEl;
			t.setPlaceholder("笔记名，或 笔记名#区域").setValue(this.target)
				.onChange((v) => { this.target = v; this.refresh(); });
			t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
			t.inputEl.style.width = "100%";
		});

		new Setting(this.contentEl)
			.setName("直接显示内容")
			.setDesc("相当于 ![[ ]]：文字笔记显示正文，手写区域显示那块笔迹。")
			.addToggle((t) => t.setValue(this.embed).onChange((v) => (this.embed = v)));

		this.listEl = this.contentEl.createDiv({
			attr: { style: "max-height:240px;overflow:auto;margin:8px 0 12px;" },
		});
		this.refresh();

		new Setting(this.contentEl)
			.addButton((b) => b.setWarning().setButtonText("删除").onClick(() => { this.onDelete(); this.close(); }))
			.addButton((b) => b.setCta().setButtonText("确定").onClick(() => this.submit()));

		setTimeout(() => { input?.focus(); input?.select(); }, 30);
	}

	/** 打了 # 就列目标手写笔记的区域，否则列文件 */
	private refresh() {
		this.listEl.empty();
		const q = this.target.trim();
		const hash = q.indexOf("#");

		const row = (label: string, sub: string, pick: () => void) => {
			const r = this.listEl.createDiv({
				attr: { style: "padding:7px 10px;border-radius:7px;cursor:pointer;display:flex;gap:8px;align-items:baseline;" },
			});
			r.createSpan({ text: label, attr: { style: "font-weight:600;" } });
			if (sub) r.createSpan({ text: sub, attr: { style: "font-size:12px;opacity:.55;" } });
			r.addEventListener("mouseenter", () => r.style.background = "var(--background-modifier-hover,rgba(127,127,127,.15))");
			r.addEventListener("mouseleave", () => r.style.background = "transparent");
			r.addEventListener("click", pick);
		};

		if (hash >= 0) {
			const base = q.slice(0, hash);
			const f = this.app.metadataCache.getFirstLinkpathDest(base, "");
			if (isHandwritingFile(this.app, f)) {
				const needle = q.slice(hash + 1).toLowerCase();
				this.app.vault.cachedRead(f).then((data) => {
					if (this.target.trim() !== q) return;      // 输入已经变了
					this.listEl.empty();
					for (const r of parse(data).regions) {
						if (!r.name.toLowerCase().includes(needle)) continue;
						row(r.name, "区域", () => { this.target = `${base}#${r.name}`; this.close2(); });
					}
				});
				return;
			}
		}

		const needle = (hash >= 0 ? q.slice(0, hash) : q).toLowerCase();
		const files = this.app.vault.getMarkdownFiles()
			.filter((f) => !needle || f.basename.toLowerCase().includes(needle))
			.slice(0, 12);
		for (const f of files) {
			const name = f.basename.replace(/\.hw$/, "");
			const folder = f.parent?.path ?? "";   // 先取出来：类型守卫会把 else 分支收窄成 never
			row(name, isHandwritingFile(this.app, f) ? "手写" : folder, () => {
				this.target = f.basename;
				this.close2();
			});
		}
	}

	/** 选中候选后回填输入框并刷新（不关闭弹窗，方便接着选区域） */
	private close2() {
		const input = this.contentEl.querySelector("input[type=text]") as HTMLInputElement | null;
		if (input) input.value = this.target;
		this.refresh();
	}

	private submit() {
		this.onDone({ target: this.target.trim(), embed: this.embed });
		this.close();
	}

	onClose() { this.contentEl.empty(); }
}
