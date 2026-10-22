# 架构说明

本文记录 `dsh-vision-click` 的内部结构、关键决策与踩过的坑，方便维护和二次开发。

## 组件

| 文件 | 角色 | 生命周期 |
| --- | --- | --- |
| `index.js` | 宿主插件：注册 10 个工具、编排「截图 → 定位 → 动作 → 复核」、与急停联动 | 随 DSH 插件加载 |
| `scripts/agent.ps1` | 常驻进程（JSON Lines over stdio）：截屏、OCR、点击/拖动/滚轮/键入、逐像素差分 | 首次使用时由 `index.js` 启动，插件卸载时杀掉 |
| `scripts/stop-watcher.ps1` | 独立的急停看门狗：轮询 `GetAsyncKeyState`，F6+F7 → 写标记、杀 daemon、松键、通知宿主 | 独立进程，与 agent 循环互不依赖 |
| `native/DshOcr.cs` / `.dll` | WinRT OCR 调用 + `LockBits` 逐像素差分（C#） | 由 `agent.ps1` 用 `Assembly.Load(bytes)` 载入 |
| `tests/target-window.ps1` | 可交互测试窗口：按钮、可拖动方块、滚动列表、文本框、同名标签 | 仅测试用 |

`index.js` 不做任何像素或输入操作，它只做编排与策略；所有「碰屏幕」的事情都集中在 `agent.ps1`，
这样安全边界（急停、fail-closed）只有一个地方需要审计。

## 一次 `gui_click {target:"保存"}` 的完整路径

```
index.js
 ├─ assertControlAllowed / assertArmed / assertWatchdog / assertRate
 ├─ capture()                 → daemon "screen"   截图 + 保存原生 PNG + 生成缩略图附件
 ├─ resolveOnFrame()
 │   ├─ foregroundWindow()    → daemon "window"   活动窗口矩形（物理像素）
 │   ├─ 逐级 OCR：
 │   │     window → window-bands → screen → screen-tiles
 │   │     每次 daemon "ocr" { path, rect, scale, lang }
 │   ├─ findCandidates()      行级 + 词级片段打分、去重、歧义判定
 │   └─ 命中后补一次整窗 OCR（防止条带漏看重复项）
 ├─ doPointer()               → daemon "click"  {x,y,button,count|holdMs}
 │                              （点击前存光标位置，点击后还原）
 └─ verify()
     ├─ capture()             动作后的新截图
     ├─ daemon "diff"         局部（±240px）与全屏两次数值差分
     └─ daemon "ocr"          文字增删对比（与动作前的窗口基线）
```

返回给模型的内容包括：命中的文字与坐标、候选列表、复核结论（有反应/没反应、新出现/消失了什么）。

## OCR 退让策略

Windows OCR 在整屏 2560×1600 上表现不稳定：小字会被并入相邻行（`网易有道翻译 MATLAB`）、
或者整块控件被忽略。实测后确定下面这条顺序（命中即停，只有失败才付额外成本）：

| 顺序 | 输入 | 为什么 |
| --- | --- | --- |
| 1 | 活动窗口整窗 | 单窗口文本密度低，最准 |
| 2 | 同一窗口切 3 条横向条带（30% 重叠） | 有些控件在整窗里被当作段落忽略，切条带后能读到 |
| 3 | 整屏 | 目标窗口不是活动窗口时的兜底 |
| 4 | 屏幕 4 块重叠瓦片（1.5 倍放大） | 全屏 OCR 分块后小字召回率明显提升 |

**词级片段**：同一行内还会尝试 1~4 个连续词的组合。因为 OCR 经常把相邻按钮并成一行，
行中心会落在两个按钮之间；词片段的包围盒才是真正可点的位置。

**歧义**：命中之后补一次整窗 OCR，把同名候选找齐。如果最高分与次高分接近（差 < 0.04）
且中心距离 > 0.02（归一化），拒绝点击并列出候选；由调用方用 `pick` 或 `near` 决定。

## 匹配打分

输入统一归一化：小写、去掉空白与中英文标点（OCR 会把「保存」识别成「保 存」）。

| 情况 | 分数 |
| --- | --- |
| 完全相等 | 1.00 |
| 单位文本包含目标（目标更短） | 0.84 ~ 0.96 |
| 目标是单位文本的超集且覆盖 ≥ 80% | 0.55 |
| 目标是单位文本的超集且覆盖 ≥ 60% | 0.62（只用于「很可能但不确认」，永不自动点） |
| 编辑距离相似度 ≥ 0.72 | 0.45 + 0.3 × 相似度 |
| 单字符目标（非完全匹配） | 0（「第」不该匹配「第一步」） |

`minMatchScore`（默认 0.7）以下的候选只展示、不点击。

## 复核

1. **局部差分**：以落点为中心的矩形（点击 ±240px / 拖放 ±320px / 滚动 ±420px），
   C# 内 `LockBits` 取 32bpp 像素，按 24×16 网格求每格平均差；单格差 > 0.05 记为「变化格」。
