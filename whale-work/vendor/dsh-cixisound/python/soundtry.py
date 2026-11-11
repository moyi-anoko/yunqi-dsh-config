#!/usr/bin/env python
"""
soundtry.py — DSH-SoundTry 的本地音频理解后端。

放在插件里的原因：它只用「本插件打包的 runtime venv + 借来的 ComfyUI torch/CUDA」，
不碰系统 Python、不装第二个 torch。

子命令：
    transcribe   语音/歌词 → 带时间码的文本（faster-whisper）
    rhythm       BPM（网格回套+相位扫描）、拍点、鼓组进场、切点对位
    melody       旋律线：音域/调性/音高轮廓（pyin，可选 torchcrepe / Demucs）
    all          一次给上面三样的摘要（面向"看懂一条视频"）

约定：
    * 音频一律用 ffmpeg 解码成 16k 单声道再交给 numpy——
      刻意不走 PyAV：faster-whisper 传的 metadata_errors 会随 av 版本变而崩。
    * 机器可读结果打在最后一行：@@JSON@@{...}
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = PLUGIN_ROOT / "models"
DEFAULT_MODEL = os.environ.get("SOUNDTRY_MODEL", "medium")   # 1.0：默认 medium（1.4 GB），不再用 large-v3（2.9 GB）
CACHE_DIR = PLUGIN_ROOT / "cache"
JSON_MARK = "@@JSON@@"

# demucs 的权重缓存也放插件里；huggingface 直连被拦，别在那儿等 10 秒超时
os.environ.setdefault("TORCH_HOME", str(MODELS_DIR / "torch"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("DEMUCS_OFFLINE", "1")

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


# ─────────────────────────── 环境 ───────────────────────────
def find_ffmpeg() -> str:
    for key in ("DSH_FFMPEG_PATH", "DSH_VIDEO_FFMPEG", "FFMPEG_PATH", "SOUNDTRY_FFMPEG"):
        p = os.environ.get(key)
        if p and os.path.isfile(p):
            return p
    p = shutil.which("ffmpeg")
    if p:
        return p
    for cand in (
        PLUGIN_ROOT / "vendor" / "ffmpeg" / "ffmpeg.exe",
        Path.home() / ".dsh/plugins/dsh-video-vision/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe",
    ):
        if Path(cand).is_file():
            return str(cand)
    raise SystemExit("找不到 ffmpeg：设 DSH_FFMPEG_PATH，或把 ffmpeg 放进 <插件>/vendor/ffmpeg/")


def load_audio(path: str, sr: int = 16000):
    import numpy as np
    import soundfile as sf

    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            [find_ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error",
             "-i", path, "-vn", "-ac", "1", "-ar", str(sr),
             "-c:a", "pcm_s16le", "-y", wav],
            check=True, capture_output=True,
        )
        data, got = sf.read(wav, dtype="float32", always_2d=False)
        if data.size == 0:
            raise SystemExit("音轨为空（这条视频可能没有音频流）")
        if got != sr:
            raise SystemExit(f"重采样失败：得到 {got}Hz")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return np.ascontiguousarray(data)
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


def has_audio(path: str) -> bool:
    ff = find_ffmpeg()
    try:
        p = subprocess.run(
            [ff, "-hide_banner", "-nostdin", "-i", path],
            capture_output=True, text=True, errors="ignore", timeout=60,
        )
    except Exception:
        return False
    return "Stream #" in p.stderr and "Audio:" in p.stderr


def has_video(path: str) -> bool:
    ff = find_ffmpeg()
    try:
        p = subprocess.run(
            [ff, "-hide_banner", "-nostdin", "-i", path],
            capture_output=True, text=True, errors="ignore", timeout=60,
        )
    except Exception:
        return False
    return "Stream #" in p.stderr and "Video:" in p.stderr


# whisper 在无人声段最常"背"出来的几句话（训练数据里的固定套路）。
# 这些句子本身完全像人话，靠长度/语速判据抓不到，只能点名。
HALLUCINATION_PATTERNS = [
    r"请?不?吝?点赞", r"订阅", r"转发", r"打赏", r"明镜与点点", r"点点栏目",
    r"字幕由.{0,8}(提供|制作)", r"感谢(观看|收看)", r"字幕组",
    r"中文字幕", r"字幕提供", r"字幕制作", r"翻译[：: ]", r"校对[：: ]",
    r"Amara\.org", r"subtitle", r"Thanks? for watching",
    r"作曲[：: ]", r"作词[：: ]", r"编曲[：: ]", r"制作人[：: ]", r"录音[：: ]",
    r"出品[：: ]", r"发行[：: ]", r"监制[：: ]", r"混音[：: ]",
]


def looks_hallucinated(text: str) -> bool:
    import re
    t = (text or "").strip()
    if not t:
        return True
    return any(re.search(p, t, flags=re.I) for p in HALLUCINATION_PATTERNS)
_stem_cache = {}
_BACKEND = {"name": None}   # 实际用的分离后端，报告里不许写死



def _stems_dir(path: str):
    st = os.stat(path)
    tag = f"{st.st_size}-{int(st.st_mtime)}"
    return CACHE_DIR / "stems" / tag



_BACKEND_LABEL = {"mdx-onnx": "MDX-Net ONNX", "demucs": "Demucs", "hpss": "HPSS"}

def backend_label(default="未知"):
    """当前这组 stems 是哪个后端产出的（缓存命中时从 backend.txt 读）。"""
    if _BACKEND["name"]:
        return _BACKEND_LABEL.get(_BACKEND["name"], _BACKEND["name"])
    return default

def _read_stems(outdir):
    """只读缓存，不碰 torch。"""
    got = {}
    for n in ("vocals", "bass", "other", "drums"):
        p = outdir / f"{n}.flac"
        if not p.is_file():
            return None
        y, _ = _sf_read_16k(str(p))
        got[n] = y
    return got


def stems_for(path: str, use_gpu: bool = True, separator: str = None):
    """Demucs 分轨，缓存到 <插件>/cache/stems/<size>-<mtime>/。

    **进程隔离**：Demucs（torch）默认在子进程里跑，只把 flac 写到磁盘；主进程再读回来。
    原因是实测到的一类原生崩溃——torch 和 ctranslate2 同进程时，在某些机器上会在
    解释器退出阶段堆损坏（Windows 0xC0000409），而 whisper 和 demucs 恰好都要用。
    子进程隔离之后，转写进程里根本没有 torch，这类崩溃就不可能发生。

    想退回同进程（省一次 python 启动，约 2–3 秒）：设 SOUNDTRY_INPROC_SEPARATE=1。
    """
    key = (path, use_gpu)
    if key in _stem_cache:
        return _stem_cache[key]

    outdir = _stems_dir(path)
    sep = (separator or os.environ.get("SOUNDTRY_SEPARATOR") or "auto").strip().lower()

    # separator=none 表示"明确不分离"：连缓存都不该用，否则这个开关等于没写
    # （缓存里有别的后端留下的轨时，它会静默生效，和用户意图相反）。
    if sep == "none":
        _stem_cache[key] = None
        return None

    # 缓存命中：只读文件，此路径完全不 import torch
    got = _read_stems(outdir)
    if got:
        bf = outdir / "backend.txt"
        if bf.exists():
            _BACKEND["name"] = bf.read_text(encoding="utf-8").strip() or None
        _stem_cache[key] = got
        return got

    # ① ONNX（MDX-Net）：默认后端，全程不碰 torch
    if sep in ("auto", "onnx") and mdx_model_path():
        try:
            got = _separate_onnx(path, outdir)
            if got:
                _BACKEND["name"] = "mdx-onnx"
                _stem_cache[key] = got
                print("# （分离后端：MDX-Net ONNX，onnxruntime，无 torch）")
                return got
        except Exception as e:
            print(f"# （MDX 分离失败：{type(e).__name__}: {e}；尝试下一个后端）")

    # ② Demucs：子进程隔离
    if sep in ("auto", "demucs") and _demucs_available():
        if os.environ.get("SOUNDTRY_INPROC_SEPARATE") != "1":
            try:
                cmd = [sys.executable, str(Path(__file__).resolve()), "stems", path]
                if not use_gpu:
                    cmd.append("--no-gpu")
                r = subprocess.run(cmd, capture_output=True, timeout=1800)
                if r.returncode == 0:
                    got = _read_stems(outdir)
                    if got:
                        _BACKEND["name"] = "demucs"
                        _stem_cache[key] = got
                        print("# （分离后端：Demucs，子进程）")
                        return got
                else:
                    # 子进程输出按 UTF-8 解、坏字节替换掉：Windows 上管道默认走 GBK，
                    # 中文日志会直接抛 UnicodeDecodeError，把"分离成功"误判成失败。
                    raw = (r.stderr or b"") + (r.stdout or b"")
                    tail = raw.decode("utf-8", "replace").strip().splitlines()[-3:]
                    print("# （子进程分离失败，改在本进程内做：" + " | ".join(tail) + "）")
            except Exception as e:
                print(f"# （子进程分离异常，改在本进程内做：{type(e).__name__}）")
        got = _stems_inproc(path, outdir, key, use_gpu)
        if got:
            return got

    # ③ HPSS：零依赖兜底（质量差，只保证不空手）
    if sep in ("auto", "hpss"):
        got = _stems_hpss(path, outdir)
        if got:
            _stem_cache[key] = got
            print("# （分离后端：HPSS，仅谐波/打击分离 —— 质量有限，和弦与旋律会被污染）")
            return got

    _stem_cache[key] = None
    return None


def mdx_model_path():
    """MDX-Net 权重在哪（deps 会下到 models/uvr/）。"""
    for name in ("Kim_Vocal_2.onnx", "UVR-MDX-NET-Voc_FT.onnx"):
        p = MODELS_DIR / "uvr" / name
        if p.is_file():
            return p
    return None


def _demucs_available():
    try:
        import importlib.util
        return importlib.util.find_spec("demucs") is not None
    except Exception:
        return False


def _separate_onnx(path, outdir, n_fft=7680, hop=1024, sr=44100, dim_t=256):
    """MDX-Net（UVR）分离，纯 onnxruntime —— 不用 torch。

    参数不是猜的：dim_f/dim_t 来自模型输入形状；n_fft=7680 是用已知歌词实测选出来的
    （7680 → 逐行 49/58 = 85%，6144 → 42/58 = 72%）。
    做法是整轨 STFT + 每 256 帧一块过模型，避免 UVR 那套 chunk 边界补偿。
    """
    import librosa
    import numpy as np
    import onnxruntime as ort

    model = mdx_model_path()
    if not model:
        raise RuntimeError("没有 MDX 权重（models/uvr/*.onnx）")

    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) - 1)
    sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
    dim_f = int(sess.get_inputs()[0].shape[2])

    # 解码成 44.1k 立体声
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "in.wav")
        subprocess.run(
            [find_ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error",
             "-i", path, "-vn", "-ac", "2", "-ar", str(sr), "-c:a", "pcm_s16le", "-y", wav],
            check=True, capture_output=True,
        )
        import soundfile as sf
        y, _ = sf.read(wav, dtype="float32", always_2d=True)
    if y.size == 0:
        raise RuntimeError("解出来的音轨为空")
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    y = np.ascontiguousarray(y[:, :2].T)          # (2, N)

    specs = [librosa.stft(y[c], n_fft=n_fft, hop_length=hop, window="hann", center=True)
             for c in range(2)]
    bins, T = specs[0].shape
    outs = [np.zeros((bins, T), dtype=np.complex64) for _ in range(2)]

    n_blocks = int(np.ceil(T / dim_t))
    for b in range(n_blocks):
        t0, t1 = b * dim_t, min((b + 1) * dim_t, T)
        w = t1 - t0
        block = np.zeros((4, dim_f, dim_t), dtype=np.float32)
        f = min(dim_f, bins)
        for c in range(2):
            s = specs[c][:, t0:t1]
            block[c * 2, :f, :w] = s[:f].real
            block[c * 2 + 1, :f, :w] = s[:f].imag
        res = sess.run(None, {"input": block[None]})[0][0]
        for c in range(2):
            outs[c][:f, t0:t1] = res[c * 2, :f, :w] + 1j * res[c * 2 + 1, :f, :w]

    voc = np.stack([librosa.istft(outs[c], hop_length=hop, window="hann",
                                  center=True, length=y.shape[1]) for c in range(2)])
    voc = voc[:, :y.shape[1]]
    inst = y - voc

    def rms(x):
        return float(np.sqrt(np.mean(np.asarray(x, dtype="float64") ** 2)))

    r_mix, r_voc = rms(y), rms(voc)
    if r_voc > 1e-9 and r_mix > 1e-9:
        voc *= (r_mix / r_voc) * 0.9     # 电平对齐（模型自带的 compensate 未知）

    outdir.mkdir(parents=True, exist_ok=True)
    got = {}
    import soundfile as sf
    for name, arr in (("vocals", voc), ("other", inst)):
        mono = arr.mean(axis=0)
        y16 = _resample_to_16k(mono, sr)
        sf.write(str(outdir / f"{name}.flac"), y16, 16000, format="FLAC")
        got[name] = y16
    # MDX 是 2-stem：鼓与贝斯没有单独分离。
    # 鼓：从**原始混音**取打击分量 —— 不能从去掉人声的伴奏取，那样鼓会被削掉大半，
    #     结构分析会把"有鼓"误判成"没鼓"。贝斯留空（和弦只用 other）。
    import librosa as _lr
    perc = _lr.effects.hpss(_resample_to_16k(y.mean(axis=0), sr), margin=(1.0, 5.0))[1]
    sf.write(str(outdir / "drums.flac"), perc.astype("float32"), 16000, format="FLAC")
    got["drums"] = perc.astype("float32")
    bass = np.zeros_like(got["other"])
    sf.write(str(outdir / "bass.flac"), bass, 16000, format="FLAC")
    got["bass"] = bass
    (outdir / "backend.txt").write_text("mdx-onnx\n", encoding="utf-8")
    return got


def _stems_hpss(path, outdir):
    """零依赖兜底：只分谐波/打击。质量明显不如 MDX/Demucs，仅用于"至少能跑"。"""
    import librosa
    import numpy as np
    import soundfile as sf

    y16 = load_audio(path)
    y = librosa.resample(y16, orig_sr=16000, target_sr=22050)
    harm, perc = librosa.effects.hpss(y, margin=(1.0, 5.0))
    harm16 = _resample_to_16k(harm, 22050)
    perc16 = _resample_to_16k(perc, 22050)
    outdir.mkdir(parents=True, exist_ok=True)
    got = {"vocals": harm16, "other": harm16,
           "drums": perc16, "bass": np.zeros_like(harm16)}
    for name, arr in got.items():
        sf.write(str(outdir / f"{name}.flac"), arr.astype("float32"), 16000, format="FLAC")
    (outdir / "backend.txt").write_text("hpss\n", encoding="utf-8")
    return got


def _stems_inproc(path, outdir, key, use_gpu):
    try:
        import torch
        from demucs.api import Separator
    except Exception:
        _stem_cache[key] = None
        return None

    device = pick_device(use_gpu, need_gb=4.0)
    try:
        import soundfile as sf
        sep = Separator(model="htdemucs", device=device, progress=False)
        # 视频文件不能直接交给 soundfile（只认音频容器），先让 ffmpeg 解成 wav。
        with tempfile.TemporaryDirectory() as td:
            src = path
            if Path(path).suffix.lower() not in (".wav", ".flac", ".ogg", ".mp3", ".m4a", ".aiff"):
                src = os.path.join(td, "in.wav")
                subprocess.run(
                    [find_ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error",
                     "-i", path, "-vn", "-ac", "2", "-ar", "44100",
                     "-c:a", "pcm_s16le", "-y", src],
                    check=True, capture_output=True,
                )
            wav, sr = sf.read(src, dtype="float32", always_2d=True)
        if wav.size == 0:
            raise RuntimeError("解出来的音轨为空")
        tensor = torch.from_numpy(wav.T).contiguous()
        _, out = sep.separate_tensor(tensor, sr)
        outdir.mkdir(parents=True, exist_ok=True)
        got = {}
        for name, data in out.items():
            mono = data.mean(dim=0).cpu().numpy().astype("float32")
            # 存 16k 单声道，够 ASR / pyin / chroma 用，且体积小
            y16 = _resample_to_16k(mono, sr)
            sf.write(str(outdir / f"{name}.flac"), y16, 16000, format="FLAC")
            got[name] = y16
        _stem_cache[key] = got
        return got
    except Exception as e:
        print(f"# （分离失败：{type(e).__name__}: {e}；退回混合信号）")
        _stem_cache[key] = None
        return None


def cmd_stems(args):
    """只做分离、只写 flac —— 给 stems_for 的子进程用。"""
    path = args.input
    outdir = _stems_dir(path)
    outdir.mkdir(parents=True, exist_ok=True)
    got = _stems_inproc(path, outdir, (path, bool(getattr(args, "gpu", True))), bool(getattr(args, "gpu", True)))
    if got is None:
        print("# 分离失败")
        return {"ok": False, "dir": str(outdir)}
    print(f"# 分离完成：{outdir}")
    for n in got:
        print(f"  {n}: {len(got[n]) / 16000:.1f}s")
    return {"ok": True, "dir": str(outdir), "stems": list(got)}


def nvidia_vram_gb():
    """查第一块 NVIDIA 显卡的显存（GB）。查不到返回 None —— 不假装知道。"""
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            return None
        first = (r.stdout or "").strip().splitlines()[0].strip()
        return round(float(first) / 1024.0, 1)
    except Exception:
        return None


def pick_device(want_gpu: bool, need_gb: float = 4.0) -> str:
    """有 GPU 且显存 > need_gb 才用 cuda，否则 cpu。"""
    if not want_gpu:
        return "cpu"
    vram = nvidia_vram_gb()
    if vram is None:
        return "cpu"
    if vram <= need_gb:
        print(f"# （显存 {vram} GB ≤ {need_gb} GB，改用 CPU）")
        return "cpu"
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _resample_to_16k(y, sr):
    import numpy as np
    if sr == 16000:
        return np.ascontiguousarray(y, dtype="float32")
    try:
        import resampy
        return resampy.resample(y.astype("float32"), sr, 16000).astype("float32")
    except Exception:
        import librosa
        return librosa.resample(y.astype("float32"), orig_sr=sr, target_sr=16000)


def _sf_read_16k(path):
    import soundfile as sf
    y, sr = sf.read(path, dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    return y, sr


def vocal_energy(vocals, start, end, hop_ms=50):
    """某段时间里人声轨的短时能量中位数 —— 用来判"这段到底有人在唱吗"。"""
    import numpy as np
    a = max(0, int(start * 16000))
    b = min(len(vocals), int(end * 16000))
    if b <= a:
        return 0.0
    seg = vocals[a:b]
    if seg.size == 0:
        return 0.0
    # 段比一个 50ms 窗口还短时（歌尾、句尾），要退化成整段 RMS，
    # 否则 reshape(1, 800) 会因为只有 427 个采样而抛 ValueError。
    win = min(int(0.05 * 16000) or 1, seg.size)
    n = max(1, seg.size // win)
    frames = seg[: n * win].reshape(n, win)
    rms = np.sqrt((frames.astype("float64") ** 2).mean(axis=1))
    return float(np.median(rms))


# ─────────────────────── 和弦 ───────────────────────
CHORD_TEMPLATES = {
    "": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6], "aug": [0, 4, 8],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7],
    "maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10], "7": [0, 4, 7, 10],
    "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "m7b5": [0, 3, 6, 10],
}


def _clabel(root_pc, quality):
    return f"{NAMES[root_pc % 12]}{quality}"


def estimate_key_from_chroma(chroma):
    """Krumhansl 定调：返回 (根音 pc, 模式, 相关系数)。"""
    import numpy as np
    key_pc, key_mode, best = 0, 'major', -1.0
    for i in range(12):
        for nm, prof in (('major', MAJOR), ('minor', MINOR)):
            r = float(np.corrcoef(np.roll(prof, i), chroma)[0, 1])
            if r > best:
                best, key_pc, key_mode = r, i, nm
    return key_pc, key_mode, best


def parse_key_arg(text):
    """解析 --key，例如 G#m / C / Am / F#minor。解析不出返回 (None, None)。"""
    t = (text or '').strip()
    if not t:
        return None, None
    low = t.lower()
    mode = 'minor' if (low.endswith('m') and not low.endswith('maj')) or 'min' in low else 'major'
    core = t
    for suf in ('minor', 'major', 'min', 'maj'):
        if core.lower().endswith(suf):
            core = core[: -len(suf)]
            break
    if core.lower().endswith('m') and mode == 'minor':
        core = core[:-1]
    core = core.strip().replace('♯', '#').replace('♭', 'b')
    # 允许 Bb 这种写法：换成对应的 # 名
    if core in NAMES:
        return NAMES.index(core), mode
    flat_map = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}
    if core in flat_map and flat_map[core] in NAMES:
        return NAMES.index(flat_map[core]), mode
    return None, None


