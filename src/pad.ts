import { App, KeymapEventHandler, Modal, Notice, Scope } from "obsidian";
import {
	InkOpts, NOTE_INK, PAGE_H, PAGE_W, SPLINE_FROM, Stroke,
	drawStroke, erasePrecise, hitStroke, pathToCanvas, pointInPoly, polyBounds, strokeChanged, strokeInPoly, strokePath, strokeRev,
} from "./ink";
import { CARD_EDGE, CARD_GAP, CTX_H, CTX_W, ICONS, MODAL, S, drawIcon } from "./styles";
import { t } from "./i18n";
import type HandwritingPlugin from "./main";
import { buildEraserDial, Dial } from "./dial";

const EDGE_PAD = 12;   // css px
/* A tap with two fingers undoes, with three redoes: each finger lands within
 * MULTI_TAP_GAP of the one before, all are off the glass within MULTI_TAP_UP
 * of the second landing, and none moves more than MULTI_TAP_SLOP */
const MULTI_TAP_GAP = 200;   // ms
const MULTI_TAP_UP = 300;    // ms
const MULTI_TAP_SLOP = 10;   // css px
/* Holding the tool bar this long takes it up to be dragged; a press that
 * wanders further than LIFT_SLOP first was not a hold */
const LIFT_MS = 300;
const LIFT_SLOP = 10;   // css px
const ZOOM_MAX = 8;

/** The page is paper: white whatever the theme, with ink in near-black. It is
 *  also what the model is sent, rendered black on white, so what you see while
 *  writing is what gets read. */
const PAPER = "#ffffff";
const INK = "#1a1a1a";

/** Diameter of the preview dot on a width button, capped so it fits the button */
const dotPx = (sz: number) => Math.min(sz + 4, 28);

/** "ai" is the AI pen: it writes notes to the model, which are never
 *  transcribed. Same gesture as the pen, different meaning. */
type Tool = "pen" | "ai" | "eraser" | "lasso";

/** A change, recorded as how to take it back. Taking one back yields the
 *  entry that puts it back again, which is how redo works: the two stacks
 *  trade entries. */
type UndoEntry =
	| { kind: "stroke-add"; index: number }
	| { kind: "stroke-insert"; index: number; stroke: Stroke }
	| { kind: "strokes-set"; before: Stroke[] }
	| { kind: "sel-move"; strokes: Stroke[]; dx: number; dy: number };

/** How the pad was left. `convert` is set only by the convert button; closing
 *  any other way keeps the writing for next time. */
export interface PadExit { strokes: Stroke[]; convert: boolean }

/** How the pad is shown: over the whole screen, or in a pane beside the note */
export type PadMode = "full" | "split";
/** The edge the tool bar floats by */
export type ToolbarSide = "left" | "right" | "top" | "bottom";

/** What the pad needs from whatever it is shown in */
export interface PadHost {
	/** Where the pad's keyboard shortcuts go */
	scope: Scope;
	/** The tool bar's close button */
	close(): void;
	/** The convert button, once the page has something on it and there is a
	 *  key to convert it with */
	convert(): void;
	/** The button that moves the pad, page and all, to the other way of being
	 *  shown. Left out where there is no other way: a phone has no split view. */
	swap?: { to: PadMode; go(): void };
}

/** The pad over the whole screen. Closing it, with the close button or Esc,
 *  keeps the pad for next time; converting closes it and hands the page over;
 *  swapping closes it and hands the pad itself on, to be shown in a pane. */
export class PadModal extends Modal {
	private converting = false;
	private swapping = false;

	constructor(
		app: App,
		readonly pad: InkPad,
		private onExit: (exit: PadExit) => void,
		/** Absent where there is no split view */
		private onSwap?: () => void,
	) {
		super(app);
	}

	onOpen() {
		const m = this.modalEl;
		// The stock close button and title bar go: the tool bar has its own close
		m.empty();
		for (const [k, v] of Object.entries(MODAL)) m.style.setProperty(k, v, "important");
		// A focused note behind the pad would keep the on-screen keyboard up,
		// covering half the page
		(document.activeElement as HTMLElement | null)?.blur?.();
		this.pad.mount(m, {
			scope: this.scope,
			close: () => this.close(),
			convert: () => { this.converting = true; this.close(); },
			swap: this.onSwap ? { to: "split", go: () => { this.swapping = true; this.close(); } } : undefined,
		});
	}

	onClose() {
		const strokes = this.pad.unmount();
		if (this.swapping) this.onSwap?.();
		else this.onExit({ strokes, convert: this.converting });
	}
}

/** One sheet of paper, shown in whatever hosts it (see PadHost).
 *
 *  Not a document: it holds a page of ink until the user either converts it,
 *  which hands the strokes to the plugin to be read, or closes it, which keeps
 *  it, page and undo history, for next time. Nothing here touches the vault.
 *
 *  The page is a fixed A4 sheet. Zoomed all the way out the whole of it fits
 *  on screen; zoomed in, a finger pans it in either direction. */
export class InkPad {
	private root!: HTMLDivElement;
	private surface!: HTMLDivElement;
	private base!: HTMLCanvasElement;
	private live!: HTMLCanvasElement;
	private overlay!: HTMLDivElement;
	private bctx!: CanvasRenderingContext2D;
	private lctx!: CanvasRenderingContext2D;
	private tools!: HTMLDivElement;
	/** Left-hand bar showing the pen's widths */
	private ctxBar!: HTMLDivElement;
	private syncCtx: (() => void) | null = null;
	private syncTools: (() => void) | null = null;
	private dial: Dial | null = null;
	private ro?: ResizeObserver;
	private narrow: boolean | null = null;
	private desk = "";

	private strokes: Stroke[];
	private cur: Stroke | null = null;
	private lasso: [number, number][] | null = null;
	private drawing = false;
	private lastT = -1;
	private paintReq: number | null = null;
	/** A stroke just finished, still on the live layer while its predicted tip
	 *  shrinks back; it moves to the page once that is done */
	private retract: { st: Stroke; reach: number } | null = null;
	private retractRaf = 0;

	/** Where the eraser is, for the size preview ring */
	private eraserAt: { x: number; y: number } | null = null;
	/** Strokes as they were when an erase gesture began, so one drag is one undo */
	private eraseSnap: Stroke[] | null = null;
	/** The lasso selection: a ring plus the strokes it caught */
	private sel: { path: [number, number][]; strokes: Stroke[]; showOpts: boolean } | null = null;
	/** `id` is the pointer doing the dragging, so a second finger landing
	 *  mid-drag cannot tug the selection about */
	private selDrag: { id: number; ox: number; oy: number; dx: number; dy: number; moved: boolean } | null = null;
	/** Floating UI that must be counter-scaled: buttons should not grow with zoom */
	private counterScaled: HTMLElement[] = [];

	private tool: Tool = "pen";
	/** Which pen the dial goes back to when the eraser is put down */
	private lastPen: "pen" | "ai" = "pen";
	/** Which of the three width slots is active. The widths themselves live in
	 *  settings, so they survive a restart and follow the vault across devices. */
	private sizeIdx = 1;
	private get sizes() { return this.plugin.settings.sizes; }
	private get size() { return this.sizes[this.sizeIdx] ?? 8; }
	private undoStack: UndoEntry[] = [];
	private redoStack: UndoEntry[] = [];

	/** Tap detection: recorded on press, discarded once movement passes the
	 *  threshold, because that is a stroke or a pan rather than a tap */
	private tap: { x: number; y: number; finger: boolean } | null = null;
	/** A tap with several fingers in the making, from the first finger down:
	 *  where the view was then, and where each finger landed */
	private multiTap: { view: { zoom: number; panX: number; panY: number }; downs: Map<number, { x: number; y: number }>; last: number; second: number } | null = null;
	private panMoved = false;
	/** A finger is resting on the selection; the drag starts once it leaves the
	 *  dead zone */
	private fingerOnSel: { x: number; y: number } | null = null;

	/* Viewport. Zoom 1 is the whole page on screen; ink coordinates are always
	   page units, independent of the screen. */
	private zoom = 1;
	private panX = 0;
	private panY = 0;

	/** Fingers currently on the screen. Pen writes, finger scrolls, as in Notability. */
	private touches = new Map<number, { x: number; y: number }>();
	private pinch: { d: number; cx: number; cy: number; zoom: number } | null = null;
	private panFrom: { x: number; y: number } | null = null;
	/** Recent pan samples, used to estimate flick velocity when the finger lifts */
	private velSamples: { t: number; x: number; y: number }[] = [];
	private glideRaf = 0;

