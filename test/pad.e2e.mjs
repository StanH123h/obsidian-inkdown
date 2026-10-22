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
	await button("Whole page / page width");
	s = await state();
	ok(s.zoom === 1, "fit resets the zoom");

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

	/* ---- other shapes of screen ---- */
	for (const [w, h, name] of [[1180, 820, "landscape"], [390, 844, "phone"]]) {
		await viewport(w, h);
		await js(`openPad(${JSON.stringify([])})`);
		await new Promise((r) => setTimeout(r, 300));
		const g = await js(`(() => { const m = document.querySelector('.modal').getBoundingClientRect(); const go = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Turn this into Markdown at the cursor').getBoundingClientRect(); return { m: [m.width, m.height], go: [go.x, go.y, go.width, go.height] }; })()`);
		ok(g.m[0] === w && g.m[1] === h, `${name}: full screen, got ${g.m}`);
		ok(g.go[0] >= 0 && g.go[1] >= 0 && g.go[0] + g.go[2] <= w + 0.5 && g.go[1] + g.go[3] <= h + 0.5, `${name}: convert button on screen at ${g.go.map((v) => v.toFixed(0))}`);
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
