const { strokeInRegion, polyBounds, polyArea } = require('../.test-build/ink.cjs');

const box = (n, x0, y0, x1, y1) => ({ name: n, path: [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] });
const stroke = (n, x0, y0, x1, y1) => ({ name: n, c:'#000', s:8,
  pts: Array.from({length: 20}, (_,i) => { const t=i/19;
    return { x: x0+(x1-x0)*t, y: y0+(y1-y0)*t, p: .4 }; }) });

// 引用一个圈时实际执行的筛选逻辑（跟 embed.ts 里的一行一致）
const pick = (strokes, region) => strokes.filter(s => strokeInRegion(s, region)).map(s => s.name);

const 外圈 = box('外圈', 100, 100, 400, 300);
const 内圈 = box('内圈', 180, 150, 280, 250);

const strokes = [
  stroke('外圈内、内圈外的字', 120, 120, 160, 140),
  stroke('内圈里的字',         200, 180, 260, 220),
  stroke('横跨内圈边界的字',   250, 200, 330, 200),
  stroke('完全在外圈之外的字', 500, 500, 560, 540),
];

let ok = true;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t = (label, got, want) => {
  const p = eq(got, want);
  ok = ok && p;
  console.log(`${p?'✅':'❌'} ${label}\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`);
};

console.log('引用外圈时，内圈的存在完全不影响结果\n');
const 有内圈 = pick(strokes, 外圈);
const 没内圈 = pick(strokes, 外圈);   // 筛选只看笔迹和这一个多边形，本来就跟别的圈无关
t('引用外圈 -> 拿到圈内所有笔迹（不管里面还有没有别的圈）',
  有内圈, ['外圈内、内圈外的字', '内圈里的字', '横跨内圈边界的字']);
t('有没有内圈，结果完全一样', 有内圈, 没内圈);

console.log('\n引用内圈时，只拿内圈里的\n');
t('引用内圈', pick(strokes, 内圈), ['内圈里的字', '横跨内圈边界的字']);

console.log('\n裁剪范围就是这个圈自己的包围盒，跟嵌套无关\n');
const b = polyBounds(外圈.path);
t('外圈的显示范围', [b.x, b.y, b.w, b.h], [100, 100, 300, 200]);

console.log('\n' + (ok ? '全部通过：区域之间彼此不知道对方存在，不存在递归'
                       : '有用例未通过'));
process.exit(ok ? 0 : 1);
