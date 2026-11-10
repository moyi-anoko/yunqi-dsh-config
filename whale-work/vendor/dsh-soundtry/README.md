# dsh-soundtry

**DSH 的本地听觉插件 · 1.0.2**

让 agent 听得见声音：**转写、节奏、旋律、和弦、结构**六件套，全部在本机跑，零 API 费用。

- **人声分离默认走 UVR MDX-Net**（onnxruntime 推理，**不需要 torch**）——快嘴说唱上比 Demucs 还准
- **依赖是声明的，不是猜的**：`deps.manifest.json` 列清每一样；首次运行时自己装、自己下模型
- **权重不进仓库**：仓库只记 URL、字节数和 MD5，63.7 MB 的分离模型 + 1.46 GB 的 whisper medium 都在你机器上下
- **不可信的地方会自己说**：BPM 有 `ambiguous`/`level`/`conflict` 三态，切点双阈值同时报，和弦明说"根音可信、品质不可信"
- **设置就在插件里**：**插件 → 已安装 → dsh-soundtry** 详情页里有「声音分析」区块，可切 CPU/GPU、分离后端、模型；显存 < 4 GB 时自动锁 CPU 并给出提示

## 统一声明

- 这个插件**可以单独理解音乐**，也可以**配合其他画面理解插件一起理解视频**
- 经测试，也可以让**刷 B 站的鱼**（`dsh-bili-whale`）更好地理解视频内容噢
- ⚠️ 本地推理几乎不消耗 token，但**处理速度会因电脑配置不同而有不同表现**，属正常现象
- 所以**一般建议在“鱼”凭借其他依据没法很好理解视频时使用**
- 有任何问题可以在**评论区反馈**，也可以加入 **QQ 群：1130719501** 提出你的宝贵意见
- 插件地址：<https://github.com/CixiSVesper/dsh-soundtry>


## 运行要求

**只需要一个 Python 环境，不需要 ComfyUI。**

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows 10/11 x64** | 路径与 PATH 分隔符目前按 Windows 写死，macOS/Linux 会失败 |
| Python | **3.10 – 3.12** | 有就用现成的；没有再装一个 |
| 磁盘 | **3 GB** 起 | venv 154 MB + whisper medium 1457 MB + MDX 64 MB + ffmpeg 62 MB + 缓存 |
| 内存 | **6 GB 可用**，8 GB 推荐 | 实测 4 分钟歌「分离+转写」峰值 **4.42 GB**（随音频长度线性增长） |
| CPU | 4 核起 | MDX 分离约 **2.3× 实时**（207 秒歌 ≈ 89 秒） |
| 显卡 | **不需要** | ≥ 4 GB 显存才会启用；且只加速 whisper / demucs，MDX 分离固定 CPU |
| ffmpeg | 需要一份 | 首次运行会从 `PATH`、邻近插件或 `SOUNDTRY_FFMPEG` 复制进 `vendor/` |
| Node | ≥ 20 | DSH 宿主侧要求 |

### Python 从哪来：两条路

```
告诉 DSH：用我已有的 python  →  borrow 模式（默认）→ venv 只装 4 个包，约 160 MB
告诉 DSH：没有 python        →  standalone 模式 → 整套进 venv，约 7 GB
```

**给 agent 的原话：**

> 「dsh-soundtry 需要一个 Python 3.10–3.12。**先找机器上已有的**（比如 ComfyUI 的 `python\python.exe`），把路径写进 `~/.dsh/soundtry.json` 的 `python` 字段，用 borrow 模式；**如果机器上根本没有 Python，就装一个 3.12**，让插件自己建 venv 装依赖。」

插件自己也会找：`SOUNDTRY_PYTHON` → 配置 `python` → 配置 `comfyui` → 自动扫 `D:\ComfyUI\*`、`C:\ComfyUI\*` → `PATH` 上的 `python`。

