/* The eraser dial: a floating control in the top-left corner of the canvas.
 *
 * The eraser is reached constantly and Apple Pencil's own double-tap is not
 * available to a web view, so it does not belong in the tool column behind a
 * mode switch. It is one ball, always in reach.
 *
 * Concentric by design: the inner disc is the button, the ring around it holds
 * the configuration that used to live in the left context bar.
 *
 *      upper-left sector   whole-stroke mode
 *      upper-right sector  precise mode
 *      lower semicircle    size, dragged along the arc
 *
 * Angles are measured from the positive x-axis with y pointing down, so
 * increasing degrees sweep clockwise on screen: 0 right, 90 bottom, 180 left,
 * 270 top. The upper half is therefore 180..360 and the lower half 0..180.
 */

import { t } from "./i18n";
import { drawIcon } from "./styles";

const NS = "http://www.w3.org/2000/svg";

/* Same blue a selected lasso uses, so "this tool is armed" reads the same way
 * everywhere in the view */
const SEL = "rgba(70,135,255,1)";
const SEL_FILL = "rgba(70,135,255,.20)";
const DIM = "var(--text-muted, #6b6b6b)";
const TRACK = "var(--background-modifier-border, rgba(127,127,127,.30))";
const FACE = "var(--background-primary, #fff)";

const R_OUT = 42;
const R_IN = 28;
const R_MID = (R_OUT + R_IN) / 2;
const R_TEXT = 32.5;        // baseline sits below centre so glyphs fill the ring
const R_KNOB = R_MID;
const C = R_OUT + 4;        // centre, leaving room for the knob and the shadow
const BOX = C * 2;

export const SIZE_MIN = 3;
export const SIZE_MAX = 60;

