import { App, Modal, Notice, Setting } from "obsidian";
import { sanitizeName } from "./format";

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
