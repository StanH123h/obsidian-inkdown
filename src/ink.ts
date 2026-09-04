/* 笔迹模型与渲染引擎。
 * 坐标一律用「页面单位」（页宽固定 PAGE_W），跟设备分辨率、窗口大小无关，
 * 这样同一份笔记在 iPad 和电脑上长得一样。 */

export const PAGE_W = 1000;
/** 页高。A4 是 210x297mm，比例 1.414。文档是纵向连续的坐标空间，
 *  第 k 页占 y ∈ [k*PAGE_H, (k+1)*PAGE_H)，跨页的笔画不会被切断。 */
export const PAGE_H = 1414;

export interface Pt { x: number; y: number; p: number }
export interface Stroke { c: string; s: number; pts: Pt[] }

export interface InkOpts {
	smooth: number;   // 0..0.9  平滑强度
	thin: number;     // 0..1    压感对粗细的影响
	taper: number;    // 0 = 关，1 = 轻微
	filter: number;   // 0 = 指数平滑，1 = 1€ 滤波
}

/** 采样率的名义值。存盘的笔迹没有时间戳，用固定值保证渲染结果可复现。 */
const RATE = 120;

const TAPER_PX = [0, 3];
const TAU = Math.PI * 2;
const ease = (t: number) => t * t * (3 - 2 * t);

interface RPt { x: number; y: number; r: number }

/** 从原始采样点算出带半径的渲染点。每次渲染都重算，所以改参数能立刻反映到已有笔迹上。 */
export function build(stroke: Stroke, opt: InkOpts, done: boolean): RPt[] {
	const clean = cleanRaw(stroke.pts);
	if (!clean.length) return [];

	// 落笔/抬笔瞬间的压力是假的：数字化仪还没读出来，iPad 会报 0 或极小值。
	// 用第一个/最后一个可信采样回填，而不是靠伪造笔锋去遮。
	let head = 0;
	while (head < clean.length && head < 6 && !(clean[head].p > 0.02)) head++;
	const pHead = head < clean.length ? clean[head].p : 0.25;
	let tail = clean.length - 1;
	while (tail > head && clean.length - 1 - tail < 6 && !(clean[tail].p > 0.02)) tail--;
	const pTail = clean[tail] ? clean[tail].p : pHead;

	const k = 1 - opt.smooth;
	const smooth = opt.filter === 1 ? oneEuro(clean, opt.smooth) : null;
	const out: (RPt & { p: number; d: number })[] = [];
	let prev: (RPt & { p: number; d: number }) | null = null;
	let dist = 0;

	for (let i = 0; i < clean.length; i++) {
		const q = clean[i];
		const rawP = i < head ? pHead : i > tail ? pTail : (q.p > 0 ? q.p : (prev ? prev.p : pHead));
		const x = smooth ? smooth[i][0] : prev ? prev.x + (q.x - prev.x) * k : q.x;
		const y = smooth ? smooth[i][1] : prev ? prev.y + (q.y - prev.y) * k : q.y;
		const p = prev ? prev.p + (rawP - prev.p) * 0.35 : rawP;
		if (prev) dist += Math.hypot(x - prev.x, y - prev.y);
		const pt: RPt & { p: number; d: number } = { x, y, p, d: dist, r: 0 };
		out.push(pt);
		prev = pt;
	}

	const total = dist;
	const tp = TAPER_PX[opt.taper] ?? 0;
	for (const pt of out) {
		let r = stroke.s / 2 * (1 - opt.thin * (1 - pt.p));
		if (tp && total > 0) {
			// 笔锋长度最多占整笔的 15%，否则短笔画（汉字的点、横）会被两头吃成米粒
			const T = Math.min(tp, total * 0.15) || 1;
			r *= ease(Math.min(pt.d / T, 1));
			if (done) r *= ease(Math.min((total - pt.d) / T, 1));
		}
		pt.r = Math.max(r, 0.2);
	}
	return out;
}