	/* What writing costs on this device. An iPad has no devtools, so the pad
	   measures itself and hands the numbers to the diagnostics panel on close. */
	private perf = {
		strokes: 0, events: 0, samples: 0, penMs: 0, down: 0,
		lag: [] as number[], live: [] as number[], paint: [] as number[],
		/* how many main and coalesced events arrived on whole pixels */
		mainN: 0, mainWhole: 0, coalN: 0, coalWhole: 0,
	};

	/** Whether the pen's positions arrive rounded, counted over the stroke in
	 *  hand, plus what the last stroke turned out to be -- the guess for the
	 *  first few samples of the next, before there are enough to tell */
	private grid = { n: 0, whole: 0, half: 0, last: 0 };
	/** Set on the first resize, which is when the page width is known */
	private placed = false;
	/** For a pad mounted again: the view it had, and the canvas size it had
	 *  it in. The same size gets the same view back; another (a pane after
	 *  full screen, say) gets the new width filled, on the same part of the
	 *  page. */
	private keep: { zoom: number; panX: number; panY: number; w: number; h: number } | null = null;
	/** The canvas size at the last unmount, for `keep` */
	private lastSize = { w: 0, h: 0 };
	/** Whether the pad is on screen: a parked one can still be handed a page */
	private mounted = false;
	/** The layout the bars were last built for, narrow or not and the tool
	 *  bar's side; unknown until measured */
	private layoutKey: string | null = null;
	/** The strip along each edge the cards float over, kept off the page. The
	 *  cards' own is worked out wherever they are placed; the page takes it
	 *  up only when it is laid out (opening, resizing, fitting), so dragging
	 *  the tool bar elsewhere leaves the page where it is. */
	private cardRoom = { left: 0, top: 0, right: 0, bottom: 0 };
	private room = { left: 0, top: 0, right: 0, bottom: 0 };
	private grip: HTMLElement | null = null;
	/** Ends a press on the tool bar that may yet become a drag */
	private hold: (() => void) | null = null;
	/** The tool bar being dragged: the press it began with, the shade over the
	 *  page, the places it can go and the nearest */
	private drag: { id: number; x: number; y: number; shade: HTMLElement;
		slots: Map<ToolbarSide, { el: HTMLElement; x: number; y: number; w: number; h: number }>; near: ToolbarSide } | null = null;
	/** The hint on moving the tool bar, until it has done its job */
	private hint: HTMLElement | null = null;
	/** The open "⋯" menu, and the scrim under it */
	private menu: HTMLElement | null = null;
	private scrim: HTMLElement | null = null;

	/** Whoever shows the pad now; set on each mount, since the pad can move */
	private host!: PadHost;
	/** The shortcuts registered with the host, to take back when leaving it */
	private keys: KeymapEventHandler[] = [];

	constructor(
		private plugin: HandwritingPlugin,
		strokes: Stroke[],
	) {
		this.strokes = strokes;
	}

	/* ============ Lifecycle ============ */

	/** Build the pad inside `parent`, which must already be in the document:
	 *  the desk colour is read from the theme, and the canvas sized to fit.
	 *  A pad taken down can be mounted again elsewhere, with its page, undo
	 *  history and view as they were. */
	mount(parent: HTMLElement, host: PadHost) {
		this.host = host;
		// Unknown until measured, so the first applyLayout builds both bars
		// again in the new place
		this.narrow = null;
		this.layoutKey = null;
		// The zoom is relative to the space the page has: kept in the same
		// space, replaced in another, where it would be wrong (a pad moved into
		// a narrower pane would be zoomed in)
		if (this.placed) { this.placed = false; this.keep = { zoom: this.zoom, panX: this.panX, panY: this.panY, ...this.lastSize }; }
		this.mounted = true;
		const root = this.root = parent.createDiv();
		// Obsidian's mobile edge swipes walk up from the touch target looking for
		// this flag, the same opt-out its own sliders use. Without it a finger on
		// the dial or either bar can open a sidebar mid-gesture.
		root.dataset.ignoreSwipe = "true";
		root.setAttribute("style", S.root);
		this.surface = root.createDiv({ attr: { style: S.surface } });
		this.base = this.surface.createEl("canvas", { attr: { style: S.canvas } });
		this.live = this.surface.createEl("canvas", { attr: { style: S.canvas } });
		const clip = this.surface.createDiv({ attr: { style: S.overlayClip } });
		this.overlay = clip.createDiv({ attr: { style: S.overlay } });
		// The eraser lives on the canvas, not in the tool column: it is reached
		// constantly, and Apple Pencil's own double-tap is not something a web
		// view can see.
		this.dial = buildEraserDial(this.surface, {
			isEraser: () => this.tool === "eraser",
			toggleEraser: () => this.setTool(this.tool === "eraser" ? this.lastPen : "eraser"),
			getMode: () => this.plugin.settings.eraserMode,
			setMode: (v) => { this.plugin.settings.eraserMode = v; void this.plugin.saveSettings(); },
			getSize: () => this.plugin.settings.eraserSize,
			setSize: (v, done) => {
				this.plugin.settings.eraserSize = v;
				if (done) void this.plugin.saveSettings();
			},
			scale: () => this.scale,
			moved: (x, y, done) => {
				this.plugin.settings.dialX = x;
				this.plugin.settings.dialY = y;
				if (done) void this.plugin.saveSettings();
			},
		});
		this.bctx = this.base.getContext("2d")!;
		// desynchronized skips the usual DOM compositing and sends the canvas
		// buffer as directly to the display controller as it can. Only the layer
		// being drawn on wants this; latency matters there, stability below.
		this.lctx = this.live.getContext("2d",
			this.plugin.settings.lowLatency ? { desynchronized: true } : {}) as CanvasRenderingContext2D;
		this.desk = getComputedStyle(root).getPropertyValue("--background-secondary").trim() || "#f2f2f2";

		this.ctxBar = root.createDiv({ attr: { style: S.ctxBar } });
		this.tools = root.createDiv({ attr: { style: S.tools } });
		this.applyLayout();   // the first call always builds both bars
		this.bindPointer();
		this.bindToolbarDrag();

		this.keys = [
			host.scope.register(["Mod"], "z", () => { this.undo(); return false; }),
			// Both spellings: with Shift held the key may arrive as "Z"
			host.scope.register(["Mod", "Shift"], "z", () => { this.redo(); return false; }),
			host.scope.register(["Mod", "Shift"], "Z", () => { this.redo(); return false; }),
			host.scope.register(["Mod"], "Enter", () => { this.tryConvert(); return false; }),
		];

		// The tool bar alone changing size (taking a second column, say) only
		// moves the cards; anything else lays the pad out again
		this.ro = new ResizeObserver((entries) => {
			if (entries.every((e) => e.target === this.tools)) { this.placeCards(); return; }
			this.applyLayout();
			this.resize();
		});
		this.ro.observe(root);         // decides the narrow layout
		this.ro.observe(this.surface); // decides the canvas size
		this.ro.observe(this.tools);   // wraps to two columns, moving the context bar
		this.resize();
		this.showHint();
	}

	/** Take the pad down and hand back what is on the page */
	unmount(): Stroke[] {
		for (const k of this.keys) this.host.scope.unregister(k);
		this.keys = [];
		this.ro?.disconnect();
		if (this.paintReq != null) window.cancelAnimationFrame(this.paintReq);
		// Settled rather than just stopped: a stroke left mid-retract is kept
		// off the page layer, and would stay off it after a remount
		this.settleRetract();
		this.stopGlide();
		// Fingers down here will never lift here; the next mount starts with none
		this.touches.clear();
		this.pinch = null;
		this.panFrom = null;
		this.plugin.padReport = this.report();
		const r = this.surface.getBoundingClientRect();
		this.lastSize = { w: r.width, h: r.height };
		// Each mount makes its own canvases. Emptied now, these do not keep two
		// screens' worth of pixels for as long as the pad is parked.
		for (const c of [this.base, this.live]) { c.width = 0; c.height = 0; }
		this.closeMenu();
		this.hold?.();
		this.drag = null;
		this.hint = null;
		this.mounted = false;
		this.root.remove();
		return this.strokes;
	}

	/** Whether there is anything on the page */
	get empty() { return !this.strokes.length; }
	get strokeCount() { return this.strokes.length; }

	/** Opening a parked pad again: the page, history and view come back, but
	 *  it starts with the pen in hand, the middle width, nothing selected, as
	 *  a new pad does. Call before mounting. */
	takeUpPen() {
		this.tool = this.lastPen = "pen";
		this.sizeIdx = 1;
		this.eraserAt = null;
		this.lasso = null;
		this.sel = null;
	}

