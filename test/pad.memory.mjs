/* What a closed pad leaves in memory, measured in headless Chrome.
 *
 *   npm run test:pad            (runs after pad.e2e.mjs; needs Google Chrome)
 *
 * A closed pad is kept for next time, so whatever it still holds stays held.
 * The big part is the canvases: two of them, at the screen's full pixel
 * size, about 14 MB each on an iPad. Chrome's memory-infra dump counts canvas
 * memory exactly, by allocation rather than by sampling, so the numbers here
 * do not drift from run to run the way the process's resident size does.
 *
 * What this cannot see: iPadOS WebKit, which has its own limit on canvas
 * memory across a page. The canvases are let go of the same way there. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9833 + Math.floor(Math.random() * 500);
const WARM = 3, CYCLES = 10;

let bad = 0, n = 0;
let last = "starting";
const ok = (cond, msg) => { n++; last = msg.split("\n")[0]; if (!cond) { bad++; console.log("FAIL " + msg); } };
setTimeout(() => { console.log(`HUNG after: ${last}`); quit(2); }, 150000).unref();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hw-mem-"));
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

/* ---- a minimal DevTools client: the page, and the browser for tracing ---- */
async function open(url) {
	const ws = new WebSocket(url);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let seq = 0;
	const waiting = new Map(), events = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
		else if (m.method) events.push(m);
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++seq;
		waiting.set(id, (m) => (m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result)));
		ws.send(JSON.stringify({ id, method, params }));
	});
	return { send, events };
}
let page, browser;
async function connect() {
	for (let i = 0; i < 50 && !page; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			const p = list.find((t) => t.type === "page");
			if (p) page = await open(p.webSocketDebuggerUrl);
		} catch { /* not up yet */ }
		if (!page) await new Promise((r) => setTimeout(r, 200));
	}
	if (!page) throw new Error("Chrome did not come up");
	const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	browser = await open(webSocketDebuggerUrl);
}
const js = async (expr) => {
	last = "js: " + expr.replace(/\s+/g, " ").slice(0, 80);
	const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	return r.result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
const click = async (x, y) => {
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await frame();
};
const button = async (label) => {
	const r = await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	if (!r) throw new Error("no button " + label);
	await click(r[0], r[1]);
};
const pen = async (x0, y, x1) => {
	const steps = 24;
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.5 });
	for (let i = 1; i <= steps; i++)
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / steps, y, button: "left", buttons: 1, pointerType: "pen", force: 0.5 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
	await frame();
};
const CLOSE = "Close (your writing is kept for next time)";

/* ---- measuring ---- */
const gc = async () => {
	for (let i = 0; i < 3; i++) await page.send("HeapProfiler.collectGarbage");
	await wait(200);
};
/** Canvas memory in the whole browser, in MB, and how many canvases hold it */
async function canvasMemory() {
	await gc();
	browser.events.length = 0;
	await browser.send("Tracing.start", {
		traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] } },
		transferMode: "ReturnAsStream",
	});
	const dump = await browser.send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" });
	if (!dump.success) throw new Error("memory dump failed");
	await browser.send("Tracing.end");
	let done;
	for (let i = 0; i < 100 && !(done = browser.events.find((e) => e.method === "Tracing.tracingComplete")); i++) await wait(50);
	if (!done) throw new Error("tracing did not finish");
	let text = "";
	for (;;) {
		const r = await browser.send("IO.read", { handle: done.params.stream, size: 1 << 20 });
		text += r.base64Encoded ? Buffer.from(r.data, "base64").toString() : r.data;
		if (r.eof) break;
	}
	await browser.send("IO.close", { handle: done.params.stream });
	const trace = JSON.parse(text);
	let bytes = 0, canvases = 0;
	for (const e of trace.traceEvents ?? trace) {
		if (e.ph !== "v") continue;
		const al = e.args?.dumps?.allocators ?? {};
		if (al.canvas) bytes += parseInt(al.canvas.attrs.size.value, 16);
		canvases += Object.keys(al).filter((k) => /^canvas\/ResourceProvider_[^/]+$/.test(k)).length;
	}
	return { mb: bytes / 1048576, canvases };
}
/** Live DOM nodes, attached or not, event listeners, and the JS and DOM
 *  heaps, in KB */
