/**
 * tools.js — 四个工具的声明。
 *
 * 描述会进系统提示，每次请求都要付 token，所以这里只写"什么时候用、怎么读结果"，
 * 不写实现细节。真正的分析都在 python/soundtry.py 里，结果以文本块返回。
 */
import { runSoundtry } from './runner.js';

export const READ_TOOL = 'sound_read';
export const TRANSCRIBE_TOOL = 'sound_transcribe';
export const RHYTHM_TOOL = 'sound_rhythm';
export const MELODY_TOOL = 'sound_melody';
export const CHORDS_TOOL = 'sound_chords';
export const STRUCTURE_TOOL = 'sound_structure';

const SEPARATE_DESC = 'Split vocals from the mix before analysing (default ON — do not turn this off casually). '
  + 'With it off, three things degrade at once: the melody locks onto the bass, chords get polluted by the singer, '
  + 'AND whisper starts inventing lines over instrumental sections (measured case: a 10 s intro came out as '
  + '"Zither Harp"). Only set false when separation itself is broken, or the input is already a dry vocal stem.';

const INPUT_DESC = 'A media file: a video (mp4/mkv/…) or an audio file (wav/mp3/flac…). Absolute path, or '
  + 'relative to the working directory. bilibili DASH downloads split streams: pass the file that has audio, '
  + 'or mux them first (ffmpeg -i video -i audio -c copy out.mp4).';

/**
 * 把工具参数转成 python CLI 的 argv。
 *
 * 关键：`input` 在 python 侧是**位置参数**（`p.add_argument("input")`），
 * 不是 `--input`。这里必须单独处理，否则 argparse 会把路径吃掉当位置参数、
 * 只剩一个孤儿 `--input` 报 unrecognized —— 五个工具会同时挂。
 * 位置参数必须排在所有 flag 之前。
 */
function toArgs(pairs) {
  const out = [];
  const positional = pairs.input;
  if (positional !== undefined && positional !== null && positional !== false) {
    out.push(String(positional));
  }
  for (const [key, value] of Object.entries(pairs)) {
    if (key === 'input') continue;              // 已经作为位置参数放进去了
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    if (value === true) { out.push(flag); continue; }
    if (Array.isArray(value)) {
      for (const v of value) out.push(flag, String(v));
      continue;
    }
    out.push(flag, String(value));
  }
  return out;
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string', description: 'Human-readable analysis report.' } },
  },
  render(args, value) {
    return [{ type: 'text', text: value?.text ?? '(no output)' }];
  },
};