	/** Hand the page over and start a clean one, for a host that stays open
	 *  after converting. The undo history goes with it: undoing back into a
	 *  page already sent would send it twice. The clean page opens as a new
	 *  pad does, at the top, filling the width. */
	takePage(): Stroke[] {
		const page = this.strokes;
		this.setPage([]);
		this.zoom = this.widthZoom();
		this.panX = this.panY = -Infinity;
		this.syncViewport();
		return page;
	}

	/** Put a page back, when converting it failed */
	setPage(strokes: Stroke[]) {
		this.settleRetract();
		this.strokes = strokes;
		this.undoStack = [];
		this.redoStack = [];
		// Off screen there is nothing to draw: the next mount draws it all
		if (!this.mounted) { this.sel = null; return; }
		this.clearSelection();
		this.redrawAll();
	}

	private report(): Record<string, string> {
		const f = this.perf, sec = f.penMs / 1000;
		return {
			"pen strokes": String(f.strokes),
			"pen events / s": sec > 0 ? (f.events / sec).toFixed(0) : "write something first",
			"samples / s": sec > 0 ? (f.samples / sec).toFixed(0) : "-",
			"samples per event": f.events ? (f.samples / f.events).toFixed(2) : "-",
			"input lag p50/p95/max": pct(f.lag),
			"live draw p50/p95/max": pct(f.live),
			"page repaint p50/p95/max": pct(f.paint),
			"whole-pixel coords": `main ${share(f.mainWhole, f.mainN)}, coalesced ${share(f.coalWhole, f.coalN)}`,
			"rounding corrected": this.grid.last ? `yes, ${this.grid.last} px steps` : "no (input looks precise)",
			"curve": this.plugin.settings.curve ? `spline from ${SPLINE_FROM} device px/unit, now ${this.lod().curve ? "spline" : "straight"}` : "straight",
			"scale at close": `${this.scale.toFixed(3)} px/unit, zoom ${this.zoom.toFixed(2)}`,
			"low-latency canvas": this.lctx.getContextAttributes?.().desynchronized ? "desynchronized active" : "normal compositing",
			"coalesced events API": typeof PointerEvent.prototype.getCoalescedEvents === "function" ? "yes" : "no",
		};
	}

	/** The convert button. Checked here rather than after closing, so a missing
	 *  key leaves you on the page you wrote instead of throwing it away. */
	private tryConvert() {
		if (!this.strokes.length) { new Notice(t("notice.empty")); return; }
		const problem = this.plugin.convertBlocker();
		if (problem) { new Notice(problem); return; }
		this.host.convert();
	}

	private applyLayout() {
		const narrow = this.root.clientWidth > 0 && this.root.clientWidth < 420;
		this.narrow = narrow;
		const key = `${narrow}:${this.side}`;
		if (key === this.layoutKey) return;
		this.layoutKey = key;
		const across = this.across;
		this.root.setAttribute("style", narrow ? S.rootNarrow : S.root);
		this.tools.setAttribute("style", across ? S.toolsRow : S.tools);
		if (this.ctxBar.isConnected) this.ctxBar.setAttribute("style", across ? S.ctxBarRow : S.ctxBar);
		this.buildToolbar();
		this.buildContextBar();
		this.placeCards();
	}

	/** The edge the tool bar floats by. A narrow pad has room for a row only:
	 *  top stays top, and the sides go to the foot. */
	private get side(): ToolbarSide {
		const s = this.plugin.settings.toolbarSide;
		return this.narrow ? (s === "top" ? "top" : "bottom") : s;
	}
	/** Whether the bars run across the pad, as rows, rather than down it */
	private get across() { return this.side === "top" || this.side === "bottom"; }

	/* ============ Tool bar ============ */

	private setTool(tool: Tool) {
		this.tool = tool;
		if (tool === "pen" || tool === "ai") this.lastPen = tool;
		if (tool !== "eraser") this.eraserAt = null;
		if (tool !== "lasso") this.clearSelection();
		this.syncTools?.();
		this.buildContextBar();
		this.redrawLive();
	}

	private buildToolbar() {
		const bar = this.tools;
		bar.empty();
		// Its button is gone; a menu left open would point at nothing
		this.closeMenu();

		const off = this.narrow ? S.btnSm : S.btn, on = this.narrow ? S.btnSmOn : S.btnOn;
		const btn = (icon: keyof typeof ICONS, title: string, cb: () => void) => {
			const b = bar.createEl("button", { attr: { "aria-label": title, title, style: off } });
			drawIcon(b, icon);
			b.addEventListener("click", cb);
			return b;
		};
		const across = this.across;
		const sep = () => bar.createDiv({ attr: { style: across ? S.sepNarrow : S.sep } });

		this.grip = bar.createDiv({ attr: { style: across ? S.gripRow : S.grip } });
		this.grip.createDiv({ attr: { style: across ? S.gripBarRow : S.gripBar } });
		btn("close", t("tool.close"), () => this.host.close());
		const swap = this.host.swap;
		if (swap) {
			const split = swap.to === "split";
			const b = btn(swap.to, t(split ? "tool.split" : "tool.full"), () => swap.go());
			// Worded as well as drawn: an icon alone leaves you guessing whether
			// it shows where the pad is or where it would go
			b.setAttribute("style", off + S.btnStacked);
			b.createDiv({ text: t(split ? "tool.splitLabel" : "tool.fullLabel"), attr: { style: S.btnCaption } });
		}
		sep();
		const penBtn = btn("pen", t("tool.pen"), () => this.setTool("pen"));
		const aiBtn = btn("pen", t("tool.aiPen"), () => this.setTool("ai"));
		aiBtn.createDiv({ text: "AI", attr: { style: S.btnBadge + `color:${NOTE_INK};` } });
		const lasBtn = btn("lasso", t("tool.lasso"), () => this.setTool("lasso"));
		sep();
		btn("undo", t("tool.undo"), () => this.undo());
		btn("redo", t("tool.redo"), () => this.redo());
		const more: HTMLElement = btn("more", t("tool.more"), () => this.openMenu(more));
		more.setAttribute("style", off + S.btnStacked);
		more.createDiv({ text: t("tool.moreLabel"), attr: { style: S.btnCaption } });

		const go = bar.createEl("button", {
			attr: { "aria-label": t("tool.convertHint"), title: t("tool.convertHint"), style: !across ? S.go : this.narrow ? S.goNarrow : S.goRow },
		});
		drawIcon(go, "send", 18);
		if (!across) go.createSpan({ text: t("tool.convert") });
		go.addEventListener("click", () => this.tryConvert());

		this.syncTools = () => {
			this.dial?.refresh();
			penBtn.setAttribute("style", this.tool === "pen" ? on : off);
			aiBtn.setAttribute("style", (this.tool === "ai" ? on : off) + `color:${NOTE_INK};`);
			lasBtn.setAttribute("style", this.tool === "lasso" ? on : off);
		};
		this.syncTools();
	}

