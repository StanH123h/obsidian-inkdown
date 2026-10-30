/* Two languages: English and Chinese.
 *
 * Which one is used follows the user's Obsidian display language, and anything
 * that is not Chinese gets English. The setting can also pin one explicitly.
 *
 * Not translated on purpose: the diagnostics panel, which is a debugging tool
 * rather than a feature. The prompt sent to the model is English either way;
 * it tells the model to keep whatever language the handwriting is in.
 */

import { getLanguage } from "obsidian";

export type Lang = "en" | "zh";

const STR = {
	/* tool bar */
	"tool.pen": ["Pen", "笔"],
	"tool.aiPen": ["AI pen: notes for the AI, never transcribed", "AI 笔：写给 AI 看的批注，不会被转写"],
	"tool.lasso": ["Lasso: circle ink to move it", "套索：圈住笔迹来移动"],
	"tool.fit": ["Whole page / page width", "整页 / 页宽"],
	"tool.undo": ["Undo", "撤销"],
	"tool.redo": ["Redo", "重做"],
	"tool.clear": ["Clear the page", "清空整页"],
	"tool.more": ["More", "更多"],
	"tool.moreLabel": ["More", "更多"],
	"menu.position": ["Toolbar position", "工具栏位置"],
	"side.left": ["Left", "左"],
	"side.right": ["Right", "右"],
	"side.top": ["Top", "上"],
	"side.bottom": ["Bottom", "下"],
	"hint.drag": ["Hold to drag", "长按以拖拽"],
	"hint.twoFingers": ["Two fingers to undo", "双指撤销"],
	"hint.threeFingers": ["Three fingers to redo", "三指重做"],
	"hint.tapPen": ["Tap again to hide", "点一下收起"],
	"tool.close": ["Close (your writing is kept for next time)", "关闭（字迹会留到下次）"],
	"tool.convert": ["Convert", "转换"],
	"tool.convertHint": ["Turn this into Markdown at the cursor", "转成 Markdown，插到光标处"],
	"tool.split": ["Open beside the note", "在笔记旁边打开"],
	"tool.full": ["Full screen", "全屏"],
	"tool.splitLabel": ["Split", "分屏"],
	"tool.fullLabel": ["Full", "全屏"],

	/* the pad in a pane */
	"view.title": ["Handwriting pad", "手写板"],
	"view.target": ["Into: {0}", "插到：{0}"],
	"view.noTarget": ["Tap the note to write into", "点一下要插入的笔记"],

	/* context bar and dial */
	"ctx.penWidth": ["Pen width {0}", "笔宽 {0}"],
	"ctx.eraseStroke": ["Whole", "整笔"],
	"ctx.erasePrecise": ["Precise", "精确"],
	"sel.delete": ["Delete the strokes inside", "删除圈中的笔迹"],

	/* commands */
	"cmd.open": ["Handwrite at the cursor", "在光标处手写"],
	"cmd.diagnostics": ["Diagnostics (for troubleshooting on mobile)", "诊断信息（移动端排查用）"],

	/* notices */
	"notice.nothingToUndo": ["Nothing to undo", "没有可撤销的操作"],
	"notice.nothingToRedo": ["Nothing to redo", "没有可重做的操作"],
	"notice.strokesDeleted": ["Deleted {0} strokes", "已删除 {0} 条笔迹"],
	"notice.noNote": ["Open a note first: the result goes in at its cursor", "先打开一篇笔记：识别结果会插到它的光标处"],
	"notice.empty": ["Nothing written yet", "还没写任何东西"],
	"notice.noKey": ["Link an API key in the plugin settings first", "先在插件设置里关联 API 密钥"],
	"notice.failed": ["Recognition failed: {0}\nYour writing is back in the pad.", "识别失败：{0}\n字迹已放回写字板。"],
	"notice.failedNotRestored": ["Recognition failed: {0}\nThe pad already has new writing, so the failed page was not put back.", "识别失败：{0}\n写字板里已经有新字迹，失败的那页没有放回去。"],
	"notice.refused": ["the model declined this request", "模型拒绝了这次请求"],
	"notice.noText": ["the model returned no text", "模型没有返回文字"],
	"notice.pending": ["⏳ Reading handwriting ({0})…", "⏳ 正在识别手写（{0}）…"],
	"err.auth": ["the API key was rejected (401)", "API 密钥被拒绝（401）"],
	"err.rate": ["too many requests (429); try again in a moment", "请求太频繁（429），稍等再试"],
	"err.network": ["could not reach the service: {0}", "连不上服务：{0}"],

	/* result fallback */
	"result.title": ["Recognised text", "识别结果"],
	"result.desc": ["The placeholder in the note was deleted, so the result is here instead.", "笔记里的占位文字已被删掉，结果放在这里。"],
	"result.copy": ["Copy", "复制"],
	"result.copied": ["Copied", "已复制"],

	/* settings */
	"set.language": ["Language", "语言"],
	"set.languageDesc": ["Follows Obsidian's display language by default. Command names in the palette update after a restart.", "默认跟随 Obsidian 的显示语言。命令面板里的名称重启后更新。"],
	"set.langAuto": ["Automatic", "自动"],
	"set.aiHeading": ["Recognition", "识别"],
	"set.writingHeading": ["Writing", "书写"],
	"set.provider": ["Service", "服务"],
	"set.providerDesc": ["Who reads the handwriting. OpenAI-compatible also covers any other service that speaks the same API.", "由谁来识别手写。「OpenAI 兼容」也适用于其他使用同一套接口的服务。"],
	"set.providerAnthropic": ["Claude (Anthropic)", "Claude（Anthropic 官方）"],
	"set.providerOpenAI": ["OpenAI-compatible", "OpenAI 兼容"],
	"set.key": ["API key", "API 密钥"],
	"set.keyDesc": ["Kept in Obsidian's keychain on this device, never in the vault. Choose Link..., then Add secret...: give it any name, such as {0}, and paste the key as the secret.", "存在这台设备上 Obsidian 的钥匙串里，不会进库。点「Link...」→「Add secret...」：ID 随便起，比如 {0}，Secret 里粘贴 API 密钥。"],
	"set.model": ["Model", "模型"],
	"set.modelDesc": ["Opus reads untidy handwriting best. Haiku is the quickest and cheapest.", "Opus 认潦草字迹最准，Haiku 最快也最便宜。"],
	"set.recommended": ["recommended", "推荐"],
	"set.figures": ["Redraw maths figures", "重画数学图"],
	"set.figuresDesc": ["Graphs of functions, geometric figures and the like are redrawn by Claude in Python (matplotlib) and inserted as images, saved where Obsidian puts attachments. A page with a figure takes a few seconds longer.", "函数图像、几何图形这类图，由 Claude 用 Python（matplotlib）重新画一遍，作为图片插入笔记，图片存在 Obsidian 的附件文件夹。有图的页面会多花几秒。"],
	"set.check": ["Check for mistakes", "检查错误"],
	"set.checkDesc": ["What you wrote is never changed. If a step looks wrong, a warning callout after it says where and why.", "转写内容不会被改动。如果某一步看起来有错，会在结果末尾加一个警告框，说明在哪里、为什么。"],
	"set.openaiModelDesc": ["The model ID, for example gpt-6-astra.", "模型 ID，例如 gpt-6-astra。"],
	"set.baseUrl": ["API address", "接口地址"],
	"set.baseUrlDesc": ["Leave as is for OpenAI. For another OpenAI-compatible service, put its address here; it usually ends in /v1.", "用 OpenAI 就保持不变。换成其他兼容 OpenAI 接口的服务时填它的地址，一般以 /v1 结尾。"],
	"set.taper": ["Stroke taper", "起收笔锋"],
	"set.taperDesc": ["Off: width comes entirely from real pressure. Subtle: adds a 3px transition so the start of a stroke is softer.", "关：粗细完全由真实压力决定。轻微：额外加 3px 的过渡，起笔边缘更柔和。"],
	"set.off": ["Off", "关"],
	"set.subtle": ["Subtle", "轻微"],
	"set.renderer": ["Smoothing filter", "平滑算法"],
	"set.rendererDesc": ["By distance: the filter works per unit of path travelled, so a stroke looks the same however densely it was sampled. Per sample is the older behaviour and cuts tight curves harder once a stroke has been thinned.", "按距离：滤波按走过的路程工作，采样密疏不影响笔迹形状。按采样点是旧行为，笔迹被抽稀之后会把小弯切得更狠。"],
	"set.oneEuro": ["By distance (recommended)", "按距离（推荐）"],
	"set.exponential": ["Per sample (older)", "按采样点（旧）"],
	"set.curve": ["Smooth curves", "曲线平滑"],
	"set.curveDesc": ["Draws a smooth curve through the pen's samples instead of straight lines between them, so a stroke has no corners however far you zoom in. Turn it off to compare.", "在笔的采样点之间画平滑曲线，而不是直线连接，放得再大也看不到折角。关掉可以对比效果。"],
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

/** Resolve the "auto" setting: Obsidian's display language, which is English
 *  until one is chosen. Anything that is not Chinese gets English. */
export function detectLang(): Lang {
	return /^zh/i.test(getLanguage()) ? "zh" : "en";
}

export function t(key: Key, ...args: (string | number)[]): string {
	const pair = STR[key];
	const s = (lang === "zh" ? pair[1] : pair[0]) ?? pair[0];
	return args.length ? s.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? "")) : s;
}
