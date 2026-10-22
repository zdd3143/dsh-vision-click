# Changelog

所有值得注意的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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

[1.0.1]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.0.1
[1.0.0]: https://github.com/zdd3143/dsh-vision-click/releases/tag/v1.0.0
