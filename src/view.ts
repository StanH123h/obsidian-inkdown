import { Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import {
	InkOpts, PAGE_H, PAGE_W, Region, Stroke,
	distToPoly, drawStroke, erasePrecise, hitStroke, pathToCanvas, strokeInRegion, pointInPoly, polyArea, polyBounds, predictTip,
} from "./ink";
import { HwDoc, LinkItem, newId, parse, sanitizeName, serialize } from "./format";
import { renderResolved, resolveTarget } from "./embed";
import { LinkModal, NameRegionModal } from "./modals";
import { ICONS, S, drawIcon } from "./styles";
import { t } from "./i18n";
import type HandwritingPlugin from "./main";

/** Injected by esbuild at build time; see esbuild.config.mjs */
declare const __HW_VERSION__: string;

export const VIEW_TYPE = "handwriting-view";

const EDGE_PAD = 12;   // css px

/** Diameter of the preview dot on a width button, capped so it fits the button */
const dotPx = (sz: number) => Math.min(sz + 4, 28);

const COLORS = ["#1a1a1a", "#c0392b", "#2d6ca8", "#1a7f37"];

/** "lasso" selects and manipulates content; "wiki" draws the named regions that
 *  [[note#region]] resolves to. Same drawing gesture, different meaning. */
type Tool = "pen" | "eraser" | "lasso" | "wiki";

type UndoEntry =
	| { kind: "stroke-add"; index: number }
	| { kind: "stroke-del"; items: { index: number; stroke: Stroke }[] }
	| { kind: "strokes-set"; before: Stroke[] }
	| { kind: "item-add"; id: string }
	| { kind: "item-del"; index: number; item: LinkItem }
	| { kind: "region-add"; id: string }
	| { kind: "region-del"; index: number; region: Region }
	| { kind: "region-move"; id: string; dx: number; dy: number }
	| { kind: "sel-move"; strokes: Stroke[]; dx: number; dy: number };

export class HandwritingView extends TextFileView {
	private plugin: HandwritingPlugin;

	private surface!: HTMLDivElement;
	private base!: HTMLCanvasElement;
	private live!: HTMLCanvasElement;
	private overlay!: HTMLDivElement;
	private bctx!: CanvasRenderingContext2D;
	private lctx!: CanvasRenderingContext2D;
	private tools!: HTMLDivElement;
	/** Left-hand bar showing configuration for whichever tool is active */
	private ctxBar!: HTMLDivElement;
	private syncCtx: (() => void) | null = null;
	/** Where the eraser is, for the size preview ring */
	private eraserAt: { x: number; y: number } | null = null;
	/** Strokes as they were when an erase gesture began, so one drag is one undo */
	private eraseSnap: Stroke[] | null = null;
	/** Transient lasso selection: a ring plus the strokes it caught. Never saved. */
	private sel: { path: [number, number][]; strokes: Stroke[]; showOpts: boolean } | null = null;
	private selDrag: { ox: number; oy: number; dx: number; dy: number; moved: boolean } | null = null;
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
	/** Which of the three width slots is active. The widths themselves live in
	 *  settings, so they survive a restart and follow the vault across devices. */
	private sizeIdx = 1;

	private get sizes() { return this.plugin.settings.sizes; }
	private get size() { return this.sizes[this.sizeIdx] ?? 8; }
	private undoStack: UndoEntry[] = [];

	/** Id of the selected region. Tap empty space to clear it. */
	private selRegion: string | null = null;
	private regionDrag: { id: string; ox: number; oy: number; dx: number; dy: number; moved: boolean } | null = null;
	/** Floating UI that must be counter-scaled: buttons should not grow with zoom */
	private counterScaled: HTMLElement[] = [];
	/** Whether the option bar is open. Only a long press opens it; a plain tap
	 *  just selects. */
	private showOpts = false;
	/** Tap detection: recorded on press, discarded once movement passes the
	 *  threshold, because that is a stroke or a pan rather than a tap */
	private tap: { x: number; y: number; finger: boolean } | null = null;
	private lpTimer = 0;
	private panMoved = false;
	/** A finger is resting on a region; the drag starts once it leaves the dead zone */
	private fingerOn: { id: string; x: number; y: number } | null = null;

	/* Viewport: zoom and pan. Ink coordinates are always content units,
	   independent of the screen. */
	private zoom = 1;
	private panX = 0;
	private panY = 0;
	private pages = 2;

	/** Fingers currently on the screen. Pen writes, finger scrolls, as in Notability. */
	private touches = new Map<number, { x: number; y: number }>();
	private pinch: { d: number; cx: number; cy: number; zoom: number } | null = null;
	private panFrom: { x: number; y: number } | null = null;
	/** Recent pan samples, used to estimate flick velocity when the finger lifts */
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
	getDisplayText() { return this.file?.basename.replace(/\.hw$/, "") ?? t("view.title"); }

	/* ============ TextFileView contract ============ */

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

	/* ============ Lifecycle ============ */

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
			// desynchronized skips the usual DOM compositing and sends the canvas
			// buffer as directly to the display controller as it can. Only the layer
			// being drawn on wants this; latency matters there, stability below.
			this.lctx = this.live.getContext("2d",
				this.plugin.settings.lowLatency ? { desynchronized: true } : {}) as CanvasRenderingContext2D;
			this.lowLatency = !!this.lctx.getContextAttributes?.().desynchronized;

			this.ctxBar = root.createDiv({ attr: { style: S.ctxBar } });
			this.tools = root.createDiv({ attr: { style: S.tools } });
			this.buildToolbar(this.tools);
			this.buildContextBar();
			this.bindPointer();

			this.ro = new ResizeObserver(() => { this.applyLayout(); this.resize(); });
			this.ro.observe(root);        // decides the narrow layout
			this.ro.observe(this.surface); // decides the canvas size
			this.ro.observe(this.tools);   // wraps to two columns, moving the context bar
			this.applyLayout();
			this.resize();
		} catch (e) {
			root.setAttribute("style", "padding:16px;overflow:auto;-webkit-user-select:text;user-select:text;");
			root.empty();
			root.createEl("h3", { text: t("view.loadFailed") });
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
		if (this.ctxBar?.isConnected) this.ctxBar.setAttribute("style", narrow ? S.ctxBarNarrow : S.ctxBar);
		for (const d of this.seps) d.setAttribute("style", narrow ? S.sepNarrow : S.sep);
		if (this.ctxBar) this.buildContextBar();
	}

	async onClose() {
		this.ro?.disconnect();
		window.clearTimeout(this.sbarTimer);
		this.clearLongPress();
		this.stopGlide();
	}

	/* ============ Toolbar ============ */

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

		const penBtn = btn("pen", t("tool.pen"), () => { this.tool = "pen"; this.eraserAt = null; this.clearSelection(); sync(); this.buildContextBar(); this.redrawLive(); });
		const eraBtn = btn("eraser", t("tool.eraser"), () => { this.tool = "eraser"; this.clearSelection(); sync(); this.buildContextBar(); });
		const lasBtn = btn("lasso", t("tool.lasso"), () => { this.tool = "lasso"; this.eraserAt = null; sync(); this.buildContextBar(); this.redrawLive(); });
		const wikiBtn = btn("lasso", t("tool.wiki"), () => { this.tool = "wiki"; this.eraserAt = null; this.clearSelection(); sync(); this.buildContextBar(); this.redrawLive(); });
		wikiBtn.createDiv({ text: "Wiki", attr: { style: S.btnBadge } });
		sep();

		btn("fit", t("tool.fit"), () => this.fitWidth());
		btn("link", t("tool.link"), () => this.addLink());
		btn("undo", t("tool.undo"), () => this.undo());
		btn("code", t("tool.source"), () => this.plugin.toMarkdown(this.leaf));

		// The version is printed on the toolbar: when debugging across iCloud it is
		// the fastest way to confirm which build is actually running. It comes from
		// the bundle, not from manifest.json, because those are separate files and
		// a sync service can deliver them at different times.
		bar.createDiv({ text: "v" + __HW_VERSION__, attr: { style: S.version } });

		const sync = () => {
			penBtn.setAttribute("style", this.tool === "pen" ? S.btnOn : S.btn);
			eraBtn.setAttribute("style", this.tool === "eraser" ? S.btnOn : S.btn);
			lasBtn.setAttribute("style", this.tool === "lasso" ? S.btnOn : S.btn);
			wikiBtn.setAttribute("style", this.tool === "wiki" ? S.btnOn : S.btn);
		};
		sync();
	}

	/* ============ Left context bar ============ */

	/** Notability's arrangement: the right bar picks a tool and never changes,
	 *  the left bar shows that tool's configuration. */
	/** Park the context column against the tool bar. The tool bar's size is
	 *  content-driven -- it wraps into a second column when the buttons do not fit
	 *  -- so a hardcoded offset would overlap it or leave a gap. */
	private placeCtxBar() {
		if (!this.ctxBar?.isConnected || !this.tools) return;
		if (this.narrow) {
			this.ctxBar.style.bottom = this.tools.offsetHeight + "px";
			this.ctxBar.style.right = "";
		} else {
			this.ctxBar.style.right = this.tools.offsetWidth + "px";
			this.ctxBar.style.bottom = "";
		}
	}

	private buildContextBar() {
		const bar = this.ctxBar;
		if (!bar) return;
		bar.empty();
		this.syncCtx = null;

		// Neither lasso has anything to configure, so the column is detached from
		// the DOM entirely rather than merely hidden. It is positioned absolutely,
		// floating over the canvas, so attaching and detaching it never resizes the
		// drawing area -- the canvas used to jump sideways by 72px each time.
		if (this.tool === "lasso" || this.tool === "wiki") { bar.remove(); return; }
		if (!bar.isConnected) {
			// Reapply the style: applyLayout skips the bar while it is detached
			bar.setAttribute("style", this.narrow ? S.ctxBarNarrow : S.ctxBar);
			this.contentEl.insertBefore(bar, this.tools);
		}
		this.placeCtxBar();
		const vert = !this.narrow;

		const sep = () => bar.createDiv({ attr: { style: vert ? S.sep : S.sepNarrow } });

		if (this.tool === "pen") {
			const dots: HTMLElement[] = [];
			const btns = this.sizes.map((sz, i) => {
				const b = bar.createEl("button", { attr: { "aria-label": t("ctx.penWidth", sz), style: S.btn } });
				dots.push(b.createDiv({ attr: { style: S.dot(dotPx(sz)) } }));
				b.addEventListener("click", () => { this.sizeIdx = i; sync(); });
				return b;
			});
			sep();

			// Adjusts whichever width slot is active, previewing on its dot.
			const slider = this.makeSlider(bar, vert, 1, 28,
				() => this.sizes[this.sizeIdx],
				(v) => {
					this.sizes[this.sizeIdx] = v;
					dots[this.sizeIdx].setAttribute("style", S.dot(dotPx(v)));
					btns[this.sizeIdx].setAttribute("aria-label", t("ctx.penWidth", v));
				},
				() => this.plugin.saveSettings());
			sep();

			const colorDots = COLORS.map((c) => {
				const b = bar.createEl("button", { attr: { "aria-label": t("ctx.color"), style: S.btn } });
				const d = b.createDiv({ attr: { style: S.colorDot(c, false) } });
				b.addEventListener("click", () => { this.color = c; sync(); });
				return d;
			});

			const sync = () => {
				btns.forEach((b, i) => b.setAttribute("style", i === this.sizeIdx ? S.btnOn : S.btn));
				colorDots.forEach((d, i) => d.setAttribute("style", S.colorDot(COLORS[i], COLORS[i] === this.color)));
				slider.refresh();
			};
			this.syncCtx = sync;
			sync();
			return;
		}

		if (this.tool === "eraser") {
			const seg = this.makeSegment(bar, vert,
				[{ label: t("ctx.eraseStroke"), value: "stroke" }, { label: t("ctx.erasePrecise"), value: "precise" }],
				() => this.plugin.settings.eraserMode,
				(v) => {
					this.plugin.settings.eraserMode = v;
					this.plugin.saveSettings();
				});
			sep();

			// A number alone says nothing about how big the eraser actually is, so a
			// swatch beside the slider scales with it. The ring on the canvas stays
			// where it belongs -- under the pointer while erasing -- rather than
			// being parked mid-page while the slider moves.
			const previewPx = (v: number) => Math.min(8 + v * 0.7, 46);
			const previewBox = bar.createDiv({ attr: { style: S.eraserPreviewBox } });
			const preview = previewBox.createDiv({ attr: { style: S.eraserPreview + `width:${previewPx(this.plugin.settings.eraserSize)}px;height:${previewPx(this.plugin.settings.eraserSize)}px;` } });
			const slider = this.makeSlider(bar, vert, 3, 60,
				() => this.plugin.settings.eraserSize,
				(v) => {
					this.plugin.settings.eraserSize = v;
					preview.setAttribute("style", S.eraserPreview + `width:${previewPx(v)}px;height:${previewPx(v)}px;`);
				},
				() => this.plugin.saveSettings());
			this.syncCtx = () => { seg.refresh(); slider.refresh(); };
			return;
		}

	}

	/** Segmented control with a pill that slides to the selected option.
	 *  Two options sit side by side; in the narrow layout they stack instead. */
	private makeSegment(
		parent: HTMLElement, stacked: boolean,
		items: { label: string; value: string }[],
		get: () => string, set: (v: string) => void,
	) {
		// Stack along the bar's long axis: a vertical bar gets a vertical stack.
		// Two Chinese labels side by side in a 60px column are unreadably tight.
		const IW = stacked ? 56 : 52, IH = stacked ? 26 : 26;
		const W = stacked ? IW + 4 : IW * items.length + 4;
		const H = stacked ? IH * items.length + 4 : IH + 4;
		const wrap = parent.createDiv({
			attr: { style: S.seg + `width:${W}px;height:${H}px;flex-direction:${stacked ? "column" : "row"};` },
		});
		const pill = wrap.createDiv({
			attr: { style: S.segPill + `width:${IW}px;height:${IH}px;left:2px;top:2px;` },
		});
		const els = items.map((it) => {
			const b = wrap.createEl("button", {
				text: it.label,
				attr: { style: S.segItem + `width:${IW}px;height:${IH}px;flex:0 0 auto;` },
			});
			b.addEventListener("click", (e) => { e.stopPropagation(); set(it.value); refresh(); });
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			return b;
		});
		const refresh = () => {
			const i = Math.max(0, items.findIndex((it) => it.value === get()));
			pill.style.transform = stacked ? `translateY(${i * IH}px)` : `translateX(${i * IW}px)`;
			els.forEach((b, j) => b.setAttribute(
				"style", S.segItem + `width:${IW}px;height:${IH}px;flex:0 0 auto;` + (j === i ? S.segItemOn : "")));
		};
		refresh();
		return { refresh };
	}

	/** A slider we draw ourselves.
	 *
	 *  <input type="range"> needs the browser's default touch handling, and
	 *  Obsidian mobile claims horizontal drags for its sidebar gesture, so
	 *  dragging one opens the file pane instead of moving the knob. Pointer
	 *  capture plus touch-action:none, the same approach the canvas uses, keeps
	 *  the gesture from leaking out. */
	private makeSlider(
		parent: HTMLElement, vert: boolean, min: number, max: number,
		get: () => number, onInput: (v: number) => void, onDone: () => void,
	) {
		const LEN = vert ? 118 : 118, THICK = 26, KNOB = 18;
		const el = parent.createDiv({
			attr: { style: S.slider + (vert ? `width:${THICK}px;height:${LEN}px;` : `width:${LEN}px;height:${THICK}px;`) },
		});
		const track = el.createDiv({
			attr: {
				style: S.sliderTrack + (vert
					? `left:${THICK / 2 - 2}px;top:${KNOB / 2}px;width:4px;height:${LEN - KNOB}px;`
					: `top:${THICK / 2 - 2}px;left:${KNOB / 2}px;height:4px;width:${LEN - KNOB}px;`),
			},
		});
		const fill = el.createDiv({ attr: { style: S.sliderFill } });
		const knob = el.createDiv({
			attr: { style: S.sliderKnob + `width:${KNOB}px;height:${KNOB}px;box-sizing:border-box;` },
		});
		const label = parent.createDiv({ attr: { style: S.sliderVal } });

		const span = LEN - KNOB;
		const refresh = () => {
			const v = get();
			const t = (v - min) / (max - min);
			if (vert) {
				// Up is more, which reads the right way round for a size control.
				const y = (1 - t) * span;
				knob.style.left = `${THICK / 2 - KNOB / 2}px`;
				knob.style.top = `${y}px`;
				fill.style.cssText = S.sliderFill + `left:${THICK / 2 - 2}px;width:4px;top:${y + KNOB / 2}px;height:${span - y}px;`;
			} else {
				const x = t * span;
				knob.style.top = `${THICK / 2 - KNOB / 2}px`;
				knob.style.left = `${x}px`;
				fill.style.cssText = S.sliderFill + `top:${THICK / 2 - 2}px;height:4px;left:${KNOB / 2}px;width:${x}px;`;
			}
			label.setText(String(v));
		};

		const apply = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			const t = vert
				? 1 - (e.clientY - r.top - KNOB / 2) / span
				: (e.clientX - r.left - KNOB / 2) / span;
			const v = Math.round(min + Math.min(Math.max(t, 0), 1) * (max - min));
			if (v !== get()) { onInput(v); }
			refresh();
		};

		el.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			el.setPointerCapture(e.pointerId);
			apply(e);
		});
		el.addEventListener("pointermove", (e: PointerEvent) => {
			if (!el.hasPointerCapture(e.pointerId)) return;
			e.preventDefault();
			apply(e);
		});
		const end = (e: PointerEvent) => {
			if (!el.hasPointerCapture(e.pointerId)) return;
			el.releasePointerCapture(e.pointerId);
			onDone();
		};
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", end);
		el.addEventListener("touchstart", (e: TouchEvent) => e.preventDefault());

		void track;
		refresh();
		return { refresh };
	}

	/* ============ Size and coordinates ============ */

	/** At zoom 1 the page fills the viewport width with EDGE_PAD to spare on each
	 *  side; without it the page frame sits on the very edge of the screen and is
	 *  effectively invisible. */
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
		this.placeCtxBar();
		this.redrawAll();
		this.rebuildOverlay();
	}

	/** Bake the content-to-device-pixel pan and zoom into the context in one go */
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

	/* ============ Paging: always keep one blank page ============ */

	/** Notability's approach: as soon as the last page has something on it, add
	 *  another. Derived from the content rather than stored separately, so
	 *  deleting content shrinks the page count again. */
	private recountPages() {
		let maxY = 0;
		for (const st of this.doc.strokes) for (const p of st.pts) if (p.y > maxY) maxY = p.y;
		for (const it of this.doc.items) maxY = Math.max(maxY, it.y + 60);
		for (const g of this.doc.regions) {
			const b = polyBounds(g.path);
			maxY = Math.max(maxY, b.y + b.h);
		}
		this.pages = Math.max(2, Math.floor(Math.max(maxY, 0) / PAGE_H) + 2);
	}

	private clampPan() {
		const maxY = Math.max(0, this.contentH() - this.viewH);
		this.panY = Math.min(Math.max(this.panY, 0), maxY);
		if (PAGE_W <= this.viewW) this.panX = -(this.viewW - PAGE_W) / 2;   // centre the page when it is narrower than the viewport
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

	/* ============ Canvas rendering ============ */

	private redrawAll() {
		if (!this.surface) return;
		const cx = this.bctx;
		cx.setTransform(1, 0, 0, 1, 0, 0);
		cx.clearRect(0, 0, this.base.width, this.base.height);
		this.applyTransform(cx);
		this.drawPages(cx);

		// Only draw ink inside the viewport; across many pages this skips almost
		// all of the work
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

	/** Desk colour, the page, its frame and the page breaks. Zoomed out past the
	 *  screen, an unframed page is impossible to tell from the background in dark
	 *  mode. */
	private drawPages(cx: CanvasRenderingContext2D) {
		const st = getComputedStyle(this.contentEl);
		const pick = (name: string, fb: string) => st.getPropertyValue(name).trim() || fb;
		const page = pick("--background-primary", "#ffffff");
		const desk = pick("--background-secondary", "rgba(127,127,127,.12)");
		const border = pick("--background-modifier-border", "rgba(127,127,127,.45)");
		const faint = pick("--text-faint", "rgba(127,127,127,.5)");
		const H = this.contentH();

		// Outside the page is the "desk", covering the whole viewport
		cx.fillStyle = desk;
		cx.fillRect(this.panX - 8, this.panY - 8, this.viewW + 16, this.viewH + 16);

		// The page itself, only the part near the viewport; no need to fill a long
		// document end to end
		const y0 = Math.max(0, this.panY - 60), y1 = Math.min(H, this.panY + this.viewH + 60);
		if (y1 > y0) {
			cx.fillStyle = page;
			cx.fillRect(0, y0, PAGE_W, y1 - y0);
		}

		cx.save();
		// Dashed page breaks
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

		// Page frame: one rectangle for the whole document, with canvas clipping
		// whatever falls outside the viewport. Uses --text-faint rather than the
		// border colour, which is too faint in dark themes to read as an edge.
		cx.lineWidth = 2 / this.scale;
		cx.strokeStyle = faint;
		cx.strokeRect(0, 0, PAGE_W, H);

		// Page numbers
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
		// Unselected is a thin dim-blue dashed line, selected is thicker and bright:
		// the state has to be obvious at a glance
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
			// Predicted points are drawn but never stored; the next batch of real
			// samples discards and recomputes them
			const ahead = this.drawing ? predictTip(this.cur.pts, this.plugin.settings.predict) : [];
			const s = ahead.length ? { ...this.cur, pts: this.cur.pts.concat(ahead) } : this.cur;
			drawStroke(this.lctx, s, this.opts(), false);
		}
		if (this.lasso && this.lasso.length > 1) this.drawRegionOutline(this.lctx, this.lasso, "drawing");
		// A freshly drawn lasso is by definition selected, so it uses the same
		// "selected" look as a Wiki region rather than a style of its own. Drawing
		// it grey read as "not selected", which is the opposite of the truth.
		if (this.sel) this.drawRegionOutline(this.lctx, this.sel.path, "selected");
		// Eraser preview: how big the eraser is and where it currently sits
		if (this.tool === "eraser" && this.eraserAt) {
			const cx = this.lctx, r = this.plugin.settings.eraserSize;
			cx.save();
			cx.lineWidth = 1.5 / this.scale;
			cx.setLineDash([5 / this.scale, 4 / this.scale]);
			cx.strokeStyle = "rgba(130,130,130,.9)";
			cx.fillStyle = "rgba(150,150,150,.12)";
			cx.beginPath();
			cx.arc(this.eraserAt.x, this.eraserAt.y, r, 0, Math.PI * 2);
			cx.fill();
			cx.stroke();
			cx.restore();
		}
	}

	/** Draw straight from the event instead of waiting for requestAnimationFrame,
	 *  which would cost up to a whole frame. Coalesced events already arrive one
	 *  batch per frame, so this does not add redraws, it just happens a frame
	 *  earlier. */
	private schedule() { this.redrawLive(); }

	/* ============ Input ============ */

	/* Responsibilities are split by input device:
	 *   pen     writing only; never selects, drags, or long-presses for a menu.
	 *           Our lassos are persistent named regions, not one-shot selections,
	 *           so dotting a few marks inside a ring is ordinary writing and must
	 *           not select it.
	 *   finger  manipulation only; tap to select or clear, drag a region, pan,
	 *           pinch zoom. Never draws.
	 *   mouse   there is no finger on desktop, so it does both.
	 */
	private bindPointer() {
		const el = this.live;

		this.registerDomEvent(el, "pointerdown", (e: PointerEvent) => {
			const finger = e.pointerType === "touch";

			if (finger && !this.plugin.settings.allowFinger) {
				// Ignore every touch while the pen is down, or resting a palm on the
				// screen while writing would scroll the page
				if (this.drawing) return;
				this.stopGlide();
				this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
				el.setPointerCapture(e.pointerId);
				if (this.touches.size >= 2) { this.panFrom = null; this.fingerOn = null; return; }

				const p = this.toPage(e);
				this.tap = { x: e.clientX, y: e.clientY, finger: true };
				this.armLongPress(p.x, p.y, true);

				// Pressing on any region prepares a drag, otherwise a pan. Selecting
				// first is deliberately not required. Either way the gesture only
				// starts past the dead zone, so a tap is never mistaken for a drag.
				if (this.sel && pointInPoly(this.sel.path, p.x, p.y)) {
					this.fingerOn = { id: "__sel__", x: e.clientX, y: e.clientY };
					this.panFrom = null;
					return;
				}
				const hit = this.regionAt(p.x, p.y);
				this.lastTouchInfo = hit
					? `on "${hit.name}", drag pending`
					: `on empty space, pan pending (selected: ${this.selRegion ?? "none"})`;
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
			// The pen takes over everything: drop any pan in progress
			if (!finger) { this.stopGlide(); this.touches.clear(); this.panFrom = null; this.pinch = null; }
			el.setPointerCapture(e.pointerId);
			const pt = this.toPage(e);

			if (this.tool === "eraser") {
				this.drawing = true;
				this.eraseSnap = this.doc.strokes;
				this.eraseAt(pt.x, pt.y);
				return;
			}
			if (this.tool === "lasso" || this.tool === "wiki") {
				// Either lasso tool always draws a new ring; otherwise a selected
				// outer region would make it impossible to draw one inside it
				this.drawing = true;
				this.lastT = e.timeStamp;
				this.clearSelection();   // a new ring replaces the previous selection
				this.lasso = [[pt.x, pt.y]];
				this.schedule();
				return;
			}

			// The mouse doubles as a finger: it can tap to select and drag a selected
			// region. The pen cannot.
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

			if (this.selDrag && this.sel) {
				e.preventDefault();
				const p = this.toPage(e);
				const dx = p.x - this.selDrag.ox, dy = p.y - this.selDrag.oy;
				if (Math.abs(dx) + Math.abs(dy) > 1.5) this.selDrag.moved = true;
				this.moveSelection(dx, dy);
				this.selDrag.dx += dx; this.selDrag.dy += dy;
				this.selDrag.ox = p.x; this.selDrag.oy = p.y;
				this.redrawAll();
				this.rebuildOverlay();
				return;
			}

			// Region dragging, shared by finger and mouse, hence before the touch branch
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

				// Finger resting on a region: start dragging once it leaves the dead zone
				if (this.fingerOn) {
					if (Math.hypot(e.clientX - this.fingerOn.x, e.clientY - this.fingerOn.y) < 4) return;
					const p = this.toPage(e);
					const id = this.fingerOn.id;
					this.fingerOn = null;
					if (id === "__sel__") {
						this.selDrag = { ox: p.x, oy: p.y, dx: 0, dy: 0, moved: false };
						return;
					}
					if (this.selRegion !== id) this.select(id);   // selecting what you drag gives feedback
					this.startRegionDrag(id, p.x, p.y);
					this.lastTouchInfo += " -> drag started";
					return;
				}
				if (this.panFrom) {
					// Dead zone: below this distance it is not a pan, otherwise a slight
					// wobble would drag the view
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

			if (!this.drawing) {
				// Hovering with a pen or mouse still previews the eraser ring
				if (this.tool === "eraser" && e.pointerType !== "touch") {
					this.eraserAt = this.toPage(e);
					this.redrawLive();
				}
				return;
			}
			e.preventDefault();
			if (this.tool === "eraser") { const p = this.toPage(e); this.eraseAt(p.x, p.y); return; }

			// On iPadOS the coalesced windows of consecutive pointermove events
			// overlap, so deduplicate by strictly increasing timestamp
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

			if (this.tool === "lasso" || this.tool === "wiki") {
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

			if (this.selDrag) {
				const d = this.selDrag;
				this.selDrag = null;
				if (d.moved && this.sel) {
					this.undoStack.push({ kind: "sel-move", strokes: [...this.sel.strokes], dx: d.dx, dy: d.dy });
					this.recountPages();
					this.requestSave();
				}
				return;
			}

			// Finish a region drag
			if (this.regionDrag) {
				const d = this.regionDrag;
				this.regionDrag = null;
				if (d.moved) {
					this.undoStack.push({ kind: "region-move", id: d.id, dx: d.dx, dy: d.dy });
					this.recountPages();
					this.requestSave();
				}
				return;
			}

			// Tap: select or clear. The pen never reaches this, it never sets this.tap
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
			if (this.tool === "eraser") {
				const snap = this.eraseSnap;
				this.eraseSnap = null;
				this.eraserAt = null;
				this.redrawLive();
				// One erase gesture is one undo step
				if (snap && snap !== this.doc.strokes) {
					this.undoStack.push({ kind: "strokes-set", before: snap });
					this.requestSave();
				}
				return;
			}
			if (this.tool === "lasso" || this.tool === "wiki") { this.finishLasso(); return; }
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

		// Desktop: the wheel scrolls, Ctrl/Cmd plus wheel zooms about the pointer
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

	/** Hit test, two rules whose order matters:
	 *
	 *  1. "Inside" beats "next to": if the point falls inside any region, the
	 *     choice is made among those, and a region whose outline merely happens
	 *     to be closer cannot steal it.
	 *  2. Among containing regions the smallest area wins, i.e. the innermost.
	 *     An outer region is still reachable: tap its outline, or a part of it
	 *     the inner one does not cover.
	 *
	 *  Only if nothing contains the point do we fall back to the nearest outline
	 *  within tolerance. Repeated taps at the same spot give the same answer. */
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
		this.lastHitInfo = `(${x.toFixed(0)},${y.toFixed(0)}), ${this.doc.regions.length} regions -> `
			+ (hit ? `hit "${hit.name}" (${inner ? "inside" : `outline ${nearD.toFixed(0)} units`})` : "no hit");
		return hit;
	}

	private lastHitInfo = "no tap yet";
	private lastTouchInfo = "no touch yet";

	private select(id: string | null, opts = false) {
		if (this.selRegion === id && this.showOpts === opts) return;
		this.selRegion = id;
		this.showOpts = id ? opts : false;
		this.redrawAll();
		this.rebuildOverlay();
	}

	/** Tap: selects the region under it (ring or tag alike), clears on empty space.
	 *  The ring and its tag are one thing. */
	private handleTap(x: number, y: number) {
		if (this.sel) {
			if (pointInPoly(this.sel.path, x, y)) {
				this.sel.showOpts = !this.sel.showOpts;
				this.rebuildOverlay();
				return;
			}
			this.clearSelection();
		}
		const hit = this.regionAt(x, y);
		this.select(hit ? hit.id : null);
	}

	private armLongPress(x: number, y: number, allow: boolean) {
		this.clearLongPress();
		if (!allow) return;
		this.lpTimer = window.setTimeout(() => {
			this.lpTimer = 0;
			if (!this.tap) return;              // already moved, not a long press
			const hit = this.regionAt(x, y);
			if (!hit) return;
			this.tap = null;                    // handled as a long press, so not a tap on release
			this.drawing = false;
			this.cur = null;
			this.redrawLive();
			this.select(hit.id, true);
		}, 480);
	}

	private clearLongPress() {
		if (this.lpTimer) { window.clearTimeout(this.lpTimer); this.lpTimer = 0; }
	}

	/** Start dragging a region, shared by finger and mouse */
	private startRegionDrag(id: string, x: number, y: number) {
		const g = this.doc.regions.find((r) => r.id === id);
		if (!g) return;
		this.drawing = false;
		this.cur = null;
		this.regionDrag = { id, ox: x, oy: y, dx: 0, dy: 0, moved: false };
	}

	/** Moving a Wiki region moves only the ring. A Wiki region annotates an area
	 *  of the page rather than owning what happens to sit in it, so what it
	 *  resolves to is whatever ends up inside after the move. The plain lasso is
	 *  the tool that picks content up and carries it. */
	private moveRegion(g: Region, dx: number, dy: number) {
		for (const pt of g.path) { pt[0] += dx; pt[1] += dy; }
	}

	private stopGlide() {
		if (this.glideRaf) { cancelAnimationFrame(this.glideRaf); this.glideRaf = 0; }
	}

	/** Inertial scrolling: after the finger lifts, keep gliding with exponential
	 *  decay and stop at the edges. Without it the view freezes the instant the
	 *  finger stops, which feels harsh -- browsers and every native list decelerate. */
	private startGlide() {
		const s = this.velSamples;
		if (s.length < 2) return;
		const last = s[s.length - 1];
		let first = s[0];
		for (let i = s.length - 1; i >= 0; i--) {
			if (last.t - s[i].t <= 90) first = s[i]; else break;   // last 90ms only, so a slow approach does not dilute the flick
		}
		const dt = last.t - first.t;
		if (dt < 8) return;
		// screen px/ms -> content units/ms; the pan runs opposite to the finger
		let vx = -(last.x - first.x) / dt / this.scale;
		let vy = -(last.y - first.y) / dt / this.scale;
		if (Math.hypot(vx, vy) < 0.03) return;

		let prev = performance.now();
		const step = () => {
			const now = performance.now();
			const d = Math.min(now - prev, 48);   // on a dropped frame, do not lurch forward
			prev = now;
			const wantX = this.panX + vx * d, wantY = this.panY + vy * d;
			this.panX = wantX; this.panY = wantY;
			this.syncViewport();                  // clamps internally
			if (Math.abs(this.panY - wantY) > 1e-6) vy = 0;   // hit the top or bottom edge
			if (Math.abs(this.panX - wantX) > 1e-6) vx = 0;
			const decay = Math.pow(0.9975, d);    // glides to a stop in about a second, close to iOS
			vx *= decay; vy *= decay;
			if (Math.hypot(vx, vy) < 0.015) { this.glideRaf = 0; return; }
			this.glideRaf = requestAnimationFrame(step);
		};
		this.glideRaf = requestAnimationFrame(step);
	}

	/** Pinch zoom: keep the content point under the pinch midpoint fixed */
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

	/** Zoom to z, leaving content point (cx,cy) at screen coordinate (sx,sy) */
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

	/** Writing on the last page adds another, so one blank page always remains */
	private growPages() {
		const before = this.pages;
		this.recountPages();
		if (this.pages !== before) { this.clampPan(); this.redrawAll(); }
	}

	private eraseAt(x: number, y: number) {
		this.eraserAt = { x, y };
		const r = this.plugin.settings.eraserSize;
		const before = this.doc.strokes;
		// Only strokes whose bounds meet the eraser circle can be affected
		const near = (st: Stroke) => {
			const b = bboxOf(st);
			return b.x0 - r <= x && x <= b.x1 + r && b.y0 - r <= y && y <= b.y1 + r;
		};
		let after: Stroke[];
		if (this.plugin.settings.eraserMode === "precise") {
			after = [];
			let changed = false;
			for (const st of before) {
				if (!near(st)) { after.push(st); continue; }
				const parts = erasePrecise([st], x, y, r);
				if (parts.length === 1 && parts[0] === st) { after.push(st); continue; }
				changed = true;
				after.push(...parts);
			}
			if (!changed) { this.redrawLive(); return; }
		} else {
			after = before.filter((st) => !(near(st) && hitStroke(st, x, y, r)));
			if (after.length === before.length) { this.redrawLive(); return; }
		}
		this.doc.strokes = after;
		this.recountPages();
		this.redrawAll();
	}

	/* ============ Plain lasso selection ============ */

	/** Turn the ring just drawn into a selection. Membership is by intersection:
	 *  a stroke only partly inside still belongs to it, so deleting takes the
	 *  whole stroke rather than cutting it. Unlike a Wiki region this is
	 *  transient -- it is never named and never saved. */
	private finishSelection(path: [number, number][]) {
		const region: Region = { id: "sel", name: "", path };
		const strokes = this.doc.strokes.filter((st) => strokeInRegion(st, region));
		this.sel = strokes.length ? { path, strokes, showOpts: false } : null;
		this.redrawLive();
		this.rebuildOverlay();
	}

	private clearSelection() {
		if (!this.sel) return;
		this.sel = null;
		this.redrawLive();
		this.rebuildOverlay();
	}

	private moveSelection(dx: number, dy: number) {
		if (!this.sel) return;
		for (const pt of this.sel.path) { pt[0] += dx; pt[1] += dy; }
		for (const st of this.sel.strokes) {
			for (const p of st.pts) { p.x += dx; p.y += dy; }
			dirtyBox(st);   // point count is unchanged, so the cached bounds must be dropped
		}
	}

	private deleteSelection() {
		if (!this.sel) return;
		const before = this.doc.strokes;
		const gone = new Set(this.sel.strokes);
		this.doc.strokes = before.filter((st) => !gone.has(st));
		this.undoStack.push({ kind: "strokes-set", before });
		this.sel = null;
		this.recountPages();
		this.redrawAll();
		this.rebuildOverlay();
		this.requestSave();
		new Notice(t("notice.strokesDeleted", gone.size));
	}

	/** Delete button, at the selection's top-right corner */
	private renderSelectionBar() {
		if (!this.sel || !this.sel.showOpts) return;
		const box = polyBounds(this.sel.path);
		const bar = this.overlay.createDiv({ attr: { style: S.regionBar } });
		bar.style.left = box.x + box.w + "px";
		bar.style.top = box.y + "px";
		this.counterScaled.push(bar);
		const b = bar.createEl("button", { attr: { "aria-label": t("sel.delete"), title: t("sel.delete"), style: S.regionBtn } });
		drawIcon(b, "trash", 16);
		b.addEventListener("pointerdown", (e) => e.stopPropagation());
		b.addEventListener("click", (e) => { e.stopPropagation(); this.deleteSelection(); });
	}

	/* ============ Lasso to named region ============ */

	private finishLasso() {
		const path = this.lasso ?? [];
		if (this.tool === "lasso") {
			this.lasso = null;
			const box0 = polyBounds(path);
			if (path.length < 8 || box0.w < 12 || box0.h < 12) { this.clearSelection(); this.redrawLive(); return; }
			this.finishSelection(path);
			return;
		}
		this.lasso = null;
		this.redrawLive();
		const box = polyBounds(path);
		// A tiny ring counts as a stray touch; closure is implicit in the polygon,
		// whose first and last points connect automatically
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
			new Notice(t("notice.regionCreated", region.name, this.linkBase()));
		}, () => { this.redrawLive(); }).open();
	}

	private linkBase() { return this.file?.basename ?? ""; }

	/* ============ Overlay items on the canvas ============ */

	private addLink() {
		const item: LinkItem = {
			id: newId(),
			x: this.panX + this.viewW * 0.15,
			y: this.panY + this.viewH * 0.3,
			w: 420,
			target: "",
			embed: false,
		};
		this.doc.items.push(item);
		this.undoStack.push({ kind: "item-add", id: item.id });
		this.editItem(item, true);
	}

	private editItem(item: LinkItem, isNew = false) {
		new LinkModal(this.app, { target: item.target, embed: item.embed }, (v) => {
			if (!v.target && isNew) { this.removeItem(item.id, false); return; }
			item.target = v.target;
			item.embed = v.embed;
			this.rebuildOverlay();
			this.requestSave();
		}, () => this.removeItem(item.id, true)).open();
	}

	private removeItem(id: string, record: boolean) {
		const i = this.doc.items.findIndex((x) => x.id === id);
		if (i < 0) return;
		if (record) this.undoStack.push({ kind: "item-del", index: i, item: this.doc.items[i] });
		this.doc.items.splice(i, 1);
		this.rebuildOverlay();
		this.requestSave();
	}

	private syncOverlayTransform() {
		if (!this.overlay) return;
		const s = this.scale;
		this.overlay.style.transform =
			`translate(${(-this.panX * s).toFixed(2)}px, ${(-this.panY * s).toFixed(2)}px) scale(${s})`;
		// Floating UI cancels out the overall zoom, or buttons would turn into
		// giants when the canvas is zoomed in
		const k = (1 / s).toFixed(4);
		for (const el of this.counterScaled) el.style.transform = `scale(${k})`;
	}

	private rebuildOverlay() {
		if (!this.overlay) return;
		this.syncOverlayTransform();
		this.overlay.empty();
		this.counterScaled = [];
		for (const g of this.doc.regions) this.renderRegionTag(g);
		this.renderSelectionBar();
		for (const it of this.doc.items) this.renderItem(it);
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
			text: g.name || t("region.unnamed"),
			attr: { style: sel ? S.regionNameOn : S.regionName },
		});
		// The tag and the ring are one thing: tap selects, long press opens options
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

		btn("rename", t("region.rename"), () => {
			const taken = this.doc.regions.filter((r) => r.id !== g.id).map((r) => r.name);
			new NameRegionModal(this.app, taken, (n) => {
				g.name = sanitizeName(n);
				this.rebuildOverlay();
				this.requestSave();
			}, () => {}).open();
		});
		btn("copy", t("region.copyRef"), () => {
			navigator.clipboard?.writeText(`![[${this.linkBase()}#${g.name}]]`);
			new Notice(t("notice.refCopied"));
		});
		btn("trash", t("region.delete"), () => {
			const i = this.doc.regions.findIndex((r) => r.id === g.id);
			if (i < 0) return;
			this.undoStack.push({ kind: "region-del", index: i, region: this.doc.regions[i] });
			this.doc.regions.splice(i, 1);
			this.selRegion = null;
			this.showOpts = false;
			this.redrawAll();
			this.rebuildOverlay();
			this.requestSave();
			new Notice(t("notice.regionDeleted", g.name));
		});
	}

	private renderItem(it: LinkItem) {
		if (!it.embed) {
			const chip = this.overlay.createDiv({
				text: it.target ? `[[${it.target}]]` : t("link.empty"),
				attr: { style: it.target ? S.chip : S.chipMissing },
			});
			chip.style.left = it.x + "px";
			chip.style.top = it.y + "px";
			this.wireItem(chip, chip, it);
			return;
		}

		const boxEl = this.overlay.createDiv({ attr: { style: S.embedBox } });
		boxEl.style.left = it.x + "px";
		boxEl.style.top = it.y + "px";
		boxEl.style.width = it.w + "px";

		const bar = boxEl.createDiv({ attr: { style: S.embedBar } });
		bar.createSpan({ text: `![[${it.target || "?"}]]` });
		const body = boxEl.createDiv({ attr: { style: S.embedBody } });
		this.wireItem(boxEl, bar, it);

		resolveTarget(this.app, it.target, this.file?.path ?? "").then((r) =>
			renderResolved(body, r, it.w - 26, this.opts()),
		);
	}

	/** Drag to move, tap to edit */
	private wireItem(root: HTMLElement, handle: HTMLElement, it: LinkItem) {
		let sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
		handle.addEventListener("pointerdown", (e: PointerEvent) => {
			e.stopPropagation();
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			sx = e.clientX; sy = e.clientY; ox = it.x; oy = it.y; moved = false;
		});
		handle.addEventListener("pointermove", (e: PointerEvent) => {
			if (!handle.hasPointerCapture(e.pointerId)) return;
			const dx = (e.clientX - sx) / this.scale, dy = (e.clientY - sy) / this.scale;
			if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) moved = true;
			it.x = ox + dx; it.y = oy + dy;
			root.style.left = it.x + "px";
			root.style.top = it.y + "px";
		});
		handle.addEventListener("pointerup", (e: PointerEvent) => {
			if (!handle.hasPointerCapture(e.pointerId)) return;
			handle.releasePointerCapture(e.pointerId);
			if (moved) this.requestSave();
			else this.editItem(it);
		});
	}

	/* ============ Undo ============ */

	undo() {
		const e = this.undoStack.pop();
		if (!e) { new Notice(t("notice.nothingToUndo")); return; }
		switch (e.kind) {
			case "stroke-add": this.doc.strokes.splice(e.index, 1); break;
			case "stroke-del": for (const it of [...e.items].reverse()) this.doc.strokes.splice(it.index, 0, it.stroke); break;
			case "strokes-set": this.doc.strokes = e.before; break;
			case "item-add": this.doc.items = this.doc.items.filter((x) => x.id !== e.id); break;
			case "item-del": this.doc.items.splice(e.index, 0, e.item); break;
			case "region-add": this.doc.regions = this.doc.regions.filter((x) => x.id !== e.id); break;
			case "region-del": this.doc.regions.splice(e.index, 0, e.region); break;
			case "sel-move":
				for (const st of e.strokes) {
					for (const p of st.pts) { p.x -= e.dx; p.y -= e.dy; }
					dirtyBox(st);
				}
				break;
			case "region-move": {
				const g = this.doc.regions.find((r) => r.id === e.id);
				if (g) for (const pt of g.path) { pt[0] -= e.dx; pt[1] -= e.dy; }
				break;
			}
		}
		this.recountPages();
		this.clampPan();
		this.redrawAll();
		this.rebuildOverlay();
		this.requestSave();
	}

	/* ============ Diagnostics and refresh ============ */

	diagnostics(): Record<string, string> {
		const cs = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : "—");
		const root = this.contentEl;
		return {
			"contentEl class": root.className || "(empty)",
			"root display / dir": cs(root, "display") + " / " + cs(root, "flex-direction"),
			"root size": `${root.clientWidth} x ${root.clientHeight}`,
			"tool bar size": this.tools ? `${this.tools.clientWidth} x ${this.tools.clientHeight}` : "—",
			"context bar": this.ctxBar
				? `${this.ctxBar.clientWidth} x ${this.ctxBar.clientHeight}, ${this.ctxBar.childElementCount} children, tool=${this.tool}`
				: "absent",
			"tool bar children": this.tools ? String(this.tools.childElementCount) : "—",
			"bundle / manifest version": `${__HW_VERSION__} / ${this.plugin.manifest.version}`,
			"width slot / widths": `${this.sizeIdx} / [${this.sizes.join(", ")}]`,
			"narrow layout": String(this.narrow),
			"last tap": this.lastHitInfo,
			"last finger press": this.lastTouchInfo,
			"selected region": this.selRegion
				? (this.doc.regions.find((r) => r.id === this.selRegion)?.name ?? "?") : "none",
			"pages / zoom": `${this.pages} / ${(this.zoom * 100).toFixed(0)}%`,
			"scroll": `${this.panY.toFixed(0)} / ${this.contentH()}`,
			"low-latency canvas": this.lowLatency ? "desynchronized active" : "normal compositing",
			"coalesced events API": typeof PointerEvent.prototype.getCoalescedEvents === "function" ? "yes" : "no",
			"prediction API": typeof (PointerEvent.prototype as any).getPredictedEvents === "function" ? "yes" : "no (we extrapolate)",
			"event rate": this.evtStamps.length > 5
				? (1000 * (this.evtStamps.length - 1) /
					(this.evtStamps[this.evtStamps.length - 1] - this.evtStamps[0])).toFixed(0) + " Hz"
				: "draw a stroke first",
			"strokes / items / regions": `${this.doc.strokes.length} / ${this.doc.items.length} / ${this.doc.regions.length}`,
		};
	}

	refresh() { this.syncCtx?.(); this.resize(); }

	/** Rebuild everything that carries a label, after the language changes */
	relocalize() {
		if (!this.tools) return;
		this.buildToolbar(this.tools);
		this.buildContextBar();
		this.rebuildOverlay();
	}
}

/** Drop a stroke's cached bounds. Moving a selection changes coordinates without
 *  changing the point count, which is what the cache keys on. */
function dirtyBox(st: Stroke) { (st as unknown as { _n?: number })._n = -1; }

/** Stroke bounding box, cached on the stroke, used to cull ink outside the
 *  viewport in a multi-page document. */
const bboxCache = new WeakMap<Stroke, { x0: number; x1: number; y0: number; y1: number }>();
function bboxOf(st: Stroke) {
	let b = bboxCache.get(st);
	if (b && (st as unknown as { _n?: number })._n === st.pts.length) return b;
	let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
	for (const p of st.pts) {
		if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
	}
	b = {
		x0: isFinite(x0) ? x0 : 0, x1: isFinite(x1) ? x1 : 0,
		y0: isFinite(y0) ? y0 : 0, y1: isFinite(y1) ? y1 : 0,
	};
	bboxCache.set(st, b);
	(st as unknown as { _n?: number })._n = st.pts.length;
	return b;
}
