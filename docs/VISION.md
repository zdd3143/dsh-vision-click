# 可选：本地视觉模型兜底（UI-TARS-7B + Ollama）

OCR 读不到的控件（图标、Canvas、艺术字、OCR 漏字）可以交给本地视觉模型。
默认关闭；开启后只在 **OCR 没有候选、或候选分数低于 `minMatchScore`** 时才调用。

## 设计：VLM 提议，OCR 吸附

```
截图
 ├─ 裁活动窗口 → 缩到 1280 宽 → 本地 VLM（UI-TARS-7B）
 │        └─ 输出 Action: click(start_box='(x,y)')   ← 0~1000 归一化
 ├─ 把点换算回屏幕像素
 ├─ 在 OCR 的词级框里找「最近的、且文字与 target 相关」的框 → 吸附到框中心
 └─ 照常走像素差分 + 文字增删复核
```

- **精度来自 OCR**：模型只负责「大概在哪」，最终落点锚定在真实文字框上；
- **相关性过滤**：吸附只在词文本与 target 有包含/相似关系时发生。
  否则会吸附到旁边一句无关文字（实测踩过：点「开始测试」时吸到了「已拖动到 40,400」里的「拖」）；
- **失败即回退**：模型超时/没给出坐标 → 仍然走原来的 OCR 错误路径，不会卡住；
- **不可用时零影响**：`visionEnabled: false`（默认）时，代码路径与之前完全一致。

## 部署 UI-TARS-7B（GGUF）

```powershell
# 1) 模型目录与 Ollama
$env:OLLAMA_MODELS = "D:\models\ollama"
ollama serve

# 2) 下载（huggingface.co 不可达时用镜像；单连接可续传，并发会被 429）
curl.exe -L -C - -o UI-TARS-7B-DPO-Q4_K_M.gguf `
  https://hf-mirror.com/bartowski/UI-TARS-7B-DPO-GGUF/resolve/main/UI-TARS-7B-DPO-Q4_K_M.gguf
curl.exe -L -C - -o mmproj-UI-TARS-7B-DPO-f16.gguf `
  https://hf-mirror.com/bartowski/UI-TARS-7B-DPO-GGUF/resolve/main/mmproj-UI-TARS-7B-DPO-f16.gguf

# 3) 导入：两个 FROM（模型 + 视觉投影器，缺投影器就只能读文字）
@"
FROM ./UI-TARS-7B-DPO-Q4_K_M.gguf
FROM ./mmproj-UI-TARS-7B-DPO-f16.gguf
PARAMETER temperature 0
PARAMETER num_ctx 8192
"@ | Set-Content Modelfile -Encoding UTF8
ollama create ui-tars:7b -f Modelfile
```

参考数据（RTX 4060 Laptop 8G）：模型 6.0GB、100% GPU、新截图约 2~8 秒/次，
同一张图重复提问（KV 前缀复用）0.5~0.8 秒；首次加载约 25 秒。

## 开启

`cordis.patch.yml`（或 profile patch）里加：

```yaml
- id: vision-click
  name: 'dsh-vision-click'
  config:
    visionEnabled: true
    visionBaseUrl: http://127.0.0.1:11434
    visionModel: ui-tars:7b
    visionMode: fallback      # fallback | always
    visionTimeoutMs: 30000
    visionMaxWidth: 1280
    visionSnapRadius: 0.08
```

`visionMode: always` 会跳过「OCR 有把握就不问模型」的优化，适合联调。

## 结果里怎么看用了模型

`gui_click` 返回 `source` 与 `vision`：

```json
{
  "source": "vision",
  "vision": { "model": "ui-tars:7b", "ms": 541, "snapped": true, "snappedText": "开始", "nearest": { "dist": 12, "radius": 70 } }
}
```

消息里也会写：`（OCR 没有把握，由视觉模型 ui-tars:7b 定位 541ms，并吸附到「开始」）`。

## 实测

测试窗口（1174×829 截图，提示词 `Task: click the "xxx" button`）：

