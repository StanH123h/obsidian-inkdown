/* What actually goes over the wire to each service, and how the answer is fitted
 * into the note. Obsidian's requestUrl is replaced by a recorder, so nothing
 * leaves this machine and nothing is billed.
 *
 * What this cannot see: whether the real APIs accept these requests today, and
 * whether a model reads real handwriting well. Both need a run on the device. */
const stub = require('./obsidian-stub.js');
const T = require('../.test-build/transcribe.cjs');

let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('FAIL ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n     got ${JSON.stringify(a)}\n  wanted ${JSON.stringify(b)}`);

/* ---- answer clean-up ---- */
eq(T.unwrapFence('```markdown\n$x^2$\n```'), '$x^2$', 'a fence around everything is removed');
eq(T.unwrapFence('```\n- a\n- b\n```'), '- a\n- b', 'an unlabelled fence around everything is removed');
eq(T.unwrapFence('```mermaid\ngraph TD\nA-->B\n```'), '```mermaid\ngraph TD\nA-->B\n```', 'a lone mermaid block is content, kept');
eq(T.unwrapFence('```\nA\n```\ntext\n```\nB\n```'), '```\nA\n```\ntext\n```\nB\n```', 'two blocks are not one fence');
eq(T.unwrapFence('  plain  '), 'plain', 'plain text is trimmed');

/* ---- fitting into the line ---- */
eq(T.fitInsertion('$x$', 'so ', ' holds'), '$x$', 'inline maths goes in exactly at the cursor');
eq(T.fitInsertion('$$\nx\n$$', 'so ', ''), '\n$$\nx\n$$', 'a block after text starts on a new line');
eq(T.fitInsertion('$$\nx\n$$', '', 'after'), '$$\nx\n$$\n', 'a block before text ends its line');
eq(T.fitInsertion('- a', 'text', ''), '\n- a', 'a one-line list is still a block');
eq(T.fitInsertion('$$x$$', '', ''), '$$x$$', 'a block on an empty line needs nothing');

// A callout ending the insertion must not swallow the note's next line
const callout = '$x$\n\n> [!warning] 可能有误\n> - 第 1 行：符号错了。';
eq(T.fitInsertion(callout, '', '', '下一段正文'), callout + '\n', 'a callout before more text gets a blank line after it');
eq(T.fitInsertion(callout, '', '', ''), callout, 'at the end of the note it needs nothing');
eq(T.fitInsertion(callout, 'so ', ' and', ''), '\n' + callout + '\n\n', 'mid-line, the rest of the line starts a new paragraph');
eq(T.fitInsertion('$$\nx\n$$', '', '', '下一段'), '$$\nx\n$$', 'displayed maths does not swallow anything, so no extra line');

/* ---- where the cursor ends up ---- */
{
  const M = '⏳ 正在识别手写（10:00:00）…';
  const at = (doc) => doc.indexOf(M);
  // Returns the new note with | at the cursor
  const run = (doc, ins, cur = at(doc) + M.length) => {
    const r = T.cursorAfter(doc, at(doc), M.length, ins, cur);
    const out = doc.slice(0, at(doc)) + r.ins + doc.slice(at(doc) + M.length);
    return r.cursor == null ? out : out.slice(0, r.cursor) + '|' + out.slice(r.cursor);
  };
  const block = '$$\nx^2\n$$';
  eq(run('a\n' + M + '\nb', block), 'a\n' + block + '\n|b', 'after a block, the cursor goes to the start of the next line');
  eq(run('a\n' + M, block), 'a\n' + block + '\n|', 'at the end of the note, a line is added for it');
  eq(run('a\n' + M, block + '\n\n> [!warning] 可能有误\n> - x\n'), 'a\n' + block + '\n\n> [!warning] 可能有误\n> - x\n|', 'after a callout with its blank line kept, onto that blank line');
  eq(run('a ' + M, '$x$'), 'a $x$|', 'after inline words, just past them');
  eq(run('a\n' + M + '\nb', block, 0), 'a\n' + block + '\nb', 'a cursor that moved elsewhere is left alone');
  eq(run('a\n' + M + '\nb', block, at('a\n' + M + '\nb')), 'a\n' + block + '\n|b', 'at the start of the placeholder counts as waiting there too');
}

/* ---- context ---- */
const ctx = T.describeSurroundings({ title: '线性代数', before: '定理 1：', after: '' });
ok(ctx.includes('线性代数') && ctx.includes('<before_cursor>\n定理 1：\n</before_cursor>') && !ctx.includes('after_cursor'),
  'context carries the title and the text before the cursor, and omits an empty after');
ok(T.describeSurroundings({ title: 'x', before: ' ', after: '' }).includes('start of the note'), 'an empty note says so');

const PNG = 'iVBORw0KGgo=';
const around = { title: 'Note', before: 'Let', after: '' };
const claude = (model) => ({ provider: 'anthropic', model, apiKey: 'sk-ant-test', baseUrl: '' });
const msg = (over) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: '$a^2+b^2=c^2$' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 20 }, ...over,
});

