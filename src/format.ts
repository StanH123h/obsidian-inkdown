/* 手写笔记文件的读写。
 *
 * 文件本体是一个完全正常的 markdown，Obsidian 照常索引它 —— wiki link、反链、
 * 图谱、搜索、重命名重构全部照常工作。笔迹和画布元素藏在 %%ink ... %% 里
 * （%% 是 Obsidian 的注释语法，不会显示）。
 *
 * 正文里那两段是**生成**的，作用是把画布上的东西"翻译"成 Obsidian 看得懂的形式：
 *   ## 区域  下面每个 ### 标题对应画布上一个套索区域，
 *            于是别处写 [[本文件#区域名]] 能解析、能自动补全、能进反链。
 *   ## 链接  把画布上的 wiki link 镜像成真链接，于是反链和图谱认得它们。
 *
 *   ---
 *   handwriting: v1
 *   ---
 *   # 标题
 *
 *   ## 区域
 *   ### 反应机理图
 *
 *   ## 链接
 *   - [[SN2 反应]]
 *   - ![[能量图]]
 *
 *   %%ink
 *   {"v":1,"w":1000,"strokes":[...],"items":[...],"regions":[...]}
 *   %%
 */

import { App, TFile } from "obsidian";
import { PAGE_W, Region, Stroke, cleanRaw } from "./ink";

/** 画布上的 wiki link 元素。
 *
 *  这个功能当前**没有启用** —— 联动的方向定为「普通文档引用手写内容」，
 *  而不是「手写画布里塞文档」。前者靠区域 + markdown 后处理器已经能用，
 *  后者只会把复杂度堆在画布上。
 *
 *  这里保留读写是为了**不丢数据**：老文件里可能已经存了 items，
 *  原样读进来、原样写回去，将来这个功能单独做的时候能直接接上。 */
export interface LinkItem {
	id: string;
	x: number;          // 页面单位
	y: number;
	w: number;          // 嵌入时的显示宽度
	target: string;     // [[ ]] 里面的内容，可带 #区域
	embed: boolean;     // true = ![[ ]]，直接显示内容
}

export interface HwDoc {
	title: string;
	strokes: Stroke[];
	items: LinkItem[];
	regions: Region[];
}

const INK_RE = /%%ink\n([\s\S]*?)\n%%/;

/* 手写笔记就是普通的 .md 文件，靠 frontmatter 里的 handwriting 标记识别。
 *
 * 早期用的是 .hw.md 这种复合后缀，但 Obsidian 眼里那种文件的 basename 是
 * 「BBB.hw」（扩展名只认最后一个 .md），于是 [[BBB]] 解析不到，而且文件列表、
 * 搜索、图谱里到处显示 BBB.hw。改成普通 .md 之后链接行为完全恢复正常。
 * 旧文件继续按路径识别，不用迁移也能打开。 */

export function isLegacyHandwritingPath(path: string): boolean {
	return path.endsWith(".hw.md");
}

// 声明成类型守卫，调用处就不用再单独判空了
export function isHandwritingFile(app: App, file: TFile | null): file is TFile {
	if (!file || file.extension !== "md") return false;
	if (isLegacyHandwritingPath(file.path)) return true;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm && fm.handwriting != null;
}

/** 直接看内容判断。用于元数据缓存还没就绪、或者拿不到 TFile 的场合。 */
export function isHandwritingData(data: string): boolean {
	return /^---[\s\S]*?^handwriting:/m.test(data.slice(0, 800)) || data.includes("%%ink\n");
}

export const newId = () => Math.random().toString(36).slice(2, 8);

/** 区域名要当 markdown 标题用，这几个字符会破坏链接语法 */
export function sanitizeName(name: string): string {
	return name.replace(/[#\[\]|^\n\r]/g, "").trim();
}

export function emptyDoc(title: string): string {
	return serialize({ title, strokes: [], items: [], regions: [] });
}

export function parse(data: string): HwDoc {
	const title = data.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
	const doc: HwDoc = { title, strokes: [], items: [], regions: [] };
	const m = data.match(INK_RE);
	if (!m) return doc;
	try {
		const j = JSON.parse(m[1]);
		doc.strokes = (j.strokes ?? []).map((s: any): Stroke => ({
			c: s.c ?? "#1a1a1a",
			s: s.s ?? 8,
			pts: (s.pts ?? []).map((p: number[]) => ({ x: p[0], y: p[1], p: p[2] })),
		}));
		doc.items = (j.items ?? []).map((it: any): LinkItem => ({
			id: it.id ?? newId(),
			x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 360,
			target: it.target ?? "", embed: !!it.embed,
		}));
		doc.regions = (j.regions ?? []).map((r: any): Region => ({
			id: r.id ?? newId(),
			name: r.name ?? "",
			path: r.path ?? [],
		}));
	} catch (e) {
		// 数据块坏了也不要连累其它内容
		console.error("[handwriting] 笔迹数据解析失败", e);
	}
	return doc;
}

export function serialize(doc: HwDoc): string {
	const out: string[] = ["---", "handwriting: v1", "---", ""];
	if (doc.title) out.push(`# ${doc.title}`, "");

	if (doc.regions.length) {
		out.push("## 区域", "");
		for (const r of doc.regions) if (r.name) out.push(`### ${r.name}`, "");
	}

	const json = {
		v: 1,
		w: PAGE_W,
		strokes: doc.strokes.map((s) => ({
			c: s.c, s: s.s,
			pts: decimate(cleanRaw(s.pts)).map((p) => [r1(p.x), r1(p.y), r2(p.p)]),
		})),
		items: doc.items.map((i) => ({
			id: i.id, x: r1(i.x), y: r1(i.y), w: r1(i.w), target: i.target, embed: i.embed,
		})),
		regions: doc.regions.map((g) => ({
			id: g.id, name: g.name,
			path: g.path.map(([x, y]) => [r1(x), r1(y)]),
		})),
	};
	out.push("%%ink", JSON.stringify(json), "%%", "");
	return out.join("\n");
}

/** 采样点抽稀：合并事件会给出非常密的点，间距小于 0.6 个页面单位的丢掉。
 * 肉眼看不出差别，文件能小一大截。
 * 存盘前先过一遍 cleanRaw()，顺便把 0.0.5 之前写坏的重复点永久清掉。 */
function decimate(pts: { x: number; y: number; p: number }[]) {
	if (pts.length < 3) return pts;
	const out = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const last = out[out.length - 1];
		if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) >= 0.6) out.push(pts[i]);
	}
	out.push(pts[pts.length - 1]);
	return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
