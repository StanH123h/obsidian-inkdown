/* Drives the pad in headless Chrome with real pen, finger and mouse input.
 *
 *   npm run test:pad            (needs Google Chrome installed)
 *
 * Input goes through the DevTools protocol, so the browser treats it as coming
 * from a real device: pointer capture, coalesced events and pressure all
 * behave as they do on hardware, which synthetic DOM events cannot fake.
 *
 * What this cannot see: Obsidian's own stylesheet (a stand-in modal is used),
 * iPadOS WebKit, Apple Pencil timing and palm contact. Those need the iPad.
 * Screenshots land in .test-build/pad-*.png for a look. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", ".test-build");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333 + Math.floor(Math.random() * 500);

let bad = 0, n = 0;
let last = "starting";
const ok = (cond, msg) => { n++; last = msg.split("\n")[0]; if (!cond) { bad++; console.log("FAIL " + msg); } };
// A run that hangs says where, instead of sitting there
setTimeout(() => { console.log(`HUNG after: ${last}`); quit(2); }, 150000).unref();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hw-pad-"));
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", "about:blank",
], { stdio: "ignore" });
const quit = (code) => {
	chrome.once("exit", () => {
		try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a temp dir; the OS will clear it */ }
		process.exit(code);
	});
	chrome.kill();
};

/* ---- a minimal DevTools client ---- */
let ws, seq = 0;
const waiting = new Map();
const errors = [];
async function connect() {
	for (let i = 0; i < 50; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			const page = list.find((t) => t.type === "page");
			if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 200));
	}
	if (!ws) throw new Error("Chrome did not come up");
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
		if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
	});
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq;
	waiting.set(id, (m) => (m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result)));
	ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expr) => {
	last = "js: " + expr.replace(/\s+/g, " ").slice(0, 80);
	const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r.result.value;
};
const frame = () => js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
const shot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(out, `pad-${name}.png`), Buffer.from(data, "base64"));
};

/* ---- input ---- */
const pen = async (pts, force = 0.5) => {
	const [x0, y0] = pts[0];
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force });
	for (const [x, y] of pts.slice(1))
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "pen", force });
	const [x1, y1] = pts[pts.length - 1];
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
	await frame();
};
const line = (x0, y0, x1, y1, steps = 24) =>
	Array.from({ length: steps + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]);
const ring = (cx, cy, r, steps = 40) =>
	Array.from({ length: steps + 1 }, (_, i) => [cx + r * Math.cos((i / steps) * 2 * Math.PI), cy + r * Math.sin((i / steps) * 2 * Math.PI)]);
const click = async (x, y) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await frame();
};
const touch = async (type, points) => {
	await send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
};
const button = async (label) => {
	const r = await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	if (!r) throw new Error("no button " + label);
	await click(r[0], r[1]);
};
const state = () => js(`(() => { const p = __pad; return {
	strokes: p.strokes.length, tool: p.tool, zoom: p.zoom, panX: p.panX, panY: p.panY,
	sel: p.sel ? p.sel.strokes.length : null,
	first: p.strokes[0] ? { x: p.strokes[0].pts[0].x, y: p.strokes[0].pts[0].y } : null,
	open: !!document.querySelector('.modal-container'), exit: __exit && { convert: __exit.convert, strokes: __exit.strokes.length },
	notices: (window.__notices || []).slice() }; })()`);

/** A finger's tap, as the touch screen makes it: touch, lift, then the click
 *  the browser sends after, to whatever is under the finger by then */
