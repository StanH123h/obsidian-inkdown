/* Every style is written inline on the element. The plugin injects no CSS and
 * ships no styles.css.
 *
 * Why: a <style> injected into document.head has no effect on Obsidian mobile
 * (measured: fine on desktop, layout and icon sizes both lost on iPad). A
 * separate styles.css has a different problem -- it is a second file next to
 * main.js, and over iCloud or another sync service the two may not arrive
 * together. Inline styles outrank any stylesheet and travel with main.js,
 * which sidesteps both traps at once.
 *
 * Colours still go through CSS variables with fallbacks, so theme switching
 * keeps working. */

const MUTED = "var(--text-muted, #6b6b6b)";
const ACCENT = "var(--text-accent, #5b6ed6)";
const HOVER = "var(--background-modifier-hover, rgba(127,127,127,.18))";
const BORDER = "var(--background-modifier-border, rgba(127,127,127,.28))";

/* The tool bar and the width bar are cards floating over the canvas, as the
 * eraser dial does: the page runs on underneath. CARD_EDGE is their distance
 * from the pad's edge, CARD_GAP the space between the two. */
export const CARD_EDGE = 12;
export const CARD_GAP = 8;
const CARD =
	// touch-action and the callout: a card is held down to be dragged, and
	// must not scroll or bring up the system's menu meanwhile
	"position:absolute;z-index:20;margin:0;box-sizing:border-box;border-radius:16px;" +
	"touch-action:none;-webkit-touch-callout:none;" +
	`background:var(--background-primary, #fff);border:1px solid ${BORDER};` +
	"box-shadow:0 4px 18px rgba(0,0,0,.14);";

const BTN =
	"position:relative;display:flex;align-items:center;justify-content:center;flex:0 0 auto;" +
	"width:40px;height:40px;padding:0;margin:0;border:0;border-radius:9px;" +
	"box-shadow:none;cursor:pointer;-webkit-appearance:none;appearance:none;";

