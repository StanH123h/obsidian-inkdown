import { App, Modal, Notice, Setting } from "obsidian";
import { isHandwritingFile, parse, sanitizeName } from "./format";
import { t } from "./i18n";

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
		this.titleEl.setText(t("name.title"));
		this.contentEl.createEl("p", {
			text: t("name.desc"),
			attr: { style: "font-size:13px;opacity:.7;margin:0 0 12px;" },
		});

		let input: HTMLInputElement;
		new Setting(this.contentEl).setName(t("name.field")).addText((txt) => {
			input = txt.inputEl;
			txt.setPlaceholder(t("name.placeholder")).onChange((v: string) => (this.value = v));
			txt.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
		});
		setTimeout(() => input?.focus(), 30);

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => { this.cancelled = true; this.close(); }))
			.addButton((b) => b.setCta().setButtonText(t("common.ok")).onClick(() => this.submit()));
	}

	private cancelled = false;

	private submit() {
		const name = sanitizeName(this.value);
		if (!name) { new Notice(t("notice.nameEmpty")); return; }
		// Obsidian resolves duplicate headings as "first one wins, the rest fail
		// silently", which is far too easy to miss, so reject duplicates outright
		if (this.taken.includes(name)) { new Notice(t("notice.nameTaken", name)); return; }
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
		this.titleEl.setText(t("link.title"));

		let input: HTMLInputElement;
		new Setting(this.contentEl).setName(t("link.target")).addText((txt) => {
			input = txt.inputEl;
			txt.setPlaceholder(t("link.placeholder")).setValue(this.target)
				.onChange((v) => { this.target = v; this.refresh(); });
			txt.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.submit(); });
			txt.inputEl.style.width = "100%";
		});

		new Setting(this.contentEl)
			.setName(t("link.embed"))
			.setDesc(t("link.embedDesc"))
			.addToggle((tg) => tg.setValue(this.embed).onChange((v) => (this.embed = v)));

		this.listEl = this.contentEl.createDiv({
			attr: { style: "max-height:240px;overflow:auto;margin:8px 0 12px;" },
		});
		this.refresh();

		new Setting(this.contentEl)
			.addButton((b) => b.setWarning().setButtonText(t("common.delete")).onClick(() => { this.onDelete(); this.close(); }))
			.addButton((b) => b.setCta().setButtonText(t("common.ok")).onClick(() => this.submit()));

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
						row(r.name, t("link.area"), () => { this.target = `${base}#${r.name}`; this.close2(); });
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
				text: needle ? t("link.noMatch") : t("link.noneYet"),
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
