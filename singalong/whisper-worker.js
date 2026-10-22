// Runs Whisper off the main thread, so the screen stays smooth while it thinks.
// Uses the phone's GPU when the browser offers it (much faster), otherwise a smaller model on the CPU.
import { pipeline, env, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { averageLogProb } from './lyric-score.js';

env.allowLocalModels = false;

let asr = null;
let info = { device: '', model: '' };

const CHOICES = {
  webgpu: { model: 'onnx-community/whisper-base.en', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  // Bigger and better over music, but a large first download (the half-precision encoder halves it where the GPU allows).
  'webgpu-small': { model: 'onnx-community/whisper-small.en', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  'webgpu-small-fp16': { model: 'onnx-community/whisper-small.en', device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
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

async function init(size) {
  let gpu = false;
  let f16 = false;
  try {
    const adapter = self.navigator?.gpu && (await self.navigator.gpu.requestAdapter());
    gpu = !!adapter;
    f16 = !!adapter?.features?.has?.('shader-f16');
  } catch { gpu = false; }
  if (gpu) {
    if (size === 'small') {
      try { await load(f16 ? 'webgpu-small-fp16' : 'webgpu-small'); return; } catch { asr = null; }
      if (f16) { try { await load('webgpu-small'); return; } catch { asr = null; } }
    }
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

/**
 * For each candidate text: how likely does the model think that text is, given this audio?
 * The audio is read once; each candidate then costs only a short pass through the decoder.
 * Returns {scores:[{id, avg, n}]}, or {scores:[], error} if this model/browser can't do it.
 */
async function score(audio, candidates) {
  try {
    const model = asr.model;
    const tok = asr.tokenizer;
    const ids = tok.model.convert_tokens_to_ids(['<|startoftranscript|>', '<|notimestamps|>', '<|endoftext|>']);
    if (ids.some((x) => x === undefined || x === null)) return { scores: [], error: 'special tokens not found' };
    const [SOT, NOTS, EOT] = ids.map(Number);
    const { input_features } = await asr.processor(audio);
    const kwargs = await model._prepare_encoder_decoder_kwargs_for_generation({
      inputs_tensor: input_features, model_inputs: { input_features }, model_input_name: 'input_features', generation_config: { guidance_scale: null },
    });
    const encoder_outputs = kwargs.encoder_outputs;
    const scores = [];
    for (const c of candidates) {
      const text = tok.encode(' ' + c.text, { add_special_tokens: false }).map(Number);
      if (!text.length || text.length > 120) continue;
      const seq = [SOT, NOTS, ...text, EOT];
      const input = seq.slice(0, -1);
      const decoder_input_ids = new Tensor('int64', BigInt64Array.from(input.map(BigInt)), [1, input.length]);
      const out = await model.forward({ encoder_outputs, decoder_input_ids });
      const logits = out.logits;
      const data = logits.data ?? (await logits.getData());
      const vocab = logits.dims[logits.dims.length - 1];
      // Row k predicts seq[k + 1]; the text and the end marker are predicted from row 1 on.
      const avg = averageLogProb(data, vocab, 1, seq.slice(2));
      scores.push({ id: c.id, avg: +avg.toFixed(4), n: text.length });
      for (const [k, v] of Object.entries(out)) { try { if (v && typeof v.dispose === 'function') v.dispose(); } catch { /* already freed */ } void k; }
    }
    try { encoder_outputs?.dispose?.(); } catch { /* already freed */ }
    return { scores };
  } catch (err) {
    return { scores: [], error: String(err?.message || err).slice(0, 160) };
  }
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await init(m.size || 'base');
      postMessage({ type: 'ready', ...info });
    } else if (m.type === 'score') {
      const t0 = performance.now();
      const r = await score(m.audio, m.candidates);
      postMessage({ type: 'scored', id: m.id, ...r, ms: Math.round(performance.now() - t0) });
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
