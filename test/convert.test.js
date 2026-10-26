/* Several conversions at once, as the pane allows: a long page sent, then a
 * short one before the first has come back. Whatever order the answers arrive
 * in, each must replace its own placeholder, so the note ends up exactly as if
 * they had come back one by one.
 *
 * Runs the real convert() from main.ts against a stand-in editor. Requests are
 * held until the test lets them go, so it decides which answer comes first.
 *
 * What this cannot see: CodeMirror itself, which the stand-in imitates (text,
 * cursor, replaceRange moving the cursor along), and timing on the device. */

// rasterize() draws the page on a canvas; under node a stand-in that accepts
// every call will do. CodeMirror, loaded with main.ts for the stand-in caret,
// looks at the document's style when it loads.
const noop = new Proxy(function () {}, { get: () => noop, set: () => true, apply: () => noop });
globalThis.document = {
  documentElement: { style: {} },
  createElement: () => ({ width: 0, height: 0, getContext: () => noop, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }),
};

// The placeholder names the time to the second: the clock is the test's
const RealDate = Date;
let clock = new RealDate(2026, 9, 26, 10, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
};

const stub = require('./obsidian-stub.js');
const Plugin = require('../.test-build/main.cjs').default;

let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('FAIL ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg}\n     got ${JSON.stringify(a)}\n  wanted ${JSON.stringify(b)}`);

/** Text with a cursor, changed the way CodeMirror changes it: a cursor after
 *  a replaced range moves with the text, one inside it goes to its start */
function editor(text) {
  let doc = text, cur = text.length;
  const pos = (off) => { const lines = doc.slice(0, off).split('\n'); return { line: lines.length - 1, ch: lines[lines.length - 1].length }; };
  const off = (p) => doc.split('\n').slice(0, p.line).reduce((o, l) => o + l.length + 1, 0) + p.ch;
  return {
    getValue: () => doc,
    getLine: (i) => doc.split('\n')[i] ?? '',
    lineCount: () => doc.split('\n').length,
    posToOffset: off,
    offsetToPos: pos,
    getCursor: () => pos(cur),
    setCursor: (p) => { cur = off(p); },
    replaceRange(ins, from, to = from) {
      const a = off(from), b = off(to);
      doc = doc.slice(0, a) + ins + doc.slice(b);
      if (cur > b) cur += ins.length - (b - a);
      else if (cur > a) cur = a;
    },
    /** Typing at the cursor */
    type(s) { doc = doc.slice(0, cur) + s + doc.slice(cur); cur += s.length; },
    /** The note with | at the cursor */
    shown: () => doc.slice(0, cur) + '|' + doc.slice(cur),
  };
}

const answer = (text) => ({ body: {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 20 },
} });
const refusal = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
const page = (len) => [{ c: '#000', s: 5, pts: Array.from({ length: len }, (_, i) => ({ x: i, y: 0, p: 0.5 })) }];
const settle = async (cond) => { for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r)); };

/** Send pages one after another into a note that reads "Proof:" with the
 *  cursor after it, then let the answers come back in `order`.
 *  @param replies  what each request gets back, by page
 *  @param sameSecond  send them all within one second
 *  @param between  done to the note after each page is sent but the last
 *  @param waiting  looks at the note once all are sent, before any answer */
async function run(order, { replies = [answer('$$\nA\n$$'), answer('$$\nB\n$$')], sameSecond = false, between, waiting, pad } = {}) {
  const ed = editor('Proof:\n');
  const file = { path: 'Note.md', basename: 'Note' };
  const view = Object.assign(new stub.MarkdownView(), { file, editor: ed, getMode: () => 'source', containerEl: { isConnected: true } });
  const app = {
    workspace: { getLeavesOfType: (type) => (type === 'markdown' ? [{ view }] : []) },
    vault: { process: async () => { throw new Error('the note is open: it must be edited through its editor'); } },
    secretStorage: { getSecret: () => 'sk-ant-test' },
  };
  const plugin = new Plugin(app, { version: 'test' });
  plugin.settings = { ...plugin.settings, anthropicSecret: 'key' };
  if (pad) plugin.shown = pad;
  const held = [];
  stub.setResponder(() => new Promise((resolve) => held.push(resolve)));
  stub.notices.length = 0;
  const jobs = [];
  for (let i = 0; i < replies.length; i++) {
    jobs.push(plugin.convert(view, file, page(i ? 3 : 60)));
    await settle(() => held.length === i + 1);
    if (held.length !== i + 1) throw new Error(`page ${i + 1} sent no request`);
    if (i < replies.length - 1) { between?.(ed); if (!sameSecond) clock += 1000; }
  }
  waiting?.(ed.getValue());
  for (const i of order) { held[i](replies[i]); await jobs[i]; }
  return ed.shown();
}

(async () => {
  /* ---- answers in any order ---- */
  const inOrder = await run([0, 1]);
  eq(inOrder, 'Proof:\n$$\nA\n$$\n$$\nB\n$$\n|', 'one by one: in the order written, the cursor after the last');
  eq(await run([1, 0]), inOrder, 'the short page answered first still lands second');
  let out = '';
  eq(await run([1, 0], { sameSecond: true, waiting: (text) => { out = text; } }), inOrder, 'and so it does when both were sent within the same second');
  ok(/^Proof:\n⏳ Reading handwriting \((\d\d:\d\d:\d\d)\)…⏳ Reading handwriting \(\1 #2\)…$/.test(out), `the placeholders of the same second are numbered apart: ${JSON.stringify(out)}`);

  const three = [answer('$$\nA\n$$'), answer('$$\nB\n$$'), answer('$$\nC\n$$')];
  const threeInOrder = await run([0, 1, 2], { replies: three });
  for (const order of [[2, 1, 0], [1, 2, 0], [2, 0, 1]])
    eq(await run(order, { replies: three, sameSecond: true }), threeInOrder, `three pages answered ${order.map((i) => i + 1).join(', ')}`);

  /* ---- the note changing while they are out ---- */
  // Back to the top of the note before the second page: each answer goes
  // where its own page was sent from
  const top = (ed) => ed.setCursor({ line: 0, ch: 0 });
  const moved = await run([0, 1], { between: top });
  eq(await run([1, 0], { between: top }), moved, 'the cursor moved between pages: answered out of order, still each in its place');
  ok(moved.indexOf('B') < moved.indexOf('Proof:') && moved.indexOf('A') > moved.indexOf('Proof:'), `the second page went to the top, the first after "Proof:": ${JSON.stringify(moved)}`);

  // Typing while the first page is out goes after its placeholder
  const typing = (ed) => ed.type('and ');
  const typed = await run([0, 1], { between: typing });
  eq(await run([1, 0], { between: typing, sameSecond: true }), typed, 'typing between pages: the same note whichever answer comes first');

  /* ---- one of them failing ---- */
  let back = null;
  const pad = { empty: true, setPage: (s) => { back = s; } };
  const failed = await run([1, 0], { replies: [refusal, answer('$$\nB\n$$')], sameSecond: true, pad });
  ok(!failed.includes('⏳') && failed.includes('B') && !failed.includes('A'), `the failed page leaves no placeholder, and the other answer still lands: ${JSON.stringify(failed)}`);
  ok(back?.[0]?.pts.length === 60, 'the failed page, not the other one, goes back on the open pad');
  ok(stub.notices.some((m) => m.startsWith('Recognition failed')), 'and says so');

  console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS convert: ${n} checks`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