> ⚠️ **一个真实的坑**：borrow 模式会 `pip install demucs`。如果那个 Python **没有 torch**，pip 会把 torch 一起拉下来（约 2.5 GB）。只用 MDX 分离的话，装依赖时可以跳过 demucs，或直接用 `separator: "onnx"`。


## 设置项（在插件详情页里）

打开 **插件 → 已安装 → dsh-soundtry**，详情页底部有「声音分析」：

| 控件 | 可选 | 说明 |
|---|---|---|
| 推理设备 | 自动 / 只用 GPU / 只用 CPU | 自动 = 显存 ≥ 4 GB 用 GPU。**显存小于 4 GB 时 GPU 不可用**，会显示「显存 X GB，小于 4 GB，暂不支持 GPU 推理加速（已强制 CPU）」 |
| 分离后端 | 自动 / MDX-Net ONNX / Demucs / HPSS | 自动的降级顺序：ONNX → Demucs → HPSS |
| 转写模型 | medium / large-v3 | large-v3 需另下 1.5 GB |

改动写入 `~/.dsh/soundtry.json`，**保存后下一次工具调用即生效，不用重启**。读-改-写，只动这三个键，手写的 `python` / `comfyui` 不会被抹掉。

被降级时，工具输出顶部会多一行 `⚠ …`，agent 也能看到，不会误以为在 GPU 上跑。

> 诊断用：`SOUNDTRY_FAKE_VRAM=3.2` 可以模拟小显存机器，验证降级与提示文案。

## 1.0.2：分离后端换成 MDX-Net（onnxruntime，无 torch）

这一版把**人声分离**从 Demucs（torch）换成了 **UVR MDX-Net 的 ONNX 模型**，用 onnxruntime 推理。
torch 从此在整条主路径上都不再需要。

同一首快嘴说唱（卦者灵风《阳光开朗大男孩》，206.7 秒，已知官方歌词，whisper medium + 歌词提示）：

| 分离方式 | 逐行命中 | 分离耗时 | 依赖 |
|---|---|---|---|
| **MDX-Net Kim_Vocal_2（默认）** | **49/58 = 85%** | 89 s（CPU） | **onnxruntime（无 torch）** |
| Demucs htdemucs | 46/58 = 79% | 25 s（GPU） | torch 7.2 GB |
| 不分离 | 46/58 = 79% | 0 | — |
| HPSS（零依赖兜底） | — | 极快 | 无，但质量差 |

**质量反而更好，代价是慢 3.5 倍**（CPU 89 秒 vs GPU 25 秒）。要 GPU 加速得装 onnxruntime-gpu，
它要求的 cuDNN 版本和 ComfyUI 用的常冲突——这正是这一版想摆脱的耦合，所以默认就用 CPU。

### 后端怎么选

```
--separator auto   （默认） 有 ONNX 权重 → MDX；否则 demucs；再否则 hpss
--separator onnx   强制 MDX（无 torch）
--separator demucs 强制 Demucs（要 torch）
--separator hpss   零依赖兜底：只做谐波/打击分离，和弦与旋律会被污染
--separator none   不分离
```

模型**不进仓库**：`deps.manifest.json` 里只记 URL、字节数、MD5，首次运行时下到 `models/uvr/`（63.7 MB）。
下载失败不报错，分离会自动退到 demucs / hpss。

### 参数为什么是这些

不猜。模型的输入形状是 `[batch, 4, 3072, 256]`，`n_fft` 用已知歌词实测选定：

| n_fft | 逐行命中 |
|---|---|
| **7680** | **85%** |
| 6144 | 72% |

### 已知限制

- MDX 是 **2-stem**（人声 / 伴奏），没有单独的鼓与贝斯。结构分析的"鼓"是从**原始混音**取打击分量近似的，
  所以 `sound_structure` 在有 ONNX 后端时对"有没有鼓"的判断不如 Demucs 精细。
