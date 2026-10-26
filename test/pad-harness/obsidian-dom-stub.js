/* Just enough of Obsidian for the pad to run in a plain browser page: the DOM
 * helpers Obsidian adds to every element, a Modal that mounts into <body>, a
 * Scope that keeps the shortcuts registered with it, and a Notice that records
 * what it was asked to show. */
const P = HTMLElement.prototype;
const fill = (el, info) => {
  if (!info) return el;
  if (typeof info === 'string') { el.className = info; return el; }
  if (info.cls) el.className = [].concat(info.cls).join(' ');
  if (info.text != null) el.textContent = info.text;
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, String(v));
  return el;
};
P.createEl = function (tag, info) { const el = fill(document.createElement(tag), info); this.appendChild(el); return el; };
P.createDiv = function (info) { return this.createEl('div', info); };
P.createSpan = function (info) { return this.createEl('span', info); };
P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
P.setText = function (s) { this.textContent = s; };
P.setCssProps = function (props) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); };

class Scope {
  constructor() { this.keys = []; }
  register(mods, key, fn) { const h = { mods, key, fn }; this.keys.push(h); return h; }
  unregister(h) { this.keys = this.keys.filter((k) => k !== h); }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'modal-container';
    // Roughly what Obsidian's stylesheet does to a modal, so the pad has
    // something to override
    this.modalEl = this.containerEl.createDiv({ cls: 'modal', attr: { style: 'position:relative;width:600px;max-width:80vw;max-height:85vh;padding:16px;border-radius:12px;margin:40px auto;' } });
    this.modalEl.createDiv({ cls: 'modal-close-button' });
    this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
    this.scope = new Scope();
  }
  open() { document.body.appendChild(this.containerEl); this.onOpen(); }
  close() { this.onClose(); this.containerEl.remove(); }
  onOpen() {}
  onClose() {}
}
class Notice { constructor(msg) { (window.__notices ||= []).push(String(msg)); } }

module.exports = { Modal, Notice, Scope, requestUrl: async () => { throw new Error('no network in the harness'); } };