(async () => {
  /* ---- Claude: the request ---- */
  stub.setResponder(() => ({ body: msg() }));
  const r = await T.recognize(PNG, around, claude('claude-opus-5-5'));
  eq(r.markdown, '$a^2+b^2=c^2$', 'the answer text comes back');
  ok(r.detail.includes('900 in / 20 out'), 'token counts reach the diagnostics');
  eq(stub.calls.length, 1, 'one request');
  const c = stub.calls[0];
  const h = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const body = JSON.parse(c.body);
  eq(c.url, 'https://api.anthropic.com/v1/messages?beta=true', 'beta messages endpoint');
  eq(c.method, 'POST', 'posted');
  // SDK 1.0 sends the API key as a bearer token, no longer as x-api-key
  eq(h['authorization'], 'Bearer sk-ant-test', 'key sent as a bearer token');
  ok((h['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01'), 'fallback beta header');
  eq(body.fallbacks, 'default', 'fallbacks: default');
  eq(body.model, 'claude-opus-5-5', 'model');
  eq(body.output_config, { effort: 'medium' }, 'medium effort');
  ok(!('thinking' in body) && !('temperature' in body), 'no thinking or sampling parameters (both 400 on Opus 5.5)');
  ok(typeof body.system === 'string' && body.system.includes('mermaid') && body.system.includes('LaTeX'), 'system prompt');
  const [img, txt] = body.messages[0].content;
  eq(img, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, 'image first, as base64 png');
  ok(txt.type === 'text' && txt.text.includes('<before_cursor>\nLet\n</before_cursor>'), 'context after the image');
  eq(c.contentType, 'application/json', 'content type passed to requestUrl');

  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, claude('claude-haiku-5-5'));
  const hb = JSON.parse(stub.calls[0].body);
  const hh = Object.fromEntries(Object.entries(stub.calls[0].headers).map(([k, v]) => [k.toLowerCase(), v]));
  ok(!('fallbacks' in hb) && !(hh['anthropic-beta'] || '').includes('fallback'), 'no fallbacks for Haiku');

  /* ---- Claude: what can go wrong ---- */
  const fails = async (respond, want, label) => {
    stub.setResponder(respond);
    try { await T.recognize(PNG, around, { ...claude('claude-opus-5-5') }); ok(false, label + ': did not throw'); }
    catch (e) { ok(e instanceof T.RecognitionError && e.message.includes(want), `${label}: got "${e.message}"`); }
  };
  await fails(() => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }), '401', 'bad key');
  eq(stub.calls.length, 1, 'a 401 is not retried');
  await fails(() => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'image too large' } } }), 'image too large', 'API error message surfaces');
  await fails(() => ({ body: msg({ content: [], stop_reason: 'refusal' }) }), 'declined', 'refusal');
  await fails(() => ({ body: msg({ content: [{ type: 'text', text: '  ' }] }) }), 'no text', 'empty answer');

  /* ---- OpenAI-compatible ---- */
  stub.setResponder(() => ({ body: { model: 'gpt-6-astra', choices: [{ finish_reason: 'stop', message: { content: '```markdown\n- 一\n- 二\n```' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } } }));
  const o = await T.recognize(PNG, around, { provider: 'openai', model: 'gpt-6-astra', apiKey: 'sk-test', baseUrl: 'https://example.com/v1/' });
  eq(o.markdown, '- 一\n- 二', 'openai answer, fence removed');
  const oc = stub.calls[0], ob = JSON.parse(oc.body);
  eq(oc.url, 'https://example.com/v1/chat/completions', 'base url joined without a double slash');
  eq(oc.headers.Authorization, 'Bearer sk-test', 'bearer key');
  eq(ob.messages[0].role, 'system', 'system message first');
  eq(ob.messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }, 'image as a data url');

  stub.setResponder(() => ({ status: 401, body: { error: { message: 'Incorrect API key' } } }));
  try { await T.recognize(PNG, around, { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: '' }); ok(false, 'openai 401 did not throw'); }
  catch (e) { ok(e.message.includes('401'), 'openai 401: ' + e.message); }
  eq(stub.calls[0].url, 'https://api.openai.com/v1/chat/completions', 'empty base url falls back to OpenAI');

  /* ---- maths figures, redrawn by Claude in Python ---- */
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  const drawn = (over = {}) => msg({
    content: [
      { type: 'text', text: 'Let me redraw the parabola.' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'bash_code_execution', input: { command: 'python plot.py && ls "$OUTPUT_DIR"' } },
      { type: 'bash_code_execution_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'bash_code_execution_result', stdout: 'figure-1.svg\n', stderr: '', return_code: 0, content: [{ type: 'bash_code_execution_output', file_id: 'file_fig1' }] } },
      { type: 'text', text: '设 $f(x)=x^2$，图像如下：\n\n{{figure:figure-1.svg}}' },
    ],
    ...over,
  });
  const files = (req, done) => {
    if (req.url.endsWith('/v1/files/file_fig1/content')) return { body: SVG, headers: { 'content-type': 'image/svg+xml' } };
    if (req.url.includes('/v1/files/file_fig1')) return { body: { id: 'file_fig1', type: 'file', filename: 'figure-1.svg', mime_type: 'image/svg+xml', size_bytes: SVG.length, created_at: '2026-10-21T00:00:00Z', downloadable: true } };
    return done();
  };
  stub.setResponder((req) => files(req, () => ({ body: drawn() })));
  const fig = await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: true });
  const fb = JSON.parse(stub.calls[0].body);
  eq(fb.tools, [{ type: 'code_execution_20260521', name: 'code_execution' }], 'figures on: the code execution tool is offered');
  ok(fb.system.includes('matplotlib') && fb.system.includes('OUTPUT_DIR'), 'figures on: the prompt asks for a redraw');
  eq(fig.markdown, '设 $f(x)=x^2$，图像如下：\n\n{{figure:figure-1.svg}}', 'only the text after the last tool call is the answer');
  eq(fig.figures.length, 1, 'the figure comes back');
  eq([fig.figures[0].name, fig.figures[0].ext, new TextDecoder().decode(fig.figures[0].data)], ['figure-1.svg', 'svg', SVG], 'name, type and bytes as saved');
  ok(stub.calls.some((c) => c.url.endsWith('/v1/files/file_fig1/content')), 'downloaded through the files API');

  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: false });
  const nb = JSON.parse(stub.calls[0].body);
  ok(!('tools' in nb) && nb.system.includes('one line in italics') && !nb.system.includes('matplotlib'), 'figures off: no tool, drawings are described');

  // A paused turn is handed back as it is and resumed
  let turn = 0;
  stub.setResponder((req) => files(req, () => ({ body: turn++ === 0 ? drawn({ stop_reason: 'pause_turn', content: drawn().content.slice(0, 3) }) : msg({ content: [{ type: 'text', text: '{{figure:figure-1.svg}}' }] }) })));
  const paused = await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: true });
  const messageCalls = stub.calls.filter((c) => c.url.includes('/v1/messages'));
  eq(messageCalls.length, 2, 'pause_turn: asked again');
  const second = JSON.parse(messageCalls[1].body).messages;
  ok(second.length === 2 && second[1].role === 'assistant' && second[1].content.some((b) => b.type === 'bash_code_execution_tool_result'), 'pause_turn: the turn so far goes back as the assistant message');
  ok(paused.figures.length === 1 && paused.markdown === '{{figure:figure-1.svg}}', 'pause_turn: files from the first part are kept');

  // OpenAI-compatible services never get the redraw prompt
  stub.setResponder(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }));
  await T.recognize(PNG, around, { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: '', figures: true });
  ok(!JSON.parse(stub.calls[0].body).messages[0].content.includes('matplotlib'), 'openai: drawings are described, not redrawn');

  // If the API refuses the request with the tool, the handwriting still comes
  // through, without it
  stub.setResponder((req) => JSON.parse(req.body).tools
    ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'tool not supported here' } } }
    : { body: msg() });
  const degraded = await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: true });
  eq(degraded.markdown, '$a^2+b^2=c^2$', 'a refused tool falls back to plain recognition');
  ok(degraded.detail.includes('code execution off') && degraded.detail.includes('tool not supported here'), 'and the diagnostics say why');

  /* ---- checking the work ---- */
  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: false, check: true });
  const cb = JSON.parse(stub.calls[0].body);
  ok(cb.system.includes('[!warning]') && cb.system.includes('stays exactly as written'), 'check on: asks for a callout and forbids changing the work');
  ok(cb.system.includes('title and all written in the language of the note') && cb.system.includes('with the bullets in English'), 'check: the callout follows the note language, body included, not just the title');
  ok(cb.tools?.length === 1 && cb.system.includes('sympy') && !cb.system.includes('redraw mathematical figures'), 'check alone: code execution offered, for checking only');
  ok(!cb.system.includes('matplotlib'), 'check alone: figures are described, not redrawn');
  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: true, check: true });
  const both = JSON.parse(stub.calls[0].body).system;
  ok(both.includes('redraw mathematical figures and to check a calculation'), 'both on: the tool is for both');
  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: false, check: false });
  const none = JSON.parse(stub.calls[0].body);
  ok(!none.tools && !none.system.includes('[!warning]') && !none.system.includes('code_execution'), 'both off: no tool, no check, no mention of either');
  stub.setResponder(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }));
  await T.recognize(PNG, around, { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: '', figures: true, check: true });
  const op = JSON.parse(stub.calls[0].body).messages[0].content;
  ok(op.includes('[!warning]') && !op.includes('code_execution'), 'openai: checks too, but without a tool to run');
  // Refused with the tool: retried without it, still checking
  stub.setResponder((req) => JSON.parse(req.body).tools
    ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } } }
    : { body: msg() });
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: true, check: true });
  const retry = stub.calls.filter((c) => c.url.includes('/v1/messages'));
  ok(retry.length === 2 && JSON.parse(retry[1].body).system.includes('[!warning]') && !JSON.parse(retry[1].body).tools, 'the retry without the tool keeps checking, and does not loop');

  /* ---- notes written with the AI pen ---- */
  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, { ...around, notes: true }, { ...claude('claude-opus-5-5'), figures: false, check: false });
  const withNotes = JSON.parse(stub.calls[0].body).system;
  ok(withNotes.includes('violet') && withNotes.includes('never transcribe it') && withNotes.includes('[!info]'), 'notes on the page: the prompt explains the violet pen');
  stub.setResponder(() => ({ body: msg() }));
  await T.recognize(PNG, around, { ...claude('claude-opus-5-5'), figures: false, check: false });
  ok(!JSON.parse(stub.calls[0].body).system.includes('violet'), 'no notes: the violet pen is not mentioned at all');
  stub.setResponder(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }));
  await T.recognize(PNG, { ...around, notes: true }, { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: '', figures: false, check: false });
  ok(JSON.parse(stub.calls[0].body).messages[0].content.includes('violet'), 'openai: told about the notes too');

  /* ---- putting figures in place ---- */
  const E = new Map([['figure-1.svg', '![[Note figure 1.svg]]'], ['figure-2.svg', '![[Note figure 2.svg]]']]);
  eq(T.placeFigures('a\n\n{{figure:figure-1.svg}}\n\nb', new Map([...E].slice(0, 1))), 'a\n\n![[Note figure 1.svg]]\n\nb', 'a placeholder becomes the embed');
  eq(T.placeFigures('a {{figure:figure-1.svg}} b', new Map([...E].slice(0, 1))), 'a ![[Note figure 1.svg]] b', 'inline too');
  eq(T.placeFigures('a\n{{figure:figure-1.svg}}', E), 'a\n![[Note figure 1.svg]]\n\n![[Note figure 2.svg]]', 'a figure never placed goes at the end');
  eq(T.placeFigures('a\n{{figure:nope.svg}}\nb', E.size ? new Map() : E), 'a\nb', 'a placeholder with no figure is dropped with its line');

  console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS transcribe: ${n} checks`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
