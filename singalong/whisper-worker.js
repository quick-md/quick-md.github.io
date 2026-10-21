// Runs Whisper off the main thread, so the screen stays smooth while it thinks.
// Uses the phone's GPU when the browser offers it (much faster), otherwise a smaller model on the CPU.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let asr = null;
let info = { device: '', model: '' };

const CHOICES = {
  webgpu: { model: 'onnx-community/whisper-base.en', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  wasm: { model: 'onnx-community/whisper-tiny.en', device: 'wasm', dtype: 'q8' },
};

async function load(kind) {
  const c = CHOICES[kind];
  const files = new Map();
  asr = await pipeline('automatic-speech-recognition', c.model, {
    device: c.device,
    dtype: c.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0; let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        postMessage({ type: 'progress', p: total ? loaded / total : 0 });
      }
    },
  });
  info = { device: c.device, model: c.model.split('/')[1] };
}

async function init() {
  let gpu = false;
  try { gpu = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())); } catch { gpu = false; }
  if (gpu) {
    try { await load('webgpu'); return; } catch { asr = null; }
  }
  await load('wasm');
}

async function run(audio) {
  // Whisper can get stuck repeating one phrase when it can't make out words (music, a strummed chord).
  // Cap how much it may write for this much audio, and forbid repeating the same four words.
  const secs = audio.length / 16000;
  const out = await asr(audio, {
    max_new_tokens: Math.min(80, Math.ceil(10 + secs * 6)),
    no_repeat_ngram_size: 4,
    return_timestamps: false,
  });
  return Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await init();
      postMessage({ type: 'ready', ...info });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      let text;
      try {
        text = await run(m.audio);
      } catch (err) {
        // The GPU path can fail only once it is working: fall back to the CPU and try again.
        if (info.device !== 'webgpu') throw err;
        await load('wasm');
        postMessage({ type: 'ready', ...info });
        text = await run(m.audio);
      }
      postMessage({ type: 'result', id: m.id, text, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
