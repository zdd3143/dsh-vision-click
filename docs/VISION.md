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
