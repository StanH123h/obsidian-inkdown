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

	tools:
		// flex-wrap plus a fixed height wraps into a second column when the buttons
		// do not fit, instead of hiding them in a scroll area
		"display:flex;flex-direction:column;flex-wrap:wrap;align-items:center;" +
		"align-content:flex-start;justify-content:flex-start;" +
		`gap:6px;flex:0 0 auto;height:100%;padding:10px 8px;margin:0;box-sizing:border-box;` +
		`overflow:hidden;border-left:1px solid ${BORDER};` +
		"background:var(--background-secondary, rgba(127,127,127,.07));",
	toolsNarrow:
		"display:flex;flex-direction:row;align-items:center;justify-content:flex-start;" +
		"gap:6px;flex:0 0 auto;width:100%;height:58px;padding:8px 10px;margin:0;box-sizing:border-box;" +
		`overflow-x:auto;overflow-y:hidden;border-top:1px solid ${BORDER};` +
		"background:var(--background-secondary, rgba(127,127,127,.07));",

	btn: BTN + `background:transparent;color:${MUTED};`,
	btnOn: BTN + `background:${HOVER};color:${ACCENT};`,

	sep: `flex:0 0 auto;width:22px;height:1px;margin:5px 0;background:${BORDER};`,
	sepNarrow: `flex:0 0 auto;width:1px;height:22px;margin:0 5px;background:${BORDER};`,

	// The overlay follows pan and zoom through a single CSS transform, and its
	// children are positioned in content units. Scrolling then updates one
	// transform instead of repositioning every child or re-rendering embeds.
	overlayClip: "position:absolute;inset:0;pointer-events:none;overflow:hidden;",
	overlay: "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;",
	scrollbar:
		"position:absolute;right:2px;width:4px;border-radius:2px;pointer-events:none;" +
		`background:${MUTED};opacity:0;transition:opacity .25s;`,
	chip:
		"position:absolute;pointer-events:auto;box-sizing:border-box;cursor:grab;" +
		"padding:4px 11px;border-radius:9px;white-space:nowrap;font-size:19px;line-height:1.4;" +
		`color:${ACCENT};background:var(--background-primary,#fff);` +
		`border:1px solid ${ACCENT};touch-action:none;`,
	chipMissing:
		"position:absolute;pointer-events:auto;box-sizing:border-box;cursor:grab;" +
		"padding:4px 11px;border-radius:9px;white-space:nowrap;font-size:19px;line-height:1.4;" +
		"color:var(--text-error,#c0392b);background:var(--background-primary,#fff);" +
		"border:1px dashed var(--text-error,#c0392b);touch-action:none;",
	embedBox:
		"position:absolute;pointer-events:auto;box-sizing:border-box;" +
		`border:1px solid ${BORDER};border-radius:9px;overflow:hidden;` +
		"background:var(--background-primary,#fff);touch-action:none;",
	embedBar:
		"display:flex;align-items:center;gap:6px;padding:5px 11px;cursor:grab;" +
		"font-size:16px;background:var(--background-secondary,rgba(127,127,127,.08));" +
		`color:${MUTED};touch-action:none;`,
	embedBody: "padding:10px 13px;font-size:18px;",
	// Floating bar for a region. Positioned in content units but counter-scaled,
	// so the buttons do not turn into giants when the canvas is zoomed in.
	regionBar:
		"position:absolute;display:flex;align-items:center;gap:2px;pointer-events:auto;" +
		"transform-origin:0 0;white-space:nowrap;border-radius:9px;padding:2px;" +
		`background:${"var(--background-primary, #fff)"};box-shadow:0 1px 6px rgba(0,0,0,.18);` +
		`border:1px solid ${BORDER};touch-action:none;`,
	regionName:
		"padding:3px 9px;border-radius:7px;font-size:12px;line-height:1.5;cursor:pointer;" +
		`color:${MUTED};`,
	regionNameOn:
		"padding:3px 9px;border-radius:7px;font-size:12px;line-height:1.5;cursor:pointer;" +
		"color:var(--text-on-accent,#fff);background:var(--interactive-accent,#5b6ed6);",
	regionBtn:
		"display:flex;align-items:center;justify-content:center;width:26px;height:26px;" +
		"padding:0;margin:0;border:0;border-radius:7px;background:transparent;cursor:pointer;" +
		`color:${MUTED};`,

	regionTag:
		"position:absolute;pointer-events:auto;cursor:pointer;transform:translateY(-100%);" +
		"padding:2px 9px;border-radius:8px 8px 8px 0;font-size:15px;line-height:1.6;" +
		"white-space:nowrap;color:var(--text-on-accent,#fff);" +
		"background:var(--interactive-accent,#5b6ed6);opacity:.85;touch-action:none;",

	// Left-hand context bar: the configuration for whichever tool is active.
	// Positioned absolutely so it floats over the canvas instead of competing with
	// it for width -- otherwise the drawing area jumps sideways every time the bar
	// appears or disappears. Its offset from the edge is measured at runtime, since
	// the tool bar has no fixed width: it wraps into a second column when the
	// buttons do not fit.
	ctxBar:
		"position:absolute;z-index:20;top:0;height:100%;width:72px;" +
		"display:flex;flex-direction:column;align-items:center;justify-content:flex-start;" +
		"gap:7px;padding:10px 6px;margin:0;box-sizing:border-box;overflow:hidden;" +
		`border-left:1px solid ${BORDER};box-shadow:-4px 0 14px rgba(0,0,0,.10);` +
		// A shade darker than the tool bar so the two columns read as two
		"background:var(--background-secondary-alt, rgba(127,127,127,.16));",
	ctxBarNarrow:
		"position:absolute;z-index:20;left:0;right:0;height:58px;" +
		"display:flex;flex-direction:row;align-items:center;justify-content:flex-start;" +
		"gap:7px;padding:8px 10px;margin:0;box-sizing:border-box;" +
		"overflow-x:auto;overflow-y:hidden;" +
		`border-top:1px solid ${BORDER};box-shadow:0 -4px 14px rgba(0,0,0,.10);` +
		"background:var(--background-secondary-alt, rgba(127,127,127,.16));",

	// Segmented control with a highlight pill that slides between the options.
	// Stacks along the bar's long axis: vertical bar, vertical stack.
	seg:
		"position:relative;display:flex;flex:0 0 auto;box-sizing:border-box;" +
		`border-radius:9px;padding:2px;background:${HOVER};overflow:hidden;`,
	// Preview of the eraser's actual size, so the number means something
	eraserPreview:
		"flex:0 0 auto;border-radius:50%;box-sizing:border-box;" +
		`border:1.5px dashed ${MUTED};background:rgba(150,150,150,.14);`,
	segPill:
		"position:absolute;border-radius:7px;background:var(--background-primary, #fff);" +
		"box-shadow:0 1px 3px rgba(0,0,0,.16);transition:transform .18s cubic-bezier(.3,.7,.3,1);",
	segItem:
		"position:relative;display:flex;align-items:center;justify-content:center;" +
		"flex:1 1 0;border:0;background:transparent;padding:0;margin:0;cursor:pointer;" +
		`font-size:11px;line-height:1;letter-spacing:-.02em;color:${MUTED};transition:color .18s;`,
	segItemOn: "color:var(--text-normal, #222);font-weight:600;",

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
	sliderVal:
		`flex:0 0 auto;font-size:11px;text-align:center;color:${MUTED};font-variant-numeric:tabular-nums;`,

	sizePop:
		"position:absolute;z-index:30;display:flex;align-items:center;gap:11px;" +
		"padding:11px 15px;border-radius:13px;box-sizing:border-box;" +
		`background:var(--background-primary, #fff);border:1px solid ${BORDER};` +
		"box-shadow:0 6px 24px rgba(0,0,0,.22);",
	sizePopRange: "width:170px;margin:0;",
	sizePopVal:
		`min-width:26px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:${MUTED};`,

	// Small corner label on a tool button, e.g. the Wiki variant of the lasso
	btnBadge:
		"position:absolute;right:2px;bottom:1px;font-size:7px;line-height:1;" +
		"font-weight:700;letter-spacing:-.02em;pointer-events:none;",

	version:
		"flex:0 0 auto;margin-top:4px;font-size:9px;line-height:1.2;letter-spacing:.02em;" +
		`color:${MUTED};opacity:.55;text-align:center;`,

	dot: (px: number) =>
		`width:${px}px;height:${px}px;border-radius:50%;flex:0 0 auto;background:var(--text-normal, #222);`,
	colorDot: (c: string, on: boolean) =>
		`width:19px;height:19px;border-radius:50%;flex:0 0 auto;background:${c};` +
		(on ? `box-shadow:0 0 0 2px ${ACCENT};` : ""),
};

