/* Several conversions at once, as the pane allows: a long page sent, then a
 * short one before the first has come back. Whatever order the answers arrive
 * in, each must replace its own placeholder, so the note ends up exactly as if
 * they had come back one by one. Then, where a result goes under a block
 * that takes in the line under it, a callout say (#31).
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
    setValue: (s) => { doc = s; cur = Math.min(cur, s.length); },
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
 *  cursor after it, or `note` with the cursor at `cursor`, then let the
 *  answers come back in `order`.
 *  @param replies  what each request gets back, by page
 *  @param sameSecond  send them all within one second
 *  @param between  done to the note after each page is sent but the last
 *  @param waiting  looks at the note once all are sent, before any answer
 *  @param meanwhile  done to the note then, after `waiting`
 *  @param close  the note closed then too: the answers go into the file,
 *    and the note comes back without a cursor */
async function run(order, { replies = [answer('$$\nA\n$$'), answer('$$\nB\n$$')], sameSecond = false, between, waiting, meanwhile, close = false, pad, parked, after, note = 'Proof:\n', cursor } = {}) {
  const ed = editor(note);
  if (cursor != null) ed.setCursor(ed.offsetToPos(cursor));
  const file = { path: 'Note.md', basename: 'Note' };
  let mode = 'source';
  const view = Object.assign(new stub.MarkdownView(), { file, editor: ed, getMode: () => mode, containerEl: { isConnected: true } });
  const app = {
    workspace: { getLeavesOfType: (type) => (type === 'markdown' ? [{ view }] : []) },
    vault: { process: async (f, fn) => {
      if (mode === 'source') throw new Error('the note is open: it must be edited through its editor');
      ed.setValue(fn(ed.getValue()));
    } },
    secretStorage: { getSecret: () => 'sk-ant-test' },
  };
  const plugin = new Plugin(app, { version: 'test' });
  plugin.settings = { ...plugin.settings, anthropicSecret: 'key' };
  if (pad) plugin.shown = pad;
  if (parked) plugin.parked = parked;
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
  meanwhile?.(ed);
  if (close) mode = 'preview';
  for (const i of order) { held[i](replies[i]); await jobs[i]; }
  after?.(plugin);
  return close ? ed.getValue() : ed.shown();
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

  // With no pad on screen, it goes into the parked one, or a new parked one;
  // never over a parked page with writing on it
  let kept = null;
  await run([0], { replies: [refusal], after: (p) => { kept = p.parked; } });
  ok(kept?.strokeCount === 1 && kept.strokes[0].pts.length === 60, `no pad open, nothing parked: the failed page is parked for next time (${kept?.strokeCount} strokes)`);
  let over = false;
  await run([0], { replies: [refusal], parked: { empty: false, setPage: () => { over = true; } } });
  ok(!over && stub.notices.some((m) => m.includes('was not put back')), 'a parked page with writing on it is left alone, and the notice says so');

  /* ---- under a block that takes in the line under it (#31) ---- */
  // In Markdown, a line of text straight under a callout, a quote, a list
  // or a table is part of it. With the cursor on the empty line under one,
  // the result goes in after a blank line, outside it, and so does the
  // placeholder while the page is read; the line under them is left as it
  // was. Failing, the note is as it was.
  const below = 'Words below';
  async function under(block, what, { reply = 'Hello', want = 'Hello|\n' + below } = {}) {
    const note = `${block}\n\n${below}`, cursor = block.length + 1;
    let seen = '';
    eq(await run([0], { replies: [answer(reply)], note, cursor, waiting: (t) => { seen = t; } }), `${block}\n\n${want}`, `${what}: the result after a blank line, outside it`);
    ok(/^⏳ Reading handwriting \(\d\d:\d\d:\d\d\)…$/.test(seen.slice(block.length + 2, seen.length - below.length - 1)) && seen.startsWith(block + '\n\n') && seen.endsWith('\n' + below),
      `${what}: the placeholder outside it too, while the page is read: ${JSON.stringify(seen)}`);
    eq(await run([0], { replies: [refusal], note, cursor, pad: { empty: true, setPage() {} } }), `${block}\n|\n${below}`, `${what}: failing, the note as it was`);
  }
  // Every kind of callout Obsidian has, under each of its names
  const kinds = ['note', 'abstract', 'summary', 'tldr', 'info', 'todo', 'tip', 'hint', 'important', 'success', 'check', 'done',
    'question', 'help', 'faq', 'warning', 'caution', 'attention', 'failure', 'fail', 'missing', 'danger', 'error', 'bug', 'example', 'quote', 'cite'];
  for (const k of kinds) await under(`> [!${k}] Title\n> Body`, `a ${k} callout`);
  // and every shape of one
  const shapes = {
    'folded': '> [!note]- Folded\n> Body',
    'foldable, open': '> [!note]+ Open\n> Body',
    'a title only': '> [!note] Only a title',
    'no title text': '> [!note]\n> Body',
    'its kind in capitals': '> [!NOTE] Capitals\n> Body',
    'a kind of its own': '> [!mine] A kind of its own\n> Body',
    'with metadata': '> [!tip|wide] **Bold** title\n> Body',
    'nested': '> [!info] Outer\n> Outer body\n> > [!warning] Inner\n> > Inner body',
    'ending in an empty line of its own': '> [!note] Title\n> Body\n>',
    'with a list in it': '> [!todo] Things\n> - [ ] One thing',
    'with maths in it': '> [!example] Example\n> $$x^2$$',
    'no space after >': '>[!note] No space\n>Body',
    'in a list': '- An item\n  > [!note] In a list\n  > Body',
    'with a line already taken in': '> [!note] Title\n> Body\nHarro',
    'with two lines taken in, as in the test note': '> [!tip] Tip\n> The callout body\nHarro\nHello',
  };
  for (const [shape, block] of Object.entries(shapes)) await under(block, `a callout, ${shape}`);
  // The same for whatever else takes in the line under it. What decides
  // is the paragraph above the cursor, not only its last line: a line with
  // no > or - of its own is still in the block it was carried on into.
  const others = {
    'a quote': '> A quote',
    'a list': '- An item',
    'a list with *': '* An item',
    'a list with +': '+ An item',
    'a numbered list': '1. An item',
    'a numbered list with )': '1) An item',
    'a task list': '- [ ] To do',
    'a nested list': '- An item\n  - A sub-item',
    'a list item over two lines': '- Shopping: tomatoes, eggs\n  and spring onions',
    'a line taken into a list': '- An item\nHello',
    'a line taken into a quote': '> A quote\nmore',
    'a line taken into a table': '| Name | Number |\n| ---- | ---- |\n| A | 1 |\nHello',
    'a table': '| Name | Number |\n| ---- | ---- |\n| A | 1 |',
  };
  for (const [what, block] of Object.entries(others)) await under(block, what);
  // Whatever the result is: the line above decides, not the result
  const callout = '> [!tip] Tip\n> Body';
  await under(callout, 'a list as the result', { reply: '- A new item', want: '- A new item\n|\n' + below });
  await under(callout, 'a callout as the result', { reply: '> [!note] New\n> Its body', want: '> [!note] New\n> Its body\n|\n' + below });
  await under(callout, 'displayed maths as the result', { reply: '$$\nx\n$$', want: '$$\nx\n$$\n|' + below });
  // Under the last line of the note
  let atEnd = '';
  eq(await run([0], { replies: [answer('Hello')], note: callout + '\n', cursor: callout.length + 1, waiting: (t) => { atEnd = t; } }), callout + '\n\nHello|', 'under a callout at the end of the note: the same');
  ok(atEnd.startsWith(callout + '\n\n⏳'), `and its placeholder: ${JSON.stringify(atEnd)}`);
  eq(await run([0], { replies: [refusal], note: callout + '\n', cursor: callout.length + 1, pad: { empty: true, setPage() {} } }), callout + '\n|', 'failing there, the note as it was');
  // Once the placeholder is in, the note is the user's: the result goes
  // wherever the placeholder is then, and nothing is put right after it
  const note = `${callout}\n\n${below}`, cursor = callout.length + 1;
  const tight = (ed) => ed.setValue(ed.getValue().replace('\n\n⏳', '\n⏳'));
  eq((await run([0], { replies: [answer('Hello')], note, cursor, meanwhile: tight })).replace('|', ''), `${callout}\nHello\n${below}`,
    'the blank line taken out while the page is read: the result where the placeholder is, the blank line not put back');
  eq((await run([0], { replies: [refusal], note, cursor, meanwhile: tight, pad: { empty: true, setPage() {} } })).replace('|', ''), `${callout}\n\n${below}`,
    'failing then: only the placeholder goes, the callout\'s own line break stays');
  const elsewhere = (ed) => { const m = ed.getValue().match(/⏳[^\n]*…/)[0]; ed.setValue(ed.getValue().replace(m, '') + m); };
  eq((await run([0], { replies: [answer('Hello')], note, cursor, meanwhile: elsewhere })).replace('|', ''), `${callout}\n\n\n${below}Hello`,
    'the placeholder moved to the end of the note: the result there, the line it left as it was');
  eq(await run([0], { replies: [answer('Hello')], note, cursor, close: true }), `${callout}\n\nHello\n${below}`,
    'the note closed while the page is read: the result into the file, where the placeholder is');
  eq(await run([0], { replies: [refusal], note, cursor, close: true, pad: { empty: true, setPage() {} } }), note, 'failing then: the file as it was');

  // The rest as it was. | is the cursor.
  const same = async (shown, want, what) => eq(await run([0], { replies: [answer('Hello')], note: shown.replace('|', ''), cursor: shown.indexOf('|') }), want, what);
  await same(`Plain text\n|\n${below}`, `Plain text\nHello|\n${below}`, 'under plain text: no blank line, as before');
  await same(`${callout}\n\n|\n${below}`, `${callout}\n\nHello|\n${below}`, 'a blank line under the callout already: no second one');
  await same(`> [!note] Title\n> The bo|dy\n\n${below}`, `> [!note] Title\n> The boHello|dy\n\n${below}`, 'in the middle of a callout\'s text: in it, as before');
  await same(`${callout}|\n\n${below}`, `${callout}Hello|\n\n${below}`, 'at the end of its last line, which is in it: as before, not this issue');
  await same(`${callout}\n|Harro`, `${callout}\nHello|Harro`, 'at the start of a line it has taken in: in it, as before');
  await same(`# A heading\n|\n${below}`, `# A heading\nHello|\n${below}`, 'under a heading: no blank line');
  await same('```md\n- not a list\n> not a quote\n```\n|\n' + below, '```md\n- not a list\n> not a quote\n```\nHello|\n' + below, 'under a code block, whatever its lines look like: no blank line');
  await same(`$$\nx\n$$\n|\n${below}`, `$$\nx\n$$\nHello|\n${below}`, 'under displayed maths: no blank line');
  await same('$$\n- x + 1\n$$\n|\n' + below, '$$\n- x + 1\n$$\nHello|\n' + below, 'under displayed maths, whatever its lines look like: no blank line');
  await same(`Plain text\na second line\n|\n${below}`, `Plain text\na second line\nHello|\n${below}`, 'under a plain paragraph over two lines: no blank line');
  await same(`${callout}\n\nPlain text\n|\n${below}`, `${callout}\n\nPlain text\nHello|\n${below}`, 'under a plain paragraph after a callout, a blank line between: no blank line');
  await same(`> A quote\n# A heading\n|\n${below}`, `> A quote\n# A heading\nHello|\n${below}`, 'under a heading straight after a quote, which ends it: no blank line');

  console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS convert: ${n} checks`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
