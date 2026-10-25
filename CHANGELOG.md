# Changelog

所有值得注意的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-10-25

### 修复

- **客户端 bundle 的模块契约**：factory 里补上 `module` / `exports` 并返回 exports。
  1.1.0 的 bundle 直接给未声明的 `exports` 赋值，在 DSH 0.2 的 client loader 下抛
  `exports is not defined`——失败的是整个 Web 启动，不只是插件不显示。
- **「屏幕控制」开关读不到状态**：DSH 0.2 的 `session.command()` 只结算 admission
  （`{ ok, value: { matched } }`），不再回传命令输出，旧实现因此永远停在「屏幕控制 ?」。
  现在改为读会话事件流里 `command/done` 的 `data.text`（宿主会把 `/vision` 的输出
  原样记进这条事件），并订阅事件窗口；点击后由新事件刷新状态。
- **去掉状态命令刷屏**：旧实现每次挂载都执行 `/vision status`，槽位重挂载时形成循环，
  一次会话能刷出十几条。现在不再周期轮询；只在「历史里已有 token、而本页还不知道
  宿主状态」时探测一次（宿主重启会把授权重置为 off，历史 token 却可能还留着 on，
  需要这一次探测来纠正），其余情况只跟随事件。

### 已知限制

- 上面那次探测会在本次页面加载后首个打开的会话里留下一条 `/vision status` 输出。
  宿主命令的输出只能经由会话日志回传，无法在不写日志的前提下读到。

## [1.1.0] - 2026-10-22

### 新增

- **输入框旁的「屏幕控制」开关**（客户端插件，`lib/client.js`）：注册在 composer 的
  `conversation.input.right` 槽位，显示「屏幕控制：开 / 关」，点击即执行 `/vision arm` 或 `/vision off`。
  状态由宿主的 `/vision status` 回读，开关不会与宿主实际放行状态不一致。
- **默认拒绝**：`allowControl` 默认 `false`，未授权时不截屏、不动鼠标；授权入口只有
  `/vision arm`（用户命令，不产生模型消息）或插件设置里的 `allowControl`。
- `/vision status` 输出稳定的 `SCREEN_CONTROL=on|off` 机器可读标记。
- `gui_status` 增加 `authorized` 字段。

## [1.0.1] - 2026-10-22

### 变更

- 完善插件显示元数据：`meta.title` / `meta.description`（`package.json` 与 `locale/zh.json`、`locale/en.json`）
  现在完整描述「看 / 动 / 验 / 停 / 批」五类能力，插件列表里可直接读到功能说明。
- README 增加「功能描述」一节。

## [1.0.0] - 2026-10-22

首个可用版本。

### 新增

- `gui_look` / `gui_click` / `gui_wait` / `gui_do` / `gui_status` / `gui_rearm` 六个基础工具。
- 鼠标：左/右/中键、单击/双击、`holdMs` 长按、`hover` 悬停、按住拖动、上下左右滚轮。
- 键盘：`gui_type` 键入文字（大小写/数字/中文/符号，Unicode 注入）、`gui_key` 组合键与功能键。
- 目标定位：Windows OCR + 逐级退让（窗口 → 横向条带 → 全屏 → 瓦片）+ 词级片段匹配。
- 动作复核：局部逐像素差分 + 全屏差分 + 动作前后文字增删对比。
- 安全：F6+F7 独立进程急停、fail-closed、歧义拒绝、限速、光标还原、审计日志、孤儿保护。
- 测试：可交互测试窗口 + 31 项端到端断言。
- 文档：README、架构说明、测试说明。

### 已知限制

- 仅 Windows 10/11；管理员权限窗口与安全桌面无法操作。
- OCR 对极小字号/艺术字/强背景图会漏读，需要用 `point` 兜底或 `pick` 指定候选。
- 中文为直接注入字符，不走输入法候选流程。

[1.1.1]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.1.1
[1.1.0]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.1.0
[1.0.1]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.0.1
[1.0.0]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.0.0