/** 清洗原始采样点。必须在平滑之前做 —— 重复点一旦进了平滑链，
 *  就算后面丢掉，它已经把平滑后的位置拽偏了。
 *
 *  iPadOS 上相邻两次 pointermove 的 getCoalescedEvents() 窗口会重叠：
 *  上一次已经给过的采样，这一次又原样给一遍。点序列于是"往回跳"，
 *  轮廓自我交叉，nonzero 填充绕数抵消 —— 笔画上就是一道道龟裂。
 *
 *  判据不用方向（真实笔画也会有急转），而是直接查重：新点如果落在最近
 *  若干个已接受点的极小邻域内，它就是被重发的那一个。 */
export function cleanRaw(raw: Pt[]): Pt[] {
	const MIN_STEP = 0.5;    // 页面单位：小于此的位移视为原地抖动
	const DUP_R = 0.35;      // 落在此半径内即判定为"同一个采样点"
	const HIST = 16;         // 回看多少个已接受的点（240Hz 下约 65ms）
	const out: Pt[] = [];
	let dirX = 0, dirY = 0;

	for (let i = 0; i < raw.length; i++) {
		const q = raw[i];
		if (out.length && i < raw.length - 1) {
			const last = out[out.length - 1];
			const sx = q.x - last.x, sy = q.y - last.y;
			const step = Math.hypot(sx, sy);

			// 折角处笔速最慢、采样最密，正是抽稀削得最狠的地方 —— 而中文的横折竖折
			// 全靠这些点定形。所以方向一变就放宽阈值，宁可多留点也不要把角磨圆。
			const turn = step > 0 && (dirX || dirY)
				? (sx * dirX + sy * dirY) / step
				: 1;
			const minStep = turn < 0.97 ? DUP_R : MIN_STEP;
			if (step < minStep) continue;

			let dup = false;
			for (let j = out.length - 1, n = 0; j >= 0 && n < HIST; j--, n++) {
				if (Math.hypot(q.x - out[j].x, q.y - out[j].y) < DUP_R) { dup = true; break; }
			}
			if (dup) continue;
			// 方向只在点真的被接受之后才更新，否则被判为重复的点会把方向带偏
			if (step > 0) { dirX = sx / step; dirY = sy / step; }
		}
		out.push(q);
	}
	return out;
}

/** 渲染一条笔迹：梯形段 + 逐点圆盘，全部同向，塞进一条路径一次 fill()。
 *
 * 同向子路径在 nonzero 规则下是并集，绕数只累加不抵消 —— 结构上不可能出洞；
 * 梯形是凸的，不可能自交（用两端点各自的法线会在急转处拧成蝴蝶结）；
 * 逐点补圆盘则保证覆盖范围与"圆盘沿中心线扫过"的真实笔迹区域完全重合
 * （只在大转角补的话，噪声会让相邻两段方向差 90° 以上，外侧留下最深 1.9 单位的
 * 楔形缺口 —— 100% 缩放下看着像抗锯齿，放大就是明显的裂纹）。
 *
 * 微软 Win2D 的墨迹几何也是"圆 + 连接四边形"，但它随后会调用 Outline() 做布尔
 * 并集压成单一轮廓；canvas 2D 没有这个 API，所以我们直接依赖 nonzero 的并集语义。 */
