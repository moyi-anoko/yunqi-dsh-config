# dsh-cixisound

**DSH 的本地听觉插件 · 1.0.3（DSH-CixiSound）**

让 agent 听得见声音：**转写、节奏、旋律、和弦、结构**六件套，全部在本机跑，零 API 费用。

- **人声分离默认走 UVR MDX-Net**（onnxruntime 推理，**不需要 torch**）——快嘴说唱上比 Demucs 还准
- **依赖是声明的，不是猜的**：`deps.manifest.json` 列清每一样；首次运行时自己装、自己下模型
- **权重不进仓库**：仓库只记 URL、字节数和 MD5，63.7 MB 的分离模型 + 1.46 GB 的 whisper medium 都在你机器上下
- **不可信的地方会自己说**：BPM 有 `ambiguous`/`level`/`conflict` 三态，切点双阈值同时报，和弦明说"根音可信、品质不可信"
- **设置就在插件里**：**插件 → 已安装 → dsh-cixisound** 详情页里有「声音分析」区块，可切 CPU/GPU、分离后端、模型；显存 < 4 GB 时自动锁 CPU 并给出提示

## 统一声明

- 这个插件**可以单独理解音乐**，也可以**配合其他画面理解插件一起理解视频**
- 经测试，也可以让**刷 B 站的鱼**（`dsh-bili-whale`）更好地理解视频内容噢
- ⚠️ 本地推理几乎不消耗 token，但**处理速度会因电脑配置不同而有不同表现**，属正常现象
- 所以**一般建议在“鱼”凭借其他依据没法很好理解视频时使用**
- 有任何问题可以在**评论区反馈**，也可以加入 **QQ 群：1130719501** 提出你的宝贵意见
- 插件地址：<https://github.com/CixiSVesper/dsh-soundtry>


## 运行要求

**只要一个 Python 解释器，不需要 ComfyUI，也不需要机器上有 torch。**

插件自带一个隔离 venv（`runtime/venv`，建的时候**不加** `--system-site-packages`），
依赖和模型全部落在插件目录里。ComfyUI 删掉不影响；机器上没装过 torch 也能跑。

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows 10/11 x64** | 路径与 PATH 分隔符目前按 Windows 写死 |
| Python | **3.10 – 3.12**（只当解释器） | 3.13 上 `ctranslate2` 没有轮子，会去源码编译，别用 |
| 磁盘 | **约 2.5 GB** | venv 607 MB + whisper medium 1457 MB + MDX 64 MB + ffmpeg 62 MB |
| 内存 | **6 GB 可用**，8 GB 推荐 | 实测 4 分钟歌「分离+转写」峰值 4.42 GB |
| CPU | 4 核起 | MDX 分离约 2.3× 实时 |
| 显卡 | **不需要** | 见下面「关于 GPU」 |
| ffmpeg | 需要一份 | 会自动复制进 `vendor/ffmpeg` |

### venv 里到底装了什么

```
faster-whisper 1.2.1 + ctranslate2 4.8.4   ← 转写
onnxruntime 1.31.1                          ← MDX-Net 分离
librosa 1.0.0 + numpy 2.5.4 + scipy 1.18.1 + soundfile 0.14.0  ← 节奏/旋律/和弦/结构
```

**没装 torch、demucs、torchcrepe**——它们会把 torch（2.5 GB）拖进来。代价写在「已知局限」里：
`demucs` 后端不可用（默认本来就用 MDX-Net）、音高跟踪用 `pyin` 而不是 `torchcrepe`。

### 关于 GPU

- **分离**：MDX-Net 走 CPU，这是刻意的（onnxruntime 的 CUDA 版要 cuDNN 8，和 ComfyUI 常用的 cuDNN 9 冲突）
- **转写**：ctranslate2 想用 CUDA 就要 `cublas64_12.dll` / `cudnn`。venv 里没有，会**自动回退 CPU int8** 并在报告顶部提示。要 GPU 转写就再装两个轮子：