const tapAt = async (x, y, duration = 50) => {
	await send("Input.synthesizeTapGesture", { x, y, duration, tapCount: 1, gestureSourceType: "touch" });
	await new Promise((r) => setTimeout(r, 150));
	await frame();
};
const where = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const menuOpen = () => js("!!document.querySelector('[role=menu]')");
/** Open the "⋯" menu and pick the entry with this text */
const menu = async (label) => {
	await button("More");
	const r = await js(`(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	if (!r) throw new Error("no menu entry " + label);
	await click(r[0], r[1]);
};
/** Every button of the tool bar, and whether each is wholly inside the box */
const toolbarFits = (box = "document.documentElement") => js(`(() => { const t = __pad.tools, r = (${box}).getBoundingClientRect();
	const out = [...t.querySelectorAll('button')].filter(b => { const q = b.getBoundingClientRect(); return q.left < r.left - 0.5 || q.top < r.top - 0.5 || q.right > r.right + 0.5 || q.bottom > r.bottom + 0.5; });
	return { n: t.querySelectorAll('button').length, out: out.map(b => b.getAttribute('aria-label')), scrolls: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1 }; })()`);
/** Where the cards, the canvas and the dial are, and the page at its zoom */
const layout = () => js(`(() => { const p = __pad, R = (e) => { if (!e.isConnected) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
	const c = p.live.getBoundingClientRect(), sc = p.scale;
	return { root: R(p.root), tools: R(p.tools), widths: R(p.ctxBar), canvas: R(p.live), dial: R(p.dial.el), zoom: p.zoom, panX: p.panX, panY: p.panY,
		page: { l: c.left - p.panX * sc, t: c.top - p.panY * sc, r: c.left + (1000 - p.panX) * sc, b: c.top + (1414 - p.panY) * sc } }; })()`);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const drag = async (from, to, steps = 12) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= steps; i++)
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps, button: "left", buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1 });
	await frame();
};
async function viewport(width, height) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
	await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

try {
	await connect();
	await send("Runtime.enable");
	await send("Page.enable");
	await viewport(820, 1180);   // iPad Air, upright
	await send("Page.navigate", { url: "file://" + path.join(here, "pad-harness", "harness.html") });
	await new Promise((r) => setTimeout(r, 800));

	/* ---- cracks: every pixel well inside a noisy stroke must be solid ---- */
	for (const curve of [1, 0]) {
		const c = await js(`crackCheck(${curve})`);
		ok(c.checked > 10000 && c.holes === 0, `${curve ? "spline" : "straight"}: no cracks in ${c.checked} interior pixels (${c.holes} not solid, faintest alpha ${c.worst})` +
			(c.where.length ? "\n    " + c.where.map((w) => JSON.stringify(w)).join("\n    ") : ""));
	}
	if (process.env.ONLY === "stairs") {
		await viewport(1180, 820);
		await js("openPad([])");
		await frame();
		for (const [fix, timed, name] of [[false, true, "raw"], [true, false, "by-distance"], [true, true, "by-time"]]) {
			await js(`showStairs(${fix}, ${timed})`);
			await new Promise((r) => setTimeout(r, 300));
			await shot("stairs-" + name);
		}
		quit(0);
	}
	if (process.env.ONLY === "crack") {
		if (process.env.DUMP) { await js("crackCheck(1)"); console.log(String(await js(`crackPoints(1, ${process.env.DUMP})`)).split(",").join("\n")); }
		quit(bad ? 1 : 0);
	}

	/* ---- opening ---- */
	await js("openPad()");
	await frame();
	const geo = await js(`(() => { const m = document.querySelector('.modal').getBoundingClientRect(); const c = __pad.live.getBoundingClientRect(); return { m: [m.x, m.y, m.width, m.height], c: [c.width, c.height], buttons: document.querySelectorAll('.modal button').length, closeBtn: !!document.querySelector('.modal-close-button') }; })()`);
	ok(geo.m.join() === "0,0,820,1180", `the pad covers the whole screen, got ${geo.m}`);
	ok(geo.c[0] > 600 && geo.c[1] > 1100, `the canvas fills most of it, got ${geo.c}`);
	ok(!geo.closeBtn, "the stock close button is gone");
	await shot("open");
	let s = await state();
	ok(s.zoom === 1 && s.strokes === 0 && s.tool === "pen", "opens on an empty page with the pen");

	/* The whole page is visible at zoom 1, clear of the width column on the right */
	const fit = await js(`(() => { const p = __pad, sc = p.scale, w = p.surface.clientWidth - 72, h = p.surface.clientHeight;
		const x0 = -p.panX * sc, y0 = -p.panY * sc, x1 = (1000 - p.panX) * sc, y1 = (1414 - p.panY) * sc;
		return [x0, y0, x1, y1, w, h]; })()`);
	ok(fit[0] >= 0 && fit[1] >= 0 && fit[2] <= fit[4] + 0.5 && fit[3] <= fit[5] + 0.5, `zoomed out, the whole page is on screen: ${fit.map((v) => v.toFixed(0))}`);

	/* ---- writing ---- */
	await pen(line(150, 300, 400, 300));
	await pen(line(150, 360, 400, 420));
	s = await state();
	ok(s.strokes === 2, `two pen strokes recorded, got ${s.strokes}`);
	// On lift the predicted tip shrinks back over a few frames, then the
	// stroke is on the page and the live layer is empty
	await new Promise((r) => setTimeout(r, 200));
	const settled = await js(`(() => { const p = __pad, c = p.lctx.getImageData(0, 0, p.live.width, p.live.height).data;
		let ink = 0; for (let i = 3; i < c.length; i += 4) if (c[i]) ink++;
		const b = p.bctx.getImageData(0, 0, p.base.width, p.base.height).data;
		let dark = 0; for (let i = 0; i < b.length; i += 4) if (b[i] < 100 && b[i + 3] > 200) dark++;
		return { retracting: !!p.retract, live: ink, page: dark }; })()`);
	ok(!settled.retracting && settled.live === 0 && settled.page > 500, `after lifting, the strokes are on the page and the live layer is clear: ${JSON.stringify(settled)}`);

	/* A mouse also writes */
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 150, y: 500, button: "left", buttons: 1, clickCount: 1 });
	for (const [x, y] of line(150, 500, 380, 520).slice(1)) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 380, y: 520, button: "left", buttons: 0, clickCount: 1 });
	await frame();
	s = await state();
	ok(s.strokes === 3, `a mouse stroke too, got ${s.strokes}`);

	/* A finger does not write */
	await touch("touchStart", [[300, 700]]);
	for (const [x, y] of line(300, 700, 360, 760, 6)) await touch("touchMove", [[x, y]]);
	await touch("touchEnd", []);
	await frame();
	s = await state();
	ok(s.strokes === 3, `a finger does not draw, got ${s.strokes}`);

	await shot("written");

	/* ---- the AI pen ---- */
	const badge = await js(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'AI pen: notes for the AI, never transcribed')?.textContent`);
	ok(badge === "AI", `the AI pen carries its badge, got ${JSON.stringify(badge)}`);
	await button("AI pen: notes for the AI, never transcribed");
	await pen(line(150, 620, 380, 640));
	const note = await js(`(() => { const st = __pad.strokes.at(-1); return { ai: st.ai, c: st.c, n: __pad.strokes.length }; })()`);
	ok(note.ai === true && note.c === "#7c3aed" && note.n === 4, `the AI pen writes a violet note: ${JSON.stringify(note)}`);
	// The image the model reads keeps the note violet and the writing black
	const colours = await js(`(async () => {
		const url = rasterize(__pad.strokes);
		const img = new Image(); img.src = url; await img.decode();
		const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
		const x = c.getContext('2d'); x.drawImage(img, 0, 0);
		const d = x.getImageData(0, 0, c.width, c.height).data;
		let violet = 0, black = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i] > 90 && d[i] < 150 && d[i + 1] < 90 && d[i + 2] > 200) violet++;
			if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) black++;
		}
		return { violet, black };
	})()`);
	ok(colours.violet > 200 && colours.black > 500, `the image keeps both colours apart: ${JSON.stringify(colours)}`);
	// The dial's eraser goes back to the pen that was in hand
	const d0 = await js(`(() => { const r = __pad.dial.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	await click(d0[0], d0[1]);
	await click(d0[0], d0[1]);
	s = await state();
	ok(s.tool === "ai", `after the eraser, back to the AI pen, got ${s.tool}`);
	await button("Undo");
	await button("Pen");

	/* ---- pinch, pan, fit ---- */
	await touch("touchStart", [[350, 600], [450, 600]]);
	for (let i = 1; i <= 8; i++) await touch("touchMove", [[350 - i * 15, 600], [450 + i * 15, 600]]);
	await touch("touchEnd", []);
	await frame();
	s = await state();
	ok(s.zoom > 1.8, `pinching out zooms in, zoom ${s.zoom.toFixed(2)}`);
	const before = s.panX;
	await touch("touchStart", [[400, 600]]);
	for (const [x, y] of line(400, 600, 250, 500, 8)) await touch("touchMove", [[x, y]]);
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 1200));   // let the glide finish
	s = await state();
	ok(s.panX > before + 20, `a finger pans the zoomed page, panX ${before.toFixed(0)} -> ${s.panX.toFixed(0)}`);
	await touch("touchStart", [[150, 600], [650, 600]]);
	for (let i = 1; i <= 10; i++) await touch("touchMove", [[150 + i * 22, 600], [650 - i * 22, 600]]);
	await touch("touchEnd", []);
	await frame();
	s = await state();
	ok(s.zoom === 1, `pinching in stops at the whole page, zoom ${s.zoom}`);
	await menu("Whole page / page width");
	s = await state();
	ok(s.zoom === 1, "fit, from the ⋯ menu, resets the zoom");

	/* ---- the ⋯ menu ---- */
	const bar = await js(`(() => { const labels = [...__pad.tools.querySelectorAll('button')].map(b => b.getAttribute('aria-label')); return { labels, text: __pad.tools.textContent }; })()`);
	ok(bar.labels.includes("More") && bar.labels.includes("Redo") && !bar.labels.includes("Whole page / page width") && !bar.labels.includes("Clear the page"), `the tool bar has ⋯ and redo, and no longer fit or clear: ${bar.labels.join(", ")}`);
	ok(!/harness/.test(bar.text), `and no version printed on it: "${bar.text}"`);
	await button("More");
	const m = await js(`(() => { const m = document.querySelector('[role=menu]'), b = [...__pad.tools.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'More');
		const r = m.getBoundingClientRect(), q = b.getBoundingClientRect(), d = __pad.root.getBoundingClientRect();
		return { items: [...m.querySelectorAll('[role=menuitem]')].map(i => i.textContent), left: r.right <= q.left, inside: r.left >= d.left && r.top >= d.top && r.right <= d.right && r.bottom <= d.bottom, near: Math.abs(r.top - q.top) < 1 }; })()`);
	ok(m.items.join() === "Whole page / page width,Clear the page", `the menu holds fit and clear, worded: ${m.items}`);
	ok(m.left && m.inside && m.near, `it opens beside its button, toward the page, all on screen: ${JSON.stringify(m)}`);
	// A tap elsewhere closes it and writes nothing, even as a stroke
	const strokesBefore = (await state()).strokes;
	await pen(line(200, 700, 400, 700));
	s = await state();
	ok(s.strokes === strokesBefore && !(await js("!!document.querySelector('[role=menu]')")), `a stroke started outside the open menu only closes it: ${strokesBefore} → ${s.strokes} strokes`);
	await pen(line(200, 700, 400, 700));
	ok((await state()).strokes === strokesBefore + 1, "and the next one writes");
	// With a finger: the click after the lift must not open it again, nor
	// press whatever else was under the finger
	await tapAt(...(await where("More")));
	ok(await menuOpen(), "a finger's tap on ⋯ opens the menu");
	await tapAt(...(await where("More")));
	ok(!(await menuOpen()), "and a second tap on ⋯ closes it, rather than closing and opening it again");
	await tapAt(...(await where("More")));
	ok(await menuOpen(), "and the next tap opens it again");
	await tapAt(...(await where("Lasso: circle ink to move it")));
	s = await state();
	ok(!(await menuOpen()) && s.tool === "pen", `a tap on another tool only closes the menu, the tool stays: ${s.tool}`);
	await tapAt(...(await where("Lasso: circle ink to move it")));
	ok((await state()).tool === "lasso", "and the next tap on it takes it");
	await button("Pen");
	// A drag sends no click at the end: closing the menu with one must leave
	// the next real tap alone, and must not move the page either
	await tapAt(...(await where("More")));
	const view0 = await state();
	await touch("touchStart", [[300, 600]]);
	for (let i = 1; i <= 8; i++) await touch("touchMove", [[300 + i * 20, 600 - i * 10]]);
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 200));
	s = await state();
	ok(!(await menuOpen()) && s.panX === view0.panX && s.panY === view0.panY, `a finger dragged outside the menu closes it and moves nothing: pan ${view0.panX},${view0.panY} → ${s.panX},${s.panY}`);
	await tapAt(...(await where("Lasso: circle ink to move it")));
	ok((await state()).tool === "lasso", "and the next tap after it is not swallowed");
	await button("Pen");
	await menu("Clear the page");
	ok((await state()).strokes === 0, "clear, from the ⋯ menu, empties the page");
	await button("Undo");
	ok((await state()).strokes === strokesBefore + 1, "and undo brings it all back");
	await button("Undo");

	/* ---- lasso ---- */
	await button("Lasso: circle ink to move it");
	s = await state();
	ok(s.tool === "lasso", "lasso tool on");
	const scr = await js(`(() => { const p = __pad, r = p.live.getBoundingClientRect(), s0 = p.strokes[0].pts[0];
		return [r.left + (s0.x - p.panX) * p.scale, r.top + (s0.y - p.panY) * p.scale]; })()`);
	// The second stroke starts 60px below the first, so this ring holds only
	// the first one's start
	await pen(ring(scr[0] + 30, scr[1], 40));
	s = await state();
	ok(s.sel === 1, `the ring catches the first stroke only, caught ${s.sel}`);
	const was = s.first;
	await pen(line(scr[0] + 30, scr[1], scr[0] + 130, scr[1] + 80, 12));
	s = await state();
	ok(s.first.x > was.x + 30 && s.first.y > was.y + 20, `dragging inside the ring moves the ink: ${JSON.stringify(was)} -> ${JSON.stringify(s.first)}`);
	await shot("lasso");
	await button("Undo");
	s = await state();
	ok(Math.abs(s.first.x - was.x) < 0.01 && s.sel === null, "undo puts it back and drops the ring");

	/* A finger tap on a selection brings up delete */
	await pen(ring(scr[0] + 30, scr[1], 40));
	await touch("touchStart", [[scr[0] + 30, scr[1]]]);
	await touch("touchEnd", []);
	await frame();
	const del = await js(`!!document.querySelector('button[aria-label="Delete the strokes inside"]')`);
	ok(del, "tapping the selection shows its delete button");
	if (del) {
		await button("Delete the strokes inside");
		s = await state();
		ok(s.strokes === 2, `delete removes the caught stroke, ${s.strokes} left`);
		await button("Undo");
	}

	/* ---- eraser, through the dial ---- */
	await button("Pen");
	const dial = await js(`(() => { const r = __pad.dial.el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	await click(dial[0], dial[1]);
	s = await state();
	ok(s.tool === "eraser", `tapping the dial arms the eraser, tool ${s.tool}`);
	const n0 = s.strokes;
	await pen(line(270, 250, 270, 450, 30));
	s = await state();
	ok(s.strokes < n0, `the eraser removes what it crosses, ${n0} -> ${s.strokes}`);
	await button("Undo");
	s = await state();
	ok(s.strokes === n0, "one erase gesture is one undo");
	await click(dial[0], dial[1]);
	s = await state();
	ok(s.tool === "pen", "tapping the dial again goes back to the pen");

	/* ---- convert and close ---- */
	await js("window.__blocker = 'Link an API key in the plugin settings first'");
	await button("Turn this into Markdown at the cursor");
	s = await state();
	ok(s.open && s.notices.includes("Link an API key in the plugin settings first"), "without a key, convert explains and stays open");
	await js("window.__blocker = null");
	const page = await js("rasterize(__pad.strokes)");
	fs.writeFileSync(path.join(out, "pad-sent.png"), Buffer.from(page.split(",")[1], "base64"));
	await button("Turn this into Markdown at the cursor");
	s = await state();
	ok(!s.open && s.exit?.convert === true && s.exit.strokes === 3, `convert closes the pad and hands over the strokes: ${JSON.stringify(s.exit)}`);

	await js("openPad(__exit.strokes)");
	await frame();
	s = await state();
	ok(s.strokes === 3, "reopening with a draft shows it");
	await button("Close (your writing is kept for next time)");
	s = await state();
	ok(!s.open && s.exit?.convert === false && s.exit.strokes === 3, `close keeps the writing: ${JSON.stringify(s.exit)}`);

	await js("openPad([])");
	await button("Turn this into Markdown at the cursor");
	s = await state();
	ok(s.open && s.notices.includes("Nothing written yet"), "an empty page does not convert");
	await button("Close (your writing is kept for next time)");

	/* ---- zoomed in: spline against straight segments ---- */
	await js("openPad([])");
	await frame();
	// A quick, loopy stroke, the kind that facets worst
	const loop = Array.from({ length: 70 }, (_, i) => {
		const a = (i / 69) * Math.PI * 3;
		return [300 + 18 * a * Math.cos(a), 600 + 18 * a * Math.sin(a)];
	});
	await pen(loop, 0.6);
	await js(`(() => { const p = __pad, r = p.live.getBoundingClientRect(); const q = p.toPage({ clientX: 300, clientY: 600 });
		p.setZoom(6, q.x, q.y, r.left + r.width / 2, r.top + r.height / 2); })()`);
	await new Promise((r) => setTimeout(r, 200));
	await shot("zoom-spline");
	await js("settings.curve = 0; __pad.redrawAll()");
	await new Promise((r) => setTimeout(r, 200));
	await shot("zoom-straight");
	await js("settings.curve = 1; __pad.redrawAll()");

	/* ---- a full page: what a repaint costs ---- */
	const cost = await js(`(() => {
		const p = __pad, base = p.strokes[0];
		p.zoom = 1; p.clampPan();
		const page = [];
		for (let k = 0; k < 400; k++) {
			const dx = (k % 20) * 45 - 250, dy = Math.floor(k / 20) * 65 - 520;
			page.push({ c: base.c, s: base.s, pts: base.pts.map((q) => ({ x: q.x * 0.25 + dx + 300, y: q.y * 0.25 + dy + 500, p: q.p })) });
		}
		p.strokes = page;
		// Reading a pixel back forces the queued drawing to actually happen;
		// without it the timing only covers recording the commands
		const paint = () => { const t0 = performance.now(); p.paintAll(); p.bctx.getImageData(0, 0, 1, 1); return performance.now() - t0; };
		const time = (curve) => {
			settings.curve = curve;
			const first = paint();   // builds every outline: the cache was keyed on the old setting
			const t = [];
			for (let i = 0; i < 12; i++) t.push(paint());
			t.sort((a, b) => a - b);
			return { first, median: t[6] };
		};
		const out = {};
		for (const z of [1, 3]) {
			p.zoom = z; p.panX = 300; p.panY = 400; p.clampPan();
			out["zoom " + z] = { straight: time(0), spline: time(1) };
		}
		settings.curve = 1;
		return out;
	})()`);
	console.log(`  full page of 400 strokes, repaint (desktop Chrome; an iPad will be slower):`);
	for (const [z, c] of Object.entries(cost))
		console.log(`    ${z}: straight ${c.straight.median.toFixed(1)} ms, spline setting ${c.spline.median.toFixed(1)} ms (first paint ${c.spline.first.toFixed(1)} ms)`);
	await shot("full-page");
	await button("Close (your writing is kept for next time)");

	/* ---- undo and redo: buttons, keys and fingers ---- */
	await viewport(820, 1180);
	await js("openPad([])");
	await frame();
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	// A tap as fingers really land: a few pixels of drift, within the slop
	const tapWith = async (points, hold = 60, drift = 4) => {
		await touch("touchStart", points);
		await touch("touchMove", points.map(([x, y], i) => [x + (i ? drift : -drift), y]));
		await wait(hold);
		await touch("touchEnd", []);
		await frame();
	};
	const look = () => js("({ strokes: __pad.strokes.length, redo: __pad.redoStack.length, zoom: __pad.zoom, panX: __pad.panX, panY: __pad.panY })");
	for (const y of [300, 360, 420]) await pen(line(150, y, 400, y));
	let u = await look();
	const start = u;
	await button("Undo");
	await button("Redo");
	u = await look();
	ok(u.strokes === 3 && u.redo === 0, `the redo button puts back what undo took: ${JSON.stringify(u)}`);
	await js("__modalScope.keys.find((k) => k.key === 'z' && k.mods.join() === 'Mod').fn()");
	await js("__modalScope.keys.find((k) => k.key === 'z' && k.mods.join() === 'Mod,Shift').fn()");
	u = await look();
	ok(u.strokes === 3, "and so do Mod+Z, Mod+Shift+Z");
	await tapWith([[300, 700], [420, 700]]);
	u = await look();
	ok(u.strokes === 2 && u.zoom === start.zoom && u.panX === start.panX && u.panY === start.panY, `a two-finger tap undoes and leaves the view as it was: ${JSON.stringify(u)}`);
	await tapWith([[300, 700], [420, 700], [540, 700]]);
	u = await look();
	ok(u.strokes === 3, "a three-finger tap redoes");
	await tapWith([[300, 700], [420, 700]], 450);
	u = await look();
	ok(u.strokes === 3, "two fingers held too long undo nothing");
	await touch("touchStart", [[350, 700], [450, 700]]);
	for (let i = 1; i <= 6; i++) await touch("touchMove", [[350 - i * 10, 700], [450 + i * 10, 700]]);
	await touch("touchEnd", []);
	await frame();
	u = await look();
	ok(u.strokes === 3 && u.zoom > start.zoom, `spreading two fingers zooms and undoes nothing: zoom ${u.zoom.toFixed(2)}`);
	await tapWith([[300, 700], [420, 700]]);
	await pen(line(150, 500, 400, 500));
	u = await look();
	ok(u.strokes === 3 && u.redo === 0, "a new stroke after undoing: nothing left to redo");
	await js("window.__notices = []");
	await tapWith([[300, 700], [420, 700], [540, 700]]);
	s = await state();
	ok(s.strokes === 3 && s.notices.includes("Nothing to redo"), `redoing then says there is nothing to redo: ${JSON.stringify(s.notices)}`);
	await button("Close (your writing is kept for next time)");

	/* ---- closed and opened again: the same pad ---- */
	await js("openPad([])");
	await frame();
	for (const y of [300, 360]) await pen(line(150, y, 400, y));
	await js("__pad.zoom = 2.2; __pad.panX = 140; __pad.panY = 260; __pad.syncViewport()");
	const parked = await look();
	await button("Undo");
	await button("Lasso: circle ink to move it");
	await button("Close (your writing is kept for next time)");
	await js("reopenPad()");
	await frame();
	u = await look();
	ok(u.strokes === 1 && u.redo === 1, `reopened, the page and its history are there: ${JSON.stringify(u)}`);
	ok(Math.abs(u.zoom - parked.zoom) < 1e-9 && Math.abs(u.panX - parked.panX) < 1e-6 && Math.abs(u.panY - parked.panY) < 1e-6, `and the view is as it was left, in the same space: ${JSON.stringify(u)} (was ${JSON.stringify(parked)})`);
	ok(await js("__pad.tool") === "pen", "but it opens with the pen, whatever was in hand when it closed");
	await button("Redo");
	u = await look();
	ok(u.strokes === 2, "redo works across closing and opening again");
	await button("Close (your writing is kept for next time)");

	/* ---- the cards: floating over the canvas, clear of the page ---- */
	for (const [w, hgt, name] of [[820, 1180, "upright"], [1180, 820, "landscape"]]) {
		await viewport(w, hgt);
		await js("openPad([])");
		await new Promise((r) => setTimeout(r, 300));
		const L = await layout();
		ok(L.canvas.w === w && L.canvas.h === hgt, `${name}: the canvas fills the pad: ${L.canvas.w}×${L.canvas.h}`);
		ok(near(L.tools.r, w - 12) && near(L.tools.t + L.tools.h / 2, hgt / 2), `${name}: the tool bar floats 12px in from the right edge, at its middle: ${JSON.stringify(L.tools)}`);
		ok(near(L.widths.r, L.tools.l - 8) && near(L.widths.t, L.tools.t), `${name}: the widths sit beside it, tops level: ${JSON.stringify(L.widths)}`);
		ok(L.page.r <= L.widths.l - 8, `${name}: the page opens clear of the cards: page right ${L.page.r.toFixed(0)}, widths at ${L.widths.l.toFixed(0)}`);
		await button("Lasso: circle ink to move it");
		const L2 = await layout();
		ok(L2.widths === null && L2.zoom === L.zoom && L2.panX === L.panX && L2.panY === L.panY, `${name}: the widths go with the pen, and the page stays put`);
		await button("Pen");
		await button("Close (your writing is kept for next time)");
	}
	// The dial can be left on a card, as anywhere else: it stays where it is
	// put, over the card, so its middle can still be taken to drag it off
	await viewport(820, 1180);
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	let L = await layout();
	const onBar = [L.tools.l + 10, L.tools.t + L.tools.h / 2];
	await drag([L.dial.l + L.dial.w / 2, L.dial.t + L.dial.h / 2], onBar);
	L = await layout();
	const onTop = await js(`__pad.dial.el.contains(document.elementFromPoint(${onBar[0]}, ${onBar[1]}))`);
	ok(near(L.dial.l + L.dial.w / 2, onBar[0], 3) && near(L.dial.t + L.dial.h / 2, onBar[1], 3) && onTop, `the dial let go on the tool bar stays there, on top of it: centre ${(L.dial.l + L.dial.w / 2).toFixed(0)},${(L.dial.t + L.dial.h / 2).toFixed(0)}, on top ${onTop}`);
	await drag(onBar, [300, 300]);
	L = await layout();
	ok(near(L.dial.l + L.dial.w / 2, 300, 3) && near(L.dial.t + L.dial.h / 2, 300, 3), "and is dragged off it again by its middle");
	await js("settings.dialX = -1; settings.dialY = -1; __pad.placeDial()");
	await button("Close (your writing is kept for next time)");
	// A short window: the tool bar takes a second column rather than losing
	// buttons off the bottom
	await viewport(1000, 420);
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	const short = await toolbarFits();
	ok(!short.out.length && !short.scrolls, `a short window: every tool bar button on screen, in two columns: ${JSON.stringify(short)}`);
	await shot("short");
	await button("Close (your writing is kept for next time)");
	await viewport(820, 1180);

	/* ---- moving the tool bar ---- */
	await viewport(820, 1180);
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	for (const y of [300, 360]) await pen(line(150, y, 400, y));
	const view = async () => { const l = await layout(); return { zoom: l.zoom, panX: l.panX, panY: l.panY }; };
	const strokes = async () => (await state()).strokes;
	const v0 = await view();
	await tapAt(...(await where("Undo")));
	ok(await strokes() === 1, "a quick tap on the tool bar still presses the button");
	await button("Redo");
	// A press that wanders before the moment is up is not a hold
	let at = await where("Undo");
	await touch("touchStart", [at]);
	await touch("touchMove", [[at[0] - 30, at[1]]]);
	await new Promise((r) => setTimeout(r, 450));
	ok(!(await js("!!__pad.drag")), "a press that moves off at once does not take the tool bar up");
	await touch("touchEnd", []);
	await frame();
	// Held, it lifts: the page shaded, a place outlined at each edge, the
	// nearest lit up, the tool bar following the finger
	at = await where("Undo");
	await touch("touchStart", [at]);
	await new Promise((r) => setTimeout(r, 420));
	for (let i = 1; i <= 10; i++) await touch("touchMove", [[at[0] + (60 - at[0]) * i / 10, at[1] + (590 - at[1]) * i / 10]]);
	const mid = await js(`(() => { const d = __pad.drag; return d && { slots: d.slots.size, near: d.near, shaded: d.shade.isConnected, lit: [...d.slots].filter(([, s]) => /solid/.test(s.el.getAttribute('style'))).map(([k]) => k), moved: /translate/.test(__pad.tools.style.transform), widths: __pad.ctxBar.isConnected }; })()`);
	ok(mid && mid.slots === 4 && mid.near === "left" && mid.lit.join() === "left" && mid.shaded && mid.moved && !mid.widths, `held, the tool bar is taken up: ${JSON.stringify(mid)}`);
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 150));
	let M = await layout();
	ok(await js("settings.toolbarSide") === "left" && near(M.tools.l, 12) && near(M.widths.l, M.tools.r + 8) && near(M.widths.t, M.tools.t) && M.tools.h > M.tools.w, `let go by the left edge, it goes there, a column, the widths beside it: ${JSON.stringify(M.tools)}`);
	ok(!(await js("!!__pad.drag")) && !M.tools.transform && await strokes() === 2, "the shade is gone, and the button it was held by was not pressed");
	const v1 = await view();
	ok(v1.zoom === v0.zoom && v1.panX === v0.panX && v1.panY === v0.panY, "and the page stayed where it was");
	// Nor does it jump on the next touch, as it would if the move had already
	// changed the room it is kept within
	const p0 = (await layout()).page;
	await touch("touchStart", [[400, 800]]);
	for (let i = 1; i <= 4; i++) await touch("touchMove", [[400 + i * 5, 800]]);
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 600));
	const p1 = (await layout()).page;
	ok(near(p1.l, p0.l, 1) && near(p1.t, p0.t, 1), `and the next drag of the page does not make it jump: left ${p0.l.toFixed(0)} → ${p1.l.toFixed(0)}`);
	// Held and let go in place: back where it was, and still no press
	await tapAt(...(await where("Undo")), 450);
	ok(await js("settings.toolbarSide") === "left" && await strokes() === 2, "held and let go where it is: it stays, and the button is not pressed");
	// Fitting lays the page out clear of the cards where they are now
	await menu("Whole page / page width");
	M = await layout();
	ok(M.page.l >= M.widths.r + 8 - 0.5, `fit puts the page clear of the cards on the left: page from ${M.page.l.toFixed(0)}, widths to ${M.widths.r.toFixed(0)}`);
	// The grip is easy to take hold of: wider and taller than its bar
	const handle = await js(`(() => { const g = __pad.grip, r = g.getBoundingClientRect(), b = g.firstElementChild.getBoundingClientRect();
		const pts = [[r.left + 3, r.top + 2], [r.right - 3, r.bottom - 2], [b.left + b.width / 2, b.top - 4], [b.left + b.width / 2, b.bottom + 4]];
		return { size: [r.width, r.height], bar: [b.width, b.height], held: pts.map(([x, y]) => g.contains(document.elementFromPoint(x, y))) }; })()`);
	ok(Math.min(...handle.size) >= 14 && handle.held.every(Boolean), `the grip takes the mouse well around its bar: ${JSON.stringify(handle)}`);
	// A mouse takes it by the grip straight away
	const grip = await js("(() => { const r = __pad.grip.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
	await drag(grip, [410, 30], 10);
	await new Promise((r) => setTimeout(r, 150));
	M = await layout();
	ok(await js("settings.toolbarSide") === "top" && near(M.tools.t, 12) && near(M.tools.l + M.tools.w / 2, 410) && M.tools.w > M.tools.h && near(M.widths.t, M.tools.b + 8), `a mouse drags it by the grip to the top: a row, the widths below it: ${JSON.stringify(M.tools)}`);
	const top = await toolbarFits();
	ok(!top.out.length && !top.scrolls, `every button in the row on screen: ${JSON.stringify(top)}`);
	await shot("toolbar-top");
	// The ⋯ menu offers the four places, the one in use marked
	await button("More");
	const places = await js("[...document.querySelectorAll('[role=menuitemradio]')].map(b => b.getAttribute('aria-label') + (b.getAttribute('aria-checked') === 'true' ? '*' : ''))");
	ok(places.join() === "Left,Right,Top*,Bottom", `the ⋯ menu offers the four places, top marked: ${places}`);
	await shot("toolbar-menu");
	await button("Bottom");
	M = await layout();
	ok(await js("settings.toolbarSide") === "bottom" && near(M.tools.b, 1180 - 12) && near(M.widths.b, M.tools.t - 8), `picked from the menu, it goes to the foot: ${JSON.stringify(M.tools)}`);
	// Opened again, the page is laid out clear of it
	await button("Close (your writing is kept for next time)");
	await js("reopenPad()");
	await new Promise((r) => setTimeout(r, 300));
	M = await layout();
	ok(M.page.b <= M.widths.t - 8 + 0.5, `opened again, the page is clear of the cards at the foot: page to ${M.page.b.toFixed(0)}, widths from ${M.widths.t.toFixed(0)}`);
	await button("Close (your writing is kept for next time)");
	// A narrow pad has rows only: top or foot
	await js("settings.toolbarSide = 'left'");
	await viewport(390, 844);
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	M = await layout();
	ok(near(M.tools.b, 844 - 12), "on a phone, a tool bar set to the left sits at the foot");
	// At the top it spans the width; the dial, never moved, starts below it
	await js("__pad.moveToolbar('top')");
	M = await layout();
	ok(M.dial.t >= M.widths.b, `a phone's tool bar at the top: the dial starts below the cards, not over its buttons: dial from ${M.dial.t.toFixed(0)}, cards to ${M.widths.b.toFixed(0)}`);
	await js("__pad.moveToolbar('left')");
	await button("More");
	const phonePlaces = await js("[...document.querySelectorAll('[role=menuitemradio]')].map(b => b.getAttribute('aria-label'))");
	ok(phonePlaces.join() === "Top,Bottom", `and the ⋯ menu offers top and foot only: ${phonePlaces}`);
	await click(195, 300);
	at = await where("Undo");
	await touch("touchStart", [at]);
	await new Promise((r) => setTimeout(r, 420));
	for (let i = 1; i <= 8; i++) await touch("touchMove", [[at[0] + (20 - at[0]) * i / 8, at[1] + (600 - at[1]) * i / 8]]);
	const phoneDrag = await js("__pad.drag && [...__pad.drag.slots.keys()]");
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 150));
	ok(phoneDrag && phoneDrag.join() === "top,bottom" && await js("settings.toolbarSide") === "bottom", `dragged toward the left, a phone offers top and foot, and the nearer wins: ${phoneDrag} → ${await js("settings.toolbarSide")}`);
	await button("Close (your writing is kept for next time)");
	// The hint: shown until tapped, or until the tool bar is moved
	await viewport(820, 1180);
	await js("settings.toolbarSide = 'right'; settings.toolbarHintSeen = false");
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	const hint = await js(`(() => { const h = __pad.hint; if (!h) return null; const r = h.getBoundingClientRect(), t = __pad.tools.getBoundingClientRect(), a = h.lastElementChild.getBoundingClientRect();
		return { text: h.textContent, above: r.bottom <= t.top, arrowOverGrip: a.left < t.left + t.width / 2 && a.right > t.left + t.width / 2 }; })()`);
	ok(hint && hint.text === "Hold to drag" && hint.above && hint.arrowOverGrip, `a first open shows the hint over the tool bar, pointing at the grip: ${JSON.stringify(hint)}`);
	await shot("toolbar-hint");
	const hr = await js("(() => { const r = __pad.hint.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
	await tapAt(...hr);
	ok(!(await js("!!__pad.hint")) && await js("settings.toolbarHintSeen") === true && await strokes() === 0, "tapped, it goes for good, and writes nothing");
	await button("Close (your writing is kept for next time)");
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	ok(!(await js("!!__pad.hint")), "and is not shown again");
	await button("Close (your writing is kept for next time)");
	await js("settings.toolbarHintSeen = false");
	await js("openPad([])");
	await new Promise((r) => setTimeout(r, 300));
	at = await where("Pen");
	await touch("touchStart", [at]);
	await new Promise((r) => setTimeout(r, 420));
	await touch("touchMove", [[at[0] - 20, at[1]]]);
	ok(!(await js("!!__pad.hint")), "taking the tool bar up puts the hint away");
	await touch("touchEnd", []);
	await new Promise((r) => setTimeout(r, 150));
	ok(await js("settings.toolbarHintSeen") === true, "and moving it counts as having learnt it");
	await button("Close (your writing is kept for next time)");
	await js("settings.toolbarSide = 'right'; settings.toolbarHintSeen = true");

	/* ---- in a pane, and moving between hosts ---- */
	await viewport(1180, 820);   // landscape, the way split view is used
	await js("openSwappable(590, 820)");
	await frame();
	ok(await js(`!!document.querySelector('button[aria-label="Open beside the note"]')`), "full screen offers the pane where there is one");
	await pen(line(300, 300, 600, 300));
	await pen(line(300, 360, 600, 360));
	const keys = await js("__modalScope.keys.length");
	await button("Open beside the note");
	await new Promise((r) => setTimeout(r, 300));
	const host = () => js(`(() => { const p = __pad, c = p.live.getBoundingClientRect(); return {
		strokes: p.strokes.length, undo: p.undoStack.length, narrow: p.narrow, c: [c.width, c.height],
		widthFit: Math.abs(p.zoom - p.widthZoom()) < 1e-6, top: p.panY,
		modal: !!document.querySelector('.modal-container'), mounted: p.live.isConnected,
		modalKeys: __modalScope.keys.length, paneKeys: __paneScope?.keys.length ?? null,
		full: !!document.querySelector('button[aria-label="Full screen"]'),
		split: !!document.querySelector('button[aria-label="Open beside the note"]') }; })()`);
	let h = await host();
	ok(!h.modal && h.strokes === 2 && h.undo === 2, `moving into the pane keeps the page and its undo history: ${JSON.stringify(h)}`);
	ok(h.c[0] === 590 && h.c[1] === 820, `the canvas fills the pane, the cards floating over it: ${h.c}`);
	ok(h.widthFit, "the page fills the pane's width, rather than keeping a zoom made for the whole screen");
	ok(h.full && !h.split && h.modalKeys === 0 && h.paneKeys === keys && keys > 0, `the pane offers full screen, and the shortcuts moved with the pad: ${h.modalKeys} left behind, ${h.paneKeys} of ${keys} in the pane`);
	await shot("pane");
	await pen(line(100, 500, 300, 500));
	s = await state();
	ok(s.strokes === 3, "the pen writes in the pane");
	await js("resizePane(360, 820)");
	await new Promise((r) => setTimeout(r, 300));
	h = await host();
	ok(h.narrow === true && h.c[0] <= 360 && h.c[0] > 300, `a narrow pane gets the narrow layout, and the canvas follows: ${JSON.stringify(h)}`);
	const tf = await toolbarFits("__pad.root");
	const rows = await js("__pad.tools.offsetHeight");
	ok(!tf.out.length && !tf.scrolls && rows > 60, `every tool bar button is in the narrow pane, on a second row: ${JSON.stringify(tf)}, ${rows}px tall`);
	await shot("pane-narrow");
	await js("resizePane(590, 820)");
	await new Promise((r) => setTimeout(r, 300));
	await button("Turn this into Markdown at the cursor");
	h = await host();
	const sent = await js("__sent?.length ?? null");
	ok(sent === 3 && h.strokes === 0 && h.undo === 0 && h.mounted, `converting in the pane sends the page and leaves a clean one open: sent ${sent}, ${JSON.stringify(h)}`);
	await js("__pad.setPage(__sent)");
	s = await state();
	ok(s.strokes === 3, "a page put back after a failure shows");
	// Zoomed in and scrolled down, to see that full screen carries on from there
	await js("__pad.zoom = 2; __pad.panY = 400; __pad.syncViewport()");
	const topBefore = await js("__pad.panY");
	await button("Full screen");
	await new Promise((r) => setTimeout(r, 300));
	h = await host();
	ok(h.modal && h.strokes === 3 && h.paneKeys === 0 && h.modalKeys === keys && h.c[0] > 900, `back to full screen with the page: ${JSON.stringify(h)}`);
	ok(h.widthFit && Math.abs(h.top - topBefore) < 1, `filling the width again, on the same part of the page: top ${h.top} (was ${topBefore})`);
	await button("Close (your writing is kept for next time)");
	s = await state();
	ok(!s.open && s.exit?.convert === false && s.exit.strokes === 3, `and closing from there keeps it: ${JSON.stringify(s.exit)}`);
	// Where there is no split view, as on a phone, there is no button for it
	await js("openPad([])");
	await frame();
	h = await host();
	ok(!h.split && !h.full, "without a pane to go to, no button for one");
	await button("Close (your writing is kept for next time)");

	/* ---- the stand-in caret, in the note the pane writes into ---- */
	await js("ghostEditor('Proof:\\n\\nTheorem 2', 6)");
	const ghost = () => js("(() => { const g = __editor.contentDOM.querySelector('.inkdown-ghost-caret'); return g ? __editor.posAtDOM(g) : null; })()");
	await js("__editor.focus()");
	await frame();
	ok(await ghost() === null, "the note has the focus: its own caret, no stand-in");
	await js("document.activeElement.blur()");
	await frame();
	ok(await ghost() === 6, "the focus gone, to the pad: the stand-in where the caret was");
	await js("__editor.dispatch({ selection: { anchor: 2, head: 4 } })");
	await frame();
	ok(await ghost() === 4, "with a selection, at its end, where the page goes in");
	await js("__editor.dispatch({ changes: { from: 0, insert: 'X ' } })");
	await frame();
	ok(await ghost() === 6, "text put in before it, as a placeholder is: it moves along");
	const textAt = () => js("__editor.coordsAtPos(7).left");
	const withGhost = await textAt();
	await js("__wanted = false; refreshGhosts()");
	await frame();
	ok(await ghost() === null, "the pane closed, or another note chosen: it goes");
	const withoutGhost = await textAt();
	ok(Math.abs(withGhost - withoutGhost) < 0.5, `the text does not move when it comes and goes: ${withGhost} with it, ${withoutGhost} without`);
	await js("__wanted = true; refreshGhosts()");
	await frame();
	ok(await ghost() === 6, "and comes back with the pane");
	await js("__editor.focus()");
	await frame();
	ok(await ghost() === null, "back in the note, the real caret takes over");
	await js("__editor.destroy(); __editorEl.remove()");

	/* ---- other shapes of screen ---- */
	for (const [w, h, name] of [[1180, 820, "landscape"], [390, 844, "phone"]]) {
		await viewport(w, h);
		await js(`openPad(${JSON.stringify([])})`);
		await new Promise((r) => setTimeout(r, 300));
		const g = await js(`(() => { const m = document.querySelector('.modal').getBoundingClientRect(); const go = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Turn this into Markdown at the cursor').getBoundingClientRect(); return { m: [m.width, m.height], go: [go.x, go.y, go.width, go.height] }; })()`);
		ok(g.m[0] === w && g.m[1] === h, `${name}: full screen, got ${g.m}`);
		ok(g.go[0] >= 0 && g.go[1] >= 0 && g.go[0] + g.go[2] <= w + 0.5 && g.go[1] + g.go[3] <= h + 0.5, `${name}: convert button on screen at ${g.go.map((v) => v.toFixed(0))}`);
		const tf = await toolbarFits();
		ok(!tf.out.length && !tf.scrolls, `${name}: every tool bar button on screen, redo included: ${JSON.stringify(tf)}`);
		if (name === "phone") {
			const P = await layout();
			ok(near(P.tools.b, h - 12) && near(P.tools.l + P.tools.w / 2, w / 2) && P.tools.h < 60, `phone: one row floating 12px above the foot, centred: ${JSON.stringify(P.tools)}`);
			ok(near(P.widths.b, P.tools.t - 8) && near(P.widths.l + P.widths.w / 2, w / 2), `phone: the widths just above it: ${JSON.stringify(P.widths)}`);
			ok(P.page.b <= P.widths.t - 8, `phone: the page opens clear of them: page foot ${P.page.b.toFixed(0)}, widths from ${P.widths.t.toFixed(0)}`);
		}
		await button("More");
		const mi = await js(`(() => { const r = document.querySelector('[role=menu]').getBoundingClientRect(), q = [...__pad.tools.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'More').getBoundingClientRect();
			const clear = r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom; return [r.left, r.top, r.right, r.bottom, clear]; })()`);
		ok(mi[0] >= 0 && mi[1] >= 0 && mi[2] <= w && mi[3] <= h && mi[4], `${name}: the ⋯ menu opens on screen, clear of its button: ${mi.map((v) => typeof v === "number" ? v.toFixed(0) : v)}`);
		await shot(name + "-menu");
		await click(w / 2, h / 3);
		await shot(name);
		await button("Close (your writing is kept for next time)");
	}

	ok(!errors.length, "no page errors:\n  " + errors.join("\n  "));
	console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS pad: ${n} checks (screenshots in .test-build/pad-*.png)`);
	quit(bad ? 1 : 0);
} catch (e) {
	console.log("CRASH", e?.stack ?? e);
	if (errors.length) console.log("page errors:\n  " + errors.join("\n  "));
	quit(1);
}