def build_key_library():
    """调内和弦表：24 个调 → 允许的和弦标签（引用现有模板，不新增和弦定义）。

    每调包含三档：
      ① 自然音级三和弦 7 个
      ② 自然音级七和弦 7 个
      ③ 借用/副属（让"借用和弦"仍有机会被选中，但排在正格之后）

    这张表是**固定的**，装进插件就不再变；每首歌只是"定调 → 取其中一行"。
    实测依据：OLK 调外和弦仅 7%，说明"调内"这个先验成立，代价极小。
    """
    lib = {}
    for r in range(12):
        # 大调：I ii iii IV V vi vii°
        maj = []
        for off, q in ((0, ''), (2, 'm'), (4, 'm'), (5, ''), (7, ''), (9, 'm'), (11, 'dim')):
            maj.append(_clabel(r + off, q))
        for off, q in ((0, 'maj7'), (2, 'm7'), (4, 'm7'), (5, 'maj7'), (7, '7'), (9, 'm7'), (11, 'm7b5')):
            maj.append(_clabel(r + off, q))
        # 副属：V7/ii, V7/iii, V7/IV, V7/vi
        for off in (2, 4, 5, 9):
            maj.append(_clabel(r + off - 5, '7'))
        # 借用：bVII bVI iv
        maj += [_clabel(r + 10, ''), _clabel(r + 8, ''), _clabel(r + 5, 'm')]
        lib[(r, 'major')] = sorted(set(maj))

        # 小调（自然小调）：i ii° III iv v VI VII
        mn = []
        for off, q in ((0, 'm'), (2, 'dim'), (3, ''), (5, 'm'), (7, 'm'), (8, ''), (10, '')):
            mn.append(_clabel(r + off, q))
        for off, q in ((0, 'm7'), (2, 'm7b5'), (3, 'maj7'), (5, 'm7'), (7, 'm7'), (8, 'maj7'), (10, '7')):
            mn.append(_clabel(r + off, q))
        # 和声小调的属和弦（最常用的借用）：V、V7
        mn += [_clabel(r + 7, ''), _clabel(r + 7, '7')]
        # 副属：V7/iv, V7/VI
        for off in (5, 8):
            mn.append(_clabel(r + off - 5, '7'))
        lib[(r, 'minor')] = sorted(set(mn))
    return lib


KEY_LIBRARY = build_key_library()


def key_to_indices(key_pc, key_mode, labels):
    """把 (调, 模式) 映射成候选下标集合。库外标签一律不要。"""
    allowed = set(KEY_LIBRARY.get((int(key_pc) % 12, key_mode), []))
    return [i for i, lab in enumerate(labels) if lab in allowed]


def chord_candidates():
    out = []
    for root in range(12):
        for quality, tones in CHORD_TEMPLATES.items():
            out.append((f"{NAMES[root]}{quality}", [(root + t) % 12 for t in tones]))
    return out