async function heap() {
	await gc();
	const { nodes, jsEventListeners } = await page.send("Memory.getDOMCounters");
	const h = await page.send("Runtime.getHeapUsage");
	return { nodes, listeners: jsEventListeners, js: h.usedSize / 1024, dom: (h.embedderHeapUsedSize ?? 0) / 1024 };
}
/** A fingerprint of what the page canvas shows */
const picture = () => js(`(() => { const c = __pad.base, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
	let h = 0, ink = 0; for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3]) | 0; if (d[i + 3] && d[i] < 128) ink++; }
	return { size: [c.width, c.height], h, ink }; })()`);
const fmt = (m) => `${m.mb.toFixed(1)} MB in ${m.canvases} canvases`;

try {
	await connect();
	await page.send("Runtime.enable");
	await page.send("HeapProfiler.enable");
	// An iPad in landscape, at its pixel density: the canvases are as big as there
	await page.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true });
	await page.send("Page.navigate", { url: "file://" + path.join(here, "pad-harness", "harness.html") });
	for (let i = 0; i < 50 && !(await js("typeof openPad === 'function'").catch(() => false)); i++) await wait(100);

	const blank = await canvasMemory();
	ok(blank.mb < 0.5, `nothing on the page holds canvas memory to start with: ${fmt(blank)}`);

	await js("openPad([])");
	await frame();
	for (const y of [300, 360, 420]) await pen(150, y, 500);
	const opened = await canvasMemory();
	ok(opened.canvases === 2 && opened.mb > 10, `the measure sees the open pad's two canvases: ${fmt(opened)}`);
	// Drawn afresh, the way a mount draws it: strokes drawn as they were
	// written blend at their edges a shade differently
	await js("__pad.redrawAll()");
	const before = await picture();

	// Closed, the pad stays referenced, as the plugin keeps it parked
	await button(CLOSE);
	const parked = await canvasMemory();
	ok(parked.mb < 0.5, `a closed pad holds no canvas memory: ${fmt(parked)} (open: ${fmt(opened)})`);

	await js("reopenPad()");
	await frame();
	const after = await picture();
	ok(after.ink > 1000 && after.h === before.h && after.size.join() === before.size.join(), `opened again, the page looks as it did: ${JSON.stringify(after)} (was ${JSON.stringify(before)})`);
	const again = await canvasMemory();
	ok(again.canvases === 2, `and only its new canvases are alive: ${fmt(again)}`);
	await button(CLOSE);

	// Round and round: open, into the pane, close there; open, close. The
	// first few rounds warm up: the browser compiles code as it is first run,
	// a hundred KB or so. A leak goes on growing after that; compiled code
	// grows in small steps, under 40 KB in ten rounds as measured.
	const round = async () => {
		await js("reopenPad([590, 820])");
		await frame();
		await button("Open beside the note");
		await wait(150);
		await button(CLOSE);
		await js("reopenPad()");
		await frame();
		await button(CLOSE);
	};
	for (let i = 0; i < WARM; i++) await round();
	const once = await heap();
	for (let i = 0; i < CYCLES; i++) await round();
	const cycled = await canvasMemory();
	ok(cycled.mb < 0.5, `after ${WARM + CYCLES} rounds of opening, moving and closing, still none: ${fmt(cycled)}`);
	const later = await heap();
	ok(later.nodes === once.nodes && later.listeners === once.listeners, `the DOM and its listeners do not grow round by round: ${once.nodes} nodes, ${once.listeners} listeners → ${later.nodes}, ${later.listeners} after ${CYCLES} more rounds`);
	ok(later.js - once.js < 100 && later.dom - once.dom < 100, `nor do the heaps: JS ${once.js.toFixed(0)} → ${later.js.toFixed(0)} KB, DOM ${once.dom.toFixed(0)} → ${later.dom.toFixed(0)} KB`);

	// Dropped altogether, as when a conversion takes the page: nothing left
	await js("__pad = null; __modalScope = null; __paneScope = null");
	const gone = await canvasMemory();
	const empty = await heap();
	ok(gone.mb < 0.5, `a pad let go of leaves no canvas memory: ${fmt(gone)}`);
	console.log(`  memory: open ${fmt(opened)}, parked ${fmt(parked)}; nodes ${once.nodes} parked, ${empty.nodes} with no pad; JS heap ${once.js.toFixed(0)} → ${later.js.toFixed(0)} KB over ${CYCLES} rounds`);

	console.log(bad ? `FAIL memory: ${bad} of ${n} checks failed` : `PASS memory: ${n} checks`);
	quit(bad ? 1 : 0);
} catch (e) {
	console.log(`CRASH memory after "${last}": ${e.stack ?? e}`);
	quit(2);
}