- 电平用 RMS 对齐（模型自带的 `compensate` 未知），**只影响音量，不影响转写**。
- CPU 分离 2.3× 实时：4 分钟的歌约 90 秒。

---


## 1.0.1 修了什么（重要：崩溃修复）

上一版在**某些机器上会原生崩溃**（Windows 退出码 `3221226505` / `0xC0000409`，堆损坏，没有 Python 栈），触发条件是 **Demucs(torch) 和 whisper(ctranslate2) 同进程 + 多次 transcribe 调用**。已在 1.0.1 从三个层面堵住：

| 修复 | 做法 | 效果 |
|---|---|---|
| **分离进程隔离** | Demucs 改到子进程跑，只写 flac；主进程读回来再喂 whisper | 转写进程不再初始化 CUDA（实测 `torch.cuda.is_initialized() = False`，显存占用 0） |
| **集中调用不碰 torch** | `sound_read`（= `all`）里强制旋律跟踪走 `pyin`，不 import torchcrepe | 一次调用里不再同时出现 torch 和 ct2 |
| **安全退出** | 结果打印并 flush 后 `os._exit(0)`，跳过解释器清理 | 即使环境有隐患，也绕开崩溃发生的那段收尾 |

另外把逃生口露出来了：

- 工具参数 **`vadMode`**（`auto` / `vocals` / `off` / `mix`）。人声切块崩了就传 `off`——整段一次转写，文字质量不变，代价是失去"不编词"保护。
- 环境变量 `SOUNDTRY_INPROC_SEPARATE=1`（回到同进程分离，省 2–3 秒）、`SOUNDTRY_TRACKER=torchcrepe|pyin|auto`、`SOUNDTRY_SAFE_EXIT=0`。

实测（252 秒的歌、带歌词提示、RTX 4070）：
- 冷缓存（含子进程分离）40 秒 → 热缓存 13 秒，**逐行识别仍是 58/60**，与 1.0.0 一致（进程隔离没有质量代价）。
- 六个工具回归 6/6。

---


让 agent 听得见声音：转写、测节奏、抽旋律、认和弦、切段落——全部在本机跑，零 API 费用。

在 0.1.x 的基础上改了两件事，其它能力原样保留。

---

## 1.0 改了什么

### ① 模型：large-v3 → **medium**

| | large-v3（0.1.x） | **medium（1.0）** |
|---|---|---|
| 权重体积 | 2948 MB | **1457 MB** |
| 逐行歌词识别（252 秒歌、有歌词提示） | 60/60 = 100% | **58/60 = 96.7%** |
| 热缓存下转写一条 252 秒的歌 | 21 s | **13 s** |
| 内存/显存 | 4.1 GB | **约 2.5 GB** |

代价是每 60 行歌词会漏 2 行；换来的是**一半磁盘、四成时间**。想回退：

```powershell
$env:SOUNDTRY_MODEL='large-v3'    # 然后删掉 runtime/ready.json 让它重装
```

### ② 依赖：从"隐式借用"改成"显式声明 + 自己装"

0.1.x 的文档里要专门写一张表，说明"哪些是自带的、哪些是借 ComfyUI 的"——因为 `ctranslate2`、`av` 这类包实际解析到了 ComfyUI 的 site-packages，靠的是 venv 的 `--system-site-packages` 隐式生效。

1.0 把它们全部写进 [`deps.manifest.json`](deps.manifest.json)，并在**第一次调用工具时自己装**：

```
第一次调用 sound_read
  → 探测依赖源（环境变量 → 配置 → 自动发现 ComfyUI → PATH）
  → 决定模式（borrow / standalone）
  → 建 venv → pip install → 下载模型 → 备好 ffmpeg → 写 runtime/ready.json
  → 才开始真正转写
```

进度打到 stderr，装完记 `runtime/ready.json`（模式 + 依赖源 + 模型 + 清单摘要）。三者任一变化就重装；想强制重装就删掉这个文件。

