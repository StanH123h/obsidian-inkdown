const { pointInPoly, distToPoly, polyArea } = require('../.test-build/ink.cjs');
// Mirrors the regionAt rule, checking nesting and overlap
const pick = (regions, x, y, tol=16) => {
  let inner=null, ia=Infinity, near=null, nd=Infinity;
  for (const g of regions) {
    if (pointInPoly(g.path,x,y)) { const a=polyArea(g.path); if(a<ia){ia=a;inner=g;} }
    else { const d=distToPoly(g.path,x,y); if(d<=tol&&d<nd){nd=d;near=g;} }
  }
  return (inner??near)?.name ?? 'no hit';
};
const box=(n,x0,y0,x1,y1)=>({name:n,path:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
const A=box('outer A',100,100,400,300), B=box('inner B',180,150,280,250), C=box('nearby small C',410,180,450,220);
const R=[A,B,C];                      // A created first (the old code let it win)
const t=(x,y,want)=>{const g=pick(R,x,y);console.log(`${g===want?'PASS':'FAIL'} point(${x},${y}) -> ${g}  expected ${want}`);};
console.log('Nested: B inside A');
t(230,200,'inner B');     // centre of the inner one
t(150,200,'outer A');     // inside A, outside B
t(95,200,'outer A');      // 5 units outside A's outline
t(230,153,'inner B');     // hugging B's inner edge
// 5 units outside B and inside A -- direct consequence of the rule:
// "inside" beats "next to", so A wins
t(230,145,'outer A');
console.log('\n"inside" must beat "next to"');
t(398,200,'outer A');     // inside A, but only 12 units from C's outline
console.log('\nfully outside');
t(600,600,'no hit');
console.log('\nidempotence: five taps at the same spot');
console.log('  ' + [...Array(5)].map(()=>pick(R,230,200)).join(' / '));
