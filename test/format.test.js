/* Guards the on-disk format: saving is idempotent, a round trip loses nothing,
 * and files written by the older format still open. */
const { serialize, parse } = require('../.test-build/fmt.cjs');
const { finalizeStroke } = require('../.test-build/ink.cjs');

let bad = 0;
const t = (label, pass, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  if (!pass) bad++;
};

// A stroke as it exists after the pen lifts
function stroke(cx, cy) {
  const a = Math.random() * 6.28, len = 12 + Math.random() * 18;
  const n = Math.round(len / 0.35), pts = [];
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    pts.push({ x: cx + Math.cos(a) * len * k + Math.sin(k * 6) * 1.5,
               y: cy + Math.sin(a) * len * k + Math.cos(k * 5) * 1.5,
               p: 0.25 + Math.sin(k * 3) * 0.15 });
  }
  return finalizeStroke({ c: '#1a1a1a', s: 8, pts });
}
const strokes = [];
for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) strokes.push(stroke(60 + c * 43, 60 + r * 55));

const doc = {
  title: '化学 Lec5', strokes,
  items: [{ id: 'a', x: 1.5, y: 2.5, w: 360, target: '反应#机理', embed: true }],
  regions: [{ id: 'r', name: '机理图', path: [[1, 2], [3, 4], [5, 6]] }],
};

const md1 = serialize(doc);
const p1 = parse(md1);
const md2 = serialize(p1);
const p2 = parse(md2);
const ink = (s) => s.slice(s.indexOf('%%ink'));
const flat = (d) => d.strokes.flatMap((s) => s.pts.map((p) => `${p.x},${p.y},${p.p}`)).join('|');

t('saving is idempotent (byte for byte)', ink(md1) === ink(md2));
t('stroke count survives', p1.strokes.length === p2.strokes.length, `${p1.strokes.length}`);
t('every sample survives', flat(p1) === flat(p2), `${p1.strokes.reduce((a, s) => a + s.pts.length, 0)} points`);
t('regions survive', JSON.stringify(p1.regions) === JSON.stringify(p2.regions));
t('items survive', JSON.stringify(p1.items) === JSON.stringify(p2.items));
t('title survives', p2.title === '化学 Lec5');
t('region heading is in the markdown body', /^### 机理图$/m.test(md1));
t('link is in the markdown body', /^- !\[\[反应#机理\]\]$/m.test(md1));
t('ink block is v2 and packed', /"v":2/.test(md1) && /"z":"/.test(md1));
t('packing is worth it', md1.length < 0.4 * JSON.stringify(strokes).length,
  `${(md1.length / 1024).toFixed(0)} KB vs ${(JSON.stringify(strokes).length / 1024).toFixed(0)} KB raw`);

// Files written before the change
const v1 = `---
handwriting: v1
---
# old file

%%ink
{"v":1,"w":1000,"strokes":[{"c":"#c0392b","s":14,"pts":[[10,20,0.3],[11.5,21,0.35],[13,22.5,0.4]]}],"items":[],"regions":[{"id":"q","name":"旧区域","path":[[0,0],[9,0],[9,9]]}]}
%%
`;
const old = parse(v1);
t('v1 files still open', old.strokes.length === 1 && old.strokes[0].pts.length === 3,
  `colour ${old.strokes[0].c}, width ${old.strokes[0].s}`);
t('v1 regions survive', old.regions[0].name === '旧区域');
const migrated = parse(serialize(old));
t('v1 is rewritten as v2 without loss',
  /"v":2/.test(serialize(old)) && migrated.strokes[0].pts.length === 3);

console.log(bad ? `\n${bad} problem(s)` : '\nPASS format: v2 round trip and v1 migration');
process.exit(bad ? 1 : 0);