export const S = {
	root:
		"display:flex;flex-direction:row;align-items:stretch;padding:0;margin:0;" +
		"height:100%;width:100%;overflow:hidden;position:relative;" +
		"-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;",
	rootNarrow:
		"display:flex;flex-direction:column;align-items:stretch;padding:0;margin:0;" +
		"height:100%;width:100%;overflow:hidden;position:relative;" +
		"-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;",

	surface: "position:relative;flex:1 1 auto;min-width:0;min-height:0;touch-action:none;",
	canvas: "position:absolute;inset:0;touch-action:none;",

	// As tall as its buttons, and where the pad is shorter than that, a second
	// column rather than buttons hidden in a scroll area. Placed by pad.ts.
	tools:
		CARD + "display:flex;flex-direction:column;flex-wrap:wrap;align-items:center;" +
		"align-content:center;gap:6px;height:max-content;" +
		`max-height:calc(100% - ${CARD_EDGE * 2}px);padding:6px 6px 8px;`,
	// A row along the top or the foot; a second row where the pad is narrower
	// than the buttons
	toolsRow:
		CARD + "display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;" +
		"justify-content:center;gap:4px 2px;width:max-content;" +
		`max-width:calc(100% - ${CARD_EDGE * 2}px);padding:6px;`,
	// The handle a card is held by: across the top of a column, down the
	// start of a row. A mouse takes it straight away; anywhere else on the
	// card is held a moment first. The bar is drawn small but the handle
	// around it is not, so it is easy to take hold of.
	grip:
		"flex:0 0 auto;display:flex;align-items:center;justify-content:center;" +
		"width:40px;height:14px;margin:-2px 0;",
	gripRow:
		"flex:0 0 auto;display:flex;align-items:center;justify-content:center;" +
		"width:14px;height:36px;margin:0 -2px;",
	gripBar: "width:22px;height:4px;border-radius:2px;pointer-events:none;background:var(--text-faint, rgba(127,127,127,.45));",
	gripBarRow: "width:4px;height:22px;border-radius:2px;pointer-events:none;background:var(--text-faint, rgba(127,127,127,.45));",
	// Added to the tool bar while it is being dragged: up off the page
	lifted: "z-index:27;box-shadow:0 12px 36px rgba(0,0,0,.28);cursor:grabbing;",
	// Over the page while the tool bar is dragged, with an outline at each
	// place it can go, the nearest filled in
	dragShade:
		// Over the eraser dial too (25), which stays on the page
		"position:absolute;inset:0;z-index:26;touch-action:none;" +
		"background:rgba(127,127,127,.12);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);",
	slot: "position:absolute;box-sizing:border-box;border-radius:16px;border:2px dashed var(--text-faint, rgba(127,127,127,.5));",
	slotOn:
		"position:absolute;box-sizing:border-box;border-radius:16px;" +
		`border:2px solid ${ACCENT};background:rgba(91,110,214,.16);`,
	// The one-time hint by the tool bar, in the theme's colours turned round
	hint:
		"position:absolute;z-index:30;padding:6px 10px;margin:0;box-sizing:border-box;white-space:nowrap;" +
		"border-radius:8px;font-size:13px;line-height:1.35;font-weight:600;cursor:pointer;" +
		"background:var(--text-normal, #222);color:var(--background-primary, #fff);" +
		"box-shadow:0 4px 14px rgba(0,0,0,.25);",
	hintArrow: "position:absolute;bottom:-5px;width:10px;height:10px;transform:rotate(45deg);background:var(--text-normal, #222);",
	// Fingertips tapping in the middle of the page, shown once for the two-
	// and three-finger taps (see TAP_DOT). Placed by its centre; nothing in
	// it takes a touch.
	tapDemo: "position:absolute;z-index:24;width:0;height:0;pointer-events:none;",
	tapDot:
		"position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;box-sizing:border-box;" +
		`background:rgba(255,255,255,.6);border:2.5px solid ${ACCENT};box-shadow:0 3px 12px rgba(0,0,0,.22);opacity:0;`,
	tapRing:
		"position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;box-sizing:border-box;" +
		`border:2px solid ${ACCENT};opacity:0;`,
	tapLabel:
		"position:absolute;top:48px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;" +
		"font-size:15px;line-height:1.3;font-weight:600;white-space:nowrap;opacity:0;" +
		"background:var(--text-normal, #222);color:var(--background-primary, #fff);box-shadow:0 4px 14px rgba(0,0,0,.25);",

	btn: BTN + `background:transparent;color:${MUTED};`,
	btnOn: BTN + `background:${HOVER};color:${ACCENT};`,
	// A phone held upright has about 390px for the whole tool row, convert
	// button included, so the buttons there are a size down
	btnSm: BTN + `width:36px;height:36px;background:transparent;color:${MUTED};`,
	btnSmOn: BTN + `width:36px;height:36px;background:${HOVER};color:${ACCENT};`,

	sep: `flex:0 0 auto;width:22px;height:1px;margin:5px 0;background:${BORDER};`,
	sepNarrow: `flex:0 0 auto;width:1px;height:22px;margin:0 3px;background:${BORDER};`,

	// The overlay follows pan and zoom through a single CSS transform, and its
	// children are positioned in content units. Scrolling then updates one
	// transform instead of repositioning every child.
	overlayClip: "position:absolute;inset:0;pointer-events:none;overflow:hidden;",
	overlay: "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;",
	// Floating bar beside a lasso selection. Positioned in content units but
	// counter-scaled, so the buttons do not turn into giants when zoomed in.
	selBar:
		"position:absolute;display:flex;align-items:center;gap:2px;pointer-events:auto;" +
		"transform-origin:0 0;white-space:nowrap;border-radius:9px;padding:2px;" +
		`background:${"var(--background-primary, #fff)"};box-shadow:0 1px 6px rgba(0,0,0,.18);` +
		`border:1px solid ${BORDER};touch-action:none;`,
	selBtn:
		"display:flex;align-items:center;justify-content:center;width:26px;height:26px;" +
		"padding:0;margin:0;border:0;border-radius:7px;background:transparent;cursor:pointer;" +
		`color:${MUTED};`,

	// The width bar: the pens' widths, beside the tool bar while a pen is in
	// hand. CTX_W and CTX_H below must match its width and its narrow height.
	ctxBar:
		CARD + "display:flex;flex-direction:column;align-items:center;" +
		"gap:7px;width:52px;padding:8px 0;overflow:hidden;",
	ctxBarRow:
		CARD + "display:flex;flex-direction:row;align-items:center;" +
		`gap:7px;height:52px;width:max-content;max-width:calc(100% - ${CARD_EDGE * 2}px);` +
		"padding:0 8px;overflow-x:auto;overflow-y:hidden;",

	// Hand-rolled slider. An <input type=range> needs the browser's default touch
	// handling, which Obsidian mobile claims for its sidebar swipe, so dragging one
	// opens the file pane instead of moving the knob. This uses pointer capture and
	// touch-action:none, exactly like the canvas, so the gesture never leaks out.
	slider: "position:relative;flex:0 0 auto;touch-action:none;cursor:pointer;",
	sliderTrack: `position:absolute;border-radius:99px;background:${BORDER};`,
	sliderFill: `position:absolute;border-radius:99px;background:${ACCENT};`,
	sliderKnob:
		"position:absolute;border-radius:50%;background:var(--background-primary,#fff);" +
		`border:2px solid ${ACCENT};box-shadow:0 1px 4px rgba(0,0,0,.2);`,
	// Fixed width and tabular figures, so the number does not jump about as it
	// goes from one digit to two
	sliderVal:
		"flex:0 0 auto;width:30px;height:14px;line-height:14px;font-size:11px;text-align:center;" +
		`color:${MUTED};font-variant-numeric:tabular-nums;`,

	// Convert: the one action that leaves the pad, so it is filled with the
	// accent colour and carries a word as well as an icon. The auto margin
	// pushes it to the far end of the tool bar, away from the drawing tools.
	go:
		BTN + "flex-direction:column;gap:3px;width:44px;height:auto;padding:7px 0 6px;margin-top:auto;" +
		"background:var(--interactive-accent, #5b6ed6);color:var(--text-on-accent, #fff);" +
		"font-size:11px;line-height:1;font-weight:600;",
	// In a row there is no room for the word; the accent still marks it
	goRow:
		BTN + "flex-direction:row;width:44px;height:40px;padding:0;" +
		"background:var(--interactive-accent, #5b6ed6);color:var(--text-on-accent, #fff);",
	goNarrow:
		BTN + "flex-direction:row;gap:5px;width:44px;height:36px;padding:0;" +
		"background:var(--interactive-accent, #5b6ed6);color:var(--text-on-accent, #fff);" +
		"font-size:13px;line-height:1;font-weight:600;",

	// Small corner label on a tool button: the AI pen's "AI"
	btnBadge:
		"position:absolute;right:1px;bottom:2px;font-size:8px;line-height:1;" +
		"font-weight:800;letter-spacing:-.02em;pointer-events:none;",
	// A word under an icon, for a button whose icon alone would leave you guessing
	btnCaption: "font-size:9px;line-height:1;font-weight:700;white-space:nowrap;pointer-events:none;",
	// Added to a button's own style, to stack its icon over its caption
	btnStacked: "flex-direction:column;gap:2px;",

	// The "⋯" menu: a card beside its button, each entry worded as well as drawn
	menu:
		"position:absolute;z-index:40;display:flex;flex-direction:column;gap:2px;padding:6px;margin:0;" +
		"border-radius:12px;background:var(--background-primary, #fff);" +
		`border:1px solid ${BORDER};box-shadow:0 6px 24px rgba(0,0,0,.18);`,
	menuItem:
		"display:flex;align-items:center;gap:10px;height:40px;padding:0 14px 0 10px;margin:0;border:0;" +
		"border-radius:8px;background:transparent;font-size:14px;line-height:1;white-space:nowrap;" +
		"text-align:left;cursor:pointer;box-shadow:none;-webkit-appearance:none;appearance:none;" +
		"color:var(--text-normal, #222);",
	// Added to an entry that throws something away
	menuDanger: "color:var(--text-error, #e5484d);",
	// The tool bar's place: a caption over a row of small screens
	menuHead: `padding:6px 10px 2px;font-size:11px;line-height:1;color:${MUTED};`,
	menuSides: "display:flex;gap:4px;padding:4px 6px 6px;",
	sideBtn: BTN + `flex-direction:column;gap:2px;width:46px;height:46px;background:transparent;color:${MUTED};`,
	sideBtnOn: BTN + `flex-direction:column;gap:2px;width:46px;height:46px;background:${HOVER};color:${ACCENT};`,
	// Under the open menu and over everything else: a tap there only closes it
	scrim: "position:absolute;inset:0;z-index:39;touch-action:none;",

	// The stand-in caret in the note (see ghost.ts). Thicker than the real one
	// and in the theme's accent, so it is not taken for it; it takes no room
	// of its own, so the text does not move when it comes and goes.
	ghostCaret:
		"display:inline-block;width:3px;height:1.3em;margin:0 -1.5px;vertical-align:-0.3em;" +
		"border-radius:1.5px;pointer-events:none;background:var(--interactive-accent, #8a6cf0);",

	// Which note a pane's page goes into, across the pane from the tool bar:
	// at the top, unless the tool bar is. The pen writes straight through it.
	target: (toolbarAt: string) =>
		(toolbarAt === "top" ? "bottom:8px;" : "top:8px;") +
		"position:absolute;z-index:30;left:50%;transform:translateX(-50%);max-width:60%;" +
		"padding:3px 10px;border-radius:11px;font-size:12px;line-height:18px;" +
		"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;" +
		`color:${MUTED};background:var(--background-primary, #fff);border:1px solid ${BORDER};opacity:.92;`,

	dot: (px: number) =>
		`width:${px}px;height:${px}px;border-radius:50%;flex:0 0 auto;background:var(--text-normal, #222);`,
};

