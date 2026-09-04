/* 解析 [[目标]] / ![[目标#区域]]，并把内容渲染出来。
 * 两处共用：手写画布上的嵌入元素，以及普通 markdown 笔记里的 ![[某手写笔记#区域]]。 */

import {
	App, Component, MarkdownRenderChild, MarkdownRenderer,
	parseLinktext, resolveSubpath, TFile,
} from "obsidian";
import { Box, InkOpts, Region, Stroke, paintInk, polyBounds, strokeInRegion } from "./ink";
import { isHandwritingData, isHandwritingFile, parse } from "./format";

export type Resolved =
	| { kind: "missing"; label: string }
	| { kind: "md"; file: TFile; text: string }
	| { kind: "ink"; file: TFile; strokes: Stroke[]; box: Box; clip?: [number, number][] };

export async function resolveTarget(app: App, target: string, sourcePath: string): Promise<Resolved> {
	const { path, subpath } = parseLinktext(target);
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	if (!file) return { kind: "missing", label: target };

	// 先读内容再判断，不依赖元数据缓存是否就绪 —— 嵌入随时可能在缓存之前渲染
	const raw = await app.vault.cachedRead(file);
	if (isHandwritingData(raw)) {
		const doc = parse(raw);
		if (subpath) {
			const name = subpath.replace(/^#+/, "").trim();
			// 同名区域取第一个 —— 跟 Obsidian 解析同名标题的行为一致
			const region: Region | undefined = doc.regions.find((r) => r.name === name);
			if (!region || region.path.length < 3) return { kind: "missing", label: target };
			return {
				kind: "ink",
				file,
				strokes: doc.strokes.filter((s) => strokeInRegion(s, region)),
				box: polyBounds(region.path),
				clip: region.path,
			};
		}
		return { kind: "ink", file, strokes: doc.strokes, box: strokesBox(doc.strokes) };
	}

	// 普通 markdown：有子路径就切出对应的标题/区块
	let text = raw;
	if (subpath) {
		const cache = app.metadataCache.getFileCache(file);
		const res = cache ? resolveSubpath(cache, subpath) : null;
		if (res) text = text.slice(res.start.offset, res.end ? res.end.offset : undefined);
	}
	return { kind: "md", file, text };
}

function strokesBox(strokes: Stroke[]): Box {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of strokes) for (const p of s.pts) {
		if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
	}
	if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 把解析结果画进 container。返回渲染高度（css px），墨迹嵌入才有意义。 */
export async function renderResolved(
	app: App, container: HTMLElement, r: Resolved,
	cssWidth: number, comp: Component, opt: InkOpts, sourcePath: string,
): Promise<void> {
	container.empty();
	if (r.kind === "missing") {
		container.createSpan({
			text: `未找到：${r.label}`,
			attr: { style: "color:var(--text-error,#c0392b);font-size:13px;" },
		});
		return;
	}
	if (r.kind === "ink") {
		const cv = container.createEl("canvas", { attr: { style: "display:block;max-width:100%;" } });
		paintInk(cv, r.strokes, opt, r.box, cssWidth, r.clip);
		return;
	}
	await MarkdownRenderer.render(app, r.text, container, sourcePath, comp);
}

/* ================= 普通笔记里的 ![[某手写笔记]] ================= */

class InkEmbed extends MarkdownRenderChild {
	constructor(
		el: HTMLElement,
		private app: App,
		private target: string,
		private sourcePath: string,
		private opt: InkOpts,
	) { super(el); }

	async onload() {
		const el = this.containerEl;
		el.empty();
		const r = await resolveTarget(this.app, this.target, this.sourcePath);
		if (r.kind !== "ink") { el.createSpan({ text: `未找到：${this.target}` }); return; }
		const width = Math.max(el.clientWidth || el.parentElement?.clientWidth || 600, 120);
		const cv = el.createEl("canvas", { attr: { style: "display:block;max-width:100%;" } });
		paintInk(cv, r.strokes, this.opt, r.box, width, r.clip);
	}
}

/** 让普通 markdown 笔记里的 ![[某手写笔记#区域]] 真的显示出那块手写内容 */
export function embedProcessor(app: App, getOpt: () => InkOpts) {
	return (el: HTMLElement, ctx: { sourcePath: string; addChild(c: MarkdownRenderChild): void }) => {
		el.querySelectorAll<HTMLElement>(".internal-embed").forEach((node) => {
			const src = node.getAttribute("src");
			if (!src) return;
			const { path } = parseLinktext(src);
			const f = app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!isHandwritingFile(app, f)) return;
			node.empty();
			node.addClass("hw-embed");
			node.setAttribute("style", "display:block;");
			ctx.addChild(new InkEmbed(node, app, src, ctx.sourcePath, getOpt()));
		});
	};
}