2. **全屏差分**：同算法、不裁剪，用于捕捉「效果出现在别处」（状态栏、提示条）。
3. **文字增删**：动作前对活动窗口做 OCR 基线（条带合并），动作后再做一次，
   比较归一化文本集合；过滤纯数字/时间/单字符噪声，避免时钟跳动被当成「有反应」。

判定：局部或全屏有变化格（局部 maxDelta ≥ 0.03、全屏 ≥ 0.05）或文字集合有增删 → 有反应。

## 坐标系与 DPI

- 截图与输入都使用**物理像素**：daemon 启动时 `SetProcessDPIAware()`，避免 125%/150% 缩放下的坐标错位。
- 工具参数一律用 **0~1 归一化坐标**（相对最近一次截图），内部再换算成物理像素；
  `capture()` 记录 `originX/originY`，多显示器或非主屏拼接时也能正确映射。
- 返回给模型的图可能被等比缩小（`maxWidth`），OCR 始终用原生 PNG，因此不影响定位精度。

## 守护进程协议

`agent.ps1` 从 stdin 读一行 JSON、向 stdout 写一行 JSON：

| op | 请求字段 | 返回 |
| --- | --- | --- |
| `ping` | — | `pong`、`pid`、OCR 是否可用、语言列表 |
| `cursor` | — | `x`、`y` |
| `screen` | `area`、`maxWidth`、`outPath` | 原生/缩略图路径、尺寸、原点、光标位置 |
| `window` | — | 活动窗口 `x/y/w/h/pid/title/processName` |
| `ocr` | `path`、`rect`、`scale`、`lang` | `lines[]`（每行 `text`、`x/y/w/h`、`words[][]`） |
| `diff` | `a`、`b`、`cellsX`、`cellsY`、`rect` | `ratio`、`changed`、`maxDelta`、`bbox`、变化格列表 |
| `move` | `x`、`y` | 光标位置 |
| `click` | `x`、`y`、`button`、`count` | 落点与按钮 |
| `press` | `x`、`y`、`button`、`holdMs`、`count` | 长按参数 |
| `drag` | `x1`、`y1`、`x2`、`y2`、`button`、`steps`、`stepMs` | 起终点与步数 |
| `scroll` | `x`、`y`、`direction`、`amount`、`horizontal` | 方向与格数 |
| `type` | `text`、`delayMs`、`pressEnter` | 实际输入字符数 |
| `key` | `keys`、`count` | 解析后的键序列 |
| `release` | — | 是否已松开所有键 |

每个命令执行前都会重新检查磁盘上的急停标记：即使 daemon 在急停后仍存活，也不会再注入输入。

## 安全设计

- **fail-closed**：看门狗没运行 → 所有输入工具直接抛错，不做「尽力而为」。
- **急停链路**：看门狗（独立进程）→ 写 `emergency-stop.json` → 杀 daemon → `ReleaseAll()` →
  `index.js` 轮询到标记后取消当前回合。四个步骤都在 daemon 之外，daemon 卡死也不影响刹车。
- **孤儿保护**：看门狗带 `-ParentPid`，宿主退出后自己结束，不会留下常驻的全局键盘轮询。
- **限速 + 审计**：每分钟动作上限、每步落盘审计，便于事后复盘。

## 踩过的坑（维护者必读）

1. **PowerShell 5.1 无法遍历 WinRT 集合**：`OcrResult.Lines` 返回 `__ComObject`，`foreach` 拿不到元素。
   所以 OCR 调用整体下沉到 C#（`native/DshOcr.cs`），脚本侧只处理 JSON。
2. **`Assembly.LoadFrom` 会失败**（0x80131515，依赖 WinRT 程序集）；改用 `Assembly.Load(bytes)`。
3. **编译需要 `Windows.winmd` + Facades**：`build-ocr.ps1` 会从 Windows SDK 的 UnionMetadata 里
   挑一个能编译的版本（不同 SDK 版本暴露的命名空间不同），并逐个 `try`。
4. **整屏 OCR 不可靠**：见上面「OCR 退让策略」，条带与瓦片是实测出来的必要手段。
5. **早期「找到一个就点」会漏掉重复项**：现在命中后补一次整窗识别再判歧义。
6. **悬停高亮会污染下一帧**：点击后把光标还原，截图里就不会残留 hover 态。
7. **四采样点差分测不出小变化**：改成 C# 逐像素 + 局部区域，状态栏文字变化也能被判为「有反应」。
8. **测试窗口必须保持前台**：否则 OCR 读到的是 Harness 自己的对话窗口，
   恰好对话里又写着同样的按钮文字，会造成「在错误的窗口里命中」的假象。
9. **PowerShell 脚本要存成 UTF-8 with BOM**：否则中文在 5.1 里按 ANSI 解析，字符串截断直接语法错误。