def detect_chords(vocals, harmonic_mix, sr=16000, hop=512, frame_s=0.25,
                  key_pc=None, key_mode=None):
    """chroma + 模板 + Viterbi。

    用"去掉人声后的谐波混合"（bass+other）算 chroma —— 人声会往和弦里塞非和弦音，
    鼓会污染低频，两样都不该参与和声判断。

    两个关键处理，缺一个结果就没法看：
      1. 先把 chroma 抽稀到 0.25 秒一帧。逐帧判定会让和弦每 1 秒跳一次
         （252 秒能切出 200 多段），真实流行歌是每小节或半小节换一次。
      2. Viterbi 的换和弦代价要够大，并且偏好三和弦 —— 否则会在大三和弦与
         大七和弦之间反复横跳（C#maj7 / C#m7 抖动是同一个根音）。
    """
    import librosa
    import numpy as np

    y = librosa.resample(harmonic_mix, orig_sr=sr, target_sr=22050)
    chroma = librosa.feature.chroma_cqt(y=y, sr=22050, hop_length=hop)
    chroma = chroma / (chroma.sum(axis=0, keepdims=True) + 1e-9)
    frame_dur = hop / 22050.0
    step = max(1, int(round(frame_s / frame_dur)))
    if step > 1:
        n = chroma.shape[1] // step
        chroma = chroma[:, : n * step].reshape(12, n, step).mean(axis=2)
    times = np.arange(chroma.shape[1]) * step * frame_dur

    cands = chord_candidates()
    labels = [c[0] for c in cands]

    # ── 加权余弦打分（取代旧的线性式）──
    # 旧式 `inside - 0.5(1-inside) - bonus` 实测余量中位只有 0.0099，一半帧 <0.01，
    # 等于在并列里随机挑。加权余弦把归一化余量提到 0.074（约 4 倍）：
    # 根音/三度权重大（决定和弦身份），五度次之，七度最小（最容易糊）。
    wt = np.array([1.0, 0.6, 0.9, 0.5])
    W = np.zeros((len(cands), 12), dtype="float32")
    for i, (_, tones) in enumerate(cands):
        for j, t in enumerate(tones):
            W[i, t] = wt[min(j, 3)]
    Wn = W / (np.linalg.norm(W, axis=1, keepdims=True) + 1e-9)
    full_scores = (Wn @ chroma).astype("float32")
    # 三和弦略占优：四音模板多一个可错的音
    for i, (_, tones) in enumerate(cands):
        if len(tones) > 3:
            full_scores[i] -= 0.01 * (len(tones) - 3)

    # ── 按调筛选：只在该调的调内表里选（库是固定的，见 build_key_library）──
    allowed_idx = key_to_indices(key_pc, key_mode, labels) if (key_pc is not None and key_mode) else []
    if allowed_idx:
        scores = full_scores.copy()
        drop = np.ones(len(cands), dtype=bool)
        drop[allowed_idx] = False
        scores[drop, :] = -1e6
    else:
        scores = full_scores.copy()

    n_c, n_t = scores.shape
    switch_pen = 0.8
    dp = np.zeros((n_c, n_t), dtype="float32")
    back = np.zeros((n_c, n_t), dtype="int16")
    dp[:, 0] = scores[:, 0]
    for t in range(1, n_t):
        prev = dp[:, t - 1]
        best_prev = int(prev.argmax())
        for c in range(n_c):
            stay = prev[c]
            move = prev[best_prev] - switch_pen
            if stay >= move:
                dp[c, t] = stay + scores[c, t]
                back[c, t] = c
            else:
                dp[c, t] = move + scores[c, t]
                back[c, t] = best_prev
    path = np.zeros(n_t, dtype="int16")
    path[-1] = int(dp[:, -1].argmax())
    for t in range(n_t - 1, 0, -1):
        path[t - 1] = back[path[t], t]

    # 合并：连续同标签 + 相邻同根音（不管品质）+ 丢掉短于 0.6 秒的
    def root_of(label):
        """取根音，**必须保留升降号**。

        旧版写成 `label[0] if label[1] in "#b"`，返回单个字符：
        "G#maj7" 会被解析成 "G"，于是 G 和 G# 被当成同一个根音合并——
        和弦时间线因此把相差半音的两个和弦并成一段。实测 OLK 上
        "只报根音" 排出 G 134s，而实际主体是 G#。
        """
        if not label:
            return "?"
        if len(label) > 1 and label[1] in "#b":
            return label[:2]
        return label[:1]

    segs = []
    start_i = 0
    for t in range(1, n_t + 1):
        if t == n_t or path[t] != path[start_i]:
            a, b = float(times[start_i]), float(times[min(t, n_t - 1)])
            if b - a >= 0.6:
                segs.append({"start": round(a, 2), "end": round(b, 2), "chord": labels[path[start_i]]})
            start_i = t
    merged = []
    for s in segs:
        if merged and (merged[-1]["chord"] == s["chord"]
                       or root_of(merged[-1]["chord"]) == root_of(s["chord"])) \
                and abs(merged[-1]["end"] - s["start"]) < 0.06:
            merged[-1]["end"] = s["end"]
        else:
            merged.append(dict(s))

    from collections import Counter
    hist = Counter()
    for s in merged:
        hist[s["chord"]] += s["end"] - s["start"]

    # 每段的置信度：**整段聚合**，不用单帧。
    # 单帧打分噪声太大（实测 43 段全部落在 0.25 阈值以下，全被判"存疑"），
    # 而根音判断本来就是个跨小节的性质，聚合才稳。
    roots = [root_of(labels[i]) for i in range(len(labels))]
    for s in merged:
        i0 = int(np.clip(round(s["start"] / (step * frame_dur)), 0, n_t - 1))
        i1 = int(np.clip(round(s["end"] / (step * frame_dur)), 1, n_t))
        if i1 <= i0:
            i1 = min(n_t, i0 + 1)
        # 段级回退：若"库外最佳"明显高于"库内最佳"，说明这段有借用和弦，
        # 该段退回全库选（窄化只在该窄的时候窄）。
        seg_full = full_scores[:, i0:i1].mean(axis=1)
        seg_rest = scores[:, i0:i1].mean(axis=1)
        if allowed_idx:
            best_full = int(seg_full.argmax())
            best_rest = float(seg_rest.max())
            if float(seg_full[best_full]) > best_rest + 0.06:
                s["chord"] = labels[best_full]
                s["fallback"] = True
        seg_scores = seg_full
        sel = s["chord"]
        sel_i = labels.index(sel) if sel in labels else int(seg_scores.argmax())
        sel_score = float(seg_scores[sel_i])
        other = [float(seg_scores[j]) for j in range(len(labels)) if roots[j] != roots[sel_i]]
        alt = max(other) if other else 0.0
        span = float(seg_scores.max() - seg_scores.min()) or 1.0
        rel = (sel_score - alt) / span
        s["root"] = roots[sel_i]
        s["confidence"] = round(float(np.clip(rel, 0.0, 1.0)), 3)
        s["_rel"] = float(rel)
        s["confident"] = False

    # 绝对阈值不可用：chroma 模板对不同根音本来就只差一点（G#maj7 与 D#m7 共享两个和弦音），
    # 实测 43 段里只有 1 段过 0.25。所以改成**相对**判据：只把差距排在前 25% 的段标成"较可信"，
    # 并老实报出中位数差距——让人知道"整套根音判断的把握有多大"。
    rels = sorted(s["_rel"] for s in merged)
    if rels:
        thr = rels[int(len(rels) * 0.75)] if len(rels) > 3 else rels[-1]
        for s in merged:
            s["confident"] = bool(s["_rel"] >= thr)
            s["_rel"] = None
        merged_median = rels[len(rels) // 2]
    else:
        merged_median = 0.0

    return {"timeline": merged, "histogram": hist.most_common(6)}


def build_prompt_from_lyrics(lyrics, limit=180):
    """whisper 的 initial_prompt 约 223 token，整篇歌词塞不下，取最有代表性的前几行。"""
    out, n = [], 0
    for line in [x.strip() for x in lyrics.splitlines() if x.strip()]:
        if n + len(line) > limit:
            break
        out.append(line)
        n += len(line)
    return " ".join(out)


def lyric_line_recall(guess, lyrics, thr=0.72):
    """逐行看"这行歌词有没有被认出来"。

    比对整段的全文字错率在这里没意义：视频里还有对白、笑声、重复的副歌，
    多出来的字会把错误率撑起来。这个指标只问"每行歌词找到没有"。
    """
    import re as _re
    from difflib import SequenceMatcher

    def norm(s):
        return _re.sub(r"[\s\W_]+", "", s, flags=_re.UNICODE)

    g = norm(guess)
    hits, misses = 0, []
    for line in [x.strip() for x in lyrics.splitlines() if x.strip()]:
        k = norm(line)
        if len(k) < 4:
            continue
        best = 0.0
        for i in range(0, max(1, len(g) - len(k) + 1)):
            r = SequenceMatcher(None, k, g[i:i + len(k)], autojunk=False).ratio()
            if r > best:
                best = r
                if best > 0.95:
                    break
        if best >= thr:
            hits += 1
        else:
            misses.append({"line": line, "best": round(best, 2)})
    total = hits + len(misses)
    return {"hits": hits, "total": total, "ratio": round(hits / max(1, total), 3), "misses": misses[:8]}


def _union_length(rows):
    """覆盖时长要按区间并集算，不能把每条时长相加 ——
    词级重切会产生轻微重叠，相加会算出 206% 这种数。"""
    spans = sorted((float(r["start"]), float(r["end"])) for r in rows)
    total, a0, b0 = 0.0, None, None
    for a, b in spans:
        if a0 is None:
            a0, b0 = a, b
        elif a <= b0:
            b0 = max(b0, b)
        else:
            total += b0 - a0
            a0, b0 = a, b
    if a0 is not None:
        total += b0 - a0
    return total


# ─────────────────────────── 语音 ───────────────────────────
def pick_model(name: str) -> str:
    local = MODELS_DIR / name
    if local.is_dir() and (local / "model.bin").is_file():
        return str(local)
    return name  # 交给 faster-whisper 去缓存里找


def vocal_regions(vocals, sr=16000, win_s=0.05, rel=0.25, gap_s=0.35, min_s=0.4, pad_s=0.15):
    """在人声轨上自己找"有人在唱"的区间。

    这是从源头堵幻觉的做法：把没人声的地方整个跳过，whisper 根本没有机会编。
    混合信号上做 VAD 会把唱段判成音乐（整首歌被吃掉），但人声轨上做这件事很稳，
    因为唱歌是持续的、能量稳定的谐波，而静音/间奏那里这条轨几乎是零。

    阈值取第 90 百分位的 25%，再按 0.35 秒的小间隙合并 —— 比固定阈值抗得住
    段落之间响度差异（主歌小声、副歌大声）。
    """
    import numpy as np
    win = max(1, int(win_s * sr))
    n = len(vocals) // win
    if n < 4:
        return []
    rms = np.sqrt((vocals[: n * win].reshape(n, win).astype("float64") ** 2).mean(axis=1))
    thr = max(float(np.percentile(rms, 90)) * rel, 1e-4)
    on = rms > thr

    raw = []
    i = 0
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < n and on[j]:
            j += 1
        raw.append([i * win_s, j * win_s])
        i = j

    merged = []
    for a, b in raw:
        if merged and a - merged[-1][1] < gap_s:
            merged[-1][1] = b
        else:
            merged.append([a, b])

    total = len(vocals) / sr
    out = []
    for a, b in merged:
        if b - a < min_s:
            continue
        out.append((max(0.0, a - pad_s), min(total, b + pad_s)))
    return out


def cmd_transcribe(args):
    import numpy as np
    from faster_whisper import WhisperModel

    t0 = time.time()
    # CUDA 是否可用要在**建模型之前**判断。
    # 踩过的坑：ct2 构造时不加载 cublas，直到第一次推理才抛错；如果那次"第一次推理"
    # 正好是语言探测，进程会卡死（实测 20 秒片段 >10 分钟没返回），而不是干净报错。
    def _cuda_libs_ok():
        import ctypes
        if not str(args.device).startswith("cuda"):
            return True
        # 本地适配（2026-11-11）：pip 装的 nvidia-*-cu12 把 DLL 放在 venv 的
        # site-packages/nvidia/*/bin 下，既不在 PATH，Python 3.8+ 的 ctypes.CDLL
        # 也不再搜索 PATH —— 必须显式 add_dll_directory，否则误判「没有 cublas」。
        try:
            import glob as _glob
            import os as _os
            import sys as _sys
            _sp = _os.path.join(
                _os.path.dirname(_os.path.dirname(_sys.executable)),
                "Lib", "site-packages", "nvidia",
            )
            for _d in _glob.glob(_os.path.join(_sp, "*", "bin")):
                try:
                    _os.add_dll_directory(_d)
                except OSError:
                    pass
        except Exception:
            pass
        for dll in ("cublas64_12.dll", "cublasLt64_12.dll"):
            try:
                ctypes.CDLL(dll)
                return True
            except OSError:
                continue
        return False

    if not _cuda_libs_ok():
        print("# ⚠ 找不到 cublas64_12.dll → 直接按 CPU int8 跑。"
              "要 GPU 转写需装 nvidia-cublas-cu12 + nvidia-cudnn-cu12（约 700 MB）", flush=True)
        args.device, args.compute = "cpu", "int8"

    try:
        model = WhisperModel(pick_model(args.model), device=args.device,
                             compute_type=args.compute)
    except Exception as exc:  # noqa: BLE001
        if str(args.device).startswith("cuda"):
            print(f"# ⚠ GPU 转写不可用（{str(exc)[:90]}）→ 改用 CPU int8。"
                  f"要 GPU 转写需装 nvidia-cublas-cu12 + nvidia-cudnn-cu12（约 700 MB）", flush=True)
            args.device, args.compute = "cpu", "int8"
            model = WhisperModel(pick_model(args.model), device="cpu", compute_type="int8")
        else:
            raise
    load_s = time.time() - t0

    y = load_audio(args.input)
    dur = len(y) / 16000.0

    # 分离出人声再转写：伴奏去掉之后，唱词准确率明显上升，
    # 而且人声轨还能反过来当"这段真的有人在唱吗"的证据。
    vocals = None
    if getattr(args, "separate", True):
        stems = stems_for(args.input, use_gpu=(args.device != "cpu"))
        if stems:
            vocals = stems["vocals"]
            if len(vocals) < len(y):
                vocals = np.pad(vocals, (0, len(y) - len(vocals)))

    # 窗口：只在内存里切片，时间戳补回绝对偏移
    offset = float(getattr(args, "start", 0) or 0)
    end = getattr(args, "end", None)
    if offset or end:
        a = max(0, int(offset * 16000))
        b = int(end * 16000) if end else len(y)
        y = y[a:b]
        if y.size == 0:
            raise SystemExit(f"窗口 {offset}-{end}s 里没有音频")
        dur = len(y) / 16000.0   # 覆盖率按窗口算，不按全片算
        if vocals is not None:
            vocals = vocals[a:b]

    # 转写：默认只在"有人声的区间"上跑。
    # 这是从源头堵幻觉：whisper 看不到前奏/间奏，就没有机会编演职员表或"点赞订阅"。
    mode = getattr(args, "vad_mode", "auto")
    if mode == "auto":
        mode = "vocals" if vocals is not None else "off"

    chunks = []          # [(audio, offset_seconds)]
    if mode == "vocals" and vocals is not None:
        regions = vocal_regions(vocals)
        # 光切碎不够：1-2 秒的碎片会让 whisper 失去上下文（"暧昧告诉我不能这样"
        # 会被识别成"美国是我本人最爱"）。所以把间隔小于 block_gap 的区间合并成
        # 30 秒量级的块：既跳过纯器乐段，又保住语言模型需要的上下文。
        block_gap = float(getattr(args, "block_gap", 3.5) or 3.5)
        blocks = []
        for a, b in regions:
            if blocks and a - blocks[-1][1] < block_gap:
                blocks[-1][1] = b
            else:
                blocks.append([a, b])
        regions = [tuple(x) for x in blocks]
        if regions:
            for a, b in regions:
                chunks.append((vocals[int(a * 16000): int(b * 16000)], a))
            print(f"  （人声切分：整段 {dur:.1f}s → {len(regions)} 块、共 "
                  f"{sum(b-a for a,b in regions):.1f}s，其余跳过）")
    if not chunks:
        chunks = [(vocals if vocals is not None else y, 0.0)]

    # 门控被绕过时必须吼一声：三条路径（未分离 / separator=none / vad-mode=off）
    # 都会让 whisper 直接看到器乐段，于是它开始编"Zither Harp""点赞订阅"这类东西。
    # 实测同一首歌：默认起于 10.10s 且干净；--no-separate 会在 8.68s 编出 "Zither Harp"。
    gate_on = bool(mode == "vocals" and vocals is not None and chunks
                   and any(c[1] > 0 for c in chunks))
    gate_reason = []
    if not getattr(args, "separate", True):
        gate_reason.append("separate=false")
    if (os.environ.get("SOUNDTRY_SEPARATOR") or "auto").strip().lower() == "none":
        gate_reason.append("separator=none")
    if getattr(args, "vad_mode", "auto") == "off":
        gate_reason.append("vad_mode=off")
    if not gate_on:
        reason = " / ".join(gate_reason) or "没有可用的人声轨"
        print(f"# ⚠ 未启用人声门控（{reason}）：whisper 会看到器乐段，可能在无人处编词。"
              f"要防幻觉请用默认的 separate=true + vad_mode=auto。")

    # 有真歌词时：自动生成 prompt（whisper 有它，唱词准确率天差地别），结尾再报覆盖率
    lyrics_text = None
    if getattr(args, "lyrics", None):
        try:
            lyrics_text = Path(args.lyrics).read_text(encoding="utf-8")
        except OSError as e:
            print(f"  （读歌词失败：{e}）")
        if lyrics_text and not args.prompt:
            args.prompt = build_prompt_from_lyrics(lyrics_text)
            print(f"  （已用歌词前 {len(args.prompt)} 字作为 prompt）")

    t1 = time.time()
    raw_segments = []
    info = None
    # CUDA 运行库缺失时的兜底：ct2 在**首次推理**才加载 cublas/cudnn，
    # 所以模型能构造成功、跑到第一段才抛 RuntimeError。这里重试一次（换成 CPU int8）。
    # ── 语言：先用一小段"最响的 12 秒"试转写，定下来后全程复用 ──
    # 两个坑都踩过了：
    #   a. --lang 默认曾是 "zh"，不传参数就永远按中文识别（日文歌被写成中文音近字）
    #   b. 用 model.detect_language() 在 CPU int8 上极慢（20 秒片段跑 >10 分钟），
    #      所以改成一次 12 秒、beam_size=1 的短转写来取语言 —— 实测约 5–8 秒。
    lang = None if args.lang == "auto" else args.lang
    lang_probe = None
    if lang is None:
        src_for_lang = vocals if vocals is not None else y
        total_s = len(src_for_lang) / 16000.0
        win_s = 12.0
        if total_s <= win_s:
            seg = src_for_lang
            at = 0.0
        else:
            # 取响度最高的一小段（人声最可能在那里），而不是固定取中点
            step = int(16000 * win_s)
            nwin = max(1, int(total_s * 16000) // step)
            best, at = -1.0, 0.0
            for i in range(nwin):
                a = i * step
                seg = src_for_lang[a:a + step]
                e = float((seg.astype('float64') ** 2).mean())
                if e > best:
                    best, at = e, a / 16000.0
            seg = src_for_lang[int(at * 16000):int(at * 16000) + step]
        try:
            _segs, info_l = model.transcribe(seg, language=None, beam_size=1,
                                             word_timestamps=False,
                                             condition_on_previous_text=False)
            _ = list(_segs)                      # 逼它真的解码，才能拿到 info
            if info_l is not None:
                lang = info_l.language
                lang_probe = {"picked": lang, "probability": round(float(info_l.language_probability), 3),
                              "window_at": round(float(at), 1), "window_s": win_s, "how": "short-probe"}
        except Exception as exc:
            lang_probe = {"picked": None, "error": f"{type(exc).__name__}: {str(exc)[:60]}",
                          "how": "short-probe"}

    for attempt in (0, 1):
        try:
            for audio_chunk, base in chunks:
                segs, info = model.transcribe(
                    audio_chunk,
                    language=lang,
                    beam_size=args.beam,
                    vad_filter=(mode == "mix"),           # 混合信号上的 VAD 只在显式要求时用
                    word_timestamps=True,
                    condition_on_previous_text=False,
                    initial_prompt=args.prompt,
                )
                for s in segs:
                    words = [(float(w.start) + base, float(w.end) + base, w.word) for w in (s.words or [])]
                    raw_segments.append((float(s.start) + base, float(s.end) + base, (s.text or "").strip(), words))
            break
        except RuntimeError as exc:
            msg = str(exc)
            cuda_lib_missing = ("cublas" in msg or "cudnn" in msg or "is not found or cannot be loaded" in msg)
            if attempt == 0 and cuda_lib_missing and str(args.device).startswith("cuda"):
                print(f"# ⚠ GPU 转写不可用（{msg[:80]}）→ 回退 CPU int8。"
                      f"要 GPU 转写需在 venv 里装 nvidia-cublas-cu12 + nvidia-cudnn-cu12（约 700 MB）", flush=True)
                args.device, args.compute = "cpu", "int8"
                model = WhisperModel(pick_model(args.model), device="cpu", compute_type="int8")
                raw_segments, info = [], None
                continue
            raise

    # ── 低覆盖重试：与"幻觉门控"对称的另一半 ──
    # 门控防的是"编造"，这里防的是"漏"。带歌词 prompt 时 whisper 容易只认出一两句
    # 就收工（实测 OLK 首轮覆盖只有 42%），对那些块用更高 beam、去掉 prompt 重来一次，
    # 只有在覆盖率明显提升时才采用——不提升就保留原结果，避免越改越差。
    # 默认关闭：实测三次里有两次"一个字都没采纳"却多花 3 分钟（OLK 那个 100s 块、
    # 空山野马 213s 首歌整体 0.5x）。想用就显式开：SOUNDTRY_RETRY=1 或 --retry-low-coverage。
    _retry_on = (os.environ.get("SOUNDTRY_RETRY") == "1") or bool(getattr(args, "retry_low_coverage", False))
    if chunks and _retry_on:
        retried = adopted = 0
        for audio_chunk, base in chunks:
            span = len(audio_chunk) / 16000.0
            # 只重试"短且漏得厉害"的块：
            # 长块（>60s）重试一次要几十秒，实测常常也是白跑（OLK 那个 100s 块就被放弃采纳），
            # 阈值也从 55% 降到 40%，避免把正常块也拖进来。
            if span < 4.0 or span > 60.0 or retried >= 2:
                continue
            end = base + span
            mine = [r for r in raw_segments if r[0] >= base - 0.01 and r[1] <= end + 0.01]
            cov = sum((r[1] - r[0]) for r in mine) / span
            if cov >= 0.40:
                continue
            retried += 1
            try:
                segs2, _ = model.transcribe(
                    audio_chunk,
                    language=lang,
                    beam_size=min(int(args.beam) + 2, 10),
                    vad_filter=False,
                    word_timestamps=True,
                    condition_on_previous_text=False,
                    initial_prompt=None,      # 关键：去掉 prompt，让它别被强行"对齐"到歌词
                )
                new_raws = []
                for s2 in segs2:
                    words = [(float(w.start) + base, float(w.end) + base, w.word) for w in (s2.words or [])]
                    new_raws.append((float(s2.start) + base, float(s2.end) + base,
                                     (s2.text or "").strip(), words))
            except Exception:
                continue
            new_cov = sum((b - a) for a, b, _t, _w in new_raws) / span
            if new_cov > cov + 0.08:
                raw_segments = [r for r in raw_segments if not (r[0] >= base - 0.01 and r[1] <= end + 0.01)]
                raw_segments.extend(new_raws)
                raw_segments.sort(key=lambda r: r[0])
                adopted += 1
        if retried:
            print(f"  （低覆盖重试：{retried} 块低于 55%，采纳 {adopted} 块的新结果）")


    # 提示词会让 whisper 变自信，把整段主歌并成一条 20 多秒的字幕 —— SRT 不能这么用。
    # 用词级时间戳把它按标点/长度重新断开：每条不超过 max_line 秒、max_chars 字。
    max_line = float(getattr(args, "max_line", 8.0) or 8.0)
    max_chars = int(getattr(args, "max_chars", 26) or 26)
    split_segments = []
    for a, b, text, words in raw_segments:
        if b - a <= max_line or not words or len(words) < 3:
            split_segments.append((a, b, text))
            continue
        cur, cur_txt, cur_start = [], "", None
        for w0, w1, wt in words:
            over = bool(cur) and ((len(cur_txt) + len(wt) > max_chars) or (w1 - cur_start > max_line))
            if over:
                # 只在"像句读"的位置断：上一个 token 收在标点，或下一个 token 以空格开头
                # （whisper 用空格标歌词的短语边界）。否则宁可变长，也不要在词中间切开。
                at_boundary = cur_txt.strip()[-1:] in "。！？，、；：…" or wt.startswith(" ")
                if at_boundary or (w1 - cur_start > max_line * 1.6):
                    split_segments.append((round(cur_start, 2), round(cur[-1][1], 2), cur_txt.strip()))
                    cur, cur_txt, cur_start = [], "", None
            if cur_start is None:
                cur_start = w0
            cur.append((w0, w1, wt))
            cur_txt += wt
            if wt.strip()[-1:] in "。！？" and w1 - cur_start >= 2.0:
                split_segments.append((round(cur_start, 2), round(w1, 2), cur_txt.strip()))
                cur, cur_txt, cur_start = [], "", None
        if cur and cur_txt.strip():
            split_segments.append((round(cur_start, 2), round(cur[-1][1], 2), cur_txt.strip()))
    raw_segments = split_segments
    # 幻觉过滤：whisper 在纯器乐段会编出整段"作曲/编曲 ×××"或"点赞订阅"这种象话的假台词，
    # 只靠"太长且太稀疏"抓不住。两道闸：
    #   1. 已知幻觉词表（这些句子长度和语速都很正常，只能点名）；
    #   2. 人声轨的逐秒占比 —— 一段字幕里大部分秒数没有能量，就不是在唱。
    import numpy as _np
    ref = None
    if vocals is not None:
        wins = [float(_np.median([vocal_energy(vocals, t, t + 1.0)])) for t in _np.arange(0, dur, 1.0)]
        ref = float(_np.median(wins)) or 1e-6
    floor = 0.20 * ref if ref else None

    rows = []
    dropped = []
    for s_start, s_end, text in raw_segments:
        if not text:
            continue
        cue = {"start": round(s_start + offset, 2),
               "end": round(s_end + offset, 2), "text": text}
        why = None
        if looks_hallucinated(text):
            why = "pattern"
        elif vocals is not None and floor and mode != "vocals":
            # 逐秒看：这段里有多大比例真的有声音（只在没做前置切分时兜底）
            n_sec = max(1, int(round(s_end - s_start)))
            secs = [float(_np.median([vocal_energy(vocals, s_start + i, s_start + i + 1.0)]))
                    for i in range(n_sec)]
            frac = sum(1 for v in secs if v >= floor) / len(secs)
            cue["voice_frac"] = round(frac, 2)
            if frac < 0.4:
                why = "no-voice"
        if why:
            cue["why"] = why
            dropped.append(cue)
            continue
        rows.append(cue)
    decode_s = time.time() - t1

    if args.srt:
        out = Path(args.srt)
        out.parent.mkdir(parents=True, exist_ok=True)
        def fmt(t):
            ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000)
            m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        with out.open("w", encoding="utf-8") as f:
            for i, r in enumerate(rows, 1):
                f.write(f"{i}\n{fmt(r['start'])} --> {fmt(r['end'])}\n{r['text']}\n\n")

    covered = _union_length(rows)
    src = "人声轨" if vocals is not None else "混合信号"
    print(f"# 语音：{dur:.1f}s · {len(rows)} 条 · 覆盖 {min(100.0, covered/dur*100):.0f}% · "
          f"{info.language}({info.language_probability:.2f}) · 源={src} · "
          f"加载 {load_s:.1f}s 解码 {decode_s:.1f}s ({dur/max(decode_s,.01):.1f}x)")
    if dropped:
        print(f"  ⚠ 丢掉 {len(dropped)} 段「没人声却识别出了字」的疑似幻觉：")
        for d in dropped[:4]:
            print(f"    [{d['start']:7.2f} → {d['end']:7.2f}] {d['text']}  (人声能量 {d.get('vocal_rms')})")
    for r in rows[:args.head]:
        print(f"[{r['start']:7.2f} → {r['end']:7.2f}] {r['text']}")
    if len(rows) > args.head:
        print(f"... 还有 {len(rows)-args.head} 条（用 srt 参数落盘看全）")
    recall = None
    if lyrics_text:
        recall = lyric_line_recall("".join(x["text"] for x in rows), lyrics_text)
        print(f"  歌词覆盖：{recall['hits']}/{recall['total']} 行 = {recall['ratio']*100:.0f}%（≥0.72 相似度）")
        for m in recall["misses"][:3]:
            print(f"    未认出：{m['line']}（最高相似 {m['best']}）")

    return {
        "ok": True,
        "duration": round(dur, 2),
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "language_probe": lang_probe,
        "segments": len(rows),
        "dropped_hallucinations": len(dropped),
        "source": src,
        "gate": "on" if gate_on else "off",
        "gate_reason": None if gate_on else (" / ".join(gate_reason) or "no-vocal-stem"),
        "coverage": round(min(1.0, covered / max(dur, .01)), 3),
        "cues": rows if args.include_cues else rows[:args.head],
        "srt": args.srt or None,
        "device": args.device, "compute": args.compute,
        "lyric_recall": recall,
    }


# ─────────────────────────── 节奏 ───────────────────────────
def _comb(onset, sr, hop, bpm, phases=64):
    """相位扫描的对比度分数。用 (max-median)/std，避免偏袒慢速 BPM。"""
    import numpy as np
    frame_t = hop / sr
    idx = np.arange(len(onset))
    period = (60.0 / bpm) / frame_t
    scores = []
    for k in range(phases):
        pos = (idx - (k / phases) * period) / period
        grid = np.round(pos).astype(int)
        sel = (grid >= 0) & (grid < len(onset))
        if sel.sum() < 8:
            scores.append(0.0); continue
        pick = idx[sel][np.unique(grid[sel], return_index=True)[1]]
        scores.append(float(onset[pick].mean()))
    s = np.asarray(scores)
    k_best = int(s.argmax())
    return (float(s.max()) - float(np.median(s))) / (float(s.std()) + 1e-9), (k_best / phases) * period * frame_t


def _kick_env(y, sr, hop, band=110.0, n_fft=2048):
    """底鼓带的起音包络。强拍几乎总落在地鼓上，所以相位判定只看这一带。"""
    import librosa
    import numpy as np

    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    low = S[freqs < band].sum(axis=0)
    env = np.maximum(0.0, np.diff(low, prepend=low[:1]))
    return env, hop / sr


def _subframe_peaks(env, frame, win=3, delta=0.02):
    """亚帧峰位：peak_pick 给整数帧，再用 ±win 帧的能量重心推到小数帧。

    这是整条链路里第一个能把精度做进帧内的动作。只靠整数帧，
    任何周期估计都会被钉在 23.22ms 的格子上（0.53406 就是 23 帧）。
    """
    import librosa
    import numpy as np

    idx = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=3, post_avg=5,
                                 delta=delta, wait=5)
    out = []
    for i in idx:
        a = max(0, i - win)
        b = min(len(env), i + win + 1)
        w = np.asarray(env[a:b], dtype='float64')
        tot = float(w.sum())
        pos = float((np.arange(a, b) * w).sum() / tot) if tot > 0 else float(i)
        out.append(pos * frame)
    return np.asarray(out)