/* Icons are inline SVG rather than Obsidian's setIcon, whose icon names are not
 * guaranteed to exist across versions and platforms. Width and height are set
 * as attributes and inline styles, never left to a stylesheet. */
/** A filled shape among the outlines */
const solid = (d: string) => ({ d, fill: true });

export const ICONS = {
	pen: [
		"M4 20l4.5-1.2 9.3-9.3-3.3-3.3-9.3 9.3z",
		"M14.5 6.2l3.3 3.3",
		"M16.2 4.5a1.8 1.8 0 0 1 2.6 0l0.7 0.7a1.8 1.8 0 0 1 0 2.6l-1.5 1.5-3.3-3.3z",
	],
	eraser: [
		"M4 20h16",
		"M9.5 16.5L4.8 11.8a1.5 1.5 0 0 1 0-2.1l6-6a1.5 1.5 0 0 1 2.1 0l4.4 4.4a1.5 1.5 0 0 1 0 2.1L11.6 16.5z",
	],
	/* Lasso, matching Lucide's icon of the same name (ISC). Three parts, and the
	 * first version here got all three wrong, which is why it read as a magnifying
	 * glass: the loop is a flattened ellipse seen in perspective rather than a
	 * circle, it is an open arc broken at the lower left where the rope descends
	 * rather than a closed ring, and the small circle is the honda knot -- the
	 * sliding knot that makes a rope a lasso, and the element that actually carries
	 * the meaning. A ring with a stalk is a magnifying glass. */
	lasso: [
		"M3.704 14.467a10 8 0 1 1 3.115 2.375",
		"M7 22a5 5 0 0 1-2-3.994",
		"M3 16a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
	],
	trash: ["M4 7h16", "M9 7V5h6v2", "M7 7l1 13h8l1-13"],
	fit: ["M4 9V5h4", "M20 9V5h-4", "M4 15v4h4", "M20 15v4h-4"],
	undo: ["M4 10h10.5a4.5 4.5 0 0 1 0 9H9", "M4 10l4-4", "M4 10l4 4"],
	redo: ["M20 10H9.5a4.5 4.5 0 0 0 0 9H15", "M20 10l-4-4", "M20 10l-4 4"],
	close: ["M6 6l12 12", "M18 6L6 18"],
	more: [
		solid("M4.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0"),
		solid("M10.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0"),
		solid("M16.4 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0"),
	],
	/* Moving the pad, drawn the way macOS and iPadOS draw window tiling: a
	 * screen with the part the pad will take filled in, the right half or all
	 * of it. Arrows or corners would read as "bigger", which is what the fit
	 * button's four corners already say about the page. */
	split: [
		"M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
		solid("M13.5 8a1 1 0 0 1 1-1H18a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3.5a1 1 0 0 1-1-1z"),
	],
	full: [
		"M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
		solid("M5 8a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"),
	],
	/* Where the tool bar goes, drawn the same way: a screen with a bar along
	 * that edge */
	left: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", solid("M4.5 7.5h3.5v9H4.5z")],
	right: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", solid("M16 7.5h3.5v9H16z")],
	top: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", solid("M4.5 7.5h15v3h-15z")],
	bottom: ["M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", solid("M4.5 13.5h15v3h-15z")],
	/* Paper plane, after Lucide's "send" (ISC) */
	send: [
		"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
		"M21.854 2.147l-10.94 10.939",
	],
};

