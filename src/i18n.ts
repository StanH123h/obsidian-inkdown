/* Two languages: English and Chinese.
 *
 * Which one is used follows the user's Obsidian display language, falling back
 * to the browser locale, and anything that is not Chinese gets English. The
 * setting can also pin one explicitly.
 *
 * Not translated on purpose:
 *   - the diagnostics panel, which is a debugging tool rather than a feature
 *   - the "## regions" / "## links" sections generated into notes, which stay
 *     in English so a file means the same thing whoever opens it
 */

export type Lang = "en" | "zh";

const STR = {
	/* toolbar */
	"tool.pen": ["Pen", "笔"],
	"tool.eraser": ["Eraser", "橡皮"],
	"tool.lasso": ["Lasso: select content", "套索：圈选内容"],
	"tool.wiki": ["Wiki lasso: name an area so [[note#area]] can reference it", "Wiki 套索：圈一块内容并命名，供 [[笔记#区域]] 引用"],
	"tool.fit": ["Fit page width (reset zoom)", "适应页宽（重置缩放）"],
	"tool.link": ["Insert wiki link", "插入 wiki 链接"],
	"tool.undo": ["Undo", "撤销"],
	"tool.source": ["View markdown source", "看 Markdown 源码"],

	/* context bar */
	"ctx.color": ["Colour", "颜色"],
	"ctx.penWidth": ["Pen width {0}", "笔宽 {0}"],
	"ctx.eraseStroke": ["Whole", "整笔"],
	"ctx.erasePrecise": ["Precise", "精确"],

	/* commands */
	"cmd.newNote": ["New handwriting note", "新建手写笔记"],
	"cmd.toggleSource": ["Toggle handwriting view / markdown source", "手写视图 / Markdown 源码 切换"],
	"cmd.migrate": ["Migrate: rename .hw.md to .md", "迁移：把 .hw.md 重命名为 .md"],
	"cmd.diagnostics": ["Diagnostics (for troubleshooting on mobile)", "诊断信息（移动端排查用）"],

	/* notices */
	"notice.nothingToUndo": ["Nothing to undo", "没有可撤销的操作"],
	"notice.createFailed": ["Could not create the note: {0}", "新建失败：{0}"],
	"notice.created": ["Created in {0}", "已创建于 {0}"],
	"notice.nothingToMigrate": ["No .hw.md files to migrate", "没有 .hw.md 文件需要迁移"],
	"notice.migrated": ["Migrated {0} of {1} files", "已迁移 {0} / {1} 个文件"],
	"notice.regionCreated": ["Area \"{0}\" created; reference it with [[{1}#{0}]]", "已创建区域「{0}」，可用 [[{1}#{0}]] 引用"],
	"notice.regionDeleted": ["Deleted the area \"{0}\"", "已删除区域「{0}」"],
	"notice.strokesDeleted": ["Deleted {0} strokes", "已删除 {0} 条笔迹"],
	"notice.refCopied": ["Reference copied", "已复制引用"],
	"notice.nameTaken": ["There is already an area called \"{0}\"", "已经有一个区域叫「{0}」了"],
	"notice.nameEmpty": ["The name cannot be empty", "名字不能为空"],

	/* region bar */
	"region.rename": ["Rename", "重命名"],
	"region.copyRef": ["Copy ![[...]] reference", "复制 ![[...]] 引用"],
	"region.delete": ["Delete area", "删除区域"],
	"region.unnamed": ["(unnamed)", "(未命名)"],
	"sel.delete": ["Delete the strokes inside", "删除圈中的笔迹"],

	/* naming modal */
	"name.title": ["Name this area", "给这块内容命名"],
	"name.desc": ["Once named, [[this file#name]] references it from anywhere, and ![[...]] draws the handwriting itself.", "命名后就能在别处用 [[本文件#名字]] 引用它，加 ! 会直接显示这块手写内容。"],
	"name.field": ["Name", "名字"],
	"name.placeholder": ["e.g. reaction mechanism", "例如：反应机理图"],
	"common.cancel": ["Cancel", "取消"],
	"common.ok": ["OK", "确定"],
	"common.delete": ["Delete", "删除"],

	/* link modal */
	"link.title": ["Wiki link (handwriting only)", "Wiki 链接（只能指向手写内容）"],
	"link.target": ["Target", "目标"],
	"link.placeholder": ["Handwriting note, or note#area", "手写笔记名，或 手写笔记名#区域"],
	"link.embed": ["Show the content inline", "直接显示内容"],
	"link.embedDesc": ["Like ![[ ]]: draws the target handwriting note, or one of its areas, right here.", "相当于 ![[ ]]：直接把目标手写笔记（或它的某个圈）画在这里。"],
	"link.noMatch": ["No matching handwriting notes", "没有匹配的手写笔记"],
	"link.noneYet": ["No other handwriting notes yet", "还没有别的手写笔记"],
	"link.area": ["area", "区域"],
	"link.empty": ["[[empty link]]", "[[空链接]]"],

	/* embeds */
	"embed.missing": ["Not found: {0}", "未找到：{0}"],
	"embed.handwritingOnly": ["Handwriting only; an ordinary document cannot be embedded on the canvas", "只能引用手写内容，普通文档不能嵌在画布上"],

	/* view */
	"view.title": ["Handwriting", "手写笔记"],
	"view.loadFailed": ["The handwriting view failed to load", "手写视图加载失败"],
	"view.newNotePrefix": ["Handwriting", "手写"],

	/* settings */
	"set.language": ["Language", "语言"],
	"set.languageDesc": ["Follows Obsidian's display language by default. Command names in the palette update after a restart.", "默认跟随 Obsidian 的显示语言。命令面板里的名称重启后更新。"],
	"set.langAuto": ["Automatic", "自动"],
	"set.taper": ["Stroke taper", "起收笔锋"],
	"set.taperDesc": ["Off: width comes entirely from real pressure. Subtle: adds a 3px transition so the start of a stroke is softer.", "关：粗细完全由真实压力决定。轻微：额外加 3px 的过渡，起笔边缘更柔和。"],
	"set.off": ["Off", "关"],
	"set.subtle": ["Subtle", "轻微"],
	"set.renderer": ["Smoothing filter", "平滑算法"],
	"set.rendererDesc": ["By distance: the filter works per unit of path travelled, so a stroke looks the same however densely it was sampled. Per sample is the older behaviour and cuts tight curves harder once a stroke has been thinned.", "按距离：滤波按走过的路程工作，采样密疏不影响笔迹形状。按采样点是旧行为，笔迹被抽稀之后会把小弯切得更狠。"],
	"set.oneEuro": ["By distance (recommended)", "按距离（推荐）"],
	"set.exponential": ["Per sample (older)", "按采样点（旧）"],
	"set.predict": ["Tip prediction", "笔尖预测"],
	"set.predictDesc": ["Draws a few frames ahead of the nib to offset perceived latency. Native apps like Notability get this from the system's predictedTouches; WebKit has no such API, so we extrapolate. Higher feels more attached to the nib but can overshoot slightly through turns.", "往笔尖前方多画几帧，抵消感知延迟 —— Notability 这类原生应用靠系统的 predictedTouches 做这件事，WebKit 没有这个 API，只能自己外推。调大更跟手，但转弯时可能轻微过冲。"],
	"set.smooth": ["Smoothing", "平滑强度"],
	"set.smoothDesc": ["Higher is smoother but feels less attached to the nib.", "越高越顺滑，但跟手感会变差。"],
	"set.thin": ["Pressure sensitivity", "压感强度"],
	"set.thinDesc": ["0 gives a constant width, 1 lets pressure decide it entirely.", "0 = 恒定粗细，1 = 粗细完全跟着压力走。"],
	"set.finger": ["Allow drawing with a finger", "允许手指绘制"],
	"set.fingerDesc": ["When off, only an Apple Pencil or a mouse draws, so a palm resting on the screen leaves no marks.", "关闭时只认 Apple Pencil 和鼠标，手掌搭在屏幕上不会画出杂线。"],
	"set.lowLatency": ["Low-latency canvas", "低延迟画布"],
	"set.lowLatencyDesc": ["The desynchronized hint. Turn it off to use the normal compositing path.", "desynchronized 提示。关掉走常规合成路径。"],
} as const;

export type Key = keyof typeof STR;

let lang: Lang = "en";

export function setLang(l: Lang) { lang = l; }
export function getLang(): Lang { return lang; }

/** Resolve the "auto" setting: Obsidian's display language first, then the
 *  browser locale. Anything that is not Chinese gets English. */
export function detectLang(): Lang {
	let tag = "";
	try { tag = window.localStorage?.getItem("language") ?? ""; } catch { /* private mode */ }
	if (!tag) tag = navigator.language ?? "";
	return /^zh/i.test(tag) ? "zh" : "en";
}

export function t(key: Key, ...args: (string | number)[]): string {
	const pair = STR[key];
	const s = (lang === "zh" ? pair[1] : pair[0]) ?? pair[0];
	return args.length ? s.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? "")) : s;
}
