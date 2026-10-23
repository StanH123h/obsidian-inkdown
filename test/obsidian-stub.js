/* Stands in for the obsidian module when transcribe.ts runs under node. Each
 * test installs its own responder; every request is recorded for inspection.
 *
 * The state lives on globalThis because this file is loaded twice: once
 * bundled into the build under test, once by the test itself. */
const state = globalThis.__hwStub ??= { calls: [], respond: () => { throw new Error('no responder installed'); } };

module.exports = {
  calls: state.calls,
  getLanguage: () => 'en',
  setResponder(fn) { state.respond = fn; state.calls.length = 0; },
  async requestUrl(req) {
    state.calls.push(req);
    const { status = 200, body = {}, headers = { 'content-type': 'application/json' } } = await state.respond(req);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const buf = new TextEncoder().encode(text);
    return { status, headers, text, arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: body };
  },
};