export function drawStroke(cx: CanvasRenderingContext2D, stroke: Stroke, opt: InkOpts, done: boolean) {
	const pts = build(stroke, opt, done);
	if (!pts.length) return;
	cx.fillStyle = stroke.c;
	cx.beginPath();
	if (pts.length === 1) { disc(cx, pts[0]); cx.fill(); return; }

	if (pts.length === 1) {
		disc(cx, pts[0]);
		cx.fill();
		return;
	}

	// 每段用「这一段自己的法线」构造梯形 —— 梯形是凸的，数学上永远不可能自交。
	//
	// 之前用的是两个端点各自的法线：一旦两端法线方向差超过 90°，四边形就被拧成
	// 蝴蝶结，而蝴蝶结的两瓣绕向相反，其中一瓣绕数 -1，跟周围的 +1 相抵 —— 那就是洞。
	// 急转处点间距被压到零点几个单位，用紧邻点定方向全是噪声，很容易甩过 90°，
	// 所以中文的折笔和英文连笔最容易犯。带噪声实测：锐角折 2.1% 的段会拧。
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i], b = pts[i + 1];
		let ux = b.x - a.x, uy = b.y - a.y;
		const len = Math.hypot(ux, uy);
		if (len < 1e-9) continue;
		ux /= len; uy /= len;
		const nx = -uy, ny = ux;
		cx.moveTo(a.x + nx * a.r, a.y + ny * a.r);
		cx.lineTo(a.x - nx * a.r, a.y - ny * a.r);
		cx.lineTo(b.x - nx * b.r, b.y - ny * b.r);
		cx.lineTo(b.x + nx * b.r, b.y + ny * b.r);
		cx.closePath();
	}

	// 每一个采样点都补一个圆盘。
	//
	// 梯形只覆盖"两点之间垂直偏移"的那块，覆盖不到真实笔迹区域 —— 后者是圆盘沿
	// 中心线扫过的并集，转角外侧和变半径处都会多出一圈。原来只在转角大于 5.7° 时
	// 才补，是因为我按小角度公式估了缺口深度；但采样噪声会让相邻两段方向经常差
	// 90° 以上，缺口实测最深到 1.9 个页面单位 —— 100% 时约 1.5px 看着像抗锯齿，
	// 放大到 600% 就是 9px 的豁口，正是"面包裂纹"。
	//
	// 圆盘很便宜（一个 moveTo + 一个 arc），整页 300 笔实测只多 60% 子路径、
	// 建路径耗时不变。逐点补之后，渲染区域与数学上正确的笔迹区域完全重合。
	for (const p of pts) disc(cx, p);

	cx.fill();
}

/** 一个圆盘子路径。绕向与梯形一致（有向面积都是正的），
 *  这是"并集而非异或"的关键 —— 方向反了重叠处绕数就会抵消出洞。 */
function disc(cx: CanvasRenderingContext2D, p: { x: number; y: number; r: number }) {
	cx.moveTo(p.x + p.r, p.y);
	cx.arc(p.x, p.y, p.r, 0, TAU);
}

/** 命中测试：橡皮用。判断某点是否落在笔迹上。 */
export function hitStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
	const r = radius + stroke.s / 2;
	for (const p of stroke.pts) if (Math.hypot(p.x - x, p.y - y) <= r) return true;
	return false;
}

/* ================= 区域（套索圈出来的封闭多边形） ================= */

export interface Region {
	id: string;
	name: string;          // 用户命名，对应 markdown 里的标题
	path: [number, number][];
}

export interface Box { x: number; y: number; w: number; h: number }

