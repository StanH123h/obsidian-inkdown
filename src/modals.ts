import { App, Modal, Notice, Setting } from "obsidian";
import { isHandwritingFile, parse, sanitizeName } from "./format";

/* ============ Naming a region ============ */

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
		// Obsidian resolves duplicate headings as "first one wins, the rest fail
		// silently", which is far too easy to miss, so reject duplicates outright
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

/* ============ Editing a wiki link ============ */

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
		this.titleEl.setText("Wiki 链接（只能指向手写内容）");

		let input: HTMLInputElement;
		new Setting(this.contentEl).setName("目标").addText((t) => {
			input = t.inputEl;
			t.setPlaceholder("手写笔记名，或 手写笔记名#区域").setValue(this.target)
				.onChange((v) => { this.target = v; this.refresh(); });
			t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
			t.inputEl.style.width = "100%";
		});

		new Setting(this.contentEl)
			.setName("直接显示内容")
			.setDesc("相当于 ![[ ]]：直接把目标手写笔记（或它的某个圈）画在这里。")
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

	/** After a #, list the regions of the target note; otherwise list files */
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
					if (this.target.trim() !== q) return;      // the input has changed since
					this.listEl.empty();
					for (const r of parse(data).regions) {
						if (!r.name.toLowerCase().includes(needle)) continue;
						row(r.name, "区域", () => { this.target = `${base}#${r.name}`; this.close2(); });
					}
				});
				return;
			}
		}

		// Handwriting notes only: a wiki link on the canvas can only reference
		// handwriting, so ordinary documents are not offered
		const needle = (hash >= 0 ? q.slice(0, hash) : q).toLowerCase();
		const files = this.app.vault.getMarkdownFiles()
			.filter((f) => isHandwritingFile(this.app, f))
			.filter((f) => !needle || f.basename.toLowerCase().includes(needle))
			.slice(0, 12);
		if (!files.length) {
			this.listEl.createDiv({
				text: needle ? "没有匹配的手写笔记" : "还没有别的手写笔记",
				attr: { style: "padding:8px 10px;font-size:12px;opacity:.55;" },
			});
			return;
		}
		for (const f of files) {
			const name = f.basename.replace(/\.hw$/, "");
			row(name, f.parent?.path ?? "", () => {
				this.target = f.basename;
				this.close2();
			});
		}
	}

	/** Fill the input from a suggestion and refresh, without closing the dialog so
	 *  a region can be picked next */
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