| 目标 | 模型输出(0~1000) | 换算像素 | 实际控件 | 结果 |
| --- | --- | --- | --- | --- |
| 开始测试 | (147, 312) | (173, 259) | 按钮中心 ≈ (173, 259) | 命中 |
| 下一步 | (578, 317) | (679, 263) | 按钮 545–695 × 230–290 | 命中 |
| 拖动我 | (147, 816) | (173, 676) | 黄色方块 60–285 × 600–684 | 命中 |
| 拖到这里 | (826, 816) | (970, 676) | 投放区 840–1095 × 600–684 | 命中 |

已知限制：

- Windows OCR 本身不稳定，吸附偶尔拿不到目标词（同一帧换一次识别就可能读到），
  这时会退回模型的原始坐标并在 `vision.snapped=false` 里标出来；
- 整屏截图直接喂模型效果差，必须先裁窗口；
- 中文 target 可用，但英文指令更稳。

## 开销与默认策略

视觉模型是**用户显式开启**的能力，默认关闭：

- 模型常驻时约占 **5~6 GB 显存**（`ollama ps` 显示 `100% GPU`），空闲 5 分钟后自动卸载；
- 每次调用（新截图）约 2~8 秒；同一张图重复提问 0.5~0.8 秒（KV 前缀复用）；
- 关闭时插件完全不加载模型、不占显存，OCR 路径与之前一致。

不想让它占显存时：

```powershell
ollama stop ui-tars:7b        # 立即卸载，显存回到基线
```

## 实测：开 / 关视觉的差别

任务（`tests/complex-window.ps1`，6 步）：点画布上**没有文字**的齿轮图标 → 点低对比度小字 →
把方块拖到目标区 → 列表滚到底并点第 40 行 → 点提交 → **把滑块拖到右端（滑块拇指没有文字）**。
每步都用状态栏文字判定，不看出参。

```powershell
node tests/run-compare-test.mjs
```

| 步骤 | 仅 OCR | OCR + 视觉 | 用了模型 |
| --- | --- | --- | --- |
| 点齿轮图标（画布，无文字） | 失败：找不到 | 通过 | 是 |
| 点低对比度小字 | 通过 | 通过 | 否 |
| 拖到目标区 | 通过 | 通过 | 否 |
| 列表滚到底并点第 40 行 | 通过 | 通过 | 否 |
| 点提交 | 通过 | 通过 | 否 |
| 拖滑块到右端（拇指无文字） | 失败：找不到 | 通过 | 是 |
| **合计** | **4/6** | **6/6** | |
| 总耗时 | 10.0s | 16.9s | |

结论：视觉只在「OCR 完全无能为力」的那两步被调用（图标、滑块拇指），代价约 2~5 秒；
其余步骤没有额外开销。这也解释了为什么默认关闭——大多数任务 OCR 够用。

## 拖拽 / 滚动的失败重试（visionOnDragRetry / visionOnScrollRetry）

点击失败可以微调坐标，拖拽和滚动不行——它们的失败原因不是「点偏了」：

- **拖拽没生效**：多半是没抓住把手（滑块拇指、画布对象、无文字的拖拽柄），按下的位置差十几像素。
  开启后，插件会用**动作后的新截图**再问一次模型两端在哪，用新端点重拖一次；仍以复核为准。
- **滚动没生效**：可能是鼠标落在不可滚动区域，也可能已经到头。
  开启后，插件用新截图让模型重新定位滚动区域并滚一次；如果还是没变化，就明确告诉调用方「可能已到底」。

护栏：每次动作**最多重试一次**（`retried` 字段标出），仍然走像素 + 文字复核；模型不可用时回退到原结论。

## 已知问题

- 第一次点击可能落在图标边缘（模型给的是元素大致位置），插件会在**没变化时做一次微调重试**
  （`visionRetries`，默认 1 次，±10~16px），仍由复核决定成败；
- OCR 不稳定时吸附可能拿不到词框，会保留模型原始坐标并标 `snapped: false`。