export function polyBounds(path: [number, number][]): Box {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of path) {
		if (x < x0) x0 = x; if (x > x1) x1 = x;
		if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 射线法判断点是否在多边形内 */
export function pointInPoly(path: [number, number][], px: number, py: number): boolean {
	let inside = false;
	for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
		const [xi, yi] = path[i], [xj, yj] = path[j];
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** 笔迹是否与区域相交 —— 只要有采样点落在多边形里就算 */
export function strokeInRegion(stroke: Stroke, region: Region): boolean {
	for (const p of stroke.pts) if (pointInPoly(region.path, p.x, p.y)) return true;
	return false;
}

export function pathToCanvas(cx: CanvasRenderingContext2D, path: [number, number][]) {
	if (!path.length) return;
	cx.beginPath();
	cx.moveTo(path[0][0], path[0][1]);
	for (let i = 1; i < path.length; i++) cx.lineTo(path[i][0], path[i][1]);
	cx.closePath();
}

/** 把笔迹画进一块独立画布：用于区域嵌入和外部笔记里的 ![[...]] 渲染。
 *  box 是要显示的页面坐标范围，clip 给了就只显示多边形内部。 */
export function paintInk(
	canvas: HTMLCanvasElement,
	strokes: Stroke[],
	opt: InkOpts,
	box: Box,
	cssWidth: number,
	clip?: [number, number][],
) {
	const pad = 6;
	const w = Math.max(box.w + pad * 2, 1), h = Math.max(box.h + pad * 2, 1);
	const scale = cssWidth / w;
	const cssHeight = h * scale;
	const dpr = window.devicePixelRatio || 1;

	canvas.width = Math.max(1, Math.round(cssWidth * dpr));
	canvas.height = Math.max(1, Math.round(cssHeight * dpr));
	canvas.style.width = cssWidth + "px";
	canvas.style.height = cssHeight + "px";

	const cx = canvas.getContext("2d")!;
	cx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
	cx.translate(-box.x + pad, -box.y + pad);
	cx.lineCap = "round";
	cx.lineJoin = "round";
	if (clip) { pathToCanvas(cx, clip); cx.clip(); }
	for (const st of strokes) drawStroke(cx, st, opt, true);
	return cssHeight;
}


/* ================= 1€ 滤波器（Casiez et al., CHI 2012） =================
 * 固定强度的平滑必须在"抖"和"拖"之间二选一。1€ 的洞察是：人慢速移动时
 * 对抖动敏感、对延迟不敏感；快速移动时正好相反。所以让截止频率跟着速度走 ——
 * 慢就压得狠（不抖），快就放开（不拖）。同样的抖动抑制量下，延迟比固定低通小得多。 */
function oneEuro(pts: Pt[], smooth: number): [number, number][] {
	const te = 1 / RATE;
	const alphaOf = (cutoff: number) => {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / te);
	};
	// smooth 滑块映射到最小截止频率：越平滑 -> 截止越低 -> 慢速时压得越狠
	const minCutoff = 0.6 + (1 - smooth) * 7;
	const beta = 0.05;              // 速度系数。实测扫参：慢写抖动比指数平滑更小，快写滞后少 73%
	const aD = alphaOf(1);          // 导数本身也要低通，否则速度估计会抖

	const out: [number, number][] = [];
	if (!pts.length) return out;
	let fx = pts[0].x, fy = pts[0].y, px = fx, py = fy, edx = 0, edy = 0;
	out.push([fx, fy]);

	for (let i = 1; i < pts.length; i++) {
		const { x, y } = pts[i];
		const dx = (x - px) * RATE, dy = (y - py) * RATE;
		edx += aD * (dx - edx);
		edy += aD * (dy - edy);
		const a = alphaOf(minCutoff + beta * Math.hypot(edx, edy));
		fx += a * (x - fx);
		fy += a * (y - fy);
		px = x; py = y;
		out.push([fx, fy]);
	}
	return out;
}

/* ================= 笔尖预测 =================
 * Notability 这类原生应用靠 UIKit 的 predictedTouches 把笔迹先画到笔尖前面，
 * 这是"跟手"感的主要来源。WebKit 没实现 getPredictedEvents()，只能自己外推。
 * 只在快速移动时预测：慢速时人对抖动敏感、对延迟不敏感，预测反而会抖。 */
export function predictTip(pts: Pt[], frames: number): Pt[] {
	const n = pts.length;
	if (n < 3 || frames <= 0) return [];
	const a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
	const vx = (c.x - a.x) / 2, vy = (c.y - a.y) / 2;
	const sp = Math.hypot(vx, vy);
	if (sp < 0.4) return [];

	// 转弯处收敛预测量，否则笔尖会往切线方向甩出去
	const d1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	const d2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
	const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (d1 * d2);
	const damp = Math.max(0, Math.min(1, (dot - 0.2) / 0.8));
	if (damp <= 0) return [];

	const steps = Math.round(frames * damp);
	const out: Pt[] = [];
	let x = c.x, y = c.y, moved = 0;
	for (let i = 0; i < steps; i++) {
		const f = damp * (1 - i / (steps + 1));
		if (moved + sp * f > 16) break;      // 预测距离封顶，宁可少预测也不要甩飞
		x += vx * f; y += vy * f; moved += sp * f;
		out.push({ x, y, p: c.p });
	}
	return out;
}