	/** The "⋯" menu: what is not needed at every turn of the pen. It opens
	 *  beside its button, toward the page, over a scrim that takes the next
	 *  tap anywhere else: that tap only closes it, and writes nothing. */
	private openMenu(anchor: HTMLElement) {
		this.closeMenu();
		const scrim = this.root.createDiv({ attr: { style: S.scrim } });
		// Kept until the finger or pen lifts, so the rest of the touch does not
		// land on the page with no start
		scrim.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			scrim.setPointerCapture(e.pointerId);
			this.menu?.remove();
			this.menu = null;
			this.eatClick();
		});
		for (const type of ["pointerup", "pointercancel"]) scrim.addEventListener(type, () => this.closeMenu());
		scrim.addEventListener("wheel", (e) => { e.preventDefault(); this.closeMenu(); }, { passive: false });

		const menu = this.root.createDiv({ attr: { style: S.menu, role: "menu" } });
		const item = (icon: keyof typeof ICONS, label: string, cb: () => void, danger = false) => {
			const b = menu.createEl("button", { attr: { role: "menuitem", style: S.menuItem + (danger ? S.menuDanger : "") } });
			drawIcon(b, icon, 18);
			b.createSpan({ text: label });
			b.addEventListener("click", () => { this.closeMenu(); cb(); });
		};
		menu.createDiv({ text: t("menu.position"), attr: { style: S.menuHead } });
		const places = menu.createDiv({ attr: { style: S.menuSides } });
		const sides: ToolbarSide[] = this.narrow ? ["top", "bottom"] : ["left", "right", "top", "bottom"];
		for (const side of sides) {
			const here = side === this.side;
			const b = places.createEl("button", {
				attr: { role: "menuitemradio", "aria-checked": String(here), "aria-label": t(`side.${side}`), style: here ? S.sideBtnOn : S.sideBtn },
			});
			drawIcon(b, side, 20);
			b.createDiv({ text: t(`side.${side}`), attr: { style: S.btnCaption } });
			b.addEventListener("click", () => { this.closeMenu(); this.moveToolbar(side); });
		}
		item("fit", t("tool.fit"), () => this.fitPage());
		item("trash", t("tool.clear"), () => this.clearPage(), true);
		this.menu = menu;
		this.scrim = scrim;

		// Beside a column, toward the page; above or below a row
		const r = this.root.getBoundingClientRect(), a = anchor.getBoundingClientRect();
		const w = menu.offsetWidth, h = menu.offsetHeight, gap = 8;
		const ax = a.left - r.left, ay = a.top - r.top;
		let x: number, y: number;
		if (this.across) {
			x = ax + a.width - w;
			y = ay > r.height / 2 ? ay - gap - h : ay + a.height + gap;
		} else {
			x = ax > r.width / 2 ? ax - gap - w : ax + a.width + gap;
			y = ay;
		}
		const clamp = (v: number, hi: number) => Math.max(gap, Math.min(v, hi - gap));
		menu.setCssProps({ left: clamp(x, r.width - w) + "px", top: clamp(y, r.height - h) + "px" });
	}

	/** A finger's tap ends in a click, sent after the lift to whatever is under
	 *  it by then. The scrim is gone by then, so the tap that closed the menu
	 *  would also press the button under it: "⋯" opening the menu again, or
	 *  another tool. That click is taken here, before anything sees it. A
	 *  browser may send none, so the next touch down stops the watch, rather
	 *  than letting it take a real click later. */
	private eatClick() {
		const root = this.root;
		const eat = (e: Event) => { e.preventDefault(); e.stopPropagation(); stop(); };
		const stop = () => {
			root.removeEventListener("click", eat, true);
			root.removeEventListener("pointerdown", stop, true);
		};
		root.addEventListener("click", eat, true);
		root.addEventListener("pointerdown", stop, true);
	}

	private closeMenu() {
		this.menu?.remove();
		this.scrim?.remove();
		this.menu = this.scrim = null;
	}

	/* ============ Left context bar ============ */

	/** Keep the dial on the canvas. The surface resizes under it on rotation and
	 *  in split view, and a dial parked off the edge could never be got back.
	 *  Until it is moved it sits at the top left of the page's part, so a tool
	 *  bar along the top or the left does not start out under it. */
	private placeDial() {
		if (!this.dial) return;
		const r = this.surface.getBoundingClientRect();
		if (!r.width || !r.height) return;
		const s = this.plugin.settings;
		const first = s.dialX < 0 || s.dialY < 0;
		const at = this.dial.place(first ? this.cardRoom.left + 14 : s.dialX, first ? this.cardRoom.top + 14 : s.dialY,
			{ w: r.width, h: r.height });
		if (!first) { s.dialX = at.x; s.dialY = at.y; }
	}

	/** Float the cards over the canvas by the tool bar's edge: by a side, the
	 *  tool bar a column at the middle with the widths beside it, toward the
	 *  page; by the top or the foot, a row at the middle with the widths
	 *  beside it likewise. Their sizes follow their contents, so they are
	 *  measured each time. */
	private placeCards() {
		const W = this.root.clientWidth, H = this.root.clientHeight;
		const t = this.tools, c = this.ctxBar, side = this.side;
		const tw = t.offsetWidth, th = t.offsetHeight;
		const cw = c.isConnected ? c.offsetWidth : 0, ch = c.isConnected ? c.offsetHeight : 0;
		const room = { left: 0, top: 0, right: 0, bottom: 0 };
		let tx: number, ty: number, cx: number, cy: number;
		if (side === "left" || side === "right") {
			ty = cy = Math.max(CARD_EDGE, (H - th) / 2);
			tx = side === "right" ? W - CARD_EDGE - tw : CARD_EDGE;
			cx = side === "right" ? tx - CARD_GAP - cw : tx + tw + CARD_GAP;
			room[side] = CARD_EDGE + tw + CARD_GAP + CTX_W;
		} else {
			tx = (W - tw) / 2;
			cx = (W - cw) / 2;
			ty = side === "bottom" ? H - CARD_EDGE - th : CARD_EDGE;
			cy = side === "bottom" ? ty - CARD_GAP - ch : ty + th + CARD_GAP;
			room[side] = CARD_EDGE + th + CARD_GAP + CTX_H;
		}
		t.setCssProps({ left: tx + "px", top: ty + "px" });
		if (c.isConnected) c.setCssProps({ left: cx + "px", top: cy + "px" });
		this.cardRoom = room;
		this.placeHint();
	}

	/* ============ Moving the tool bar ============ */

	/** Holding the tool bar takes it up, to be dragged to another edge: a
	 *  moment's hold anywhere on it, buttons included, or straight away by its
	 *  grip. A quick tap on a button is still a tap. The press is followed on
	 *  the document: until it is a drag nothing is captured, which would take
	 *  the click away from the button. */
	private bindToolbarDrag() {
		this.tools.addEventListener("pointerdown", (e: PointerEvent) => {
			if (this.hold || this.drag || e.button !== 0) return;
			const doc = this.root.ownerDocument;
			const move = (ev: PointerEvent) => {
				if (ev.pointerId !== e.pointerId) return;
				if (this.drag) this.dragToolbar(ev);
				else if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > LIFT_SLOP) stop();
			};
			const end = (ev: PointerEvent) => {
				if (ev.pointerId !== e.pointerId) return;
				if (this.drag) this.dropToolbar(ev.type === "pointerup");
				stop();
			};
			const stop = () => {
				window.clearTimeout(timer);
				doc.removeEventListener("pointermove", move);
				doc.removeEventListener("pointerup", end);
				doc.removeEventListener("pointercancel", end);
				this.hold = null;
			};
			const timer = window.setTimeout(() => this.liftToolbar(e), this.grip?.contains(e.target as Node) ? 0 : LIFT_MS);
			doc.addEventListener("pointermove", move);
			doc.addEventListener("pointerup", end);
			doc.addEventListener("pointercancel", end);
			this.hold = stop;
		});
	}

	/** Take the tool bar up: the page shaded, an outline at each place it can
	 *  go, sized as it would be there */
	private liftToolbar(e: PointerEvent) {
		const t = this.tools;
		try { t.setPointerCapture(e.pointerId); } catch { /* lifted after all fingers left; the drag ends at once */ }
		this.closeMenu();
		this.dismissHint();
		// The press began on a button, and ends in a click on it: not this time
		this.eatClick();
		this.ctxBar.remove();
		const W = this.root.clientWidth, H = this.root.clientHeight;
		const now = { w: t.offsetWidth, h: t.offsetHeight };
		const col = this.across ? { w: now.h, h: now.w } : now;
		const row = { w: Math.min(col.h, W - CARD_EDGE * 2), h: col.w };
		col.h = Math.min(col.h, H - CARD_EDGE * 2);
		const at: Record<ToolbarSide, { x: number; y: number; w: number; h: number }> = {
			left: { x: CARD_EDGE, y: (H - col.h) / 2, ...col },
			right: { x: W - CARD_EDGE - col.w, y: (H - col.h) / 2, ...col },
			top: { x: (W - row.w) / 2, y: CARD_EDGE, ...row },
			bottom: { x: (W - row.w) / 2, y: H - CARD_EDGE - row.h, ...row },
		};
		const shade = this.root.createDiv({ attr: { style: S.dragShade } });
		const slots = new Map<ToolbarSide, { el: HTMLElement; x: number; y: number; w: number; h: number }>();
		const sides: ToolbarSide[] = this.narrow ? ["top", "bottom"] : ["left", "right", "top", "bottom"];
		for (const side of sides) slots.set(side, { el: shade.createDiv(), ...at[side] });
		t.setAttribute("style", (t.getAttribute("style") ?? "") + S.lifted);
		this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, shade, slots, near: this.side };
		this.dragToolbar(e);
	}

	/** The tool bar follows the press; the place nearest it lights up */
	private dragToolbar(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		this.tools.setCssProps({ transform: `translate(${e.clientX - d.x}px, ${e.clientY - d.y}px) scale(1.04)` });
		const r = this.root.getBoundingClientRect();
		const px = e.clientX - r.left, py = e.clientY - r.top;
		let best = d.near, bestD = Infinity;
		for (const [side, s] of d.slots) {
			const dist = Math.hypot(Math.max(s.x - px, 0, px - s.x - s.w), Math.max(s.y - py, 0, py - s.y - s.h));
			if (dist < bestD) { bestD = dist; best = side; }
		}
		d.near = best;
		for (const [side, s] of d.slots)
			s.el.setAttribute("style", (side === best ? S.slotOn : S.slot) + `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;`);
	}

	/** Let go: to the place lit up, or, if the press was cancelled, back */
	private dropToolbar(commit: boolean) {
		const d = this.drag;
		if (!d) return;
		this.drag = null;
		d.shade.remove();
		if (commit) this.moveToolbar(d.near);
		else { this.layoutKey = null; this.applyLayout(); }
	}

	/** Put the tool bar by another edge, and keep it there, here and in any pad
	 *  opened later. The page stays where it is: it makes way for the cards
	 *  the next time it is laid out. */
	private moveToolbar(side: ToolbarSide) {
		const s = this.plugin.settings;
		s.toolbarSide = side;
		s.toolbarHintSeen = true;
		void this.plugin.saveSettings();
		this.dismissHint();
		this.layoutKey = null;
		this.applyLayout();
		// A dial never moved starts clear of the cards; it follows them
		this.placeDial();
	}

	/** Tell of the drag once: by the tool bar until it has been moved, or
	 *  until the hint is tapped */
	private showHint() {
		if (this.plugin.settings.toolbarHintSeen || this.hint) return;
		const h = this.hint = this.root.createDiv({ attr: { style: S.hint } });
		h.createSpan({ text: t("hint.drag") });
		h.createDiv({ attr: { style: S.hintArrow } });
		h.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const s = this.plugin.settings;
			s.toolbarHintSeen = true;
			void this.plugin.saveSettings();
			this.dismissHint();
		});
		this.placeHint();
	}

	private dismissHint() {
		this.hint?.remove();
		this.hint = null;
	}

	/** Over a column, its arrow at the grip, where there is room; otherwise
	 *  beside the cards, toward the page */
	private placeHint() {
		const h = this.hint;
		if (!h) return;
		const W = this.root.clientWidth, H = this.root.clientHeight, gap = 10;
		const t = this.tools, c = this.ctxBar.isConnected ? this.ctxBar : t;
		const tl = t.offsetLeft, tt = t.offsetTop, tw = t.offsetWidth;
		const ul = Math.min(tl, c.offsetLeft), ut = Math.min(tt, c.offsetTop);
		const ur = Math.max(tl + tw, c.offsetLeft + c.offsetWidth), ub = Math.max(tt + t.offsetHeight, c.offsetTop + c.offsetHeight);
		const hw = h.offsetWidth, hh = h.offsetHeight, side = this.side;
		let x: number, y: number, arrow: number | null = null;
		if (!this.across && tt - gap - hh >= CARD_EDGE) {
			y = tt - gap - hh;
			x = side === "right" ? tl + tw - hw : tl;
			arrow = tl + tw / 2 - 5;
		} else if (side === "right") { x = ul - gap - hw; y = tt; }
		else if (side === "left") { x = ur + gap; y = tt; }
		else if (side === "top") { x = tl; y = ub + gap; }
		else { x = tl; y = ut - gap - hh; }
		x = Math.max(8, Math.min(x, W - hw - 8));
		y = Math.max(8, Math.min(y, H - hh - 8));
		h.setCssProps({ left: x + "px", top: y + "px" });
		const a = h.lastElementChild as HTMLElement;
		a.setAttribute("style", S.hintArrow + (arrow === null ? "display:none;" : `left:${arrow - x}px;`));
	}

	private buildContextBar() {
		const bar = this.ctxBar;
		bar.empty();
		this.syncCtx = null;

		// Only the pens have anything to configure, the eraser carrying its own
		// settings in the dial, so for every other tool the column is detached
		// from the DOM rather than merely hidden. It floats over the canvas, so
		// attaching and detaching it never resizes the drawing area.
		if (this.tool !== "pen" && this.tool !== "ai") { bar.remove(); return; }
		if (!bar.isConnected) {
			// Reapply the style: applyLayout skips the bar while it is detached
			bar.setAttribute("style", this.across ? S.ctxBarRow : S.ctxBar);
			this.root.insertBefore(bar, this.tools);
		}
		this.placeCards();
		const vert = !this.across;

		const dots: HTMLElement[] = [];
		const btns = this.sizes.map((sz, i) => {
			const b = bar.createEl("button", { attr: { "aria-label": t("ctx.penWidth", sz), style: S.btn } });
			dots.push(b.createDiv({ attr: { style: S.dot(dotPx(sz)) } }));
			b.addEventListener("click", () => { this.sizeIdx = i; sync(); });
			return b;
		});
		bar.createDiv({ attr: { style: vert ? S.sep : S.sepNarrow } });

		// Adjusts whichever width slot is active, previewing on its dot
		const slider = this.makeSlider(bar, vert, 1, 28,
			() => this.sizes[this.sizeIdx],
			(v) => {
				this.sizes[this.sizeIdx] = v;
				dots[this.sizeIdx].setAttribute("style", S.dot(dotPx(v)));
				btns[this.sizeIdx].setAttribute("aria-label", t("ctx.penWidth", v));
			},
			() => { void this.plugin.saveSettings(); });

		const sync = () => {
			btns.forEach((b, i) => b.setAttribute("style", i === this.sizeIdx ? S.btnOn : S.btn));
			slider.refresh();
		};
		this.syncCtx = sync;
		sync();
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
		const LEN = 118, THICK = 26, KNOB = 18;
		const el = parent.createDiv({
			attr: { style: S.slider + (vert ? `width:${THICK}px;height:${LEN}px;` : `width:${LEN}px;height:${THICK}px;`) },
		});
		el.createDiv({
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
			const f = (v - min) / (max - min);
			if (vert) {
				// Up is more, which reads the right way round for a size control
				const y = (1 - f) * span;
				knob.style.left = `${THICK / 2 - KNOB / 2}px`;
				knob.style.top = `${y}px`;
				fill.style.cssText = S.sliderFill + `left:${THICK / 2 - 2}px;width:4px;top:${y + KNOB / 2}px;height:${span - y}px;`;
			} else {
				const x = f * span;
				knob.style.top = `${THICK / 2 - KNOB / 2}px`;
				knob.style.left = `${x}px`;
				fill.style.cssText = S.sliderFill + `top:${THICK / 2 - 2}px;height:4px;left:${KNOB / 2}px;width:${x}px;`;
			}
			label.setText(String(v));
		};

		const apply = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			const f = vert
				? 1 - (e.clientY - r.top - KNOB / 2) / span
				: (e.clientX - r.left - KNOB / 2) / span;
			const v = Math.round(min + Math.min(Math.max(f, 0), 1) * (max - min));
			if (v !== get()) onInput(v);
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

		refresh();
		return { refresh };
	}

	/* ============ Size and coordinates ============ */

	/** The part of the canvas the page may use, in css px: all of it but the
	 *  strip the cards float over, so that it opens clear of them. The width
	 *  bar's room is kept even while it is hidden, so the page does not jump
	 *  sideways each time the pen is picked up or put down. */
	private get usableW() { return Math.max(this.surface.clientWidth - this.room.left - this.room.right, 80); }
	private get usableH() { return Math.max(this.surface.clientHeight - this.room.top - this.room.bottom, 80); }

	/** The zoom at which the page fills the width. Held upright that is zoom 1
	 *  anyway; in landscape the whole page is small, and the pad opens here. */
	private widthZoom() {
		return Math.max(1, (Math.max(this.usableW - EDGE_PAD * 2, 80) / PAGE_W) / this.fitScale);
	}

	/** Screen pixels per page unit at zoom 1: the whole page fits, with EDGE_PAD
	 *  to spare, so zooming out never shows less than all of it. On an iPad held
	 *  upright that is close to the full width anyway. */
	private get fitScale() {
		const w = Math.max(this.usableW - EDGE_PAD * 2, 80);
		const h = Math.max(this.usableH - EDGE_PAD * 2, 80);
		return Math.min(w / PAGE_W, h / PAGE_H);
	}
	private get scale() { return this.fitScale * this.zoom; }
	/** The whole canvas, in page units: what has to be painted */
	private get viewW() { return this.surface.clientWidth / this.scale; }
	private get viewH() { return this.surface.clientHeight / this.scale; }

	private resize() {
		const r = this.surface.getBoundingClientRect();
		if (!r.width || !r.height) return;
		const dpr = window.devicePixelRatio || 1;
		for (const cv of [this.base, this.live]) {
			cv.width = Math.round(r.width * dpr);
			cv.height = Math.round(r.height * dpr);
			cv.style.width = r.width + "px";
			cv.style.height = r.height + "px";
		}
		// The page is laid out clear of the cards: their room first
		this.placeCards();
		this.room = this.cardRoom;
		if (!this.placed) {
			// Open at the top of the page, filling the width. A pad mounted again
			// gets its view back in the same space, and in another fills the new
			// width where it was.
			this.placed = true;
			const k = this.keep;
			this.keep = null;
			if (k && Math.abs(k.w - r.width) < 1 && Math.abs(k.h - r.height) < 1) {
				this.zoom = k.zoom;
				this.panX = k.panX;
				this.panY = k.panY;
			} else {
				this.zoom = this.widthZoom();
				this.panX = -Infinity;
				this.panY = k ? k.panY : -Infinity;
			}
		}
		this.clampPan();
		this.placeDial();
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

	/** @param r  the canvas rect, when the caller already has it: a batch of
	 *  coalesced samples needs it once, not once per sample */
	private toPage(e: { clientX: number; clientY: number; pressure?: number; timeStamp?: number }, r = this.live.getBoundingClientRect()) {
		return {
			x: (e.clientX - r.left) / this.scale + this.panX,
			y: (e.clientY - r.top) / this.scale + this.panY,
			p: e.pressure ?? 0.5,
			t: e.timeStamp,
		};
	}

	/** On each axis: a page smaller than the usable area sits in its middle, a
	 *  larger one can be panned until its edge, plus the margin, reaches the
	 *  area's edge */
	private clampPan() {
		const m = EDGE_PAD / this.scale;
		const fit = (pan: number, view: number, page: number) =>
			view >= page + 2 * m ? -(view - page) / 2 : Math.min(Math.max(pan, -m), page - view + m);
		// Worked out from the usable area's corner, which room on the left or
		// at the top moves off the canvas's own
		const ox = this.room.left / this.scale, oy = this.room.top / this.scale;
		this.panX = fit(this.panX + ox, this.usableW / this.scale, PAGE_W) - ox;
		this.panY = fit(this.panY + oy, this.usableH / this.scale, PAGE_H) - oy;
	}

	private syncViewport() {
		this.clampPan();
		this.redrawAll();
		this.syncOverlayTransform();
	}

	private opts(): InkOpts { return this.plugin.opts(); }

	/** The settings as they apply at the current zoom: the spline only once it
	 *  would show (see SPLINE_FROM) */
	private lod(): InkOpts {
		const o = this.opts();
		return o.curve && this.scale * (window.devicePixelRatio || 1) >= SPLINE_FROM ? o : { ...o, curve: 0 };
	}

	/* ============ Canvas rendering ============ */

	/** Coalesce base-layer repaints to one per animation frame. Pinch and pan
	 *  deliver about 120 pointermove events a second on a 60Hz panel, and
	 *  re-rasterising every visible stroke on each one wastes half the work.
	 *  Nothing reads the canvas back, so deferring a frame is safe everywhere. */
	private redrawAll() {
		if (this.paintReq != null) return;
		this.paintReq = window.requestAnimationFrame(() => { this.paintReq = null; this.paintAll(); });
	}

	private paintAll() {
		const t0 = performance.now();
		const cx = this.bctx;
		cx.setTransform(1, 0, 0, 1, 0, 0);
		cx.clearRect(0, 0, this.base.width, this.base.height);
		this.applyTransform(cx);

		// The desk around the page, then the page and its edge
		cx.fillStyle = this.desk;
		cx.fillRect(this.panX - 8, this.panY - 8, this.viewW + 16, this.viewH + 16);
		cx.fillStyle = PAPER;
		cx.fillRect(0, 0, PAGE_W, PAGE_H);
		cx.lineWidth = 1 / this.scale;
		cx.strokeStyle = "rgba(0,0,0,.22)";
		cx.strokeRect(0, 0, PAGE_W, PAGE_H);

		// Zoomed in, most of the page is off screen; skip the ink that is
		const x0 = this.panX - 40, x1 = this.panX + this.viewW + 40;
		const y0 = this.panY - 40, y1 = this.panY + this.viewH + 40;
		for (const st of this.strokes) {
			if (st === this.retract?.st) continue;   // still on the live layer
			const b = bboxOf(st);
			if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
			this.fillStroke(cx, st);
		}
		this.redrawLive();
		push(this.perf.paint, performance.now() - t0);
	}

	/** Fill a finished stroke from its cached outline at the current level of
	 *  detail, building it the first time, or again once the stroke has moved
	 *  or the settings have changed */
	private fillStroke(cx: CanvasRenderingContext2D, st: Stroke) {
		const path = outline(st, this.lod());
		if (!path) return;
		cx.fillStyle = st.c;
		cx.fill(path);
	}

	private drawRing(cx: CanvasRenderingContext2D, path: [number, number][], drawing: boolean) {
		if (path.length < 2) return;
		cx.save();
		cx.setLineDash(drawing ? [] : [9 / this.scale, 6 / this.scale]);
		cx.lineWidth = (drawing ? 2 : 3) / this.scale;
		cx.strokeStyle = "rgba(70,135,255,1)";
		pathToCanvas(cx, path);
		if (!drawing) {
			cx.fillStyle = "rgba(70,135,255,.16)";
			cx.fill();
		}
		cx.stroke();
		cx.restore();
	}

	/** Called straight from the event rather than via requestAnimationFrame,
	 *  which would cost up to a whole frame. Coalesced events already arrive one
	 *  batch per frame, so this adds no redraws; it just happens a frame earlier. */
	private redrawLive() {
		this.lctx.setTransform(1, 0, 0, 1, 0, 0);
		this.lctx.clearRect(0, 0, this.live.width, this.live.height);
		this.applyTransform(this.lctx);
		// Predicted points are drawn but never stored; the next batch of real
		// samples discards and recomputes them
		if (this.cur) drawStroke(this.lctx, this.cur, this.lod(), this.drawing ? this.plugin.settings.predict : 0);
		if (this.retract) drawStroke(this.lctx, this.retract.st, this.lod(), this.plugin.settings.predict, this.retract.reach);
		if (this.lasso) this.drawRing(this.lctx, this.lasso, true);
		if (this.sel) this.drawRing(this.lctx, this.sel.path, false);
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

	/** The pen has lifted, so the predicted tip was a guess past where the
	 *  stroke really ends. Shrink it back over four frames, about 65ms, then
	 *  hand the stroke to the page: vanishing in one frame, it read as the
	 *  stroke jumping. */
	private finishRetract(st: Stroke) {
		this.settleRetract();
		if (!this.plugin.settings.predict) { this.fillStroke(this.bctx, st); return; }
		this.retract = { st, reach: 1 };
		const step = () => {
			const r = this.retract;
			if (!r) return;
			r.reach -= 0.25;
			if (r.reach <= 1e-6) { this.settleRetract(); return; }
			this.redrawLive();
			this.retractRaf = window.requestAnimationFrame(step);
		};
		this.retractRaf = window.requestAnimationFrame(step);
	}

	/** Put a shrinking stroke on the page now, as it will end up */
	private settleRetract() {
		window.cancelAnimationFrame(this.retractRaf);
		const r = this.retract;
		if (!r) return;
		this.retract = null;
		// Onto the page first, then off the live layer, so there is no frame
		// with the stroke on neither
		if (this.strokes.includes(r.st)) this.fillStroke(this.bctx, r.st);
		this.redrawLive();
	}

	/* ============ Input ============ */

	/* Responsibilities are split by input device:
	 *   pen     writes, erases, draws the lasso and drags a selection
	 *   finger  pans, pinch-zooms, drags a selection, and taps one to bring up
	 *           its delete button. Never draws, unless the setting allows it.
	 *   mouse   there is no finger on desktop, so it acts as the pen, and the
	 *           wheel pans and zooms.
	 */
	private bindPointer() {
		const el = this.live;

		// Everything that happens on the canvas is ours. Stopping it here spares
		// every pen sample a trip through whatever Obsidian listens for higher up.
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
			el.addEventListener(type, (e) => e.stopPropagation());

		el.addEventListener("pointerdown", (e: PointerEvent) => {
			const finger = e.pointerType === "touch";
			// Anything new: the last stroke's tip has shrunk enough
			this.settleRetract();

			if (finger && !this.plugin.settings.allowFinger) {
				// Ignore every touch while the pen is down, or resting a palm on the
				// screen while writing would scroll the page
				if (this.drawing) return;
				this.stopGlide();
				if (!this.touches.size) this.multiTap = { view: { zoom: this.zoom, panX: this.panX, panY: this.panY }, downs: new Map(), last: e.timeStamp, second: 0 };
				const mt = this.multiTap;
				if (mt && e.timeStamp - mt.last <= MULTI_TAP_GAP) {
					mt.downs.set(e.pointerId, { x: e.clientX, y: e.clientY });
					mt.last = e.timeStamp;
					if (mt.downs.size === 2) mt.second = e.timeStamp;
				} else this.multiTap = null;
				this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
				el.setPointerCapture(e.pointerId);
				// Several fingers are a pinch or a multi-finger tap, never a tap
				if (this.touches.size >= 2) { this.panFrom = null; this.fingerOnSel = null; this.tap = null; return; }

				const p = this.toPage(e);
				this.tap = { x: e.clientX, y: e.clientY, finger: true };
				// On the selection a drag moves it, anywhere else it pans. Either way
				// the gesture only starts past the dead zone, so a tap stays a tap.
				if (this.sel && pointInPoly(this.sel.path, p.x, p.y)) {
					this.fingerOnSel = { x: e.clientX, y: e.clientY };
					this.panFrom = null;
					return;
				}
				this.fingerOnSel = null;
				this.panFrom = { x: e.clientX, y: e.clientY };
				this.velSamples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
				this.panMoved = false;
				return;
			}

			e.preventDefault();
			// The pen takes over everything: drop any pan in progress
			if (!finger) { this.stopGlide(); this.touches.clear(); this.panFrom = null; this.pinch = null; this.multiTap = null; }
			el.setPointerCapture(e.pointerId);
			const pt = this.toPage(e);

			if (this.tool === "eraser") {
				this.drawing = true;
				this.eraseSnap = this.strokes;
				this.eraseAt(pt.x, pt.y);
				return;
			}
			if (this.tool === "lasso") {
				// Pressing inside the selection picks it up; anywhere else starts a
				// new ring, which replaces it
				if (this.sel && pointInPoly(this.sel.path, pt.x, pt.y)) {
					this.selDrag = { id: e.pointerId, ox: pt.x, oy: pt.y, dx: 0, dy: 0, moved: false };
					return;
				}
				this.drawing = true;
				this.lastT = e.timeStamp;
				this.clearSelection();
				this.lasso = [[pt.x, pt.y]];
				this.redrawLive();
				return;
			}

			this.drawing = true;
			this.lastT = e.timeStamp;
			this.perf.down = e.timeStamp;
			this.grid.n = this.grid.whole = this.grid.half = 0;
			this.noteGrid(e);
			const ai = this.tool === "ai";
			this.cur = { c: ai ? NOTE_INK : INK, s: this.size, pts: [pt], q: this.halfStep(), ...(ai ? { ai } : {}) };
			this.redrawLive();
		});

		el.addEventListener("pointermove", (e: PointerEvent) => {
			if (this.tap && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > (this.tap.finger ? 16 : 6)) {
				this.tap = null;
			}

			if (this.selDrag) {
				if (e.pointerId !== this.selDrag.id) return;
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

			if (this.touches.has(e.pointerId)) {
				const landed = this.multiTap?.downs.get(e.pointerId);
				if (landed && Math.hypot(e.clientX - landed.x, e.clientY - landed.y) > MULTI_TAP_SLOP) this.multiTap = null;
				this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
				if (this.touches.size >= 2) { this.handlePinch(); return; }

				if (this.fingerOnSel) {
					if (Math.hypot(e.clientX - this.fingerOnSel.x, e.clientY - this.fingerOnSel.y) < 4) return;
					const p = this.toPage(e);
					this.fingerOnSel = null;
					this.selDrag = { id: e.pointerId, ox: p.x, oy: p.y, dx: 0, dy: 0, moved: false };
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

			const r = this.live.getBoundingClientRect();
			if (this.tool === "lasso") {
				for (const ev of fresh) { const p = this.toPage(ev, r); this.lasso?.push([p.x, p.y]); }
				this.redrawLive();
				return;
			}
			if (!this.cur) return;
			for (const ev of fresh) { this.cur.pts.push(this.toPage(ev, r)); this.noteGrid(ev); }
			this.cur.q = this.halfStep();
			const f0 = this.perf, whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-3;
			f0.mainN++;
			if (whole(e.clientX) && whole(e.clientY)) f0.mainWhole++;
			if (evs.length > 1 || evs[0] !== e) for (const ev of evs) {
				f0.coalN++;
				if (whole(ev.clientX) && whole(ev.clientY)) f0.coalWhole++;
			}
			const t0 = performance.now();
			this.redrawLive();
			const f = this.perf;
			f.events++;
			f.samples += fresh.length;
			push(f.lag, t0 - e.timeStamp);
			push(f.live, performance.now() - t0);
		});

		const end = (e: PointerEvent) => {
			const wasTap = this.tap;
			this.tap = null;
			this.fingerOnSel = null;

			const wasFinger = this.touches.delete(e.pointerId);
			if (wasFinger) {
				if (this.touches.size < 2) this.pinch = null;
				this.panFrom = this.touches.size === 1 ? { ...[...this.touches.values()][0] } : null;
			}
			if (wasFinger && e.type === "pointercancel") this.multiTap = null;
			if (wasFinger && this.multiTap && !this.touches.size) {
				const mt = this.multiTap;
				this.multiTap = null;
				const n = mt.downs.size;
				if ((n === 2 || n === 3) && e.timeStamp - mt.second <= MULTI_TAP_UP) {
					// The fingers may have nudged the view on their way down: put it back
					this.zoom = mt.view.zoom;
					this.panX = mt.view.panX;
					this.panY = mt.view.panY;
					this.syncViewport();
					if (n === 2) this.undo(); else this.redo();
					return;
				}
			}

			if (this.selDrag && this.selDrag.id === e.pointerId) {
				const d = this.selDrag;
				this.selDrag = null;
				if (d.moved) {
					// Dragging an empty ring moves no ink: nothing to undo
					if (this.sel?.strokes.length) {
						this.record({ kind: "sel-move", strokes: [...this.sel.strokes], dx: d.dx, dy: d.dy });
					}
				} else if (this.sel) {
					this.sel.showOpts = !this.sel.showOpts;
					this.rebuildOverlay();
				}
				return;
			}

			// A finger tap: on the selection it brings up the delete button, off it
			// it lets go of the selection
			if (wasTap?.finger) {
				if (this.sel) {
					const p = this.toPage(e);
					if (pointInPoly(this.sel.path, p.x, p.y)) {
						this.sel.showOpts = !this.sel.showOpts;
						this.rebuildOverlay();
					} else this.clearSelection();
				}
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
				if (snap && snap !== this.strokes) this.record({ kind: "strokes-set", before: snap });
				return;
			}
			if (this.tool === "lasso") { this.finishLasso(); return; }
			if (this.cur && this.cur.pts.length) {
				this.cur.q = this.halfStep();
				const g = this.grid;
				if (g.n >= 6) g.last = this.cur.q * 2 * this.scale;
				this.strokes.push(this.cur);
				this.record({ kind: "stroke-add", index: this.strokes.length - 1 });
				this.finishRetract(this.cur);
				// Build the other level of detail now, while the pen is up, so a
				// pinch that crosses SPLINE_FROM never has to stop and build it
				const o = this.opts();
				if (o.curve) { outline(this.cur, o); outline(this.cur, { ...o, curve: 0 }); }
				this.perf.strokes++;
				this.perf.penMs += Math.max(0, e.timeStamp - this.perf.down);
			}
			this.cur = null;
			this.redrawLive();
		};
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", end);
		el.addEventListener("touchstart", (ev: TouchEvent) => ev.preventDefault());
		el.addEventListener("contextmenu", (ev: Event) => ev.preventDefault());

		// Desktop: the wheel pans, Ctrl/Cmd plus wheel zooms about the pointer
		el.addEventListener("wheel", (e: WheelEvent) => {
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
		}, { passive: false });
	}

	private stopGlide() {
		if (this.glideRaf) { window.cancelAnimationFrame(this.glideRaf); this.glideRaf = 0; }
	}

	/** Inertial scrolling: after the finger lifts, keep gliding with exponential
	 *  decay and stop at the edges. Without it the view freezes the instant the
	 *  finger stops, which feels harsh -- every native list decelerates. */
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
		// screen px/ms -> page units/ms; the pan runs opposite to the finger
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
			if (Math.abs(this.panY - wantY) > 1e-6) vy = 0;   // hit an edge
			if (Math.abs(this.panX - wantX) > 1e-6) vx = 0;
			const decay = Math.pow(0.9975, d);    // glides to a stop in about a second, close to iOS
			vx *= decay; vy *= decay;
			if (Math.hypot(vx, vy) < 0.015) { this.glideRaf = 0; return; }
			this.glideRaf = window.requestAnimationFrame(step);
		};
		this.glideRaf = window.requestAnimationFrame(step);
	}

	/** Pinch zoom: keep the page point under the pinch midpoint fixed */
	private handlePinch() {
		const [a, b] = [...this.touches.values()];
		const d = Math.hypot(a.x - b.x, a.y - b.y);
		const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
		if (!this.pinch) {
			const p = this.toPage({ clientX: mx, clientY: my });
			this.pinch = { d, cx: p.x, cy: p.y, zoom: this.zoom };
			return;
		}
		this.setZoom(this.pinch.zoom * (d / this.pinch.d), this.pinch.cx, this.pinch.cy, mx, my);
	}

	/** Zoom to z, leaving page point (cx,cy) at screen coordinate (sx,sy). Never
	 *  below 1: zoomed all the way out, the whole page is on screen. */
	private setZoom(z: number, cx: number, cy: number, sx: number, sy: number) {
		this.zoom = Math.min(Math.max(z, 1), ZOOM_MAX);
		const r = this.live.getBoundingClientRect();
		this.panX = cx - (sx - r.left) / this.scale;
		this.panY = cy - (sy - r.top) / this.scale;
		this.syncViewport();
	}

	/** Whole page, or page width when the whole page is already showing */
	private fitPage() {
		// Clear of the cards where they are now, wherever the page was laid
		// out for before
		this.room = this.cardRoom;
		const w = this.widthZoom();
		this.zoom = Math.abs(this.zoom - 1) < 1e-3 && w > 1 + 1e-3 ? w : 1;
		this.syncViewport();
	}

	/* ============ Rounded input ============ */

	private noteGrid(e: { clientX: number; clientY: number }) {
		const g = this.grid;
		const whole = (v: number) => Math.abs(v - Math.round(v)) < 1e-3;
		g.n++;
		if (whole(e.clientX) && whole(e.clientY)) g.whole++;
		else if (whole(e.clientX * 2) && whole(e.clientY * 2)) g.half++;
	}

	/** Half the step the stroke in hand is rounded to, in page units, or 0
	 *  when its positions are precise. See dequantize() in ink.ts. */
	private halfStep(): number {
		const g = this.grid;
		let px = g.last;
		if (g.n >= 6) px = g.whole >= g.n * 0.9 ? 1 : (g.whole + g.half) >= g.n * 0.9 ? 0.5 : 0;
		return px / 2 / this.scale;
	}

	private eraseAt(x: number, y: number) {
		this.eraserAt = { x, y };
		const r = this.plugin.settings.eraserSize;
		const before = this.strokes;
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
		this.strokes = after;
		this.redrawAll();
	}

	private clearPage() {
		this.settleRetract();
		if (!this.strokes.length) return;
		this.record({ kind: "strokes-set", before: this.strokes });
		this.strokes = [];
		this.clearSelection();
		this.redrawAll();
	}

	/* ============ Lasso ============ */

	/** Membership is by intersection: a stroke only partly inside still
	 *  belongs, so it moves or is deleted whole rather than being cut.
	 *
	 *  An empty ring is kept. Dropping it read as "the app decided my gesture
	 *  did not count"; it stays, and dragging or deleting it simply has nothing
	 *  to act on. A ring too small to mean anything is a stray touch, though. */
	private finishLasso() {
		const path = this.lasso ?? [];
		this.lasso = null;
		const box = polyBounds(path);
		if (path.length < 8 || box.w < 12 || box.h < 12) { this.redrawLive(); return; }
		this.sel = { path, strokes: this.strokes.filter((st) => strokeInPoly(st, path)), showOpts: false };
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
			// The point count is unchanged, so the cached bounds have to be told
			strokeChanged(st);
		}
	}

	private deleteSelection() {
		if (!this.sel) return;
		// An empty ring has nothing to delete, so deleting it just dismisses it
		if (!this.sel.strokes.length) { this.clearSelection(); return; }
		const before = this.strokes;
		const gone = new Set(this.sel.strokes);
		this.strokes = before.filter((st) => !gone.has(st));
		this.record({ kind: "strokes-set", before });
		this.sel = null;
		this.redrawAll();
		this.rebuildOverlay();
		new Notice(t("notice.strokesDeleted", gone.size));
	}

	private syncOverlayTransform() {
		const s = this.scale;
		this.overlay.style.transform =
			`translate(${(-this.panX * s).toFixed(2)}px, ${(-this.panY * s).toFixed(2)}px) scale(${s})`;
		// Floating UI cancels out the overall zoom, or buttons would turn into
		// giants when the canvas is zoomed in
		const k = (1 / s).toFixed(4);
		for (const el of this.counterScaled) el.style.transform = `scale(${k})`;
	}

	/** The selection's delete button, at its top-right corner */
	private rebuildOverlay() {
		this.overlay.empty();
		this.counterScaled = [];
		if (this.sel?.showOpts) {
			const box = polyBounds(this.sel.path);
			const bar = this.overlay.createDiv({ attr: { style: S.selBar } });
			bar.style.left = box.x + box.w + "px";
			bar.style.top = box.y + "px";
			this.counterScaled.push(bar);
			const b = bar.createEl("button", { attr: { "aria-label": t("sel.delete"), title: t("sel.delete"), style: S.selBtn } });
			drawIcon(b, "trash", 16);
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("click", (e) => { e.stopPropagation(); this.deleteSelection(); });
		}
		this.syncOverlayTransform();
	}

	/* ============ Undo ============ */

	/** A new change: what was undone before it can no longer be redone */
	private record(e: UndoEntry) {
		this.undoStack.push(e);
		this.redoStack = [];
	}

	private undo() { this.step(this.undoStack, this.redoStack, "notice.nothingToUndo"); }
	private redo() { this.step(this.redoStack, this.undoStack, "notice.nothingToRedo"); }

	/** Take back the latest entry of `from`, and file what would put it back
	 *  in `to` */
	private step(from: UndoEntry[], to: UndoEntry[], none: "notice.nothingToUndo" | "notice.nothingToRedo") {
		this.settleRetract();
		const e = from.pop();
		if (!e) { new Notice(t(none)); return; }
		to.push(this.revert(e));
		// The ring no longer describes what is under it
		this.clearSelection();
		this.redrawAll();
	}

	/** Apply the inverse of a change, and return the entry that reapplies it */
	private revert(e: UndoEntry): UndoEntry {
		switch (e.kind) {
			case "stroke-add": {
				const [stroke] = this.strokes.splice(e.index, 1);
				return { kind: "stroke-insert", index: e.index, stroke };
			}
			case "stroke-insert":
				this.strokes.splice(e.index, 0, e.stroke);
				return { kind: "stroke-add", index: e.index };
			case "strokes-set": {
				const now = this.strokes;
				this.strokes = e.before;
				return { kind: "strokes-set", before: now };
			}
			case "sel-move":
				for (const st of e.strokes) {
					for (const p of st.pts) { p.x -= e.dx; p.y -= e.dy; }
					strokeChanged(st);
				}
				return { kind: "sel-move", strokes: e.strokes, dx: -e.dx, dy: -e.dy };
		}
	}
}

/** Each finished stroke's outlines, straight and spline, each keyed on what it
 *  was built from */
const pathCache = new WeakMap<Stroke, Map<number, { key: string; path: Path2D | null }>>();

function outline(st: Stroke, opt: InkOpts): Path2D | null {
	const key = `${strokeRev(st)}:${st.pts.length}:${opt.smooth}:${opt.thin}:${opt.taper}:${opt.filter}:${st.s}`;
	let slots = pathCache.get(st);
	if (!slots) pathCache.set(st, slots = new Map<number, { key: string; path: Path2D | null }>());
	let hit = slots.get(opt.curve);
	if (!hit || hit.key !== key) slots.set(opt.curve, hit = { key, path: strokePath(st, opt) });
	return hit.path;
}

const share = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}% of ${n}` : "none seen");

/** Append to a sample buffer, keeping the most recent few thousand */
function push(buf: number[], v: number) {
	buf.push(v);
	if (buf.length > 4000) buf.splice(0, buf.length - 4000);
}

/** p50 / p95 / max of a sample buffer, in milliseconds */
function pct(v: number[]): string {
	if (v.length < 10) return "write something first";
	const s = [...v].sort((a, b) => a - b);
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
	return `${at(0.5).toFixed(1)} / ${at(0.95).toFixed(1)} / ${s[s.length - 1].toFixed(1)} ms`;
}

/** Stroke bounding box, cached on the stroke, used to cull ink outside the
 *  viewport and to narrow the eraser's search */
const bboxCache = new WeakMap<Stroke, { rev: number; n: number; box: { x0: number; x1: number; y0: number; y1: number } }>();
function bboxOf(st: Stroke) {
	const hit = bboxCache.get(st);
	const rev = strokeRev(st), n = st.pts.length;
	if (hit && hit.rev === rev && hit.n === n) return hit.box;
	let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
	for (const p of st.pts) {
		if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
		if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
	}
	const box = {
		x0: isFinite(x0) ? x0 : 0, x1: isFinite(x1) ? x1 : 0,
		y0: isFinite(y0) ? y0 : 0, y1: isFinite(y1) ? y1 : 0,
	};
	bboxCache.set(st, { rev, n, box });
	return box;
}