/* Icons are inline SVG rather than Obsidian's setIcon, whose icon names are not
 * guaranteed to exist across versions and platforms. Width and height are set
 * as attributes and inline styles, never left to a stylesheet. */
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
	lasso: [
		"M12 4.5c4.4 0 8 2.5 8 5.6s-3.6 5.6-8 5.6-8-2.5-8-5.6 3.6-5.6 8-5.6z",
		"M9 15.5c-.3 1.6-.1 2.9.7 3.6a2 2 0 0 0 3-.4",
	],
	link: [
		"M10.2 13.8a4.5 4.5 0 0 0 6.7.5l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5",
		"M13.8 10.2a4.5 4.5 0 0 0-6.7-.5l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5",
	],
	trash: ["M4 7h16", "M9 7V5h6v2", "M7 7l1 13h8l1-13"],
	rename: ["M4 20l4-1 9.5-9.5-3-3L5 16z", "M14.5 6.5l3 3"],
	copy: ["M9 9h9v11H9z", "M6 15H4V4h11v2"],
	fit: ["M4 9V5h4", "M20 9V5h-4", "M4 15v4h4", "M20 15v4h-4"],
	undo: ["M4 10h10.5a4.5 4.5 0 0 1 0 9H9", "M4 10l4-4", "M4 10l4 4"],
	code: ["M9 8l-4 4 4 4", "M15 8l4 4-4 4"],
};

const NS = "http://www.w3.org/2000/svg";

export function drawIcon(el: HTMLElement, name: keyof typeof ICONS, px = 22) {
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(px));
	svg.setAttribute("height", String(px));
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.9");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	// Size goes into the inline style as well: with attributes alone, some WebKit
	// versions still let a stylesheet collapse it to 0
	svg.setAttribute("style", `width:${px}px;height:${px}px;display:block;flex:0 0 auto;`);
	for (const d of ICONS[name]) {
		const p = document.createElementNS(NS, "path");
		p.setAttribute("d", d);
		svg.appendChild(p);
	}
	el.appendChild(svg);
	return svg;
}