```powershell
runtime\venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

## 1.1.6：torch / torchaudio 彻底移出默认依赖

有用户反馈"这个插件依赖 Python venv + torchaudio cu129"。核实结论：

| 版本 | 会不会要求 torchaudio |
|---|---|
| **线上 1.0.2**（GitHub v1.0.2） | ✅ **会**。它的 `borrow` 模式默认装 `demucs`，而 demucs 拉 `torch` + `torchaudio`，从 ComfyUI 借到的正是 `2.8.0+cu129`，doctor 里也直接显示这一行 |
| **1.1.x 默认（selfcontained）** | ❌ 不会。pip 清单里根本没有 torch，实测 `torch / torchaudio / torchcrepe / demucs` 全部 NOT installed |
| 1.1.x 的 borrow / standalone | 原先仍会装 demucs → 同样拖 torch；**1.1.6 起默认不再装** |

### 改了什么

- `borrow.pip` 从 `faster-whisper, demucs, torchcrepe` 收窄为 **只有 `faster-whisper`**
- `standalone.pip` 去掉 demucs/torchcrepe；`torchIndex` / `torchPackages` 字段删除
- demucs 变成**显式开关**：`SOUNDTRY_WITH_DEMUCS=1`（或配置 `withDemucs: true`）才会装
  `torch` + `torchaudio`（cu129，约 2.5 GB）再装 demucs、torchcrepe

### 代价（诚实写）

不装 demucs 之后，分离的降级链从 **MDX-Net → Demucs → HPSS** 变成 **MDX-Net → HPSS**。
MDX 是默认且实测更好的那条（快嘴说唱逐行 85% vs Demucs 79%），所以影响很小；
想用 Demucs 的用户显式开启即可。

## 1.1.5：建"调内和弦库"+ 加权余弦打分 + 按调筛选（品质专用）

### 库是什么（固定表，不是每首歌新建）

`build_key_library()` 用乐理规则生成 **24 个调 × 18–21 个和弦**（共约 470 条映射），
引用已有的 144 个模板，不新增和弦定义。装进插件就固定不变；
每首歌只做"定调 → 取其中一行 → 只在这 18 个里匹配"。

每调包含三档：
1. 自然音级三和弦 7 个
2. 自然音级七和弦 7 个
3. 借用/副属（V7/x、和声小调属和弦、bVII/bVI/iv）—— 让借用和弦仍有位置

### 打分换成加权余弦

旧式 `inside − 0.5(1−inside) − bonus` 的判别余量（选中 vs 换根音的最佳）中位仅 **0.0099**，
一半帧 <0.01，等于在并列里随机挑。换成归一化加权余弦（根 1.0 / 三 0.9 / 五 0.6 / 七 0.5）后，
归一化余量中位 **0.074**（约 4 倍）。

### 段级回退

窄化必须有退路：某段若"库外最佳"比"库内最佳"高出 0.06，该段退回全库选，
并打 `fallback` 标记。这样定调不准时不会被整首裁死。

### 实测（One Last Kiss）

| 指标 | 建库前 | **建库后** |
|---|---|---|
| 调外和弦 | 3/43（7%） | **0/23（0%）** |
| 置信度中位 | 0.00 | **0.06** |
| 段数 / 平均段长 | 43 / 5.9s | **23 / 10.9s** |
| 出现的品质种类 | 15 种 | **8 种**（抖动更少） |
| 调内候选 | 144 | **18** |

定调：G# minor（Krumhansl 相关 0.70），与实测调性一致。

**仍然要说清**：以上都是**间接指标**（调内一致性、判别余量、稳定性），
**不是准确率**——没有人工标注就无法报真实品质准确率。要测准，需要一首歌标 10–15 个和弦。

### 新增参数

```
--key G#m / C / F#major    强制调性（定调错时才用；默认全自动）
```

## 1.1.4：四项优化（按"先测量 → 再改 → 用实测验收"做的）

### ① melody 八度纠正：从 4 个八度的假音域修到 1.5–3 个八度

pyin 在人声混响/伴唱时会在基频与倍频之间整八度跳，旧实现直接取 `nanmin/nanmax`，
OLK 报出 **E2–C6**（女声流行不可能）。

修法：pyin 的 `voiced_flag` 过滤 + 向**局部 1 秒中值**折回八度 + 音域改用 5–95 分位。

| 歌 | 修正前 min–max | 修正后（5–95 分位） |
|---|---|---|
| One Last Kiss | E2–C6 | **G#3–C#5** |
| 空山•野马 | E2–G5 | **F2–D#5** |
| 下一篇章 | E2–C6 | **D#4–A5** |

**过程中失败两版，都留在代码注释里**：① 用"前一帧已修正值"比较会级联，8 千帧里折了 5848 帧、
音域被推到 G#10；② 半音换算漏了 MIDI 基准（写成 `12*log2(f)`），整体偏高若干八度。

### ② structure 用自相似+新颖度切分：3 段 → 7 段

旧实现只有 4 状态游程合并，副歌 57.5–235s 一条到底，桥段切不出来。
加入 SSM + 棋盘核（Foote）新颖度，只在 >32 秒的段内找切点（间隔 ≥14 秒、每段最多 3 刀）。

```
0:00.0–0:15.0  断口/器乐
0:15.0–0:57.5  器乐段
0:57.5–1:14.8  器乐段
1:14.8–1:39.5  主歌
1:39.5–2:06.2  主歌
2:06.2–3:55.0  主歌（峰值）
3:55.0–4:12.0  断口/器乐
```

**仍未解决（诚实记）**：2:06–3:55 还是 108 秒一段（受"每段最多 3 刀"限制），
且标签体系仍粗（主歌/副歌/器乐靠人声与能量的相对水平判）。

### ③ chords：修 `root_of` 的降号丢失 bug + 只报根音 + 低音判转位

**最重要的是一条既有 bug**：`root_of` 写成 `label[0] if label[1] in "#b"`，返回单字符，
`G#maj7` 被解析成 `G`，于是 **G 和 G# 被当成同一根音合并**。修正后"只报根音"从
`G 134s` 变成 **`G# 118s`**（与实际调性 G# minor 一致）。