/* The fingertips' taps, over TAP_MS: in, two taps (pressed in, a ring
 * spreading out), and away. Web animations rather than CSS keyframes, which
 * would need a stylesheet (see the top of this file). */
export const TAP_MS = 2600;
export const TAP_DOT: Keyframe[] = [
	{ offset: 0, opacity: 0, transform: "scale(.6)" },
	{ offset: 0.08, opacity: 1, transform: "scale(1)" },
	{ offset: 0.18, transform: "scale(1)" },
	{ offset: 0.23, transform: "scale(.84)" },
	{ offset: 0.29, transform: "scale(1)" },
	{ offset: 0.41, transform: "scale(1)" },
	{ offset: 0.46, transform: "scale(.84)" },
	{ offset: 0.52, transform: "scale(1)" },
	{ offset: 0.85, opacity: 1 },
	{ offset: 1, opacity: 0, transform: "scale(1)" },
];
export const TAP_RING: Keyframe[] = [
	{ offset: 0, opacity: 0, transform: "scale(1)" },
	{ offset: 0.21, opacity: 0, transform: "scale(1)" },
	{ offset: 0.23, opacity: 0.6, transform: "scale(1)" },
	{ offset: 0.4, opacity: 0, transform: "scale(1.8)" },
	{ offset: 0.44, opacity: 0, transform: "scale(1)" },
	{ offset: 0.46, opacity: 0.6, transform: "scale(1)" },
	{ offset: 0.63, opacity: 0, transform: "scale(1.8)" },
	{ offset: 1, opacity: 0, transform: "scale(1)" },
];
export const TAP_LABEL: Keyframe[] = [
	{ offset: 0, opacity: 0 },
	{ offset: 0.1, opacity: 1 },
	{ offset: 0.85, opacity: 1 },
	{ offset: 1, opacity: 0 },
];

