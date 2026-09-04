const { pointInPoly, distToPoly, polyArea } = require('../.test-build/ink.cjs');
// 复刻 regionAt 的规则，验证嵌套/相交下的判定
const pick = (regions, x, y, tol=16) => {
  let inner=null, ia=Infinity, near=null, nd=Infinity;
  for (const g of regions) {
    if (pointInPoly(g.path,x,y)) { const a=polyArea(g.path); if(a<ia){ia=a;inner=g;} }
    else { const d=distToPoly(g.path,x,y); if(d<=tol&&d<nd){nd=d;near=g;} }
  }
  return (inner??near)?.name ?? '未命中';
};
const box=(n,x0,y0,x1,y1)=>({name:n,path:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
const A=box('外圈A',100,100,400,300), B=box('内圈B',180,150,280,250), C=box('旁边小圈C',410,180,450,220);
const R=[A,B,C];                      // A 先创建（旧代码里它会赢）
const t=(x,y,want)=>{const g=pick(R,x,y);console.log(`${g===want?'✅':'❌'} 点(${x},${y}) -> ${g}  期望 ${want}`);};
console.log('嵌套：A 里面套一个 B');
t(230,200,'内圈B');     // 内层中心
t(150,200,'外圈A');     // 在 A 内、B 外
t(95,200,'外圈A');      // A 轮廓外 5 单位
t(230,153,'内圈B');     // 贴着 B 的内边
// 在 B 外 5 单位、在 A 内 —— 规则直接后果："在里面"赢过"在旁边"，选 A
t(230,145,'外圈A');
console.log('\n"在里面"必须优先于"在旁边"');
t(398,200,'外圈A');     // 在 A 内部，但离旁边 C 的轮廓只有 12 单位
console.log('\n完全在外');
t(600,600,'未命中');
console.log('\n幂等性：同一位置点 5 次');
console.log('  ' + [...Array(5)].map(()=>pick(R,230,200)).join(' / '));
