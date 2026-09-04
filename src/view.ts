import { Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import {
	InkOpts, PAGE_H, PAGE_W, Region, Stroke,
	distToPoly, drawStroke, hitStroke, pathToCanvas, pointInPoly, polyArea, polyBounds, predictTip, strokeInRegion,
} from "./ink";
import { HwDoc, newId, parse, sanitizeName, serialize } from "./format";
import { NameRegionModal } from "./modals";
import { ICONS, S, drawIcon } from "./styles";
import type HandwritingPlugin from "./main";

export const VIEW_TYPE = "handwriting-view";

const EDGE_PAD = 12;   // css px

const COLORS = ["#1a1a1a", "#c0392b", "#2d6ca8", "#1a7f37"];
const SIZES = [4, 8, 14];

type Tool = "pen" | "eraser" | "lasso";

type UndoEntry =
	| { kind: "stroke-add"; index: number }
	| { kind: "stroke-del"; items: { index: number; stroke: Stroke }[] }
	| { kind: "region-add"; id: string }
	| { kind: "region-del"; index: number; region: Region }
	| { kind: "region-move"; id: string; dx: number; dy: number; strokes: number[] };

export class HandwritingView extends TextFileView {
	private plugin: HandwritingPlugin;

	private surface!: HTMLDivElement;
	private base!: HTMLCanvasElement;
	private live!: HTMLCanvasElement;
	private overlay!: HTMLDivElement;
	private bctx!: CanvasRenderingContext2D;
	private lctx!: CanvasRenderingContext2D;
	private tools!: HTMLDivElement;
	private ro?: ResizeObserver;
	private narrow: boolean | null = null;
	private seps: HTMLElement[] = [];

	private doc: HwDoc = { title: "", strokes: [], items: [], regions: [] };
	private cur: Stroke | null = null;
	private lasso: [number, number][] | null = null;
	private drawing = false;
	private lastT = -1;
	private lowLatency = false;
	private evtStamps: number[] = [];

	private tool: Tool = "pen";
	private color = COLORS[0];
	private size = SIZES[1];
	private undoStack: UndoEntry[] = [];

	/** 当前选中的区域 id。选中后才能拖动，点空白处取消。 */
	private selRegion: string | null = null;
	private regionDrag: { id: string; ox: number; oy: number; dx: number; dy: number; moved: boolean } | null = null;
	/** 需要做反向缩放的浮动 UI（放大画布时按钮不该跟着变大） */
	private counterScaled: HTMLElement[] = [];
	/** 选项条是否展开。只有长按才展开，普通点击只负责选中。 */
	private showOpts = false;
	/** 轻点判定：按下时记录，移动超过阈值就作废（那是笔画或平移，不是点击） */
	private tap: { x: number; y: number; finger: boolean } | null = null;
	private lpTimer = 0;
	private panMoved = false;
	/** 手指按在了某个已选中的圈上，等移动超过死区再真正开始拖 */
	private fingerOn: { id: string; x: number; y: number } | null = null;

	/* 视口：缩放 + 平移。笔迹坐标始终是内容单位，跟屏幕无关。 */
	private zoom = 1;
	private panX = 0;
	private panY = 0;
	private pages = 2;

	/** 正在触屏上的手指。笔用来写，手指用来滚 —— 跟 Notability 一样。 */
	private touches = new Map<number, { x: number; y: number }>();
	private pinch: { d: number; cx: number; cy: number; zoom: number } | null = null;
	private panFrom: { x: number; y: number } | null = null;
	/** 最近几次平移的采样，抬手时用来估算甩动速度 */
	private velSamples: { t: number; x: number; y: number }[] = [];
	private glideRaf = 0;
	private clip!: HTMLDivElement;
	private sbar!: HTMLDivElement;
	private sbarTimer = 0;

	constructor(leaf: WorkspaceLeaf, plugin: HandwritingPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getIcon() { return "pen-tool"; }
	getDisplayText() { return this.file?.basename.replace(/\.hw$/, "") ?? "手写笔记"; }

	/* ================= TextFileView 约定 ================= */

	getViewData(): string { return serialize(this.doc); }

	setViewData(data: string, clear: boolean) {
		if (clear) this.undoStack = [];
		this.doc = parse(data);
		if (!this.doc.title) this.doc.title = this.getDisplayText();
		this.cur = null;
		this.lasso = null;
		this.resize();
	}

	clear() {
		this.doc = { title: "", strokes: [], items: [], regions: [] };
		this.undoStack = [];
		this.cur = null;
		this.lasso = null;
	}

	/* ================= 生命周期 ================= */

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("hw-root");

		try {
			root.setAttribute("style", S.root);
			this.surface = root.createDiv({ attr: { style: S.surface } });
			this.base = this.surface.createEl("canvas", { attr: { style: S.canvas } });
			this.live = this.surface.createEl("canvas", { attr: { style: S.canvas } });
			this.clip = this.surface.createDiv({ attr: { style: S.overlayClip } });
			this.overlay = this.clip.createDiv({ attr: { style: S.overlay } });
			this.sbar = this.surface.createDiv({ attr: { style: S.scrollbar } });
			this.bctx = this.base.getContext("2d")!;
			// desynchronized：跳过常规的 DOM 合成，画布缓冲尽量直送显示控制器。
			// 只对正在写的那一层用 —— 延迟只在这层有意义，底层反而要稳定。
			this.lctx = this.live.getContext("2d",
				this.plugin.settings.lowLatency ? { desynchronized: true } : {}) as CanvasRenderingContext2D;
			this.lowLatency = !!this.lctx.getContextAttributes?.().desynchronized;

			this.tools = root.createDiv({ attr: { style: S.tools } });
			this.buildToolbar(this.tools);
			this.bindPointer();

			this.ro = new ResizeObserver(() => { this.applyLayout(); this.resize(); });
			this.ro.observe(root);
			this.applyLayout();
			this.resize();
		} catch (e) {
			root.setAttribute("style", "padding:16px;overflow:auto;-webkit-user-select:text;user-select:text;");
			root.empty();
			root.createEl("h3", { text: "手写视图加载失败" });
			root.createEl("pre", {
				text: String((e as Error)?.stack || e),
				attr: { style: "white-space:pre-wrap;font-size:12px;" },
			});
		}
	}

	private applyLayout() {
		if (!this.tools) return;
		const narrow = this.contentEl.clientWidth < 420;
		if (narrow === this.narrow) return;
		this.narrow = narrow;
		this.contentEl.setAttribute("style", narrow ? S.rootNarrow : S.root);
		this.tools.setAttribute("style", narrow ? S.toolsNarrow : S.tools);
		for (const d of this.seps) d.setAttribute("style", narrow ? S.sepNarrow : S.sep);
	}

	async onClose() {
		this.ro?.disconnect();
		window.clearTimeout(this.sbarTimer);
		this.clearLongPress();
		this.stopGlide();
	}

	/* ================= 工具栏 ================= */

	private buildToolbar(bar: HTMLDivElement) {
		bar.empty();
		this.seps = [];

		const btn = (icon: keyof typeof ICONS, title: string, cb: () => void) => {
			const b = bar.createEl("button", { attr: { "aria-label": title, title, style: S.btn } });
			drawIcon(b, icon);
			b.addEventListener("click", cb);
			return b;
		};
		const sep = () => this.seps.push(bar.createDiv({ attr: { style: this.narrow ? S.sepNarrow : S.sep } }));

		const penBtn = btn("pen", "笔", () => { this.tool = "pen"; sync(); });
		const eraBtn = btn("eraser", "橡皮（整笔擦除）", () => { this.tool = "eraser"; sync(); });
		const lasBtn = btn("lasso", "套索：圈一块内容并命名", () => { this.tool = "lasso"; sync(); });
		sep();

		const sizeBtns = SIZES.map((sz) => {
			const b = bar.createEl("button", { attr: { "aria-label": `笔宽 ${sz}`, style: S.btn } });
			b.createDiv({ attr: { style: S.dot(sz + 4) } });
			b.addEventListener("click", () => { this.size = sz; sync(); });
			return b;
		});
		sep();

		const colorDots: HTMLElement[] = [];
		COLORS.forEach((c) => {
			const b = bar.createEl("button", { attr: { "aria-label": "颜色", style: S.btn } });
			colorDots.push(b.createDiv({ attr: { style: S.colorDot(c, false) } }));
			b.addEventListener("click", () => { this.color = c; sync(); });
		});
		sep();

		btn("fit", "适应页宽（重置缩放）", () => this.fitWidth());
		btn("undo", "撤销", () => this.undo());
		btn("code", "看 Markdown 源码", () => this.plugin.toMarkdown(this.leaf));

		// 版本号直接印在工具栏上 —— 隔着 iCloud 调试时，一眼就能确认跑的是哪个版本
		bar.createDiv({ text: "v" + this.plugin.manifest.version, attr: { style: S.version } });

		const sync = () => {
			penBtn.setAttribute("style", this.tool === "pen" ? S.btnOn : S.btn);
			eraBtn.setAttribute("style", this.tool === "eraser" ? S.btnOn : S.btn);
			lasBtn.setAttribute("style", this.tool === "lasso" ? S.btnOn : S.btn);
			sizeBtns.forEach((b, i) => b.setAttribute("style", SIZES[i] === this.size ? S.btnOn : S.btn));
			colorDots.forEach((d, i) => d.setAttribute("style", S.colorDot(COLORS[i], COLORS[i] === this.color)));
		};
		sync();
	}

	/* ================= 尺寸与坐标 ================= */

	/** 缩放 1 时一页宽铺满视口，左右各留 EDGE_PAD 的余量 ——
	 *  不留的话纸张外框正好压在屏幕最边缘，等于看不见。 */
	private get scale() {
		const w = Math.max(this.surface.clientWidth - EDGE_PAD * 2, 80);
		return (w / PAGE_W) * this.zoom;
	}
	private get viewW() { return this.surface.clientWidth / this.scale; }
	private get viewH() { return this.surface.clientHeight / this.scale; }
	private contentH() { return this.pages * PAGE_H; }

	private resize() {
		if (!this.surface) return;
		const r = this.surface.getBoundingClientRect();
		if (!r.width || !r.height) return;
		const dpr = window.devicePixelRatio || 1;
		for (const cv of [this.base, this.live]) {
			cv.width = Math.round(r.width * dpr);
			cv.height = Math.round(r.height * dpr);
			cv.style.width = r.width + "px";
			cv.style.height = r.height + "px";
		}
		this.recountPages();
		this.clampPan();
		this.redrawAll();
		this.rebuildOverlay();
	}

	/** 把「内容坐标 -> 设备像素」的平移和缩放一次性装进 context */
	private applyTransform(cx: CanvasRenderingContext2D) {
		const dpr = window.devicePixelRatio || 1;
		const s = this.scale * dpr;
		cx.setTransform(s, 0, 0, s, -this.panX * s, -this.panY * s);
		cx.lineCap = "round";
		cx.lineJoin = "round";
	}

	private toPage(e: { clientX: number; clientY: number; pressure?: number }) {
		const r = this.live.getBoundingClientRect();
		return {
			x: (e.clientX - r.left) / this.scale + this.panX,
			y: (e.clientY - r.top) / this.scale + this.panY,
			p: e.pressure ?? 0.5,
		};
	}

	/* ================= 分页：始终留一页空白 ================= */

	/** Notability 的做法：只要最后一页写上了东西，就再补一页。
	 *  这里直接从内容推导，不用单独存页数 —— 删掉内容页数也会跟着收回。 */
	private recountPages() {
		let maxY = 0;
		for (const st of this.doc.strokes) for (const p of st.pts) if (p.y > maxY) maxY = p.y;
		for (const g of this.doc.regions) {
			const b = polyBounds(g.path);
			maxY = Math.max(maxY, b.y + b.h);
		}
		this.pages = Math.max(2, Math.floor(Math.max(maxY, 0) / PAGE_H) + 2);
	}

	private clampPan() {
		const maxY = Math.max(0, this.contentH() - this.viewH);
		this.panY = Math.min(Math.max(this.panY, 0), maxY);
		if (PAGE_W <= this.viewW) this.panX = -(this.viewW - PAGE_W) / 2;   // 页比视口窄就居中
		else this.panX = Math.min(Math.max(this.panX, 0), PAGE_W - this.viewW);
	}

	private syncViewport() {
		this.clampPan();
		this.redrawAll();
		this.syncOverlayTransform();
		this.flashScrollbar();
	}

	private flashScrollbar() {
		const h = this.surface.clientHeight;
		const frac = Math.min(1, this.viewH / this.contentH());
		const barH = Math.max(24, h * frac);
		const top = (this.panY / Math.max(1, this.contentH() - this.viewH)) * (h - barH);
		this.sbar.style.height = barH + "px";
		this.sbar.style.top = (isFinite(top) ? Math.max(0, top) : 0) + "px";
		this.sbar.style.opacity = "0.45";
		window.clearTimeout(this.sbarTimer);
		this.sbarTimer = window.setTimeout(() => { this.sbar.style.opacity = "0"; }, 700);
	}

	private opts(): InkOpts {
		const s = this.plugin.settings;
		return { smooth: s.smooth, thin: s.thin, taper: s.taper, filter: s.filter };
	}

	/* ================= 画布渲染 ================= */

	private redrawAll() {
		if (!this.surface) return;
		const cx = this.bctx;
		cx.setTransform(1, 0, 0, 1, 0, 0);
		cx.clearRect(0, 0, this.base.width, this.base.height);
		this.applyTransform(cx);
		this.drawPages(cx);

		// 只画视口里的笔迹。多页文档下这一步省掉绝大部分工作。
		const top = this.panY - 40, bot = this.panY + this.viewH + 40;
		for (const st of this.doc.strokes) {
			const b = bboxOf(st);
			if (b.y1 < top || b.y0 > bot) continue;
			drawStroke(cx, st, this.opts(), true);
		}
		for (const g of this.doc.regions)
			this.drawRegionOutline(cx, g.path, g.id === this.selRegion ? "selected" : "idle");
		this.redrawLive();
	}

	/** 桌面底色 + 纸张 + 描边 + 分页线。
	 *  缩到比屏幕还小的时候，如果纸张没有边界，深色模式下根本分不清哪块是画布。 */
	private drawPages(cx: CanvasRenderingContext2D) {
		const st = getComputedStyle(this.contentEl);
		const pick = (name: string, fb: string) => st.getPropertyValue(name).trim() || fb;
		const page = pick("--background-primary", "#ffffff");
		const desk = pick("--background-secondary", "rgba(127,127,127,.12)");
		const border = pick("--background-modifier-border", "rgba(127,127,127,.45)");
		const faint = pick("--text-faint", "rgba(127,127,127,.5)");
		const H = this.contentH();

		// 纸张外面是"桌面"，铺满整个视口
		cx.fillStyle = desk;
		cx.fillRect(this.panX - 8, this.panY - 8, this.viewW + 16, this.viewH + 16);

		// 纸张本身。只画视口附近那一段，长文档不必整张铺
		const y0 = Math.max(0, this.panY - 60), y1 = Math.min(H, this.panY + this.viewH + 60);
		if (y1 > y0) {
			cx.fillStyle = page;
			cx.fillRect(0, y0, PAGE_W, y1 - y0);
		}

		cx.save();
		// 分页虚线
		cx.strokeStyle = border;
		cx.lineWidth = 1 / this.scale;
		cx.setLineDash([8 / this.scale, 6 / this.scale]);
		const from = Math.max(1, Math.floor(this.panY / PAGE_H));
		const to = Math.min(this.pages, Math.ceil((this.panY + this.viewH) / PAGE_H) + 1);
		for (let k = from; k < to; k++) {
			const y = k * PAGE_H;
			cx.beginPath(); cx.moveTo(0, y); cx.lineTo(PAGE_W, y); cx.stroke();
		}
		cx.setLineDash([]);

		// 纸张外框：整个文档一个矩形，超出视口的部分由 canvas 自己裁掉。
		// 用 --text-faint 而不是 border 色 —— 后者在深色主题下太淡，看不出纸张边界。
		cx.lineWidth = 2 / this.scale;
		cx.strokeStyle = faint;
		cx.strokeRect(0, 0, PAGE_W, H);

		// 页码
		cx.fillStyle = faint;
		cx.font = `${22 / this.scale}px sans-serif`;
		cx.textAlign = "right";
		for (let k = Math.max(0, from - 1); k < to; k++) {
			cx.fillText(`${k + 1} / ${this.pages}`, PAGE_W - 26, k * PAGE_H + 46);
		}
		cx.textAlign = "left";
		cx.restore();
	}

	private drawRegionOutline(
		cx: CanvasRenderingContext2D,
		path: [number, number][],
		mode: "idle" | "drawing" | "selected",
	) {
		if (path.length < 2) return;
		cx.save();
		const sel = mode === "selected";
		cx.setLineDash(mode === "drawing" ? [] : [sel ? 9 / this.scale : 7 / this.scale, 6 / this.scale]);
		cx.lineWidth = (sel ? 3 : 2) / this.scale;
		// 未选中是暗蓝细虚线，选中变亮蓝加粗 —— 一眼要能看出状态差别
		cx.strokeStyle = mode === "idle" ? "rgba(78,96,180,.42)" : "rgba(70,135,255,1)";
		pathToCanvas(cx, path);
		if (mode !== "drawing") {
			cx.fillStyle = sel ? "rgba(70,135,255,.16)" : "rgba(78,96,180,.05)";
			cx.fill();
		}
		cx.stroke();
		cx.restore();
	}

	private redrawLive() {
		if (!this.surface) return;
		this.lctx.setTransform(1, 0, 0, 1, 0, 0);
		this.lctx.clearRect(0, 0, this.live.width, this.live.height);
		this.applyTransform(this.lctx);
		if (this.cur) {
			// 预测点只画不存 —— 下一批真实采样到达时它们就被丢弃重算
			const ahead = this.drawing ? predictTip(this.cur.pts, this.plugin.settings.predict) : [];
			const s = ahead.length ? { ...this.cur, pts: this.cur.pts.concat(ahead) } : this.cur;
			drawStroke(this.lctx, s, this.opts(), false);
		}
		if (this.lasso && this.lasso.length > 1) this.drawRegionOutline(this.lctx, this.lasso, "drawing");
	}

	/** 直接在事件里画，不等 requestAnimationFrame —— 那要多等最多一整帧。
	 *  合并事件本来就是一帧一批，所以重绘次数不会变多，只是早了一帧。 */
	private schedule() { this.redrawLive(); }

	/* ================= 输入 ================= */

	/* 职责划分：
	 *   笔    —— 只写字。不选中、不拖动、不长按弹菜单。
	 *            我们的套索是**持久存在的命名区域**，不是一次性选区，
	 *            拿笔在圈里点几个点是常态操作，不能因此就把圈选中了。
	 *   手指  —— 只操作。轻点选中/取消、拖已选中的圈、平移、双指缩放。永远不画。
	 *   鼠标  —— 桌面端没有手指，所以两样都干。
	 */
	private bindPointer() {
		const el = this.live;

		this.registerDomEvent(el, "pointerdown", (e: PointerEvent) => {
			const finger = e.pointerType === "touch";

			if (finger && !this.plugin.settings.allowFinger) {
				// 笔已经落下时，手掌一律无视 —— 否则写字时手掌搭上去页面就滚了
				if (this.drawing) return;
				this.stopGlide();
				this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
				el.setPointerCapture(e.pointerId);
				if (this.touches.size >= 2) { this.panFrom = null; this.fingerOn = null; return; }

				const p = this.toPage(e);
				this.tap = { x: e.clientX, y: e.clientY, finger: true };
				this.armLongPress(p.x, p.y, true);

				// 按在任何圈上 -> 准备拖它，否则准备平移。
				// 不要求"先选中才能拖"—— 那是我自己加的前提，手指按上去就该能拖。
				// 两者都要等移动超过死区才真正开始，这样轻点不会被误判成拖动。
				const hit = this.regionAt(p.x, p.y);
				this.lastTouchInfo = hit
					? `按在「${hit.name}」上，待拖动`
					: `按在空白处，待平移（当前选中：${this.selRegion ?? "无"}）`;
				if (hit) {
					this.fingerOn = { id: hit.id, x: e.clientX, y: e.clientY };
					this.panFrom = null;
				} else {
					this.fingerOn = null;
					this.panFrom = { x: e.clientX, y: e.clientY };
					this.velSamples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
					this.panMoved = false;
				}
				return;
			}

			e.preventDefault();
			// 笔落下时接管一切：丢掉正在进行的手指平移
			if (!finger) { this.stopGlide(); this.touches.clear(); this.panFrom = null; this.pinch = null; }
			el.setPointerCapture(e.pointerId);
			const pt = this.toPage(e);

			if (this.tool === "eraser") { this.drawing = true; this.eraseAt(pt.x, pt.y); return; }
			if (this.tool === "lasso") {
				// 套索工具下永远是画新圈 —— 否则外圈选中时就没法在它内部再圈一个
				this.drawing = true;
				this.lastT = e.timeStamp;
				this.lasso = [[pt.x, pt.y]];
				this.schedule();
				return;
			}

			// 鼠标兼任"手指"：可以轻点选中、可以拖已选中的圈。笔不行。
			if (e.pointerType !== "pen") {
				this.tap = { x: e.clientX, y: e.clientY, finger: false };
				const hit = this.regionAt(pt.x, pt.y);
				if (hit && hit.id === this.selRegion) { this.startRegionDrag(hit.id, pt.x, pt.y); return; }
			}

			this.drawing = true;
			this.lastT = e.timeStamp;
			this.evtStamps.length = 0;
			this.cur = { c: this.color, s: this.size, pts: [pt] };
			this.schedule();
		});

		this.registerDomEvent(el, "pointermove", (e: PointerEvent) => {
			if (this.tap && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > (this.tap.finger ? 16 : 6)) {
				this.tap = null;
				this.clearLongPress();
			}

			// 拖动区域（手指和鼠标共用这一段，所以放在触摸分支之前）
			if (this.regionDrag) {
				e.preventDefault();
				const g = this.doc.regions.find((r) => r.id === this.regionDrag!.id);
				if (!g) return;
				const p = this.toPage(e);
				const dx = p.x - this.regionDrag.ox, dy = p.y - this.regionDrag.oy;
				if (Math.abs(dx) + Math.abs(dy) > 1.5) this.regionDrag.moved = true;
				this.moveRegion(g, dx, dy);
				this.regionDrag.dx += dx; this.regionDrag.dy += dy;
				this.regionDrag.ox = p.x; this.regionDrag.oy = p.y;
				this.redrawAll();
				this.rebuildOverlay();
				return;
			}

			if (this.touches.has(e.pointerId)) {
				this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
				if (this.touches.size >= 2) { this.handlePinch(); return; }

				// 手指按在已选中的圈上，移动超过死区就开始拖它
				if (this.fingerOn) {
					if (Math.hypot(e.clientX - this.fingerOn.x, e.clientY - this.fingerOn.y) < 4) return;
					const p = this.toPage(e);
					const id = this.fingerOn.id;
					this.fingerOn = null;
					if (this.selRegion !== id) this.select(id);   // 拖谁就选中谁，给个反馈
					this.startRegionDrag(id, p.x, p.y);
					this.lastTouchInfo += " -> 已开始拖动";
					return;
				}
				if (this.panFrom) {
					// 死区：没超过这点距离就不当平移，否则手指微抖会把画面挪走
					if (!this.panMoved) {
						if (Math.hypot(e.clientX - this.panFrom.x, e.clientY - this.panFrom.y) < 4) return;
						this.panMoved = true;
					}
					this.panX -= (e.clientX - this.panFrom.x) / this.scale;
					this.panY -= (e.clientY - this.panFrom.y) / this.scale;
					this.panFrom = { x: e.clientX, y: e.clientY };
					this.velSamples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
					if (this.velSamples.length > 8) this.velSamples.shift();
					this.syncViewport();
					return;
				}
				if (!this.plugin.settings.allowFinger) return;
			}

			if (!this.drawing) return;
			e.preventDefault();
			if (this.tool === "eraser") { const p = this.toPage(e); this.eraseAt(p.x, p.y); return; }

			// iPadOS 上相邻两次 pointermove 的合并窗口会重叠，按时间戳严格递增去重
			const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
			const fresh: PointerEvent[] = [];
			for (const ev of evs) {
				if (ev.timeStamp <= this.lastT) continue;
				this.lastT = ev.timeStamp;
				fresh.push(ev);
			}
			if (!fresh.length && e.timeStamp > this.lastT) { this.lastT = e.timeStamp; fresh.push(e); }
			this.evtStamps.push(performance.now());
			if (this.evtStamps.length > 40) this.evtStamps.shift();

			if (this.tool === "lasso") {
				for (const ev of fresh) { const p = this.toPage(ev); this.lasso?.push([p.x, p.y]); }
			} else if (this.cur) {
				for (const ev of fresh) this.cur.pts.push(this.toPage(ev));
			}
			this.schedule();
		});

		const end = (e: PointerEvent) => {
			this.clearLongPress();
			const wasTap = this.tap;
			this.tap = null;
			this.fingerOn = null;

			const wasFinger = this.touches.delete(e.pointerId);
			if (wasFinger) {
				if (this.touches.size < 2) this.pinch = null;
				this.panFrom = this.touches.size === 1 ? { ...[...this.touches.values()][0] } : null;
			}

			// 区域拖动收尾
			if (this.regionDrag) {
				const d = this.regionDrag;
				this.regionDrag = null;
				if (d.moved) {
					this.undoStack.push({
						kind: "region-move", id: d.id, dx: d.dx, dy: d.dy,
						strokes: [...this.strokesInRegionBefore],
					});
					this.recountPages();
					this.requestSave();
				}
				return;
			}

			// 轻点：选中 / 取消选中。笔永远走不到这里，它从不设置 this.tap
			if (wasTap) {
				const p = this.toPage(e);
				this.handleTap(p.x, p.y);
				return;
			}

			if (wasFinger) {
				if (this.touches.size === 0 && this.panMoved) this.startGlide();
				if (!this.plugin.settings.allowFinger) return;
			}

			if (!this.drawing) return;
			this.drawing = false;
			if (this.tool === "lasso") { this.finishLasso(); return; }
			if (this.cur && this.cur.pts.length) {
				this.doc.strokes.push(this.cur);
				this.undoStack.push({ kind: "stroke-add", index: this.doc.strokes.length - 1 });
				drawStroke(this.bctx, this.cur, this.opts(), true);
				this.cur = null;
				this.redrawLive();
				this.growPages();
				this.requestSave();
			}
			this.cur = null;
		};
		this.registerDomEvent(el, "pointerup", end);
		this.registerDomEvent(el, "pointercancel", end);
		this.registerDomEvent(el, "touchstart", (ev: TouchEvent) => ev.preventDefault());
		this.registerDomEvent(el, "contextmenu", (ev: Event) => ev.preventDefault());

		// 桌面端：滚轮滚动，Ctrl/⌘ + 滚轮以指针为中心缩放
		this.registerDomEvent(el, "wheel", (e: WheelEvent) => {
			e.preventDefault();
			this.stopGlide();
			if (e.ctrlKey || e.metaKey) {
				const p = this.toPage(e);
				this.setZoom(this.zoom * Math.exp(-e.deltaY / 300), p.x, p.y, e.clientX, e.clientY);
			} else {
				this.panY += e.deltaY / this.scale;
				this.panX += e.deltaX / this.scale;
				this.syncViewport();
			}
		});
	}

	/** 命中判定，两条规则，顺序不能反：
	 *
	 *  1. 「在里面」优先于「在旁边」—— 只要点落在某个圈内部，就在这些圈里挑，
	 *     绝不会被旁边一个轮廓碰巧更近的圈抢走。
	 *  2. 内部有多个（嵌套）时选**面积最小**的，也就是最内层。外圈仍然选得到：
	 *     点它轮廓上，或者点内层没盖住的地方。
	 *
	 *  都没进到，才退而求其次找容差内轮廓最近的。同一位置反复点结果不变。 */
	private regionAt(x: number, y: number, tol = 16): Region | null {
		let inner: Region | null = null, innerArea = Infinity;
		let near: Region | null = null, nearD = Infinity;

		for (const g of this.doc.regions) {
			if (g.path.length < 3) continue;
			if (pointInPoly(g.path, x, y)) {
				const a = polyArea(g.path);
				if (a < innerArea) { innerArea = a; inner = g; }
			} else {
				const d = distToPoly(g.path, x, y);
				if (d <= tol && d < nearD) { nearD = d; near = g; }
			}
		}

		const hit = inner ?? near;
		this.lastHitInfo = `(${x.toFixed(0)},${y.toFixed(0)}) 共 ${this.doc.regions.length} 个区域 -> `
			+ (hit ? `命中「${hit.name}」(${inner ? "圈内" : `轮廓 ${nearD.toFixed(0)} 单位`})` : "未命中");
		return hit;
	}

	private lastHitInfo = "还没点过";
	private lastTouchInfo = "还没碰过";

	private select(id: string | null, opts = false) {
		if (this.selRegion === id && this.showOpts === opts) return;
		this.selRegion = id;
		this.showOpts = id ? opts : false;
		this.redrawAll();
		this.rebuildOverlay();
	}

	/** 轻点：点在圈上（或标签上）就选中它，点空白就取消。圈和标签是同一个东西。 */
	private handleTap(x: number, y: number) {
		const hit = this.regionAt(x, y);
		this.select(hit ? hit.id : null);
	}

	private armLongPress(x: number, y: number, allow: boolean) {
		this.clearLongPress();
		if (!allow) return;
		this.lpTimer = window.setTimeout(() => {
			this.lpTimer = 0;
			if (!this.tap) return;              // 已经移动了，不算长按
			const hit = this.regionAt(x, y);
			if (!hit) return;
			this.tap = null;                    // 长按已经处理，抬手时不要再当轻点
			this.drawing = false;
			this.cur = null;
			this.redrawLive();
			this.select(hit.id, true);
		}, 480);
	}

	private clearLongPress() {
		if (this.lpTimer) { window.clearTimeout(this.lpTimer); this.lpTimer = 0; }
	}

	/** 开始拖动某个区域（手指和鼠标共用） */
	private startRegionDrag(id: string, x: number, y: number) {
		const g = this.doc.regions.find((r) => r.id === id);
		if (!g) return;
		this.drawing = false;
		this.cur = null;
		this.strokesInRegionBefore = this.doc.strokes
			.map((st, i) => (strokeInRegion(st, g) ? i : -1))
			.filter((i) => i >= 0);
		this.regionDrag = { id, ox: x, oy: y, dx: 0, dy: 0, moved: false };
	}

	/** 拖动区域时圈里的笔迹跟着一起走 —— 否则圈移开之后框住的就是别的内容，
	 *  [[笔记#区域名]] 引用到的东西会莫名其妙变掉。 */
	private moveRegion(g: Region, dx: number, dy: number) {
		for (const pt of g.path) { pt[0] += dx; pt[1] += dy; }
		for (const i of this.strokesInRegionBefore) {
			for (const p of this.doc.strokes[i].pts) { p.x += dx; p.y += dy; }
		}
	}
	private strokesInRegionBefore: number[] = [];

	private stopGlide() {
		if (this.glideRaf) { cancelAnimationFrame(this.glideRaf); this.glideRaf = 0; }
	}

	/** 惯性滚动：抬手后按指数衰减继续滑，撞到边界就停。
	 *  没有这个，手一停画面就死住，手感很硬 —— 浏览器和所有原生列表都有这个减速过程。 */
	private startGlide() {
		const s = this.velSamples;
		if (s.length < 2) return;
		const last = s[s.length - 1];
		let first = s[0];
		for (let i = s.length - 1; i >= 0; i--) {
			if (last.t - s[i].t <= 90) first = s[i]; else break;   // 只用最后 90ms，避免被早期慢速拖累
		}
		const dt = last.t - first.t;
		if (dt < 8) return;
		// 屏幕像素/ms -> 内容单位/ms（平移方向与手指相反）
		let vx = -(last.x - first.x) / dt / this.scale;
		let vy = -(last.y - first.y) / dt / this.scale;
		if (Math.hypot(vx, vy) < 0.03) return;

		let prev = performance.now();
		const step = () => {
			const now = performance.now();
			const d = Math.min(now - prev, 48);   // 掉帧时不要一下窜出去
			prev = now;
			const wantX = this.panX + vx * d, wantY = this.panY + vy * d;
			this.panX = wantX; this.panY = wantY;
			this.syncViewport();                  // 内部会 clamp
			if (Math.abs(this.panY - wantY) > 1e-6) vy = 0;   // 撞到上下边界
			if (Math.abs(this.panX - wantX) > 1e-6) vx = 0;
			const decay = Math.pow(0.9975, d);    // 约 1 秒滑停，跟 iOS 手感接近
			vx *= decay; vy *= decay;
			if (Math.hypot(vx, vy) < 0.015) { this.glideRaf = 0; return; }
			this.glideRaf = requestAnimationFrame(step);
		};
		this.glideRaf = requestAnimationFrame(step);
	}

	/** 双指缩放：让捏合中点下的那个内容点保持不动 */
	private handlePinch() {
		const [a, b] = [...this.touches.values()];
		const d = Math.hypot(a.x - b.x, a.y - b.y);
		const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
		if (!this.pinch) {
			const p = this.toPage({ clientX: mx, clientY: my });
			this.pinch = { d, cx: p.x, cy: p.y, zoom: this.zoom };
			return;
		}
		const z = this.pinch.zoom * (d / this.pinch.d);
		this.setZoom(z, this.pinch.cx, this.pinch.cy, mx, my);
	}

	/** 缩放到 z，并让内容点 (cx,cy) 停在屏幕坐标 (sx,sy) 处 */
	private setZoom(z: number, cx: number, cy: number, sx: number, sy: number) {
		this.zoom = Math.min(Math.max(z, 0.4), 6);
		const r = this.live.getBoundingClientRect();
		this.panX = cx - (sx - r.left) / this.scale;
		this.panY = cy - (sy - r.top) / this.scale;
		this.syncViewport();
	}

	private fitWidth() {
		this.zoom = 1;
		this.syncViewport();
	}

	/** 写到最后一页就再补一页，永远留一页空白 */
	private growPages() {
		const before = this.pages;
		this.recountPages();
		if (this.pages !== before) { this.clampPan(); this.redrawAll(); }
	}

	private eraseAt(x: number, y: number) {
		const removed: { index: number; stroke: Stroke }[] = [];
		for (let i = this.doc.strokes.length - 1; i >= 0; i--) {
			if (hitStroke(this.doc.strokes[i], x, y, 6)) {
				removed.push({ index: i, stroke: this.doc.strokes[i] });
				this.doc.strokes.splice(i, 1);
			}
		}
		if (!removed.length) return;
		this.undoStack.push({ kind: "stroke-del", items: removed });
		this.recountPages();
		this.redrawAll();
		this.requestSave();
	}

	/* ================= 套索 -> 命名区域 ================= */

	private finishLasso() {
		const path = this.lasso ?? [];
		this.lasso = null;
		this.redrawLive();
		const box = polyBounds(path);
		// 太小的圈当成误触；封闭由多边形本身保证（首尾自动相连）
		if (path.length < 8 || box.w < 12 || box.h < 12) { this.redrawLive(); return; }

		const taken = this.doc.regions.map((r) => r.name);
		new NameRegionModal(this.app, taken, (name) => {
			const region: Region = { id: newId(), name: sanitizeName(name), path };
			this.doc.regions.push(region);
			this.undoStack.push({ kind: "region-add", id: region.id });
			this.selRegion = region.id;
			this.showOpts = false;
			this.tool = "pen";
			this.buildToolbar(this.tools);
			this.recountPages();
			this.redrawAll();
			this.rebuildOverlay();
			this.requestSave();
			new Notice(`已创建区域「${region.name}」，可用 [[${this.linkBase()}#${region.name}]] 引用`);
		}, () => { this.redrawLive(); }).open();
	}

	private linkBase() { return this.file?.basename ?? ""; }

	/* ================= 画布上的元素层 ================= */

	private syncOverlayTransform() {
		if (!this.overlay) return;
		const s = this.scale;
		this.overlay.style.transform =
			`translate(${(-this.panX * s).toFixed(2)}px, ${(-this.panY * s).toFixed(2)}px) scale(${s})`;
		// 浮动 UI 抵消掉整体缩放，否则放大画布时按钮会跟着变成巨无霸
		const k = (1 / s).toFixed(4);
		for (const el of this.counterScaled) el.style.transform = `scale(${k})`;
	}

	private rebuildOverlay() {
		if (!this.overlay) return;
		this.syncOverlayTransform();
		this.overlay.empty();
		this.counterScaled = [];
		for (const g of this.doc.regions) this.renderRegionTag(g);
		this.syncOverlayTransform();
	}

	private renderRegionTag(g: Region) {
		const box = polyBounds(g.path);
		const sel = g.id === this.selRegion;
		const bar = this.overlay.createDiv({ attr: { style: S.regionBar } });
		bar.style.left = box.x + "px";
		bar.style.top = box.y + "px";
		this.counterScaled.push(bar);

		const name = bar.createDiv({
			text: g.name || "(未命名)",
			attr: { style: sel ? S.regionNameOn : S.regionName },
		});
		// 标签和圈是同一个东西：点一下选中，长按弹选项
		let lp = 0, tapAt: { x: number; y: number } | null = null;
		name.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			tapAt = { x: e.clientX, y: e.clientY };
			lp = window.setTimeout(() => { lp = 0; tapAt = null; this.select(g.id, true); }, 480);
		});
		name.addEventListener("pointermove", (e: PointerEvent) => {
			if (tapAt && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) > 8) {
				tapAt = null;
				if (lp) { window.clearTimeout(lp); lp = 0; }
			}
		});
		const nameUp = (e: PointerEvent) => {
			e.stopPropagation();
			if (lp) { window.clearTimeout(lp); lp = 0; }
			if (tapAt) { tapAt = null; this.select(sel ? null : g.id); }
		};
		name.addEventListener("pointerup", nameUp);
		name.addEventListener("pointercancel", () => {
			if (lp) { window.clearTimeout(lp); lp = 0; }
			tapAt = null;
		});

		if (!sel || !this.showOpts) return;

		const btn = (icon: "rename" | "copy" | "trash", title: string, cb: () => void) => {
			const b = bar.createEl("button", { attr: { "aria-label": title, title, style: S.regionBtn } });
			drawIcon(b, icon, 16);
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
		};

		btn("rename", "重命名", () => {
			const taken = this.doc.regions.filter((r) => r.id !== g.id).map((r) => r.name);
			new NameRegionModal(this.app, taken, (n) => {
				g.name = sanitizeName(n);
				this.rebuildOverlay();
				this.requestSave();
			}, () => {}).open();
		});
		btn("copy", "复制 ![[...]] 引用", () => {
			navigator.clipboard?.writeText(`![[${this.linkBase()}#${g.name}]]`);
			new Notice("已复制引用");
		});
		btn("trash", "删除区域", () => {
			const i = this.doc.regions.findIndex((r) => r.id === g.id);
			if (i < 0) return;
			this.undoStack.push({ kind: "region-del", index: i, region: this.doc.regions[i] });
			this.doc.regions.splice(i, 1);
			this.selRegion = null;
			this.showOpts = false;
			this.redrawAll();
			this.rebuildOverlay();
			this.requestSave();
			new Notice(`已删除区域「${g.name}」`);
		});
	}

	/* ================= 撤销 ================= */

	undo() {
		const e = this.undoStack.pop();
		if (!e) { new Notice("没有可撤销的操作"); return; }
		switch (e.kind) {
			case "stroke-add": this.doc.strokes.splice(e.index, 1); break;
			case "stroke-del": for (const it of [...e.items].reverse()) this.doc.strokes.splice(it.index, 0, it.stroke); break;
			case "region-add": this.doc.regions = this.doc.regions.filter((x) => x.id !== e.id); break;
			case "region-del": this.doc.regions.splice(e.index, 0, e.region); break;
			case "region-move": {
				const g = this.doc.regions.find((r) => r.id === e.id);
				if (g) {
					for (const pt of g.path) { pt[0] -= e.dx; pt[1] -= e.dy; }
					for (const i of e.strokes) {
						const st = this.doc.strokes[i];
						if (st) for (const p of st.pts) { p.x -= e.dx; p.y -= e.dy; }
					}
				}
				break;
			}
		}
		this.recountPages();
		this.clampPan();
		this.redrawAll();
		this.rebuildOverlay();
		this.requestSave();
	}

	/* ================= 诊断 / 刷新 ================= */

	diagnostics(): Record<string, string> {
		const cs = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : "—");
		const root = this.contentEl;
		return {
			"contentEl class": root.className || "(空)",
			"root display / dir": cs(root, "display") + " / " + cs(root, "flex-direction"),
			"root 尺寸": `${root.clientWidth} x ${root.clientHeight}`,
			"tools 尺寸": this.tools ? `${this.tools.clientWidth} x ${this.tools.clientHeight}` : "—",
			"tools 子元素": this.tools ? String(this.tools.childElementCount) : "—",
			"窄屏模式": String(this.narrow),
			"上次点击判定": this.lastHitInfo,
			"上次手指按下": this.lastTouchInfo,
			"当前选中区域": this.selRegion
				? (this.doc.regions.find((r) => r.id === this.selRegion)?.name ?? "?") : "无",
			"页数 / 缩放": `${this.pages} 页 / ${(this.zoom * 100).toFixed(0)}%`,
			"滚动位置": `${this.panY.toFixed(0)} / ${this.contentH()}`,
			"低延迟画布": this.lowLatency ? "desynchronized 生效" : "常规合成",
			"合并事件 API": typeof PointerEvent.prototype.getCoalescedEvents === "function" ? "有" : "无",
			"预测 API": typeof (PointerEvent.prototype as any).getPredictedEvents === "function" ? "有" : "无（自己外推）",
			"事件频率": this.evtStamps.length > 5
				? (1000 * (this.evtStamps.length - 1) /
					(this.evtStamps[this.evtStamps.length - 1] - this.evtStamps[0])).toFixed(0) + " Hz"
				: "先写一笔",
			"笔迹 / 区域": `${this.doc.strokes.length} / ${this.doc.regions.length}`,
		};
	}

	refresh() { this.resize(); }
}

/** 笔迹包围盒。多页文档下用来剔除视口外的笔迹，缓存在笔迹对象上。 */
const bboxCache = new WeakMap<Stroke, { y0: number; y1: number }>();
function bboxOf(st: Stroke) {
	let b = bboxCache.get(st);
	if (b && (st as unknown as { _n?: number })._n === st.pts.length) return b;
	let y0 = Infinity, y1 = -Infinity;
	for (const p of st.pts) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
	b = { y0: isFinite(y0) ? y0 : 0, y1: isFinite(y1) ? y1 : 0 };
	bboxCache.set(st, b);
	(st as unknown as { _n?: number })._n = st.pts.length;
	return b;
}