新增：
- 每段 `confidence`（与"换一个根音的最佳分"的差距，按候选分跨度归一化）
- `roots_only`：只报根音（品质本来就不可信）
- 转位：用**已分离的 bass 轨**判断，且只有"低音是和弦音且不是根音"才算。第一版标了 35/43 段假转位，收紧后 **2 段**（G#/C）

**置信度只能给相对值**：模板分对不同根音本来就只差一点点（G#maj7 与 D#m7 共享两个和弦音），
绝对阈值会让 43 段全部判"存疑"。所以改成按分位数取前 25%，实测 **11/43 段（26%）**。

### ④ transcribe 低覆盖重试：实现了，但**默认关闭**

与"幻觉门控"对称：门控防编造，重试防漏。对覆盖率 <40% 的短块（<60s）用更高 beam、
去掉 prompt 重跑，只有覆盖率提升 >8% 才采纳。

**实测不划算**：三次测试两次"采纳 0 块"却多花约 3 分钟（空山野马整体跌到 0.5x）。
所以默认关闭，需要时 `--retry-low-coverage` 或 `SOUNDTRY_RETRY=1`。

## 1.1.3：裁掉 17 个未使用的包（省 66 MB）+ CPU 默认 int8

用「运行时导入拦截」实测（拦了再跑，不是看 import 语句）：
17 个包在 all / rhythm / transcribe 三条路径上全都不被加载，已卸载。

| 类别 | 体积 |
|---|---|
| venv | 609 MB → **543 MB** |
| 插件总计 | 2,287 MB → **2,221 MB** |

被裁的代表：scikit-learn(40.7 MB)、hf-xet(9.4)、
arwhals(4.5)、protobuf(2.6)、
sspec(1.7)、ilelock(1.2)、nyio(1.2)、httpx2(1.0)、urllib3(0.9)、
click(0.9)、
equests(0.5)、httpcore2(0.6)、idna(0.6)、latbuffers(0.2)、
h11(0.2)、	hreadpoolctl(0.2)、certifi(0.2)。

**保留 pip / 	ruststore**（11 MB）：安装依赖那一步要用，删了以后装不了包。

另修一处性能问题：--compute 默认是 loat16，在 CPU 上慢一个数量级。
现在设备落在 CPU 时自动用 **int8**（实测 30 秒片段：float16 21.9s → int8 16.9s）。

## 1.1.2：强拍默认值修正（WB 的证据推翻了我的判据）

1.1.1 用「四个相位的底鼓平均幅值」选第 1 拍，在 One Last Kiss 上选中 #1，而正确是 #3 —— 差半小节。

WB 给的反证很干净：37.849s 那一下幅值 281.8，前 2.5 秒只有 0.2，是 **200 倍跳变**。
按绝对响度，全场最响的 10 下里有 6 下落在 #1；按**相对前 2.5 秒的跳变**，前 6 名里 5 个落在 #3。