def _strong_peaks(env, frame, peaks, pct=70, merge_s=0.12):
    """只留强击打：底鼓那一下明显强于镲片/钢琴的碎峰。

    直接用全部峰（实测 1083 个）做回归会失败：残差 90ms、对比度掉到 1.5，
    因为弱峰把邻近的格子拉歪了。取 p70 之后 324 个峰，残差 6ms。
    """
    import numpy as np

    if len(peaks) == 0:
        return peaks
    strength = []
    for t in peaks:
        i = int(round(t / frame))
        a, b = max(0, i - 2), min(len(env), i + 3)
        strength.append(float(env[a:b].max()))
    strength = np.asarray(strength)
    thr = np.percentile(strength, pct)
    keep = peaks[strength >= thr]
    merged = []
    for t in keep:                      # 太近的当一次击打
        if merged and t - merged[-1] < merge_s:
            continue
        merged.append(float(t))
    return np.asarray(merged)


def _coherence_search(times, T0, span=0.015, steps=601):
    """圆周相干搜索周期：R(T) = |mean(e^{2πi·t/T})|。

    为什么不用自相关 lag：lag 是整数帧，精度被钉在 23.22ms 上（0.53406 就是 23 帧）。
    相干函数在 T 上是连续的，可以用 0.0001s 量级的步长扫，不经过帧格。
    """
    import numpy as np

    if len(times) < 16:
        return None
    best = None
    for T in np.linspace(T0 * (1 - span), T0 * (1 + span), steps):
        z = np.exp(1j * 2 * np.pi * times / T)
        R = float(abs(np.mean(z)))
        if best is None or R > best[0]:
            best = (R, float(T), float(np.angle(np.mean(z))))
    R, T, ph = best
    return {"R": R, "T": T, "phase": (ph / (2 * np.pi)) * T}


def _ls_period(times, T, a, tol=0.12, iters=4):
    """紧容差最小二乘：t = a + k·T。只让落在格子附近 ±0.12T 的峰参与。"""
    import numpy as np

    if len(times) < 12:
        return None
    k = m = None
    for _ in range(iters):
        k = np.round((times - a) / T)
        m = np.abs(times - (a + k * T)) <= tol * T
        if int(m.sum()) < 8:
            return None
        A = np.column_stack([np.ones(int(m.sum())), k[m]])
        coef, *_ = np.linalg.lstsq(A, times[m], rcond=None)
        a, T = float(coef[0]), float(coef[1])
    resid = times[m] - (a + k[m] * T)
    return {
        "a": a, "T": T, "used": int(m.sum()), "of": int(len(times)),
        "rms_ms": round(float(np.sqrt((resid ** 2).mean()) * 1000), 2),
        "max_ms": round(float(np.abs(resid).max() * 1000), 1),
    }