手动触发一次：

```powershell
node src/deps.js
```

---

## 六个工具

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `sound_read` | 一次给全：逐句时间码 + BPM/切点对位 + 人声旋律 + 和弦 | 想快速搞清"这条视频在说什么、什么调、什么和弦" |
| `sound_transcribe` | 语音/歌词 → 带时间码文本，可写 SRT，可切窗口 | 要字幕、要引用台词、要确认有没有旁白 |
| `sound_rhythm` | BPM（网格回套+相位连续性+偶奇拍判据）、鼓组能量、切点踩拍率 | 判断"是不是跟着音乐剪的""为什么这段更急" |
| `sound_melody` | **人声轨**上的音域、调性、最常出现的音、指定窗口的音高轮廓 | 判断副歌有没有升、句子跳了几度 |
| `sound_chords` | 缓和过的和弦时间轴（拍点级），含各和弦持续时长 | 判断四和弦循环、副歌换不换和弦、预副歌在哪抬起来 |
| `sound_structure` | 段落边界（前奏/主歌/副歌/间奏/断口/尾奏）+ 人声进、鼓进、峰值的精确时刻 | 要按段落切片、找高潮在哪、对比两首歌的结构 |

```js
sound_read      input="D:/片子.mp4"
sound_transcribe input="D:/课.mp4" start=600 end=720 srt="D:/课_10min.srt"
sound_rhythm    input="D:/歌.mp4" video="D:/歌.mp4"
sound_structure input="D:/歌.flac"
sound_melody    input="D:/歌.mp4" windows=["副歌:78:82","主歌:33:37"]
sound_chords    input="D:/歌.flac"
```

**`sound_structure` 的精度**：0.25 秒窗、不做中值滤波、只吸收短于 2 秒的碎片，边界报到 0.1 秒。实测人声进入与转录的首词相差 0.15 秒。（用 1 秒窗 + 3 秒中值滤波的粗版会漂 1–3 秒，最多到 5 秒。）

---

## 怎么做到"不编词"

whisper 在没人声的地方会**主动编**：演职员表、"点赞订阅"、字幕组——这些句子长度和语速都完全正常，靠长度/语速判据抓不住。这里的做法是**从源头堵**：

1. **分离出人声轨**（默认 MDX-Net ONNX；也可 demucs / hpss）；
2. 在人声轨上按能量找人声区间（阈值取 P90 的 25%，抗得住主歌小声/副歌大声）；
3. 把邻近区间**合并成 30 秒量级的块**（切太碎会让 whisper 失去上下文，"暧昧告诉我不能这样"会变成"美国是我本人最爱"）；
4. 只把这些块送进 whisper —— 前奏、间奏、尾奏根本不参与识别，**没有机会编**；
5. 剩下两道兜底：已知幻觉词表 + 逐秒人声占比。

实测同一首 252 秒的歌：整条转写会编 1 段"点赞订阅"；切分后 **0 段幻觉**，歌词质量不变。

### 怎么确认门控真的生效

转写报告里必须有这一行：

```
（人声切分：整段 148.6s → 1 块、共 125.0s，其余跳过）
```

**没有这行，就说明门控被绕过了。** 三条路径会绕过它，绕过时报告顶部会强制出现：

```
# ⚠ 未启用人声门控（separate=false）：whisper 会看到器乐段，可能在无人处编词。
  要防幻觉请用默认的 separate=true + vad_mode=auto。
```

| 绕过方式 | 为什么会有人这么干 | 代价 |
|---|---|---|
| `separate=false` | 想快一点 | whisper 直机器乐段，实测前奏被编成 `Zither Harp` |
| `separator=none` | 以为"不分离"更干净 | 同上（该开关现在明确不走缓存） |
| `vadMode="off"` | 1.0.0 时代崩溃时的逃生口 | 1.0.2 已不崩，**这个逃生口不再需要** |

