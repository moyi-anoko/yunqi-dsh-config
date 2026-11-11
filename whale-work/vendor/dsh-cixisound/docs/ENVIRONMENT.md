# 环境与依赖

1.0 的原则：**依赖是声明出来的，不是猜出来的。** 所有依赖写在根目录
[`deps.manifest.json`](../deps.manifest.json) 里，插件在第一次调用工具时按它把环境备齐。

---

## 一、两种模式

| | **borrow**（默认） | standalone |
|---|---|---|
| 依赖源 | 机器上已有的 Python 3.10–3.12（有 numpy/librosa 更好；ComfyUI 那种最省事） | 任意 Python 3.10–3.12 |
| venv 建法 | `python -m venv --system-site-packages` | `python -m venv` |
| 装进 venv 的 | `faster-whisper` `demucs` `torchcrepe` | 上面三个 + `torch` `torchaudio` `numpy` `scipy` `librosa` `soundfile` `onnxruntime` |
| 沿用依赖源的 | `torch` `torchaudio` `numpy` `scipy` `librosa` `soundfile` `onnxruntime`（以及通常在的 `ctranslate2` `av`） | 无 |
| 磁盘增量 | **约 110 MB** + 模型 | 约 7 GB + 模型 |
| 实测 | 本机跑通（ComfyUI 的 torch 2.8.0+cu129） | **未实测**，只按 PyTorch 官方索引写了路径 |

模式由 `SOUNDTRY_DEPS` / 配置项 `deps` 决定；不写就看依赖源有没有 torch 自动选。

---

## 二、插件目录里的东西

| 内容 | 位置 | 大小 | 从哪来 |
|---|---|---|---|
| 代码 | `src/` `python/` `docs/` `scripts/` | < 300 KB | 仓库自带 |
| 依赖声明 | `deps.manifest.json` | 2 KB | 仓库自带 |
| venv | `runtime/venv/` | 约 110 MB（borrow） | 首次运行自动建 |
| whisper medium | `models/medium/` | 1457 MB | 首次运行自动下（ModelScope） |
| Demucs htdemucs | `models/torch/` | 80 MB | 首次分离时 torch.hub 自动下 |
| ffmpeg | `vendor/ffmpeg/ffmpeg.exe` | 61.5 MB | 首次运行从机器上已有的那份复制 |
| 分离缓存 | `cache/stems/` | 每首约 30 MB | 可随时删 |
| 就绪标记 | `runtime/ready.json` | < 1 KB | 装完自动写；删了即重装 |

---

## 三、依赖源怎么找（优先级）

1. 环境变量 `SOUNDTRY_PYTHON`
2. `~/.dsh/soundtry.json` 的 `python`
3. `~/.dsh/soundtry.json` 的 `comfyui`（拼 `python/python.exe`）
4. 自动扫描 `D:\ComfyUI\*`、`C:\ComfyUI\*`、`E:\ComfyUI\*` 下的 `python/python.exe`、`python_embeded/python.exe`
5. PATH 上的 `python` / `python3`

**第 4 条就是"借用 ComfyUI"的实现**：本机实测直接命中 `D:\ComfyUI\ComfyUI-aki-v2\python\python.exe`，torch 2.8.0+cu129 原样复用，没有多下一份。

---

## 四、CUDA 运行库

borrow 模式下，子进程的 `PATH` 前面会插上依赖源的 `Lib/site-packages/torch/lib`
（cuDNN 9 / cuBLAS 12 都在那儿），并顺带设 `CUDA_PATH`。找不到就是 CPU 模式，会慢几十倍但不报错。

覆盖：`SOUNDTRY_CUDA_LIB=<那个 lib 目录>`。

---

## 五、失败时会发生什么

| 现象 | 含义 | 处理 |
|---|---|---|
| `找不到可用的 Python 作为依赖源` | 五条探测全落空 | 设 `SOUNDTRY_PYTHON`，或装个 Python |
| `venv 建好了但跑不起来` | 基础解释器损坏/权限问题 | 删 `runtime/venv` 重来 |
| `pip install … 退出码 1` | 网络或镜像问题 | 设 `SOUNDTRY_PYPI` 换镜像 |
| `model.bin 大小不对` | 镜像返回了错误页 | 删 `models/<model>/model.bin*` 重试 |
| `没找到 ffmpeg` | 复制来源都没有 | 把 `ffmpeg.exe` 放进 `vendor/ffmpeg/` |
| 转写很慢 | 掉到 CPU 了 | 查 `doctor` 里 `torch (...) available=` 是否为 True |

---

## 六、模型

| 模型 | 体积 | 逐行歌词识别 | 位置 |
|---|---|---|---|
| **medium（默认）** | 1457 MB | 58/60 = 96.7% | `models/medium/` |
| large-v3（可选） | 2948 MB | 60/60 = 100% | `models/large-v3/` |

同一首歌（252 秒）、同一份歌词提示、同一块 RTX 4070、热缓存：medium 13 秒，large-v3 21 秒。

切换：`SOUNDTRY_MODEL=large-v3`，并在配置里让 `deps.manifest.json` 的 large-v3 进入安装流程
（把 mark 的 key 变了就会重装；或直接手动放权重到 `models/large-v3/`）。

---

## 七、和 0.1.x 并存

两个插件的**工具名完全相同**。DSH 里同时启用会撞名，先卸旧的：

```powershell
node --expose-internals "<DSH>\resources\app\lib\plugin-cli.js" desktop remove dsh-soundtry
```

数据不共享：1.0 用 `~/.dsh/soundtry.json`（读不到时回退旧配置），模型和缓存放在自己的目录里。

---

## 八、分离后端（1.0.2）

| 后端 | 依赖 | 质量（已知歌词实测） | 速度（207 秒歌） |
|---|---|---|---|
| **mdx-onnx（默认）** | onnxruntime（约 50 MB）+ 权重 63.7 MB | **85%** | 89 s（CPU） |
| demucs | torch（7.2 GB） | 79% | 25 s（GPU） |
| hpss | 无 | 会污染和弦/旋律 | 极快 |

权重位置：`models/uvr/Kim_Vocal_2.onnx`，由 `deps.manifest.json` 的 `assets` 段在首次运行时下载。
下载失败不阻塞：`auto` 会依次退到 demucs、hpss。

`sound_structure` 的"鼓"在 onnx 后端下是**从原始混音取打击分量**近似的，精度不如 Demucs 的四轨分离。