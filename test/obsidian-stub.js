/* Stands in for the obsidian module when transcribe.ts runs under node. Each
 * test installs its own responder; every request is recorded for inspection.
 *
 * The state lives on globalThis because this file is loaded twice: once
 * bundled into the build under test, once by the test itself. */
const state = globalThis.__hwStub ??= { calls: [], respond: () => { throw new Error('no responder installed'); } };

/* Enough of the rest for main.ts to load under node, for convert.test.js: the
 * classes it builds on, and a MarkdownView kept on globalThis like the state,
 * so that the bundle's instanceof checks recognise the test's views. Notices
 * are recorded. */
state.MarkdownView ??= class MarkdownView {};
state.notices ??= [];
class Modal { constructor(app) { this.app = app; } open() {} close() {} }
class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
class PluginSettingTab {}
class ItemView {}
class Scope { register() { return {}; } unregister() {} }
class Notice { constructor(msg) { state.notices.push(String(msg)); } }

module.exports = {
  Modal, Plugin, PluginSettingTab, ItemView, Scope, Notice,
  MarkdownView: state.MarkdownView,
  Platform: { isMobile: false, isPhone: false },
  notices: state.notices,
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