def _stacked_profile(env, frame, a, T, dur, half_ms=80.0, step_ms=1.0):
    """把包络按候选网格折叠叠加：off=0 处有没有峰，是**独立**的验收量。

    不需要任何网格参数先验，所以不会像"吸附到最近峰"那样自证自洽。
    """
    import numpy as np

    offs = np.arange(-half_ms, half_ms + 1e-9, step_ms) / 1000.0
    if T <= 0 or dur <= a:
        return None, None
    k_max = int((dur - a) // (T * 4)) if T > 0 else 0
    ts = a + np.arange(k_max + 1) * (T * 4)
    if len(ts) < 4:
        return None, None
    scale = float(env.max()) or 1.0
    env_n = env / scale
    grid_t = np.arange(len(env_n)) * frame
    prof = np.zeros(len(offs))
    cnt = 0
    for t0 in ts:
        x = t0 + offs
        if x[0] < 0 or x[-1] >= grid_t[-1]:
            continue
        prof += np.interp(x, grid_t, env_n)
        cnt += 1
    if cnt < 4:
        return None, None
    return offs, prof / cnt


def _profile_contrast(offs, prof, away_ms=35.0):
    """对比度 = 0 处的值 / 远离 0 处的中位数。噪声约 1–2，对齐良好时几十。"""
    import numpy as np

    if prof is None:
        return 0.0, 0.0
    i0 = int(np.argmin(np.abs(offs)))
    side = prof[np.abs(offs) * 1000.0 > away_ms]
    base = float(np.median(side)) if len(side) else 0.0
    peak = float(prof[i0])
    return peak, (peak / base if base > 1e-9 else 0.0)


def _jump_votes(env, frame, peaks, a, T, bar, top_k=6, guard_s=0.35, look_s=2.5, min_ratio=15.0):
    """强拍判定：按"相对前 2.5 秒的跳变"给四个拍位投票。

    为什么不用绝对响度：实测 One Last Kiss 全场最响的 10 下里 6 下落在 #1，
    而正确答案是 #3 —— 绝对响度会被副歌的连续重击带偏。
    跳变衡量的"从无到有"才是强拍的定义：断奏/留白之后重新进来的那一下，
    几乎总是小节第 1 拍（drop 落在 bar 1）。
    """
    import numpy as np

    if len(peaks) < 8 or T <= 0 or bar <= 0:
        return None
    tgrid = np.arange(len(env)) * frame

    def strength(t):
        i = int(round(t / frame))
        lo, hi = max(0, i - 2), min(len(env), i + 3)
        return float(env[lo:hi].max())

    rows = []
    for t in peaks:
        s = strength(t)
        m = (tgrid >= t - look_s) & (tgrid < t - guard_s)
        base = float(env[m].mean()) if m.any() else 0.0
        ratio = s / max(base, 1e-6)
        if ratio >= min_ratio:
            rows.append((ratio, float(t), int(round(((t - a) % bar) / T)) % 4))
    if not rows:
        return None
    rows.sort(reverse=True)
    top = rows[:top_k]
    votes = [0, 0, 0, 0]
    for _, _, ph in top:
        votes[ph] += 1
    return {
        "votes": votes,
        "k": int(np.argmax(votes)),
        "top": [(round(r, 1), round(t, 3), ph) for r, t, ph in top[:4]],
        "n": len(rows),
    }


def beat_grid(y, sr, hop, bpm, phase, dur, fps=25.0, drums=None, force_bpm=False):
    """网格 = 亚帧强峰 + 圆周相干定周期 + 紧容差回归 + 折叠剖面验收。

    三个关键修正（都来自实测失败案例）：
      · 周期不用自相关 lag（整数帧，天花板 23.22ms）
      · 峰不全用（1083 个会让残差 90ms）：筛 p70 后残差 6ms
      · 验收用折叠剖面，不依赖网格自身产物
      · **锚点不能只信 BPM 候选**：术曲/电子常被判到错误的节拍层级（千本桜被判 112.7，
        真值 154），而相干搜索窗口只有 ±1.5%，一旦锚点偏 27% 就永远锁不上。
        所以改为在 60–200 BPM 上做全局锚点扫描，取相干最高者。
      · **优先用分离出的鼓轨**：混音 <110Hz 里贝斯是连续低频，会把 kick 的周期性淹没。
        实测モニタリング：混音对比度 10.9 / 鼓轨 94.7；千本桜：16.8 / 45.0。
    """
    import numpy as np

    src = drums if drums is not None else y
    env, frame = _kick_env(src, sr, hop)
    all_peaks = _subframe_peaks(env, frame)
    peaks = _strong_peaks(env, frame, all_peaks)

    # 全局锚点扫描：60–200 BPM 每 2% 一个锚点，每个锚点用 ±3% 的相干搜索
    # 用户显式给了 --bpm 就只搜那一个锚点（±10% 容错），否则全局扫描
    if force_bpm:
        anchors = [float(bpm)]
    else:
        anchors = [60.0 * (200.0 / 60.0) ** (i / 40.0) for i in range(41)]
    best_anchor = None
    for bpm_a in anchors:
        c = _coherence_search(peaks, 60.0 / bpm_a, span=(0.10 if force_bpm else 0.03), steps=161)
        if c and (best_anchor is None or c["R"] > best_anchor[0]["R"]):
            best_anchor = (c, bpm_a)
    # 候选 BPM 也作为一个锚点参与比较（有时它比全局扫描更接近真值）
    c_cand = _coherence_search(peaks, 60.0 / float(bpm), span=0.03, steps=161)
    if c_cand and (best_anchor is None or c_cand["R"] > best_anchor[0]["R"]):
        best_anchor = (c_cand, float(bpm))

    if best_anchor:
        coh, anchor_bpm = best_anchor
        ls = _ls_period(peaks, coh["T"], coh["phase"])
    else:
        coh, anchor_bpm, ls = None, float(bpm), None
    T = ls["T"] if ls else (coh["T"] if coh else 60.0 / float(bpm))
    a = ls["a"] if ls else (coh["phase"] if coh else float(phase))

    # 4 个强拍候选：小节级折叠剖面对比度最高者胜
    cands = []
    for k in range(4):
        offs, prof = _stacked_profile(env, frame, a + k * T, T, dur)
        peak, con = _profile_contrast(offs, prof)
        cands.append({"k": k, "peak": round(peak, 4), "contrast": round(con, 1)})
    # 强拍归属：底鼓能量最重的那一拍。四个相位都有鼓时（流行歌常见）差异可能很小，
    # 那种情况下"第 1 拍"本身是歧义的，必须报出来并允许 --downbeat 覆盖。
    jump = _jump_votes(env, frame, peaks, a, T, 4.0 * T)
    if jump and jump["votes"][jump["k"]] >= 2:
        k_best = jump["k"]
        db_source = "jump"
    else:
        k_best = max(cands, key=lambda c: c["peak"])["k"]
        db_source = "amplitude"
    peaks4 = sorted((c["peak"] for c in cands), reverse=True)
    downbeat_margin = round((peaks4[0] - peaks4[1]) / peaks4[0] * 100, 1) if peaks4[0] else None

    first = a + k_best * T
    bar_len = 4.0 * T
    n = int(np.floor((dur - first) / bar_len)) if bar_len > 0 else 0
    times = first + np.arange(max(0, n) + 1) * bar_len
    tail_gap = float(dur - times[-1]) if len(times) else float(dur)

    offs_b, prof_b = _stacked_profile(env, frame, a, T, dur)
    _, con_beat = _profile_contrast(offs_b, prof_b)
    offs_r, prof_r = _stacked_profile(env, frame, first, bar_len, dur)
    _, con_bar = _profile_contrast(offs_r, prof_r) if prof_r is not None else (0.0, None)

    # 末端验收：最后一个**实测强峰**离最近的拍线有多远（应当 < 30ms）；
    # 顺便报尾段有多长没有击打——那才是"最后一条线在鼓消失之后"的原因。
    end_err_ms = None
    tail_quiet = None
    if len(peaks) and T > 0:
        last = float(peaks[-1])
        k_near = round((last - a) / T)
        end_err_ms = round((last - (a + k_near * T)) * 1000, 1)
        tail_quiet = round(float(dur) - last, 1)

    return {
        "period": round(T, 6),
        "period_nominal": round(60.0 / float(bpm), 6),
        "period_frames": round(T / frame, 4),
        "bpm_ls": round(60.0 / T, 3) if T > 0 else None,
        "anchor_bpm": round(float(anchor_bpm), 2),
        "signal": "drums" if drums is not None else "mix",
        "bar_len_nominal": round(4 * 60.0 / float(bpm), 5),
        "bar_len": round(bar_len, 6),
        "first_downbeat": round(first, 4),
        "beat_phase": round(a, 4),
        "downbeat_index": k_best,
        "phase_scores": [c["contrast"] for c in cands],
        "phase_candidates": cands,
        "bars": int(n) + 1,
        "times": times,
        "tail_gap": round(tail_gap, 3),
        "hop_ms": round(frame * 1000, 2),
        "duration": round(float(dur), 3),
        "ls": ls,
        "coherence": round(coh["R"], 3) if coh else None,
        "peaks_all": int(len(all_peaks)),
        "peaks_strong": int(len(peaks)),
        "contrast_beat": round(con_beat, 1) if con_beat is not None else None,
        "contrast_bar": round(con_bar, 1) if con_bar is not None else None,
        "downbeat_source": db_source,
        "jump_votes": jump["votes"] if jump else None,
        "jump_top": jump["top"] if jump else None,
        "downbeat_margin_pct": downbeat_margin,
        "phase_peaks": [c["peak"] for c in cands],
        "end_err_ms": end_err_ms,
        "tail_quiet_s": tail_quiet,
        "fit": None,
        "refine": None,
    }


def _timecode(t, fps):
    """非 drop-frame 时间码 HH:MM:SS:FF。"""
    total = int(round(t * fps))
    f = total % int(fps)
    s = (total // int(fps)) % 60
    m = (total // (int(fps) * 60)) % 60
    h = total // (int(fps) * 3600)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _meter_deviation(y, sr, hop, bpm, cache={}):
    """节拍层级判定：和声换手间隔应当是「小节的整数倍」。

    这是唯一没被"网格密度/混叠"污染的判据（试过三种都不行）：
      · 网格点上的起音均值 → 偏爱稀疏网格，最优解顶到搜索边界
      · 换手是否落在小节线 ±150ms → 快 BPM 上因混叠虚高（152 BPM 反而最高）
      · 自相关精修 → 只能修节长，判不了层级
    实测 One Last Kiss：换手在 2.05s / 4.3s 成群，而 112.35 BPM 的小节是 2.136s
    （1 倍 / 2 倍，干净），73.83 BPM 的小节 3.251s 则对不上（0.63 / 1.32 倍）。
    返回中位偏差（越小越像整数倍）；算不出来返回 None。
    """
    import librosa
    import numpy as np

    key = "starts"
    if key not in cache:
        harm = librosa.effects.hpss(y, margin=(1.0, 5.0))[0]
        tl = detect_chords(None, harm, sr=sr, hop=hop)["timeline"]
        s = np.array([c["start"] for c in tl])
        iv = np.diff(s) if len(s) > 2 else np.array([])
        cache[key] = iv[(iv > 0.8) & (iv < 9.0)]
    iv = cache[key]
    if len(iv) < 8:
        return None
    bar = 4 * 60.0 / bpm
    r = iv / bar
    return float(np.median(np.abs(r - np.round(r))))


def _pick_bpm_with_meter(scored, t_lib, y, sr, hop, bpm_winner):
    """在"综合分胜者"之外，用和声节奏再判一次层级，避免 3:2 误判。

    只在两种情形下覆盖：① 换手偏差明显更好（≤0.7 倍）；② 综合分不差太多（≥0.6 倍）。
    否则保持综合分的选择——不能因为一个弱判据推翻主判据。
    """
    cands = []
    for row in scored[:4]:
        cands.append(round(float(row["bpm"]), 2))
    if t_lib:
        cands.append(round(float(t_lib), 2))
    # 加上简单比例（3:2 / 2:3 / 2:1 / 1:2），这正是出错的那一层
    for base in list(cands):
        for num, den in ((3, 2), (2, 3), (2, 1), (1, 2)):
            v = base * num / den
            if 55 <= v <= 210:
                cands.append(round(v, 2))
    seen, uniq = set(), []
    for c in cands:
        if c not in seen:
            seen.add(c)
            uniq.append(c)

    rows = []
    for b in uniq:
        d = _meter_deviation(y, sr, hop, b)
        if d is None:
            continue
        comp = next((float(r["composite"]) for r in scored if abs(r["bpm"] - b) < 0.02), None)
        rows.append((d, b, comp))
    if not rows:
        return bpm_winner, None

    win_row = next((r for r in rows if abs(r[1] - bpm_winner) < 0.02), None)
    best = min(rows)
    if win_row and best[0] <= win_row[0] * 0.7 and (best[2] is None or best[2] >= (win_row[2] or 0) * 0.6):
        return best[1], {"from": bpm_winner, "to": best[1],
                         "dev_win": round(win_row[0], 3), "dev_new": round(best[0], 3)}
    return bpm_winner, None


def write_grid_csv(path, grid, fps, level="bar"):
    """导出给剪辑软件的标记表，带 timecode 与 bar/beat 编号。

    level="bar"  → 每小节一条（给"按段落卡点"用）
    level="beat" → 每拍一条（给"逐拍卡点"用，数量约 4×小节）

    为什么带 bar/beat：剪辑时说"第 218 小节第 3 拍"能直接对上，
    说"第 466.3 秒"每次都要换算。
    """
    times = grid["times"]
    rows = ["index,bar,beat,time_sec,timecode_fps"]
    if level == "beat":
        beats = 4
        per = grid["bar_len"] / beats
        n = 0
        for i, t0 in enumerate(times):
            for b in range(beats):
                t = t0 + b * per
                if t > grid.get("duration", t + 1):
                    break
                n += 1
                rows.append(f"{n},{i + 1},{b + 1},{t:.4f},{_timecode(t, fps)}")
    else:
        for i, t in enumerate(times):
            rows.append(f"{i + 1},{i + 1},1,{t:.4f},{_timecode(t, fps)}")
    Path(path).write_text("\n".join(rows) + "\n", encoding="utf-8")
    return len(rows) - 1


def audio_meta(path):
    """阶段 0：直接读文件头，不经过 ffmpeg。

    FLAC 是无损，librosa/soundfile 直接读；转码只会更慢，还会把瞬态抹糊。
    """
    import soundfile as sf
    info = sf.info(str(path))
    return {
        "duration": round(float(info.frames) / float(info.samplerate), 3),
        "samplerate": int(info.samplerate),
        "channels": int(info.channels),
        "subtype": info.subtype,          # 24bit 会显示成 PCM_24
        "bits": int(str(info.subtype).replace("PCM_", "") or 0) if "PCM_" in str(info.subtype) else None,
    }


def bars_table(y, sr, hop, times, frame_times=None):
    """阶段 2/3：按小节聚合能量，并标出鼓在不在。

    按小节而不是按秒：人耳感知的"一段"是 4 拍，不是 5 秒。
    """
    import librosa
    import numpy as np

    harm, perc = librosa.effects.hpss(y, margin=(1.0, 5.0))
    rms_all = librosa.feature.rms(y=y, hop_length=hop)[0]
    rms_p = librosa.feature.rms(y=perc, hop_length=hop)[0]
    rms_h = librosa.feature.rms(y=harm, hop_length=hop)[0]
    t_of = np.arange(len(rms_all)) * (hop / sr)

    rows = []
    for i, t0 in enumerate(times):
        t1 = times[i + 1] if i + 1 < len(times) else t_of[-1]
        m = (t_of >= t0) & (t_of < t1)
        if not m.any():
            continue
        rows.append({
            "bar": i + 1,
            "start": round(float(t0), 3),
            "end": round(float(t1), 3),
            "rms": round(float(rms_all[m].mean()), 5),
            "rms_perc": round(float(rms_p[m].mean()), 5),
            "rms_harm": round(float(rms_h[m].mean()), 5),
        })
    if not rows:
        return []
    med_p = float(np.median([r["rms_perc"] for r in rows]))
    for r in rows:
        r["drums"] = bool(r["rms_perc"] > med_p * 1.25) if med_p > 0 else False
        r["energy_rel"] = round(r["rms"] / (float(np.median([x["rms"] for x in rows])) or 1), 2)
    return rows


def breath_candidates(rows, drop=0.75, rise=0.5):
    """阶段 4：找"鼓消失一小节又回来"的位置——算法能看见的"吸气"。

    判据用的是**打击分量**（rms_perc），不是总能量。实测 One Last Kiss 0:34.45：
    总能量只降 12%（混响尾巴还在），但打击分量从 0.00695 掉到 0.00466、
    下一小节又跳到 0.01738 —— 这正是 WB 说的"鼓没了、只剩混响"。
    用总 RMS 去找永远找不到这一刀。

    只给候选，不替你决定："这里必须停一秒"仍然要戴耳机听。
    """
    out = []
    for i in range(1, len(rows) - 1):
        prev = rows[i - 1]["rms_perc"]
        cur = rows[i]["rms_perc"]
        nxt = rows[i + 1]["rms_perc"]
        if prev <= 0 or cur <= 0:
            continue
        if cur <= prev * drop and cur <= nxt * rise:
            out.append({
                "bar": rows[i]["bar"],
                "start": rows[i]["start"],
                "end": rows[i]["end"],
                "perc_drop_pct": round((1 - cur / prev) * 100, 1),
                "perc_return_x": round(nxt / cur, 1),
                "rms_drop_pct": round((1 - rows[i]["rms"] / rows[i - 1]["rms"]) * 100, 1) if rows[i - 1]["rms"] else None,
            })
    return out


def write_bars_csv(path, rows):
    cols = ["bar", "start", "end", "rms", "rms_perc", "rms_harm", "drums", "energy_rel"]
    lines = [",".join(cols)]
    for r in rows:
        lines.append(",".join(str(r.get(c)) for c in cols))
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(rows)


def cmd_rhythm(args):
    import librosa
    import numpy as np

    y16 = load_audio(args.input)
    sr, hop = 22050, 512
    y = librosa.resample(y16, orig_sr=16000, target_sr=sr)
    dur = len(y) / sr
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)

    t_lib, _ = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop)
    t_lib = float(np.asarray(t_lib).reshape(-1)[0])

    tg = librosa.feature.tempogram(onset_envelope=onset, sr=sr, hop_length=hop)
    bpms = librosa.tempo_frequencies(tg.shape[0], sr=sr, hop_length=hop)
    mean_tg = tg.mean(axis=1)
    cand = set()
    for i in range(1, len(mean_tg) - 1):
        if mean_tg[i] > mean_tg[i - 1] and mean_tg[i] >= mean_tg[i + 1] and 55 <= bpms[i] <= 210:
            cand.add(round(float(bpms[i]), 2))
    for base in list(cand) + [t_lib]:
        for mul in (0.5, 2.0):
            if 55 <= base * mul <= 210:
                cand.add(round(base * mul, 2))

    # 半/倍速判据：偶数拍与奇数拍的 onset 强度比。
    # 只有"真正的那一层"每一拍都有击打，比值才接近 1；取它的半速或倍速都会一强一弱。
    # 所以选 BPM 不能只看对比度，必须把这个比值乘进去——否则整曲平均会把 126 判成 83。
    def odd_even(b, ph):
        period = 60.0 / b
        t = ph
        hits = []
        while t < dur:
            f = int(round(t / (hop / sr)))
            if 0 <= f < len(onset):
                hits.append(onset[f])
            t += period
        h = np.asarray(hits)
        if len(h) < 8:
            return None
        return float(h[1::2].mean() / (h[0::2].mean() + 1e-9))

    import math as _math

    half = len(onset) // 2
    t_off = half * hop / sr
    scored = []
    for b in cand:
        s_full, ph = _comb(onset, sr, hop, b)
        c1, p1 = _comb(onset[:half], sr, hop, b)
        c2, p2 = _comb(onset[half:], sr, hop, b)
        period = 60.0 / b
        gap = ((p2 + t_off) - p1) % period
        gap = min(gap, period - gap) / period          # 0 = 前后半段相位完全接上
        r = odd_even(b, ph)
        r = 1.0 if r is None else r
        # 三个信号：前后半段都要有能量（minC）、相位要接得上、每拍能量要接近（odd_even）
        composite = min(c1, c2) * _math.exp(-2.0 * abs(r - 1.0)) * _math.exp(-1.5 * gap)
        scored.append({"bpm": b, "contrast": s_full, "half1": c1, "half2": c2,
                       "phase_gap": gap, "odd_even": r, "phase": ph, "composite": composite})
    scored.sort(key=lambda x: -x["composite"])
    best = scored[0]
    bpm, score, phase, ratio = best["bpm"], best["contrast"], best["phase"], best["odd_even"]
    # 不确定度：#1 与 #2 的综合分差不到 10% 时，这个数不能当结论
    runner_up = scored[1] if len(scored) > 1 else None
    margin = (best["composite"] - runner_up["composite"]) / best["composite"] if runner_up else 1.0
    ambiguous = margin < 0.10

    # 节拍层级复核（综合分最容易在这里出错，而且是 3:2 这种"听起来也像"的错）。
    # 实测 One Last Kiss：本地判 73.83，真实 112.35（3:2），和声换手一验就分出来。
    bpm, meter_switch = _pick_bpm_with_meter(scored, t_lib, y, sr, hop, bpm)
    if meter_switch:
        row = next((r for r in scored if abs(r["bpm"] - bpm) < 0.02), None)
        if row:
            score, phase, ratio = row["contrast"], row["phase"], row["odd_even"]


    harm, perc = librosa.effects.hpss(y, margin=(1.0, 5.0))
    rms_p = librosa.feature.rms(y=perc, hop_length=hop)[0]
    seg = []
    for a, b in [(0, 30), (30, 60), (60, 110), (110, 180), (180, 240), (240, dur)]:
        m = (librosa.frames_to_time(np.arange(len(rms_p)), sr=sr, hop_length=hop) >= a) & \
            (librosa.frames_to_time(np.arange(len(rms_p)), sr=sr, hop_length=hop) < b)
        if m.any():
            seg.append({"from": a, "to": round(min(b, dur), 1), "percussive": round(float(rms_p[m].mean()), 4)})

    print(f"# 节奏：{dur:.1f}s")
    print(f"  librosa 自报 {t_lib:.2f} BPM（仅参考）")
    verdict = "（≈1，每拍都有击打）" if abs(ratio - 1) < 0.15 else "（偏离 1，可能是半/倍速层）"
    print(f"  候选第一 {bpm:.2f} BPM · 相位 {phase:.3f} · 对比度 {score:.2f} · 偶奇拍比 {ratio:.2f}{verdict}")

    if meter_switch:
        print(f"    ↳ 和声节奏复核：候选第一是 {meter_switch['from']:.2f}，但换手间隔不落在它的小节线上"
              f"（偏差 {meter_switch['dev_win']:.3f} vs {meter_switch['dev_new']:.3f} 小节），"
              f"改用 {meter_switch['to']:.2f} BPM")
    # ── 小节网格（给剪辑用）──
    # --bpm 可强制覆盖：这首歌在候选之间分不出胜负时，剪辑师需要能手动指定。
    grid_bpm = float(getattr(args, "bpm", 0) or 0) or bpm
    # 用分离出的鼓轨做包络：混音 <110Hz 里贝斯会淹没 kick 的周期性
    # （实测 モニタリング 对比度 10.9 → 94.7，千本桜 16.8 → 45.0）
    drums = None
    if getattr(args, "separate", True):
        try:
            stems_r = stems_for(args.input, use_gpu=True)
            if stems_r and "drums" in stems_r:
                # 分轨是 16 kHz，包络按 22.05 kHz 计算，必须先重采样，
                # 否则频带整体错位（实测直接把 154 BPM 的曲子算成 108 BPM）
                drums = np.asarray(stems_r["drums"], dtype="float32")
                if abs(float(stems_r.get("sr", 16000)) - float(sr)) > 1:
                    import librosa as _lr
                    drums = _lr.resample(drums, orig_sr=int(stems_r.get("sr", 16000)), target_sr=int(sr))
        except Exception:
            drums = None
    grid = beat_grid(y, sr, hop, grid_bpm, phase, dur,
                     fps=float(getattr(args, "fps", 25.0) or 25.0), drums=drums,
                     force_bpm=bool(getattr(args, "bpm", 0)))
    if getattr(args, "downbeat", None) is not None:
        # 人工指定强拍：重算首拍与网格
        k = int(args.downbeat)
        base_a = grid["beat_phase"]
        grid["first_downbeat"] = round(base_a + k * grid["period"], 4)
        grid["downbeat_index"] = k
        first = grid["first_downbeat"]
        n = int(np.floor((dur - first) / grid["bar_len"])) if grid["bar_len"] > 0 else 0
        grid["times"] = first + np.arange(max(0, n) + 1) * grid["bar_len"]
        grid["bars"] = len(grid["times"])
        print(f"    （--downbeat {k}：强制第 1 拍为首强拍 {first:.4f}s）")
    print(f"  小节网格：回归 BPM {grid['bpm_ls']:.3f} → 每拍 {grid['period']:.6f}s "
          f"= {grid['period_frames']:.3f} 帧 · 4/4 小节 {grid['bar_len']:.6f}s · 共 {grid['bars']} 小节")
    print(f"    最小二乘：{grid['ls']['used'] if grid['ls'] else 0}/{grid['peaks_strong']} 个强峰"
          f"（全部峰 {grid['peaks_all']} 个）· 残差 RMS "
          f"{grid['ls']['rms_ms'] if grid['ls'] else float('nan')}ms · 圆周相干 {grid['coherence']}")
    cb = grid['contrast_beat']
    verdict_c = ('可信（可用来切）' if cb >= 8 else
                 '勉强（建议 --bpm 钉死后再看）' if cb >= 4 else
                 '不可信（这张网格别用来切）')
    bar_txt = f"{grid['contrast_bar']}" if grid['contrast_bar'] is not None else 'n/a（小节太少）'
    print(f"    折叠剖面验收：拍级对比度 {cb} · 小节级 {bar_txt} → {verdict_c}"
          f"（>8 可信 / 4–8 勉强 / <4 不可信；不依赖网格自身参数）")
    print(f"    强拍候选（0 处幅值）：{' / '.join(f'{p:.3f}' for p in grid['phase_peaks'])}"
          f" → 选中 #{grid['downbeat_index']}，首强拍 {grid['first_downbeat']:.4f}s")
    if grid.get("downbeat_margin_pct") is not None and grid["downbeat_margin_pct"] < 15:
        print(f"    ⚠ 强拍归属不确定：最强与次强只差 {grid['downbeat_margin_pct']:.1f}%。"
              f"整片会差一拍，可用 --downbeat 0|1|2|3 指定")
    print(f"    末端独立对照：最后一个强峰离最近拍线 {grid['end_err_ms']}ms"
          f"（应 <30ms）· 最后 {grid['tail_quiet_s']}s 无击打（所以末条线会超出）")
    print(f"    精度：包络 {grid['hop_ms']:.2f}ms/帧，但周期靠亚帧质心+回归，不再被帧格钉住")
    if getattr(args, "grid_csv", None):
        lvl = getattr(args, "grid_level", "bar") or "bar"
        nrows = write_grid_csv(args.grid_csv, grid, float(getattr(args, "fps", 25.0) or 25.0), level=lvl)
        print(f"    已导出 {nrows} 行标记（{lvl} 级）→ {args.grid_csv}"
              f"（可直接导入 Premiere/达芬奇标记面板）")

    # ── 阶段 2/3：逐小节能量 + 鼓在不在 ──
    bars = bars_table(y, sr, hop, grid["times"])
    if bars:
        import statistics as _st
        lvl = [round(r["energy_rel"], 2) for r in bars]
        med = _st.median(lvl)
        loud = sum(1 for x in lvl if x > med * 1.5)
        quiet = sum(1 for x in lvl if x < med * 0.6)
        drums = sum(1 for r in bars if r["drums"])
        print(f"  小节能量：{len(bars)} 小节 · 响段 {loud} · 静段 {quiet} · 有鼓 {drums}")
        # 呼吸点（阶段 4 的算法部分：只报候选，决策留给人）
        breaths = breath_candidates(bars)
        if breaths:
            preview = " / ".join(
                f"{b['start']:.1f}s(打击-{b['perc_drop_pct']:.0f}%，随即×{b['perc_return_x']})"
                for b in breaths[:4])
            print(f"    呼吸点候选 {len(breaths)} 处：{preview}")
            print('     ↳ 判据是打击分量（鼓消失），不是总能量；'
                  '但「这里该停一秒」仍须戴耳机确认')
        else:
            print('    呼吸点候选：无（没有「鼓消失一小节又回来」的位置）')
        if getattr(args, "bars_csv", None):
            n = write_bars_csv(args.bars_csv, bars)
            print(f"    已导出 {n} 行小节能量 → {args.bars_csv}")

    if ambiguous:
        alts = " / ".join(f"{x['bpm']:.2f}" for x in scored[1:4])
        print(f"  ⚠ 不确定：与次选只差 {margin*100:.0f}%（{alts}），这个 BPM 不能当结论用")

    # 两个方法互相校：同一条片子给出两个互不相干的数，比"没算出来"更危险 ——
    # 前者会被当成确定结论引用。所以分歧必须显式报出来。
    #
    # 歧义不止 2:1。实测遇到过 3:2（112.35 vs 73.83，比值 1.522）—— 那是三连音
    # 层级，只判 half/double 会把它误报成"不可靠"。所以按一组有理数比去套。
    METRICAL = [(2, 1), (1, 2), (3, 2), (2, 3), (4, 3), (3, 4), (5, 4), (4, 5), (5, 2), (2, 5)]
    agreement = {"mine": round(bpm, 2), "librosa": round(t_lib, 2), "status": "agree"}
    if bpm > 0 and t_lib > 0:
        d = abs(t_lib - bpm) / bpm
        level = None
        for p, q in METRICAL:
            if abs(t_lib - bpm * p / q) / bpm < 0.05:
                level = (p, q)
                break
        if d <= 0.05:
            agreement["status"] = "agree"
        elif level:
            p, q = level
            agreement["status"] = "level"
            agreement["ratio"] = f"{p}:{q}"
            label = "半/倍速" if (p, q) in ((2, 1), (1, 2)) else "节拍层级"
            print(f"  · librosa 的 {t_lib:.1f} 与本地 {bpm:.1f} 是 {p}:{q} 关系（{label}）—— "
                  f"两个数都可能是对的，引用时必须说明是哪个层级")
        else:
            agreement["status"] = "conflict"
            print(f"  ⚠ BPM 不可靠：librosa {t_lib:.1f} vs 本地 {bpm:.1f}（差 {d*100:.0f}%），"
                  f"别拿这个数做结论（可能与变速/段落速度变化有关）")
        agreement["delta_pct"] = round(d * 100, 1)
    for row in scored[1:4]:
        print(f"    次选 {row['bpm']:.2f}（综合 {row['composite']:.2f}，半段 {row['half1']:.2f}/{row['half2']:.2f}，"
              f"偶奇比 {row['odd_even']:.2f}，相位差 {row['phase_gap']*100:.0f}%）")

    out = {"ok": True, "duration": round(dur, 2), "bpm": bpm, "phase": phase,
           "grid": {k: v for k, v in grid.items() if k != "times"},
           "contrast": round(score, 3), "odd_even": round(ratio, 3) if ratio else None,
           "ambiguous": ambiguous, "margin": round(margin, 3),
           "bpm_agreement": agreement,
           "librosa_bpm": round(t_lib, 2),
           "candidates": [{"bpm": x["bpm"], "contrast": round(x["contrast"], 3),
                           "half1": round(x["half1"], 3), "half2": round(x["half2"], 3),
                           "odd_even": round(x["odd_even"], 3),
                           "phase_gap": round(x["phase_gap"], 3),
                           "composite": round(x["composite"], 3)} for x in scored[:6]],
           "percussive_by_span": seg}

    if args.video and has_video(args.video):
        # 切点数强依赖阈值，这件事必须打印出来，否则会和别的工具的数字打架。
        # 同一部片子：阈值 0.30 → 230 刀、0.40 → 130、0.50 → 76。
        # dsh-video-vision 报的 119 刀大致相当于这里的 0.42–0.45。
        period = 60.0 / bpm

        def _stats(thr):
            cs = cuts_of(args.video, thr)
            if not cs:
                return None
            o = []
            for c in cs:
                r = ((c - phase) / period) % 1.0
                o.append(min(r, 1 - r) * period)
            o = np.asarray(o)
            return {"count": len(cs), "threshold": thr,
                    "hit_40ms": round(float((o <= 0.04).mean()), 3),
                    "median_offset_ms": round(float(np.median(o) * 1000), 1)}

        hard_t = float(getattr(args, "cut_threshold", 0.45) or 0.45)
        hard = _stats(hard_t)
        loose = _stats(0.30) if hard_t > 0.31 else None
        if hard:
            print(f"  硬切 {hard['count']} 个（阈值 {hard_t:.2f}）· ≤40ms 命中 "
                  f"{hard['hit_40ms']*100:.0f}% · 中位偏移 {hard['median_offset_ms']:.0f}ms")
            out["cuts"] = hard
        if loose:
            print(f"  所有变化 {loose['count']} 个（阈值 0.30，含软过渡/溶解）· ≤40ms 命中 "
                  f"{loose['hit_40ms']*100:.0f}% · 中位偏移 {loose['median_offset_ms']:.0f}ms")
            out["cuts_loose"] = loose
        if not hard and not loose:
            print(f"  （阈值 {hard_t:.2f} 下没检出切点：可能是软过渡，或阈值太严；"
                  f"试小一点的 --cut-threshold）")
    elif args.video:
        print("  （这个文件没有视频流，跳过切点对位）")

    return out


def cuts_of(media, threshold=0.30):
    p = subprocess.run(
        [find_ffmpeg(), "-hide_banner", "-nostdin", "-i", media,
         "-filter:v", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True, errors="ignore",
    )
    out = []
    for line in p.stderr.splitlines():
        if "pts_time:" in line:
            try:
                out.append(float(line.split("pts_time:")[1].split()[0]))
            except (ValueError, IndexError):
                pass
    return out


# ─────────────────────────── 旋律 ───────────────────────────
def hz_note(f):
    import numpy as np
    if f is None or f <= 0:
        return "?"
    n = int(round(69 + 12 * np.log2(f / 440.0)))
    return f"{NAMES[n % 12]}{n // 12 - 1}"


def fix_octave_jumps(f0, window_s=1.0, fps=None):
    """把整八度跳变折回来。返回 (修正后 f0, 修正次数)。

    为什么必须做：pyin 在有人声混响/伴唱时会在基频与倍频之间整八度跳，
    直接取 nanmin/nanmax 会报出"E2–C6"这种 4 个八度的不可能值。

    **第 1 版是错的，记在这里**：拿"前一帧（已修正）"比较、跳变 >7 半音就折 12，
    会级联——真实的大跳被反复折，8 千帧里改了 5848 帧，音域被推到 G#10。
    现在改成向**局部中值**折回：每帧只问"离附近 1 秒内的中位音高差几个八度"，
    折到 ±6 半音以内。不依赖前一帧，因此不可能连锁。
    """
    import numpy as np

    f = np.array(f0, dtype='float64')
    voiced = np.isfinite(f) & (f > 0)
    if voiced.sum() < 8:
        return f, 0
    idx = np.where(voiced)[0]
    # MIDI 半音（A4=440=69）。之前写成 12*log2(f)，那是"相对 1 Hz 的半音数"，
    # 再按 MIDI 换算会整体偏高若干八度 —— 实测报出 G#6–C#8 就是这个单位错。
    st = 69.0 + 12.0 * np.log2(f[idx] / 440.0)

    # 局部中值：窗口约 window_s 秒（帧数由调用方给，缺省 43 帧 ≈ 1s @ hop 512/22050）
    w = int(fps or 43) | 1
    pad = w // 2
    ext = np.pad(st, pad, mode='edge')
    med = np.array([np.median(ext[i:i + w]) for i in range(len(st))])

    k = np.round((st - med) / 12.0)          # 差几个八度
    fixed = st - 12.0 * k
    n_fix = int(np.sum(k != 0))

    out = np.full(f.shape, np.nan, dtype='float64')
    out[idx] = 440.0 * 2.0 ** ((fixed - 69.0) / 12.0)
    return out, n_fix


def cmd_melody(args):
    import librosa
    import numpy as np

    y16 = load_audio(args.input)

    # 优先用 Demucs 拆出来的 vocal 轨：这才是"人声旋律"，
    # 否则 pyin 会一直锁在贝斯的基频上（音域会掉到 E2 一带）。
    source = "混合信号（含伴奏）"
    stems = None
    if getattr(args, "separate", True):
        stems = stems_for(args.input, use_gpu=True)
    if stems and "vocals" in stems:
        y16 = stems["vocals"]
        source = f"人声轨（{backend_label()}）"

    sr, hop = 22050, 512
    y = librosa.resample(y16, orig_sr=16000, target_sr=sr)
    if source.startswith("混合"):
        y = librosa.effects.hpss(y, margin=(1.0, 5.0))[0]

    # 跟踪器选择：默认自动 —— 有 torchcrepe 就用它（更准），没有就用 pyin（纯 librosa）。
    # 但 torchcrepe 会 import torch，而 torch 和 whisper 的 ctranslate2 同进程在某些机器上
    # 会崩（0xC0000409 堆损坏）。所以集中调用（sound_read = all）默认强制 pyin，
    # 单跑 melody 才用 torchcrepe。想改：SOUNDTRY_TRACKER=pyin|torchcrepe|auto。
    want = (os.environ.get("SOUNDTRY_TRACKER") or "auto").strip().lower()
    tracker = "pyin"
    if want != "pyin":
        try:
            import torchcrepe  # noqa: F401
            tracker = "torchcrepe"
        except Exception:
            pass
    if want == "torchcrepe" and tracker != "torchcrepe":
        print("# （要求用 torchcrepe 但导入失败，退回 pyin）")

    if tracker == "pyin":
        f0, _, _ = librosa.pyin(y, fmin=librosa.note_to_hz("E2"),
                                fmax=librosa.note_to_hz("C6"), sr=sr,
                                hop_length=hop, frame_length=2048)
    else:
        import torch
        import torchcrepe
        t = torch.from_numpy(y).unsqueeze(0)
        fmin, fmax = 82.0, 1046.0
        f0t, pd = torchcrepe.predict(t, sr, hop_length=hop, fmin=fmin, fmax=fmax,
                                     model="full", batch_size=1024,
                                     device="cuda" if torch.cuda.is_available() else "cpu",
                                     return_periodicity=True)
        f0t = torchcrepe.threshold.Silence(-60.0)(f0t, t, sr, hop_length=hop)
        f0 = f0t.squeeze(0).cpu().numpy()
        f0 = np.where(pd.squeeze(0).cpu().numpy() < 0.5, np.nan, f0)

    # 有的跟踪器会返回 0 或负数（无效帧），不清掉会让音域显示成 "?–G#5"
    f0 = np.where(f0 > 0, f0, np.nan)
    # 未经修正的 min/max 留着做对照：修正后的数字不能冒充"测量值"
    raw_rng = (hz_note(np.nanmin(f0)), hz_note(np.nanmax(f0))) if np.isfinite(f0).any() else ("?", "?")
    f0_fixed, octave_fixes = fix_octave_jumps(f0)
    if np.isfinite(f0_fixed).any():
        f0 = f0_fixed
    voiced = np.isfinite(f0)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    # 音域改用 5–95 分位：min/max 会被单帧极端值撑成"4 个八度"这种不可能的值
    if voiced.any():
        lo, hi = np.nanpercentile(f0[voiced], 5), np.nanpercentile(f0[voiced], 95)
        rng = (hz_note(lo), hz_note(hi))
    else:
        rng = ("?", "?")
    notes = np.array([hz_note(f) for f in f0[voiced]]) if voiced.any() else np.array([])

    top = []
    if len(notes):
        vals, cnts = np.unique(notes, return_counts=True)
        for i in np.argsort(-cnts)[:6]:
            top.append({"note": str(vals[i]), "frames": int(cnts[i])})

    # 调性：人声轨只反映旋律音，不合适做调性；用伴奏的谐波内容更稳。
    key_src = y
    if stems and "other" in stems and "bass" in stems:
        mix = stems["other"] + stems["bass"]
        key_src = librosa.resample(mix, orig_sr=16000, target_sr=sr)
    chroma = librosa.feature.chroma_cqt(y=key_src, sr=sr, hop_length=hop).mean(axis=1)
    key, kcorr = "?", 0.0
    for i in range(12):
        for nm, prof in (("major", MAJOR), ("minor", MINOR)):
            r = float(np.corrcoef(np.roll(prof, i), chroma)[0, 1])
            if r > kcorr:
                kcorr, key = r, f"{NAMES[i]} {nm}"

    print(f"# 旋律：{Path(args.input).name} · 跟踪器 {tracker} · 源={source}")
    print(f"  有声帧 {voiced.mean()*100:.0f}% · 音域 {rng[0]}–{rng[1]}（5–95 分位）· 调性 {key}（相关 {kcorr:.2f}）")
    if octave_fixes:
        print(f"    八度纠正 {octave_fixes} 帧 · 修正前 min–max 是 {raw_rng[0]}–{raw_rng[1]}"
              f"（min/max 会被单帧极端值撑大，所以音域改用分位数）")
    print("  出现最多的音：" + "  ".join(f"{t['note']}({t['frames']})" for t in top))

    windows = []
    if args.window:
        for w in args.window:
            label, a, b = w.split(":")
            a, b = float(a), float(b)
            m = (times >= a) & (times <= b) & voiced
            if not m.any():
                windows.append({"label": label, "from": a, "to": b, "notes": []})
                continue
            seg = f0[m]
            seq = [hz_note(x) for x in seg[::max(1, len(seg) // 8)]]
            rel = (12 * np.log2(seg / np.nanmedian(seg))).tolist()
            windows.append({"label": label, "from": a, "to": b, "notes": seq,
                            "relative_semitones": [round(x, 1) for x in rel[::max(1, len(rel)//10)]]})
            print(f"  {label} [{a}-{b}s] " + " → ".join(seq))

    return {"ok": True, "tracker": tracker, "voiced_ratio": round(float(voiced.mean()), 3),
            "range": {"low": rng[0], "high": rng[1]},
            "range_raw_minmax": {"low": raw_rng[0], "high": raw_rng[1]},
            "octave_fixes": octave_fixes, "key": key, "key_correlation": round(kcorr, 2),
            "top_notes": top, "windows": windows}


# ─────────────────────────── 和弦 ───────────────────────────
def cmd_chords(args):
    import librosa
    import numpy as np

    y16 = load_audio(args.input)
    stems = stems_for(args.input, use_gpu=True) if getattr(args, "separate", True) else None

    if stems and "other" in stems and "bass" in stems:
        harmonic = np.asarray(stems["other"], dtype="float32") + np.asarray(stems["bass"], dtype="float32")
        source = f"伴奏（{backend_label()}：bass+other，去掉人声与鼓）"
    else:
        y = librosa.resample(y16, orig_sr=16000, target_sr=22050)
        harmonic = librosa.effects.hpss(y, margin=(1.0, 5.0))[0]
        source = "混合信号的谐波分量（未分离，和弦会被歌声污染）"

    # 定调 → 决定用库里哪一行（库是固定的 24 调表，见 build_key_library）
    hch = librosa.feature.chroma_cqt(
        y=librosa.resample(harmonic, orig_sr=16000, target_sr=22050),
        sr=22050, hop_length=512).mean(axis=1)
    key_pc, key_mode, key_corr = estimate_key_from_chroma(hch)
    forced = getattr(args, "key", None)
    if forced:
        pc, mode = parse_key_arg(forced)
        if pc is not None:
            key_pc, key_mode = pc, mode
            print(f"  （--key {forced}：强制使用该调的调内表）")

    allowed = key_to_indices(key_pc, key_mode, [c[0] for c in chord_candidates()])
    res = detect_chords(None, harmonic, key_pc=key_pc, key_mode=key_mode)
    tl = res["timeline"]
    dur = len(y16) / 16000.0
    print(f"  调性：{NAMES[key_pc]} {key_mode}（相关 {key_corr:.2f}）→ 调内候选 {len(allowed)}/{len(chord_candidates())}")

    # 低音判转位：我们已经分离出 bass 轨，却在和声判定里没用它——白丢一个强信号。
    # 段内 strongest bass 音级 ≠ 根音，就是转位（C/E 这种）。
    if stems and "bass" in stems:
        bass = librosa.resample(np.asarray(stems["bass"], dtype="float32"),
                                orig_sr=16000, target_sr=22050)
        bchroma = librosa.feature.chroma_cqt(y=bass, sr=22050, hop_length=512)
        bchroma = bchroma / (bchroma.sum(axis=0, keepdims=True) + 1e-9)
        bt = np.arange(bchroma.shape[1]) * (512 / 22050.0)
        # 只有"低音是和弦音且不是根音"才算转位。否则贝斯只是走了别的音，
        # 硬标 C/E 会满屏假转位（第一版 43 段里标了 35 段）。
        tones_of = {lab: set(tones) for lab, tones in chord_candidates()}
        for s in tl:
            m = (bt >= s["start"]) & (bt < s["end"])
            if not m.any():
                continue
            pc = int(np.argmax(bchroma[:, m].mean(axis=1)))
            s["bass"] = NAMES[pc]
            chord_tones = tones_of.get(s.get("chord", ""), set())
            if s.get("root") and s["bass"] != s["root"] and pc in chord_tones:
                s["inversion"] = f"{s['root']}/{s['bass']}"

    confident = [s for s in tl if s.get("confident")]
    roots_only = {}
    for s in tl:
        r = s.get("root") or s.get("chord", "?")
        roots_only[r] = roots_only.get(r, 0) + (s["end"] - s["start"])

    print(f"# 和弦：{dur:.1f}s · {len(tl)} 段 · 源={source}")
    for a in range(0, int(dur) + 1, 10):
        seg = [s for s in tl if a <= s["start"] < a + 10]
        if seg:
            print(f"  {a:>3}s  " + "  ".join(
                f"{s['chord']}{'?' if not s.get('confident') else ''}({s['start']:.1f})" for s in seg))
    print("  和弦时长占比：" + "  ".join(f"{c} {t:.0f}s" for c, t in res["histogram"]))
    print(f"  置信度：{len(confident)}/{len(tl)} 段根音明确（{len(confident)/max(1,len(tl))*100:.0f}%），"
          f"带 ? 的是品质/根音存疑")
    if roots_only:
        top_r = sorted(roots_only.items(), key=lambda kv: -kv[1])[:5]
        print("  只报根音（更可靠）：" + "  ".join(f"{r} {t:.0f}s" for r, t in top_r))
    inv = [s for s in tl if s.get("inversion")]
    if inv:
        print(f"  转位 {len(inv)} 段：" + "  ".join(f"{s['inversion']}({s['start']:.0f}s)" for s in inv[:6]))

    return {"ok": True, "duration": round(dur, 1), "source": source,
            "segments": len(tl), "confident_segments": len(confident),
            "timeline": tl,
            "roots_only": [{"root": r, "seconds": round(t, 1)} for r, t in
                           sorted(roots_only.items(), key=lambda kv: -kv[1])],
            "inversions": [{"at": s["start"], "label": s["inversion"]} for s in inv],
            "histogram": [{"chord": c, "seconds": round(t, 1)} for c, t in res["histogram"]]}


# ─────────────────────────── 结构 ───────────────────────────
def novelty_splits(mix, vr, dr, W, rows, max_sec=32.0, min_gap=14.0, max_per_row=3):
    """在过长段落内部找"内容变了"的时刻（自相似矩阵 + 棋盘核新颖度）。

    只对 > max_sec 的段做，并且相邻切点至少隔 min_gap 秒 —— 免得把副歌内部
    正常的两小节变化也切碎。
    """
    import numpy as np

    n = len(mix)
    if n < 16:
        return []
    F = np.stack([np.log1p(mix), np.log1p(vr), np.log1p(dr)])
    F = (F - F.mean(axis=1, keepdims=True)) / (F.std(axis=1, keepdims=True) + 1e-9)
    S = (F.T @ F) / F.shape[0]

    k = max(4, int(round(4.0 / W)))
    if k % 2:
        k += 1
    h = k // 2
    win = np.outer(np.hanning(k), np.hanning(k))
    g = win.copy()
    g[:h, :h] *= -1.0
    g[h:, h:] *= -1.0
    nov = np.zeros(n)
    for i in range(h, n - h):
        nov[i] = float((S[i - h:i + h, i - h:i + h] * g).sum())

    out = []
    for r in rows:
        if r["end"] - r["start"] <= max_sec:
            continue
        a = int(r["start"] / W) + int(min_gap / W)
        b = int(r["end"] / W) - int(min_gap / W)
        if b - a < 8:
            continue
        seg = nov[a:b]
        thr = float(np.percentile(seg, 95))
        peaks = [a + i for i in range(1, len(seg) - 1)
                 if seg[i] > thr and seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]]
        chosen = []
        for p in peaks:
            if len(chosen) >= max_per_row:
                break
            if all(abs(p - q) * W >= min_gap for q in chosen):
                chosen.append(p)
        out.extend(p * W for p in chosen)
    return sorted(out)


def cmd_structure(args):
    """段落边界：0.25 秒窗、不做中值滤波。

    之前用临时脚本做这件事时用了 1 秒窗 + 3 秒中值滤波 + 「短于 4 秒并入邻居」，
    边界因此偏了 1–3 秒，叠加后最多到 5 秒。这里改成细窗、不滤波、只合并
    「短于 min_len 且标签相同」的碎片，边界按 0.25 秒精度报。
    """
    import librosa
    import numpy as np

    y = load_audio(args.input)
    dur = len(y) / 16000.0
    stems = stems_for(args.input, use_gpu=True) if getattr(args, "separate", True) else None
    zp = np.zeros_like(y)
    voc = np.asarray(stems["vocals"], dtype="float32") if stems and "vocals" in stems else zp
    dru = np.asarray(stems["drums"], dtype="float32") if stems and "drums" in stems else zp
    src = f"人声轨/鼓轨（{backend_label()}）" if stems else "混合信号（未分离，只有整体能量）"

    W = float(getattr(args, "window", 0.25) or 0.25)
    n = int(W * 16000)
    k = int(dur / W)

    def env(x):
        x = np.asarray(x, dtype="float32")
        if len(x) < k * n:
            x = np.pad(x, (0, k * n - len(x)))
        return np.sqrt((x[:k * n].reshape(k, n).astype("float64") ** 2).mean(axis=1))

    mix, vr, dr = env(y), env(voc), env(dru)
    if stems:
        vthr = max(np.percentile(vr, 10), 0.12 * np.percentile(vr, 95))
        dthr = max(np.percentile(dr, 10), 0.12 * np.percentile(dr, 95))
    else:
        vthr = dthr = float("inf")

    raws = []
    for i in range(k):
        has_v, has_d = vr[i] > vthr, dr[i] > dthr
        seg = "full" if (has_v and has_d) else "vocal" if has_v else "inst" if has_d else "quiet"
        raws.append(seg)

    runs = []
    for i, L in enumerate(raws):
        if runs and runs[-1][0] == L:
            runs[-1][2] = i + 1
        else:
            runs.append([L, i, i + 1])

    min_len = float(getattr(args, "min_len", 2.0) or 2.0)
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for j, r in enumerate(runs):
            if (r[2] - r[1]) * W < min_len:
                nbr = runs[j - 1] if j > 0 else runs[j + 1]
                nbr[2] = max(nbr[2], r[2]); nbr[1] = min(nbr[1], r[1])
                runs.pop(j); changed = True
                break
        merged = []
        for r in runs:
            if merged and merged[-1][0] == r[0]:
                merged[-1][2] = r[2]
            else:
                merged.append(list(r))
        runs = merged

    chords = detect_chords(None, np.asarray(stems["bass"], dtype="float32") + np.asarray(stems["other"], dtype="float32"))["timeline"] if stems else []

    def mmss(t, tenth=False):
        m, s = int(t // 60), t - 60 * int(t // 60)
        return f"{m}:{s:04.1f}" if tenth else f"{m}:{int(s):02d}"

    LAB = {"quiet": "无人声", "inst": "器乐", "vocal": "人声", "full": "全编"}
    rows = []
    for idx, (L, a, b) in enumerate(runs):
        t0, t1 = a * W, b * W
        m = float(mix[a:b].mean())
        name = LAB[L]
        if L == "quiet":
            name = "前奏" if idx == 0 else "尾奏" if idx == len(runs) - 1 else "断口"
        elif L == "inst":
            name = "间奏"
        elif L == "full":
            name = "副歌"
        elif L == "vocal":
            name = "主歌"
        rows.append({"label": name, "start": round(t0, 2), "end": round(t1, 2),
                     "mix": round(m, 3),
                     "vocal": round(float(vr[a:b].mean()), 3),
                     "drums": round(float(dr[a:b].mean()), 3),
                     "chord_changes": int(sum(1 for c in chords if t0 <= c["start"] < t1))})

    # 用自相似+新颖度把过长的段切开：原实现里副歌 57.5–235s 只有一条，
    # 桥段和小段落变化全被吞掉。切点只在段内部找，且至少隔 8 秒。
    splits = novelty_splits(mix, vr, dr, W, rows)
    if splits:
        new_rows = []
        for r in rows:
            pts = [t for t in splits if r["start"] + 1e-6 < t < r["end"] - 1e-6]
            if not pts:
                new_rows.append(r)
                continue
            bounds = [r["start"]] + pts + [r["end"]]
            for j in range(len(bounds) - 1):
                a0, b0 = bounds[j], bounds[j + 1]
                ia, ib = int(a0 / W), max(int(b0 / W), int(a0 / W) + 1)
                if ib > len(mix):
                    ib = len(mix)
                sub = dict(r)
                sub["start"], sub["end"] = round(a0, 2), round(b0, 2)
                sub["mix"] = round(float(mix[ia:ib].mean()), 3)
                sub["vocal"] = round(float(vr[ia:ib].mean()), 3)
                sub["drums"] = round(float(dr[ia:ib].mean()), 3)
                sub["chord_changes"] = int(sum(1 for c in chords if a0 <= c["start"] < b0))
                new_rows.append(sub)
        # 子段重新打标签：沿用父段会让整首都是"副歌"。按人声/鼓/能量的相对水平判。
        v_thr = float(np.percentile(vr, 45))
        v_hi = float(np.percentile(vr, 70))
        m_med = float(np.median(mix))
        d_thr = float(np.percentile(dr, 45)) if dr.max() > 0 else float('inf')
        for r in new_rows:
            if "峰值" in str(r.get("label", "")):
                continue
            v, m, d = r["vocal"], r["mix"], r["drums"]
            if v < v_thr and d < d_thr:
                r["label"] = "断口/器乐"
            elif v >= v_hi and m >= m_med:
                r["label"] = "副歌"
            elif v >= v_thr:
                r["label"] = "主歌"
            else:
                r["label"] = "器乐段"
        rows = new_rows

    # 标签事后修正：没有独立人声/鼓、但整体很响的段，不是"断口"。
    # 基准必须用"段平均能量"的最大值 —— 用 0.25 秒窗的瞬时最高值会被一个镲片
    # 瞬态抬高，于是 0.277 的响段仍被标成静音。
    sec_max = max((r["mix"] for r in rows), default=0.0)
    for r in rows:
        if r["label"] == "断口" and sec_max > 0 and r["mix"] > 0.6 * sec_max:
            r["label"] = "器乐段"

    # 峰值要在平滑曲线上找：0.25 秒窗下，一个 2.5 秒的瞬态（镲片/混响尾巴）
    # 会冒充全曲最高点。用 1.5 秒滑动平均再取最大。
    sm = np.convolve(mix, np.ones(max(1, int(1.5 / W))) / max(1, int(1.5 / W)), mode="same")
    pi = int(np.argmax(sm))
    peak_t = pi * W
    peak = next((r for r in rows if r["start"] <= peak_t < r["end"]), rows[0])
    peak["label"] += "（峰值）"
    print(f"# 结构：{dur:.1f}s · 窗 {W:.2f}s · 最小段 {min_len:.1f}s · 源={src}")
    if stems:
        print(f"  判定阈值：人声 {vthr:.4f} / 鼓 {dthr:.4f}（= 各自 P95 的 12%）")
    print(f"{'区间':>15} {'标记':<10} {'总能量':>7} {'人声':>6} {'鼓':>6} {'换手':>4}")
    for r in rows:
        print(f"{mmss(r['start'], True):>6}–{mmss(r['end'], True):<8} {r['label']:<10} "
              f"{r['mix']:>7.3f} {r['vocal']:>6.3f} {r['drums']:>6.3f} {r['chord_changes']:>4}")

    # 三个"硬事件"：人声进入 / 鼓进入 / 能量峰值
    def first_sustained(arr, thr, hold=1.0):
        need = max(1, int(hold / W))
        for i in range(len(arr) - need + 1):
            if all(arr[i + j] > thr for j in range(need)):
                return round(i * W, 2)
        return None

    events = {"vocal_in": first_sustained(vr, vthr) if stems else None,
              "drums_in": first_sustained(dr, dthr) if stems else None,
              "peak": peak["start"], "peak_end": peak["end"]}
    bits = []
    if events["vocal_in"] is not None:
        bits.append(f"人声进 {mmss(events['vocal_in'], True)}")
    if events["drums_in"] is not None:
        bits.append(f"鼓进 {mmss(events['drums_in'], True)}")
    bits.append(f"峰值 {mmss(peak['start'], True)}–{mmss(peak['end'], True)}（{peak['mix']:.3f}）")
    print("\n# " + " · ".join(bits))
    return {"ok": True, "duration": round(dur, 1), "window": W, "source": src,
            "sections": rows, "events": events}


# ─────────────────────────── 汇总 ───────────────────────────
def cmd_all(args):
    out = {"ok": True, "file": args.input, "audio": has_audio(args.input)}
    if not out["audio"]:
        print("# 这条文件没有音频流（bilibili 的 DASH 下载通常把音视频分成两个文件）")
        print("  提示：把 30xxx 视频流和 302xx 音频流用 ffmpeg -c copy 合并后再调用")
        return out

    sep = getattr(args, "separate", True)
    # sound_read 一个进程里要同时跑 whisper（ctranslate2）和旋律跟踪（torchcrepe/torch），
    # 这正是会触发 0xC0000409 的组合。默认把跟踪器钉死在 pyin，让这个进程完全碰不到 torch；
    # 想要 torchcrepe 的精度就单独调 sound_melody，或显式设 SOUNDTRY_TRACKER=torchcrepe。
    os.environ.setdefault("SOUNDTRY_TRACKER", "pyin")
    print("=" * 60)
    tr = cmd_transcribe(argparse.Namespace(
        input=args.input, model=args.model, device=args.device, compute=args.compute,
        lang=args.lang, beam=args.beam, vad=args.vad, prompt=args.prompt, srt=args.srt,
        head=args.head, include_cues=False, separate=sep, vad_mode=args.vad_mode))
    print("=" * 60)
    rh = cmd_rhythm(argparse.Namespace(input=args.input, video=args.input))
    print("=" * 60)
    me = cmd_melody(argparse.Namespace(input=args.input, window=args.window or [], separate=sep))
    print("=" * 60)
    ch = cmd_chords(argparse.Namespace(input=args.input, separate=sep))

    out.update({"transcript": tr, "rhythm": rh, "melody": me, "chords": ch})

    # 一句话结论
    agree = (rh.get("bpm_agreement") or {}).get("status")
    bpm_note = ("（两法分歧，别引用）" if agree == "conflict"
                else "（半/倍速歧义）" if agree == "octave"
                else "（不确定）" if rh.get("ambiguous") else "")
    bits = [f"{tr['duration']:.0f} 秒",
            f"{tr['segments']} 条语音/歌词（覆盖 {tr['coverage']*100:.0f}%）",
            f"{rh['bpm']:.0f} BPM{bpm_note}",
            f"人声音域 {me['range']['low']}–{me['range']['high']}",
            f"调性 {me['key']}"]
    if tr.get("dropped_hallucinations"):
        bits.append(f"滤掉 {tr['dropped_hallucinations']} 段幻觉")
    if rh.get("cuts"):
        bits.append(f"{rh['cuts']['count']} 个切点、踩拍 {rh['cuts']['hit_40ms']*100:.0f}%")
    if ch.get("histogram"):
        bits.append("主要和弦 " + "/".join(h["chord"] for h in ch["histogram"][:3]))
    print("\n# 摘要：" + " · ".join(bits))
    out["summary"] = " · ".join(bits)
    return out


# ─────────────────────────── 体检 ───────────────────────────
def cmd_doctor(args):
    """把"借来的东西在不在"一次说清楚。"""
    import importlib

    rows = []

    def add(name, ok, detail):
        rows.append((name, bool(ok), detail))

    add("python", True, f"{sys.version.split()[0]}  {sys.executable}")
    # torch 这一族在 selfcontained 模式里本来就不装：分离走 MDX-Net ONNX、音高走 pyin。
    # 它们不是"缺了"，是"不需要"——算成失败会让 10/14 这种分数吓人且不准确。
    optional_torch = {"demucs", "torchcrepe", "torchaudio"}
    for mod in ("numpy", "soundfile", "librosa", "faster_whisper", "ctranslate2",
                "demucs", "torchcrepe", "torchaudio"):
        try:
            m = importlib.import_module(mod)
            add(mod, True, getattr(m, "__version__", "ok"))
        except Exception as e:
            if mod in optional_torch:
                add(f"{mod}（可选，本模式不需要）", True,
                    f"未安装——分离走 ONNX、音高走 pyin，功能不受影响（{type(e).__name__}）")
            else:
                add(mod, False, f"{type(e).__name__}: {e}")

    try:
        import torch
        add("torch (借用 ComfyUI)", True,
            f"{torch.__version__} cuda={torch.version.cuda} available={torch.cuda.is_available()}")
        if torch.cuda.is_available():
            add("gpu", True, torch.cuda.get_device_name(0))
    except Exception as e:
        add("torch（可选，selfcontained 不需要）", True,
            f"未安装——分离走 MDX-Net ONNX，不经过 torch（{type(e).__name__}）")

    try:
        import ctranslate2
        add("ctranslate2 CUDA 设备数", ctranslate2.get_cuda_device_count() > 0,
            str(ctranslate2.get_cuda_device_count()))
    except Exception as e:
        add("ctranslate2", False, str(e))

    try:
        ff = find_ffmpeg()
        add("ffmpeg", True, ff)
    except SystemExit as e:
        add("ffmpeg", False, str(e))

    for mname in (DEFAULT_MODEL, "large-v3"):
        mdir = MODELS_DIR / mname
        have = mdir.is_dir() and (mdir / "model.bin").is_file()
        size = f"{(mdir / 'model.bin').stat().st_size / 1024**2:.0f} MB" if have else ""
        if mname == DEFAULT_MODEL:
            add(f"模型 {mname}（默认）", have, f"{mdir} {size}".strip())
        else:
            # 备用模型缺失不算失败——1.0 默认只用 medium，large-v3 是可选的。
            add(f"模型 {mname}（备用，可选）" + ("" if have else " — 未下载，用不到可以不管"),
                True, f"{mdir} {size}".strip())

    for name, ok, detail in rows:
        print(f"{'ok  ' if ok else 'FAIL'} {name} — {detail}")
    bad = [r for r in rows if not r[1] and r[0] not in ()]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} 项就绪")
    return {"ok": not bad, "checks": [{"name": n, "ok": o, "detail": d} for n, o, d in rows]}


# ─────────────────────────── 入口 ───────────────────────────
def main():
    ap = argparse.ArgumentParser(prog="soundtry")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("input")
        p.add_argument("--model", default=os.environ.get("SOUNDTRY_MODEL", "medium"))
        p.add_argument("--device", default=os.environ.get("SOUNDTRY_DEVICE", "cuda"))
        p.add_argument("--compute", default=os.environ.get("SOUNDTRY_COMPUTE", ""))
        p.add_argument("--lang", default="auto",
                   help="auto=先探测再全程复用（默认）；也可指定 zh/ja/en/...")
        p.add_argument("--beam", type=int, default=5)
        p.add_argument("--vad", action="store_true",
                       help="兼容旧参数：等价于 --vad-mode mix（在混合信号上用 Silero VAD，对唱歌不可靠）")
        p.add_argument("--vad-mode", choices=["auto", "off", "mix", "vocals"], default=None,
                       help="auto=有人声轨时用 vocals（先切分再转写，从源头防幻觉）；"
                            "vocals=只转写人声区间；mix=混合信号上的 Silero VAD；off=整条转写")
        p.add_argument("--prompt", default=os.environ.get("SOUNDTRY_PROMPT"))
        p.add_argument("--srt", default=None)
        p.add_argument("--head", type=int, default=20)
        p.add_argument("--start", type=float, default=0.0)
        p.add_argument("--end", type=float, default=None)
        p.add_argument("--lyrics", default=None,
                       help="真歌词文本文件：自动用它生成 prompt，并在结尾报告逐行覆盖率")
        p.add_argument("--separator", choices=["auto", "onnx", "demucs", "hpss", "none"], default=None,
                       help="分离后端：auto=onnx>demucs>hpss；onnx=MDX-Net(无torch)；demucs；hpss=零依赖兜底")
        p.add_argument("--separate", action=argparse.BooleanOptionalAction, default=True,
                       help="先用分离器分出人声（默认开；--no-separate 退回混合信号）")

    p = sub.add_parser("transcribe"); common(p); p.set_defaults(func=cmd_transcribe)
    p.add_argument("--include-cues", action="store_true")

    p = sub.add_parser("rhythm")
    p.add_argument("input"); p.add_argument("--video", default=None)
    p.add_argument("--bpm", type=float, default=0, help="强制指定 BPM（候选分不出胜负时用）")
    p.add_argument("--fps", type=float, default=25.0, help="时间码帧率，默认 25")
    p.add_argument("--downbeat", type=int, choices=[0, 1, 2, 3], default=None,
                   help="强制第 1 拍是四个候选里的哪个（报告里会给出四相位的底鼓强度）")
    p.add_argument("--retry-low-coverage", action="store_true",
                   help="对覆盖率<40%的短块重跑一次（更慢，实测常无收益，默认关）")
    p.add_argument("--grid-level", choices=["bar", "beat"], default="bar")
    p.add_argument("--bars-csv", default=None, help="逐小节能量表（bar,start,end,rms,鼓在不在）")
    p.add_argument("--grid-csv", default=None,
                   help="把小节网格导出成 CSV 标记表（可导入 Premiere / 达芬奇的标记面板）")
    p.add_argument("--cut-threshold", type=float, default=0.45,
                   help="场景检测阈值：0.45≈硬切；0.30 会把软过渡/溶解也算进来（切点数差近 3 倍）")
    p.set_defaults(func=cmd_rhythm)

    p = sub.add_parser("melody")
    p.add_argument("input"); p.add_argument("--window", action="append", default=[])
    p.add_argument("--separator", choices=["auto", "onnx", "demucs", "hpss", "none"], default=None)
    p.add_argument("--separate", action=argparse.BooleanOptionalAction, default=True)
    p.set_defaults(func=cmd_melody)

    p = sub.add_parser("chords")
    p.add_argument("input")
    p.add_argument("--separator", choices=["auto", "onnx", "demucs", "hpss", "none"], default=None)
    p.add_argument("--separate", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--key", default=None,
                   help="强制调性，如 G#m / C / F#major（定调错时才需要；默认自动定调）")
    p.set_defaults(func=cmd_chords)

    p = sub.add_parser("structure")
    p.add_argument("input")
    p.add_argument("--window", type=float, default=0.25, help="分析窗长（秒），默认 0.25")
    p.add_argument("--min-len", type=float, default=2.0, help="短于此长度的碎片并入邻居，默认 2 秒")
    p.add_argument("--separator", choices=["auto", "onnx", "demucs", "hpss", "none"], default=None)
    p.add_argument("--separate", action=argparse.BooleanOptionalAction, default=True)
    p.set_defaults(func=cmd_structure)

    # 内部命令：只做分离、只写 flac，供 stems_for 的子进程调用。
    p = sub.add_parser("stems")
    p.add_argument("input")
    p.add_argument("--gpu", action=argparse.BooleanOptionalAction, default=True)
    p.set_defaults(func=cmd_stems)

    p = sub.add_parser("all"); common(p)
    p.add_argument("--window", action="append", default=[])
    p.set_defaults(func=cmd_all)

    p = sub.add_parser("doctor")
    p.add_argument("input", nargs="?", default="")
    p.set_defaults(func=cmd_doctor)

    # 防御：`input` 是位置参数。若调用方写成 `--input <path>`（历史 bug），这里改回位置参数，
    # 而不是让 argparse 报 "unrecognized arguments: --input" 把整个工具打挂。
    argv = sys.argv[1:]
    while "--input" in argv:
        i = argv.index("--input")
        if i + 1 >= len(argv):
            argv = argv[:i]
            break
        val = argv[i + 1]
        argv = argv[:i] + [val] + argv[i + 2:]

    args = ap.parse_args(argv)
    # CPU 上 float16 极慢（实测 252s 的歌唱 224s，改 int8 后 13s）。设备落在 CPU 就默认 int8。
    # 显式传 --compute 或 SOUNDTRY_COMPUTE 时不覆盖。
    if not getattr(args, "compute", ""):
        args.compute = "int8" if str(getattr(args, "device", "")).startswith("cpu") else "float16"


    # 设备语义：设置页写 auto/gpu/cpu；这里统一成 cuda/cpu，并在降级时说清楚。
    _dev = (os.environ.get("SOUNDTRY_DEVICE") or "auto").strip().lower()
    if _dev in ("auto", "gpu", "cpu"):
        _vram = nvidia_vram_gb()
        if _dev == "cpu":
            _eff = "cpu"
        elif _dev == "gpu":
            if _vram is None:
                _eff = "cpu"
                print("# （没检测到 NVIDIA 显卡，已改用 CPU）")
            elif _vram < 4:
                _eff = "cpu"
                print(f"# ⚠ 显存 {_vram} GB，小于 4 GB，暂不支持 GPU 推理加速（已强制 CPU）")
            else:
                _eff = "cuda"
        else:
            _eff = "cuda" if (_vram is not None and _vram >= 4) else "cpu"
        os.environ["SOUNDTRY_DEVICE"] = _eff
        args.device = _eff

    if getattr(args, "separator", None):
        os.environ["SOUNDTRY_SEPARATOR"] = args.separator
    if getattr(args, "vad_mode", None) is None:
        args.vad_mode = "mix" if getattr(args, "vad", False) else "auto"
    if args.cmd != "doctor" and not Path(args.input).is_file():
        raise SystemExit(f"文件不存在：{args.input}")

    result = args.func(args)
    print(JSON_MARK + json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    sys.stderr.flush()
    # 已知问题：某些机器上 torch 的 CUDA 清理会和 ctranslate2 打架，崩溃点在
    # "结果已打印、解释器退出时"（Windows 上是 0xC0000409 堆损坏，没有 Python 栈）。
    # 结果已经写进 stdout 了，这里直接跳过后面的 atexit/GC，等于绕开崩溃现场。
    # 想保留正常退出：设 SOUNDTRY_SAFE_EXIT=0。
    if os.environ.get("SOUNDTRY_SAFE_EXIT", "1") == "1":
        os._exit(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