工具真正该看的不是哪一拍最响，而是哪一拍是从无到有重新开始的——强拍的定义就包含这一层。

改后不指定任何参数：

`
判据来源 jump · 选中 #3 · 首强拍 1.4285s
跳变投票 [0, 1, 0, 5] · 前 4: 37.856s(2067×) / 164.31s(102×) / 157.888s(65×) / 97.854s(60×)
第 18 小节线 = 37.8576s
`

WB 独立拟合 37.861s（差 3.4ms），手动 --downbeat 3 给 37.8576s（完全一致）——
**现在默认就是那个值，不用再手动指定。**

判据弱的时候（跳变票数 <2）仍退回幅值，并保留「强拍归属不确定」的警告与 --downbeat 覆盖。

## 1.1.1：周期与相位不再被帧格钉住（WB 指出的三处，已修）

之前这套代码有一个结构性毛病：**在 23.22ms 的帧格上估计周期**。
`0.53406s` 恰好是 23 帧，真值 `23.071` 帧永远取不到——每拍差 1.65ms，
乘 468 拍就是 0.77 秒，够把整片错开一拍半。

| 环节 | 旧做法 | 现在 |
|---|---|---|
| 峰位 | `peak_pick` 只给整数帧 | **±3 帧能量重心**把峰推到小数帧（亚帧） |
| 周期 | `median(diff(beats))` / 自相关 lag | **圆周相干搜索 + 紧容差最小二乘回归**（几百个峰的量化噪声互相抵消） |
| 验收 | 吸附到最近峰的条数、尾差 | **折叠对齐剖面**：把包络按候选网格折叠，看 0 处是否真出峰（不需要任何网格参数先验） |
| 强拍 | `<110Hz` 均值在无鼓前奏上投票 | 底鼓能量四相位择优；分歧 <15% 时明确报「归属不确定」，并可用 `--downbeat 0..3` 覆盖 |

实测 One Last Kiss（WB 参照：0.535711s / 112.001 BPM / 残差 7.1ms）：

```
回归 BPM 111.998 → 每拍 0.535722s = 23.072 帧（真值 23.071）
最小二乘：263/324 个强峰 · 残差 RMS 6.18ms · 圆周相干 0.727
折叠剖面验收：拍级对比度 76.8 · 小节级 125.7 → 可信
末端独立对照：最后一个强峰离最近拍线 -0.4ms
```

对比旧版 0.53538s（23.057 帧，0.33ms/拍，468 拍累计 155ms）→ 现在 **0.011ms/拍，累计 5ms**。

**判定门槛是硬的**：对比度 >8 可信、4–8 勉强、<4 不可信。同一套代码在《我想要占据你》上只有 4.3，
于是它如实报「勉强，别直接拿来切」——换以前，它会照样输出一张看起来很确定的网格。

两点仍然是人工的：

- **强拍归属**（哪一拍算第 1 拍）。OLK 上四个相位的底鼓强度只差 10.6%，算法不该替你决定；
  报告会给四个幅值，用 `--downbeat` 指定。
- **"这里该停一秒"**。算法只报"鼓消失一小节又回来"的候选（判据用打击分量，不用总能量），
  决策必须戴耳机。

## 1.1.0：自带隔离环境，不再依赖 ComfyUI

1.0.x 的「borrow 模式」靠 `--system-site-packages` 借 ComfyUI 的 Python 包——省空间，但
ComfyUI 一删插件就废，机器上没有 torch 也跑不起来。1.1.0 改成 **selfcontained**：

- venv 用 `--system-site-packages` **关掉**，依赖自己装（607 MB），实测看不到系统的 numpy/torch
- 分离模型（`models/uvr/Kim_Vocal_2.onnx`，63.7 MB）下到插件里，MD5 校验过
- 加了三处**诚实性修复**：转写 GPU 不可用时自动回退并明说；`demucs/torchcrepe/torch`
  在 doctor 里标成「可选」而不是「失败」（14/14）；报告里的分离后端不再写死成 Demucs
- 保留 `borrow` / `standalone` 两种模式作为可选（`SOUNDTRY_DEPS=borrow`）


## 设置项（在插件详情页里）

打开 **插件 → 已安装 → dsh-cixisound**，详情页底部有「声音分析」：

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
node --expose-internals "<DSH>\resources\app\lib\plugin-cli.js" desktop install C:\Users\<你>\.dsh\plugins\dsh-cixisound
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

