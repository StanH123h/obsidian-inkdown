/* Settings as loadSettings() reads them from data.json: an older plugin's,
 * a damaged one, none at all. Only the pens' widths for now.
 *
 * Runs the real loadSettings() from main.ts, with data.json stood in for. */

// main.ts reaches for a document as it loads; nothing here draws
global.document = { documentElement: { style: {} } };

const Plugin = require('../.test-build/main.cjs').default;

let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('FAIL ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n     got ${JSON.stringify(a)}\n  wanted ${JSON.stringify(b)}`);

async function load(stored) {
  const plugin = new Plugin({}, { version: 'test' });
  plugin.loadData = async () => stored;
  await plugin.loadSettings();
  return plugin.settings;
}

(async () => {
  // Nothing saved yet: each pen gets the defaults, the middle width in use
  let s = await load(null);
  eq([s.sizes, s.aiSizes, s.sizeIdx, s.aiSizeIdx], [[4, 8, 14], [4, 8, 14], 1, 1], 'a first run: both pens at the defaults, the middle width');

  // Saved by an older plugin, whose two pens shared one set: the pen keeps
  // it, the AI pen starts from it
  s = await load({ sizes: [3, 9, 20] });
  eq([s.sizes, s.aiSizes, s.sizeIdx, s.aiSizeIdx], [[3, 9, 20], [3, 9, 20], 1, 1], 'from an older plugin: the AI pen starts from the pen\'s widths');
  s.aiSizes[0] = 5;
  eq(s.sizes[0], 3, 'and they are two sets: changing one leaves the other');

  // Each pen's own, as saved
  s = await load({ sizes: [3, 9, 20], aiSizes: [2, 6, 11], sizeIdx: 2, aiSizeIdx: 0 });
  eq([s.sizes, s.aiSizes, s.sizeIdx, s.aiSizeIdx], [[3, 9, 20], [2, 6, 11], 2, 0], 'each pen\'s widths and the one in use come back as saved');

  // Damaged: a bad width falls back to the pen's, a bad choice to the middle
  s = await load({ sizes: [3, 9, 20], aiSizes: [2, 'x', 40], sizeIdx: 7, aiSizeIdx: '1' });
  eq([s.aiSizes, s.sizeIdx, s.aiSizeIdx], [[2, 9, 20], 1, 1], 'a damaged data.json: bad widths and choices fall back');

  // The defaults themselves are never edited through a loaded setting
  s = await load(null);
  s.sizes[0] = 7; s.aiSizes[0] = 7;
  s = await load(null);
  eq([s.sizes[0], s.aiSizes[0]], [4, 4], 'editing a loaded width leaves the defaults alone');

  console.log(bad ? `\n${bad} of ${n} checks failed` : `PASS settings: ${n} checks`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('CRASH', e.stack); process.exit(1); });