/** The width bar's size across the edge it floats by: its width beside a
 *  column, its height above a row. Its room is kept off the page even while
 *  it is hidden. */
export const CTX_W = 52;
export const CTX_H = 52;

/* The pad covers the whole screen, which means overriding Obsidian's own sizing
 * of .modal. Those rules differ between desktop and mobile and some may carry
 * !important, so pad.ts applies these one by one with setProperty(...,
 * "important") rather than as a style string. The safe-area padding keeps the
 * tool bar clear of the iPad status bar and home indicator. */
export const MODAL: Record<string, string> = {
	position: "fixed",
	inset: "0",
	"box-sizing": "border-box",
	width: "100%",
	height: "100%",
	"max-width": "none",
	"max-height": "none",
	"min-width": "0",
	"min-height": "0",
	margin: "0",
	padding: "env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)",
	border: "0",
	"border-radius": "0",
	"box-shadow": "none",
	transform: "none",
	display: "flex",
	overflow: "hidden",
	background: "var(--background-secondary, #f2f2f2)",
};

/* The pad in a pane: the pane's content area loses its padding and scrolling,
 * so the pad fills it edge to edge. Applied the same way as MODAL. */
export const PANE: Record<string, string> = {
	position: "relative",
	padding: "0",
	display: "flex",
	overflow: "hidden",
	background: "var(--background-secondary, #f2f2f2)",
};

/* Optical sizing. Rendering every icon at the same nominal size does not make
 * them look the same size: a shape that leaves its corners empty, like the
 * eraser's tilted block, reads smaller than one that fills the frame. These are
 * per-icon corrections, not a global scale. */
const ICON_PX: Partial<Record<keyof typeof ICONS, number>> = {
	eraser: 26,
	pen: 24,
};

const NS = "http://www.w3.org/2000/svg";

export function drawIcon(el: HTMLElement, name: keyof typeof ICONS, px?: number) {
	const size = px ?? ICON_PX[name] ?? 22;
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.9");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	// Size goes into the inline style as well: with attributes alone, some WebKit
	// versions still let a stylesheet collapse it to 0
	svg.setAttribute("style", `width:${size}px;height:${size}px;display:block;flex:0 0 auto;`);
	for (const part of ICONS[name]) {
		const p = document.createElementNS(NS, "path");
		if (typeof part === "string") p.setAttribute("d", part);
		else {
			p.setAttribute("d", part.d);
			p.setAttribute("fill", "currentColor");
			p.setAttribute("stroke", "none");
		}
		svg.appendChild(p);
	}
	el.appendChild(svg);
	return svg;
}