export function readSpec() {
  return {
    name: READ_TOOL,
    description: [
      'Understand what a video/audio actually SOUNDS like — one call, local, zero token cost for the audio side.',
      '',
      'Returns four things about the same file:',
      '  - transcript: timestamped speech/lyrics, transcribed from the SEPARATED vocal stem (Demucs) so the',
      '    accompaniment does not garble the words, with segments that have no vocal energy or match a known',
      '    whisper-hallucination pattern (credits, "like and subscribe") dropped and counted;',
      '  - rhythm: BPM resolved by grid-fitting + phase sweep + half/double disambiguation (librosa\'s own',
      '    number is reported only as a reference, because it is a whole-track scalar and is routinely wrong),',
      '    plus cut density and whether the cuts land on the beat;',
      '  - melody: pitch range, top notes, key estimate, and the contour of the windows you ask for, tracked on',
      '    the vocal stem with torchcrepe (falls back to pyin);',
      '  - chords: a smoothed chord timeline from the accompaniment (bass+other, vocals and drums removed).',
      '',
      'Read the numbers like this: the winning BPM is scored by three signals — per-half contrast (a wrong',
      'tempo drifts and loses energy in the second half), phase continuity across the halves, and odd/even',
      'beat-strength ratio near 1.0 (every beat carries a hit). When the report says 不确定/ambiguous, the top',
      'candidate is within 10% of the runner-up: quote the range, not a single number. `hit_40ms` under ~0.3',
      'means picture and music run in parallel rather than being cut to the beat. Chord quality (maj7 vs m)',
      'is the least reliable part: trust the root and the harmonic rhythm, not the 7th.',
      '',
      'NOT covered: whether it is good, why a hook works, what the singer feels. Those need ears.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        model: { type: 'string', description: 'Whisper model name or path. Default large-v3 (bundled).' },
        language: { type: 'string', description: 'Spoken language code, e.g. zh, en, ja. Default zh; use auto to detect.' },
        windows: {
          type: 'array',
          items: { type: 'string' },
          description: 'Melody windows as "label:start:end" in seconds, e.g. "chorus:67.8:70.2".',
        },
        srt: { type: 'string', description: 'Write a full SRT to this path as a side effect.' },
        vad: {
          type: 'boolean',
          description: 'Enable voice-activity filtering. Off by default: on sung material VAD classifies the whole '
            + 'song as non-speech and you lose almost every line.',
        },
        prompt: { type: 'string', description: 'Bias text for the recogniser (names, jargon, a lyric line).' },
        head: { type: 'number', description: 'How many transcript lines to print. Default 20.' },
        lyrics: { type: 'string', description: 'Path to a plain-text lyric file. Turns it into the recogniser prompt (which is the single biggest accuracy win on sung material) and reports per-line recall.' },
        vadMode: {
          type: 'string',
          enum: ['auto', 'vocals', 'off', 'mix'],
          description: 'Escape hatch for the voice-region gate. "auto" (default) splits the vocal stem into blocks and only sends those to the recogniser — this is what stops whisper from inventing lines over instrumental sections. If a machine crashes on that path (native heap corruption from torch+ctranslate2 coexisting), pass "off" to transcribe the whole file in one go: same text quality on clean material, but hallucination protection is lost.',
        },
        separator: {
          type: 'string',
          enum: ['auto', 'onnx', 'demucs', 'hpss', 'none'],
          description: 'Separation backend. "auto" (default) picks MDX-Net via onnxruntime (no torch, best on dense rap), then demucs if available, then HPSS. "onnx" forces MDX (63 MB model, downloaded on first run); "hpss" is a crude zero-dependency fallback that pollutes chords/melody.',
        },        separate: { type: 'boolean', description: SEPARATE_DESC },      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'listen to media', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('all', {
        args: toArgs({
          input: args.input, model: args.model, lang: args.language,
          window: args.windows, srt: args.srt, vad: args.vad, vadMode: args.vadMode,
          prompt: args.prompt, head: args.head, separate: args.separate, separator: args.separator, lyrics: args.lyrics,
        }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}

export function transcribeSpec() {
  return {
    name: TRANSCRIBE_TOOL,
    description: [
      'Transcribe speech or sung lyrics to text with word-accurate timestamps, locally (faster-whisper).',
      '',
      'Use for: what is being said, subtitles, quotes, lecture notes, checking a video has no narration.',
      'Windows: `start`/`end` slice in memory and timestamps stay absolute, so a 2-hour file can be paged.',
      'Cost: zero tokens for the audio, only the returned text.',
      'Gotcha: keep `vad` off for songs — VAD treats sustained singing as non-speech and returns almost nothing.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        start: { type: 'number', description: 'Window start in seconds (default 0).' },
        end: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        language: { type: 'string', description: 'Language code (default zh; auto to detect).' },
        model: { type: 'string', description: 'Whisper model name or path; default large-v3 (bundled).' },
        srt: { type: 'string', description: 'Write the full SRT here, e.g. D:/out.srt.' },
        prompt: { type: 'string', description: 'Bias text: names, jargon, a line of the lyric.' },
        vad: { type: 'boolean', description: 'Voice-activity filter. Off by default (see above).' },
        head: { type: 'number', description: 'Lines to print. Default 20.' },
        includeCues: { type: 'boolean', description: 'Also return every cue as JSON in the output value.' },
        lyrics: { type: 'string', description: 'Path to a plain-text lyric file. Turns it into the recogniser prompt (which is the single biggest accuracy win on sung material) and reports per-line recall.' },
        vadMode: {
          type: 'string',
          enum: ['auto', 'vocals', 'off', 'mix'],
          description: 'Escape hatch for the voice-region gate. "auto" (default) splits the vocal stem into blocks and only sends those to the recogniser — this is what stops whisper from inventing lines over instrumental sections. If a machine crashes on that path (native heap corruption from torch+ctranslate2 coexisting), pass "off" to transcribe the whole file in one go: same text quality on clean material, but hallucination protection is lost.',
        },
        separator: {
          type: 'string',
          enum: ['auto', 'onnx', 'demucs', 'hpss', 'none'],
          description: 'Separation backend. "auto" (default) picks MDX-Net via onnxruntime (no torch, best on dense rap), then demucs if available, then HPSS. "onnx" forces MDX (63 MB model, downloaded on first run); "hpss" is a crude zero-dependency fallback that pollutes chords/melody.',
        },        separate: { type: 'boolean', description: SEPARATE_DESC },      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'transcribe audio', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('transcribe', {
        args: toArgs({
          input: args.input, start: args.start, end: args.end, lang: args.language, vadMode: args.vadMode,
          model: args.model, srt: args.srt, prompt: args.prompt, vad: args.vad,
          head: args.head, includeCues: args.includeCues, separate: args.separate, separator: args.separator, lyrics: args.lyrics,
        }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}

export function rhythmSpec() {
  return {
    name: RHYTHM_TOOL,
    description: [
      'Measure a track\'s rhythm instead of guessing at it: BPM, beat phase, drum-entry points, and — when you',
      'also pass the video — whether the cuts land on the beat.',
      '',
      'Method that matters: librosa\'s scalar tempo is reported only for reference. The answer comes from',
      'grid-fitting a set of candidates (including half and double) with a phase sweep, scored by',
      '(best − median)/std so slow tempos are not favoured. An even/odd beat-strength ratio near 1.0 confirms',
      'the faster BPM is the pulse.',
      '',
      'Use for: is this cut-to-the-beat, how dense is the editing, when does the drum kit come in, why does a',
      'section feel faster. Do NOT use it to judge whether the rhythm is any good.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        video: {
          type: 'string',
          description: 'Optional: the video file whose cuts you want compared against the beat grid. '
            + 'Defaults to `input` when that is a video.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 10 * 60 * 1000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'measure rhythm', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('rhythm', {
        args: toArgs({ input: args.input, video: args.video }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}

export function melodySpec() {
  return {
    name: MELODY_TOOL,
    description: [
      'Extract the pitch line: range, most-used notes, key estimate, and the note sequence inside windows you',
      'name. Local (pyin by default; switches to torchcrepe automatically if it is installed).',
      '',
      'Read it with this caveat in mind: without vocal separation the tracker locks onto whichever fundamental',
      'is loudest, and in pop mixes that is usually the BASS, not the singer. If the top notes sit in E2–G3,',
      'you are looking at the bass line. Treat `key` as a rough guess for the same reason.',
      '',
      'Use for: does the chorus lift, how far does the phrase leap, is it pentatonic, where is the apex.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        windows: {
          type: 'array',
          items: { type: 'string' },
          description: 'Windows as "label:start:end", e.g. "verse:32.8:36.6". Repeatable.',
        },
        lyrics: { type: 'string', description: 'Path to a plain-text lyric file. Turns it into the recogniser prompt (which is the single biggest accuracy win on sung material) and reports per-line recall.' },
        separator: {
          type: 'string',
          enum: ['auto', 'onnx', 'demucs', 'hpss', 'none'],
          description: 'Separation backend. "auto" (default) picks MDX-Net via onnxruntime (no torch, best on dense rap), then demucs if available, then HPSS. "onnx" forces MDX (63 MB model, downloaded on first run); "hpss" is a crude zero-dependency fallback that pollutes chords/melody.',
        },        separate: { type: 'boolean', description: SEPARATE_DESC },      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'extract melody', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('melody', {
        args: toArgs({ input: args.input, window: args.windows, separate: args.separate, separator: args.separator }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}

export function chordsSpec() {
  return {
    name: CHORDS_TOOL,
    description: [
      'Recover the chord progression: a smoothed timeline of chords plus how long each one holds.',
      '',
      'How it works: chroma is computed on the ACCOMPANIMENT only (Demucs bass + other, so the singer and the',
      'drums cannot add or bury chord tones), then matched against chord templates and smoothed with a Viterbi',
      'pass whose switch penalty is tuned for pop harmonic rhythm (roughly one change per bar or two).',
      '',
      'Read it like this: the ROOTS and the harmonic rhythm are the trustworthy part — that is what you need for',
      '"does the chorus change chords", "is it a four-chord loop", "where is the pre-chorus lift". Chord QUALITY',
      'is the weak part: expect major/major-7 confusion, and treat minor-7 vs plain minor as interchangeable.',
      'Hand-rolled templates, not a trained chord model (essentia and madmom cannot be installed here), so',
      'roughly 60-75% frame accuracy on a dense mix.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        lyrics: { type: 'string', description: 'Path to a plain-text lyric file. Turns it into the recogniser prompt (which is the single biggest accuracy win on sung material) and reports per-line recall.' },
        separator: {
          type: 'string',
          enum: ['auto', 'onnx', 'demucs', 'hpss', 'none'],
          description: 'Separation backend. "auto" (default) picks MDX-Net via onnxruntime (no torch, best on dense rap), then demucs if available, then HPSS. "onnx" forces MDX (63 MB model, downloaded on first run); "hpss" is a crude zero-dependency fallback that pollutes chords/melody.',
        },        separate: { type: 'boolean', description: SEPARATE_DESC },      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'detect chords', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('chords', {
        args: toArgs({ input: args.input, separate: args.separate, separator: args.separator }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}

export function structureSpec() {
  return {
    name: STRUCTURE_TOOL,
    description: [
      'Find the section boundaries — intro / verse / chorus / interlude / break / outro — and the two hard',
      'events that matter most: when the vocal enters and when the drums come in.',
      '',
      'Precision: 0.25 s windows, NO median smoothing, only fragments shorter than `minLen` are absorbed.',
      'Boundaries are reported to 0.1 s. (A coarser variant using 1 s windows plus 3 s median smoothing drifts',
      '1-3 s, and up to 5 s where two merges stack — do not mix its numbers with these.)',
      'The 峰值 is taken on a 1.5 s moving average, so a single cymbal or reverb tail cannot impersonate the',
      'loudest moment.',
      '',
      'Labels are inferred from vocal presence × drum presence × section energy, so read the numbers, not only',
      'the label: a section with no separate vocal/drum energy but 0.28 overall is 器乐段, not silence.',
      'Thresholds used for vocal/drum detection are printed, so the segmentation is auditable.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        window: { type: 'number', description: 'Analysis window in seconds. Default 0.25.' },
        minLen: { type: 'number', description: 'Fragments shorter than this (seconds) are absorbed. Default 2.' },
        separator: {
          type: 'string',
          enum: ['auto', 'onnx', 'demucs', 'hpss', 'none'],
          description: 'Separation backend. "auto" (default) picks MDX-Net via onnxruntime (no torch, best on dense rap), then demucs if available, then HPSS. "onnx" forces MDX (63 MB model, downloaded on first run); "hpss" is a crude zero-dependency fallback that pollutes chords/melody.',
        },        separate: { type: 'boolean', description: SEPARATE_DESC },      },
      required: ['input'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'segment structure', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const { report } = await runSoundtry('structure', {
        args: toArgs({
          input: args.input, window: args.window,
          minLen: args.minLen, separate: args.separate, separator: args.separator,
        }),
        signal: exec?.signal,
      });
      return { text: report };
    },
  };
}