export interface DialHost {
	isEraser(): boolean;
	/** Tapping the disc: on when another tool is active, back to the pen when
	 *  the eraser already is */
	toggleEraser(): void;
	getMode(): string;
	setMode(v: string): void;
	getSize(): number;
	/** @param done  true on release, when the value is worth persisting */
	setSize(v: number, done: boolean): void;
	/** Content-to-screen scale, so the preview shows the true on-screen reach */
	scale(): number;
	/** Dragged to a new spot within the canvas, in pixels from its top-left.
	 *  @param done  true on release, when the position is worth persisting */
	moved(x: number, y: number, done: boolean): void;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const px = (cx: number, r: number, deg: number) => cx + r * Math.cos(rad(deg));
const py = (cy: number, r: number, deg: number) => cy + r * Math.sin(rad(deg));

/** Arc from a to b at radius r. Sweep follows the direction of travel: growing
 *  angles run clockwise on screen, which is SVG's positive sweep. */
function arc(r: number, a: number, b: number): string {
	const large = Math.abs(b - a) > 180 ? 1 : 0;
	const sweep = b > a ? 1 : 0;
	return `A ${r} ${r} 0 ${large} ${sweep} ${px(C, r, b)} ${py(C, r, b)}`;
}

/** A slice of the ring, between two radii and two angles */
function sector(a: number, b: number): string {
	return [
		`M ${px(C, R_OUT, a)} ${py(C, R_OUT, a)}`,
		arc(R_OUT, a, b),
		`L ${px(C, R_IN, b)} ${py(C, R_IN, b)}`,
		arc(R_IN, b, a),
		"Z",
	].join(" ");
}

function el<K extends keyof SVGElementTagNameMap>(
	parent: Element, name: K, attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
	const n = document.createElementNS(NS, name);
	for (const k in attrs) n.setAttribute(k, attrs[k]);
	parent.appendChild(n);
	return n;
}

export interface Dial {
	refresh(): void;
	el: HTMLElement;
	/** Put the dial here, clamped so all of it stays on the canvas. Returns
	 *  where it actually landed. */
	place(x: number, y: number, within: { w: number; h: number }): { x: number; y: number };
	/** Outer size in pixels, so callers can do their own clamping */
	readonly box: number;
}

export function buildEraserDial(parent: HTMLElement, host: DialHost): Dial {
	const wrap = parent.createDiv({
		attr: {
			style:
				"position:absolute;left:14px;top:14px;z-index:5;" +
				`width:${BOX}px;height:${BOX}px;touch-action:none;` +
				"-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;",
		},
	});

	// The size preview lives beside the dial, never under the pointer on the
	// page: a ring drawn on the canvas would sit on top of whatever is written
	// there, and reusing the real eraser preview would invite erasing it
	const preview = wrap.createDiv({
		attr: {
			style:
				"position:absolute;left:" + (BOX + 14) + "px;top:50%;" +
				"transform:translateY(-50%);border-radius:50%;box-sizing:border-box;" +
				`border:1.5px dashed ${SEL};background:${SEL_FILL};` +
				"pointer-events:none;opacity:0;transition:opacity .12s;width:0;height:0;",
		},
	});

	const svg = el(wrap, "svg", {
		viewBox: `0 0 ${BOX} ${BOX}`, width: String(BOX), height: String(BOX),
		style: `width:${BOX}px;height:${BOX}px;display:block;overflow:visible;`,
	});

	// Face, drawn once under everything
	el(svg, "circle", {
		cx: String(C), cy: String(C), r: String(R_OUT), fill: FACE,
		stroke: TRACK, "stroke-width": "1",
		style: "filter:drop-shadow(0 2px 6px rgba(0,0,0,.18));",
	});

	const secL = el(svg, "path", { d: sector(180, 270), stroke: "none" });
	const secR = el(svg, "path", { d: sector(270, 360), stroke: "none" });

	// Divider between the two sectors, and between the sectors and the slider
	for (const a of [180, 270, 360]) {
		el(svg, "line", {
			x1: String(px(C, R_IN, a)), y1: String(py(C, R_IN, a)),
			x2: String(px(C, R_OUT, a)), y2: String(py(C, R_OUT, a)),
			stroke: TRACK, "stroke-width": "1",
		});
	}

	// Curved labels. A path across the top of a circle runs left to right when
	// the angle grows, which is the direction that reads right way up.
	const defs = el(svg, "defs", {});
	const labelPath = (id: string, a: number, b: number) => {
		el(defs, "path", {
			id,
			d: `M ${px(C, R_TEXT, a)} ${py(C, R_TEXT, a)} ${arc(R_TEXT, a, b)}`,
			fill: "none",
		});
	};
	labelPath("hw-dial-l", 180, 270);
	labelPath("hw-dial-r", 270, 360);

	const label = (href: string, text: string) => {
		const tx = el(svg, "text", {
			"font-size": "8", "font-weight": "600", "letter-spacing": ".2",
			"font-family": "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
			"text-anchor": "middle", fill: DIM,
			style: "pointer-events:none;",
		});
		const tp = el(tx, "textPath", { startOffset: "50%" });
		tp.setAttribute("href", href);
		// Safari still wants the namespaced form
		tp.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
		tp.textContent = text;
		return tx;
	};
	const labL = label("#hw-dial-l", t("ctx.eraseStroke"));
	const labR = label("#hw-dial-r", t("ctx.erasePrecise"));

	// Lower semicircle: the size slider. Small at the left, large at the right.
	el(svg, "path", {
		d: `M ${px(C, R_MID, 180)} ${py(C, R_MID, 180)} ${arc(R_MID, 180, 0)}`,
		fill: "none", stroke: TRACK, "stroke-width": String(R_OUT - R_IN - 3),
		"stroke-linecap": "butt",
	});
	const fill = el(svg, "path", {
		fill: "none", stroke: SEL, "stroke-width": String(R_OUT - R_IN - 3),
		"stroke-linecap": "butt", opacity: ".55",
	});
	const knob = el(svg, "circle", {
		r: "6.5", fill: FACE, stroke: SEL, "stroke-width": "2.5",
		style: "filter:drop-shadow(0 1px 3px rgba(0,0,0,.25));",
	});

	// Inner disc: the button itself
	el(svg, "circle", {
		cx: String(C), cy: String(C), r: String(R_IN - 2),
		fill: FACE, stroke: TRACK, "stroke-width": "1",
	});
	const iconBox = wrap.createDiv({
		attr: {
			style:
				`position:absolute;left:${C - R_IN}px;top:${C - R_IN}px;` +
				`width:${R_IN * 2}px;height:${R_IN * 2}px;` +
				"display:flex;align-items:center;justify-content:center;" +
				"pointer-events:none;",
		},
	});
	drawIcon(iconBox, "eraser", 26);

	function place(x: number, y: number, within: { w: number; h: number }) {
		// A dial parked half off the canvas would be unreachable, and the canvas
		// resizes underneath it on rotation and in split view
		const M = 6;
		const cx = Math.max(M, Math.min(x, Math.max(M, within.w - BOX - M)));
		const cy = Math.max(M, Math.min(y, Math.max(M, within.h - BOX - M)));
		wrap.style.left = cx + "px";
		wrap.style.top = cy + "px";
		// The preview sits on whichever side has room for it
		const right = cx + BOX + 14 + 150 < within.w;
		preview.style.left = right ? BOX + 14 + "px" : "";
		preview.style.right = right ? "" : BOX + 14 + "px";
		return { x: cx, y: cy };
	}

	const norm = (v: number) => (v - SIZE_MIN) / (SIZE_MAX - SIZE_MIN);

	function refresh() {
		const on = host.isEraser();
		iconBox.style.color = on ? SEL : DIM;

		const mode = host.getMode();
		for (const [sec, lab, mine] of [
			[secL, labL, "stroke"], [secR, labR, "precise"],
		] as [SVGPathElement, SVGTextElement, string][]) {
			const sel = on && mode === mine;
			sec.setAttribute("fill", sel ? SEL_FILL : "transparent");
			lab.setAttribute("fill", sel ? SEL : DIM);
			lab.setAttribute("opacity", on ? "1" : ".55");
		}

		const t01 = Math.max(0, Math.min(1, norm(host.getSize())));
		const deg = 180 - 180 * t01;
		fill.setAttribute("d",
			`M ${px(C, R_MID, 180)} ${py(C, R_MID, 180)} ${arc(R_MID, 180, deg)}`);
		fill.setAttribute("opacity", on ? ".65" : ".25");
		fill.setAttribute("stroke", on ? SEL : DIM);
		knob.setAttribute("cx", String(px(C, R_KNOB, deg)));
		knob.setAttribute("cy", String(py(C, R_KNOB, deg)));
		knob.setAttribute("stroke", on ? SEL : DIM);
	}

	/* ---- input ---- */

	type Grab = "disc" | "slider" | null;
	let grab: Grab = null;
	// Where the pointer sat inside the dial when the drag began, so the dial does
	// not jump to centre itself under the finger
	let hold: { dx: number; dy: number } | null = null;
	let dragging = false;

	const at = (e: PointerEvent) => {
		const r = svg.getBoundingClientRect();
		// The viewBox maps 1:1 to CSS pixels only when nothing has scaled the
		// element, so go through the measured box instead of assuming it
		const x = ((e.clientX - r.left) / r.width) * BOX - C;
		const y = ((e.clientY - r.top) / r.height) * BOX - C;
		let deg = (Math.atan2(y, x) * 180) / Math.PI;
		if (deg < 0) deg += 360;
		return { d: Math.hypot(x, y), deg };
	};

	const showPreview = () => {
		// True on-screen reach, which is what the number actually means. Capped so
		// a huge eraser at high zoom cannot cover the page.
		const d = Math.min(host.getSize() * 2 * host.scale(), 140);
		preview.style.width = d + "px";
		preview.style.height = d + "px";
		preview.setCssProps({ opacity: "1" });
	};

	const applyAngle = (deg: number) => {
		// Only the lower half drives the slider; clamp anything above the
		// horizontal to whichever end it is nearest, so a finger sliding off the
		// arc pins at min or max instead of jumping across
		let t01: number;
		if (deg >= 0 && deg <= 180) t01 = (180 - deg) / 180;
		else t01 = deg > 180 && deg < 270 ? 0 : 1;
		const v = Math.round(SIZE_MIN + t01 * (SIZE_MAX - SIZE_MIN));
		host.setSize(v, false);
		refresh();
		showPreview();
	};

	/** The dial is dragged by its middle. A press on the disc is only a tap once
	 *  it is released without travelling, the same dead-zone rule the canvas uses
	 *  to tell a tap on a region from a drag of it. */
	const DEAD = 5;

	svg.addEventListener("pointerdown", (e: PointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		const { d, deg } = at(e);
		dragging = false;
		if (d <= R_IN) {
			grab = "disc";
			const r = wrap.getBoundingClientRect();
			hold = { dx: e.clientX - r.left, dy: e.clientY - r.top };
			svg.setPointerCapture(e.pointerId);
			return;
		}
		if (d > R_OUT + 10) return;
		// A generous band: the ring is 14px wide and a fingertip is not
		if (deg >= 0 && deg <= 180 && d >= R_IN - 8) {
			grab = "slider";
			svg.setPointerCapture(e.pointerId);
			applyAngle(deg);
			return;
		}
		// Upper half: pick a mode
		grab = null;
		if (d >= R_IN - 4) {
			host.setMode(deg >= 180 && deg < 270 ? "stroke" : "precise");
			refresh();
		}
	});

	svg.addEventListener("pointermove", (e: PointerEvent) => {
		if (!grab) return;
		e.stopPropagation();
		e.preventDefault();
		if (grab === "slider") { applyAngle(at(e).deg); return; }

		const host_ = wrap.parentElement;
		if (!hold || !host_) return;
		const pr = host_.getBoundingClientRect();
		const x = e.clientX - pr.left - hold.dx;
		const y = e.clientY - pr.top - hold.dy;
		if (!dragging) {
			const r = wrap.getBoundingClientRect();
			if (Math.hypot(x - (r.left - pr.left), y - (r.top - pr.top)) < DEAD) return;
			dragging = true;
			wrap.setCssProps({ opacity: ".75" });
		}
		const at2 = place(x, y, { w: pr.width, h: pr.height });
		host.moved(at2.x, at2.y, false);
	});

	const release = (e: PointerEvent) => {
		if (grab === "disc") {
			wrap.setCssProps({ opacity: "" });
			if (dragging) {
				const r = wrap.getBoundingClientRect();
				const pr = wrap.parentElement?.getBoundingClientRect();
				if (pr) host.moved(r.left - pr.left, r.top - pr.top, true);
			} else {
				// A press that never travelled: this was a tap
				host.toggleEraser();
				refresh();
			}
		} else if (grab === "slider") {
			host.setSize(host.getSize(), true);
			preview.setCssProps({ opacity: "0" });
		}
		grab = null;
		hold = null;
		dragging = false;
		e.stopPropagation();
	};
	svg.addEventListener("pointerup", release);
	svg.addEventListener("pointercancel", (e) => {
		if (grab === "slider") preview.setCssProps({ opacity: "0" });
		wrap.setCssProps({ opacity: "" });
		grab = null;
		hold = null;
		dragging = false;
		e.stopPropagation();
	});
	// The canvas below must never see these
	svg.addEventListener("touchstart", (e) => e.preventDefault());
	svg.addEventListener("contextmenu", (e) => e.preventDefault());

	refresh();
	return { refresh, el: wrap, place, box: BOX };
}