JSON 里也能查：`"gate": "on" \| "off"`，以及 `"gate_reason"`。

> 同一首 `TC - 熄灭` 的实测：默认在 10.10s 才开始，句句是歌词；`--no-separate` 在 8.68s 编出 `Zither Harp`。

---

## 数字上的诚实

这个插件里凡是"可能不可信"的地方都会自己说出来：

| 数值 | 不确定性怎么表达 |
|---|---|
| BPM | `ambiguous`（与次选差 <10%）/ `level`（半倍速、3:2 等节拍层级）/ `conflict`（与 librosa 分歧） |
| 切点 | 硬切（阈值 0.45）与所有变化（阈值 0.30）**双阈值同时报** |
| 歌词 | 逐行覆盖率 + 未认出清单 |
| 和弦 | 描述里明说"根音可信、品质（maj7 vs m）不可信" |
| 结构 | 判定阈值（人声/鼓）随输出打印，可复核 |

---

## 配置

配置文件 `~/.dsh/soundtry.json`（找不到时回退到旧版的 `~/.dsh/soundtry.json`）：

```json
{
  "python":     "D:\\ComfyUI\\ComfyUI-aki-v2\\python\\python.exe",
  "comfyui":    "D:\\ComfyUI\\ComfyUI-aki-v2",
  "deps":       "borrow",
  "model":      "medium",
  "ffmpeg":     "",
  "device":     "cuda",
  "compute":    "float16",
  "pypi":       "https://pypi.tuna.tsinghua.edu.cn/simple",
  "extraPath":  []
}
```

环境变量优先于配置文件：`SOUNDTRY_PYTHON` · `SOUNDTRY_DEPS` · `SOUNDTRY_MODEL` · `SOUNDTRY_DEVICE` · `SOUNDTRY_COMPUTE` · `SOUNDTRY_PYPI` · `SOUNDTRY_FFMPEG` · `SOUNDTRY_CUDA_LIB`。

---

## 安装

```powershell
node --expose-internals "<DSH>\resources\app\lib\plugin-cli.js" desktop install C:\Users\<你>\.dsh\plugins\dsh-soundtry
```

> ⚠️ **工具名与 0.1.x 完全相同**（`sound_read` / `sound_transcribe` / …）。两个同时启用会撞名，**装 1.0 前先卸掉旧版**。

自检：

```powershell
node src/deps.js                                    # 装依赖 + 下模型
runtime\venv\Scripts\python.exe python\soundtry.py doctor
```

---

## 已知局限

- **和弦品质**（maj7 vs m、6 vs m7）只有 60–75% 帧准确率。没有用 essentia（无 Windows 轮子）或 madmom（只有源码包），是手写模板 + Viterbi。
- **没有小节线/调式切分**：只给和弦时间轴，不给"第几小节"。
- **台风/音乐剧类强混响录音**的和弦容易糊。
- **审美判断做不了**：它能测"这里 6% 的切点踩在拍上"，测不出"这段好不好听"。
- `standalone` 模式未经本机实测（见上）。

---

## 许可

MIT。**代码**是 MIT；**模型权重不在本仓库**，各自遵循上游许可，首次运行时由用户机器下载：

| 权重 | 来源 | 体积 | 许可 |
|---|---|---|---|
| whisper medium（faster-whisper 格式） | [ModelScope](https://www.modelscope.cn/models/pengzhendong/faster-whisper-medium) | 1457 MB | Whisper 原许可（MIT） |
| MDX-Net Kim_Vocal_2（ONNX） | [hf-mirror: audio-separator-models](https://hf-mirror.com/lainlives/audio-separator-models) | 63.7 MB | 随 UVR 生态分发，商用前请自行核对上游 |
| Demucs htdemucs（可选后端） | Meta，首次分离时 torch.hub 下载 | 80 MB | MIT |

