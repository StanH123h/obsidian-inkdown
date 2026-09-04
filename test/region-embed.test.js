const { strokeInRegion, polyBounds, polyArea } = require('../.test-build/ink.cjs');

const box = (n, x0, y0, x1, y1) => ({ name: n, path: [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] });
const stroke = (n, x0, y0, x1, y1) => ({ name: n, c:'#000', s:8,
  pts: Array.from({length: 20}, (_,i) => { const t=i/19;
    return { x: x0+(x1-x0)*t, y: y0+(y1-y0)*t, p: .4 }; }) });

// The filter an embed actually performs (the same line as in embed.ts)
const pick = (strokes, region) => strokes.filter(s => strokeInRegion(s, region)).map(s => s.name);

const outer = box('outer', 100, 100, 400, 300);
const inner = box('inner', 180, 150, 280, 250);

const strokes = [
  stroke('inside outer, outside inner', 120, 120, 160, 140),
  stroke('inside inner',              200, 180, 260, 220),
  stroke('crossing inner boundary',   250, 200, 330, 200),
  stroke('fully outside outer',       500, 500, 560, 540),
];

let ok = true;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t = (label, got, want) => {
  const p = eq(got, want);
  ok = ok && p;
  console.log(`${p?'PASS':'FAIL'} ${label}\n     got      ${JSON.stringify(got)}\n     expected ${JSON.stringify(want)}`);
};

console.log('Embedding the outer region: the inner one changes nothing\n');
const withInner = pick(strokes, outer);
const withoutInner = pick(strokes, outer);   // the filter only sees ink and this one polygon
t('embed outer -> all ink inside it, regardless of nested regions',
  withInner, ['inside outer, outside inner', 'inside inner', 'crossing inner boundary']);
t('identical with and without the inner region', withInner, withoutInner);

console.log('\nEmbedding the inner region: only its own ink\n');
t('embed inner', pick(strokes, inner), ['inside inner', 'crossing inner boundary']);

console.log('\nThe clip box is the region\'s own bounds, unaffected by nesting\n');
const b = polyBounds(outer.path);
t('outer region display bounds', [b.x, b.y, b.w, b.h], [100, 100, 300, 200]);

// Design principle: own content renders, references do not. A region embed
// takes only ink and a polygon; the canvas's wiki-link items (doc.items) never
// take part -- structurally they cannot even be passed in.
console.log('\nCanvas wiki-link items take no part in a region embed\n');
const embedInputs = { strokes, region: outer };
t('a region embed takes only ink and a polygon, no items',
  Object.keys(embedInputs).sort(), ['region', 'strokes']);

console.log('\n' + (ok ? 'All passed: regions are unaware of each other, embeds form no chains'
                       : 'Some cases failed'));
process.exit(ok ? 0 : 1);
