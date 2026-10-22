// Whisper mode: listens to the microphone, finds phrases, and has Whisper (in a Web Worker)
// write them down. Same two-method shape as SpeechLoop, so the app can use either.
import { RATE, Segmenter, cleanTranscript, resampleTo16k } from './whisper-core.js';

export const whisperSupported = () => !!(
  navigator.mediaDevices?.getUserMedia && window.Worker && typeof WebAssembly === 'object' &&
  (window.AudioContext || window.webkitAudioContext)
);

// ---- microphone -------------------------------------------------------------------------

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('sa-capture', Capture);
`;

export class MicCapture {
  /** @param {{music?: boolean}} opts music: phone auto-gain off (it pushes a loud guitar into clipping) and a filter for low rumble */
  constructor(opts = {}) {
    this.music = !!opts.music;
  }

  async start(onChunk) {
    // Noise suppression off: it tends to treat a guitar (and sometimes the voice over it) as noise.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: !this.music },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ sampleRate: RATE }); } catch { this.ctx = new AC(); }
    await this.ctx.resume();
    const rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    mute.connect(this.ctx.destination);
    let tail = src;
    if (this.music) {
      // Cuts the low guitar strings and handling thump below the voice's useful range.
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 120;
      hp.Q.value = 0.707;
      src.connect(hp);
      tail = hp;
    }
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'sa-capture');
      this.node.port.onmessage = (e) => onChunk(resampleTo16k(e.data, rate));
    } catch {
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => onChunk(resampleTo16k(new Float32Array(e.inputBuffer.getChannelData(0)), rate));
    }
    tail.connect(this.node);
    this.node.connect(mute);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.ctx?.resume?.(); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** What the browser actually gave us, for the session log. */
  describe() {
    const st = this.stream?.getAudioTracks?.()[0]?.getSettings?.() || {};
    return { music: this.music, autoGain: st.autoGainControl ?? null, noiseSuppression: st.noiseSuppression ?? null, echoCancellation: st.echoCancellation ?? null, rate: this.ctx?.sampleRate ?? null };
  }

  stop() {
    document.removeEventListener('visibilitychange', this.onVisible);
    try { this.node?.disconnect(); } catch { /* already gone */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.stream = this.ctx = this.node = null;
  }
}

// ---- Whisper in a worker ----------------------------------------------------------------

/** One shared copy, so stopping and starting again doesn't reload the model. */
let shared = null;

export class WorkerTranscriber {
  constructor(size = 'base') {
    this.size = size;
    this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.waiting = new Map();
    this.onProgress = null;
    this.info = '';
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') this.onProgress?.(m.p);
      else if (m.type === 'ready') { this.info = `${m.model} on ${m.device === 'webgpu' ? 'GPU' : 'CPU'}`; this.loaded?.resolve(); }
      else if (m.type === 'result' || m.type === 'scored') this.waiting.get(m.id)?.resolve(m);
      else if (m.type === 'error') {
        if (m.id) this.waiting.get(m.id)?.reject(new Error(m.message));
        else this.loaded?.reject(new Error(m.message));
      }
    };
    this.worker.onerror = (e) => this.loaded?.reject(new Error(e.message || 'The speech model could not start.'));
  }

  load() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => { this.loaded = { resolve, reject }; });
    this.ready.catch(() => { this.ready = null; });
    this.worker.postMessage({ type: 'load', size: this.size });
    return this.ready;
  }

  /** How well does each candidate text fit this audio? ({id, text}[] in, {scores:[{id, avg, n}]} out) */
  score(audio, candidates) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'score', id, audio, candidates });
    }).finally(() => this.waiting.delete(id));
  }

  run(audio) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, audio });
    }).finally(() => this.waiting.delete(id));
  }
}

/** One shared copy per model size: choosing another size stops the old worker and starts a new one. */
export function sharedTranscriber(size = 'base') {
  if (shared && shared.size !== size) { try { shared.worker.terminate(); } catch { /* already gone */ } shared = null; }
  return (shared ||= new WorkerTranscriber(size));
}

// ---- the loop ---------------------------------------------------------------------------

export class WhisperLoop {
  /**
   * @param {{onHeard, onBoundary, onFatal, onProgress?, onReady?, onInfo?}} h
   * @param {{transcriber?, mic?, tickMs?, refreshMs?, segmenter?}} deps for tests
   */
  constructor(h, deps = {}) {
    this.h = h;
    const opts = deps.opts || {};
    this.lyricAware = !!opts.lyricAware;
    this.transcriber = deps.transcriber || sharedTranscriber(opts.model || 'base');
    this.mic = deps.mic || new MicCapture({ music: !!opts.music });
    this.seg = deps.segmenter || new Segmenter();
    this.tickMs = deps.tickMs ?? 150;
    this.refreshMs = deps.refreshMs ?? 900; // how often a phrase in progress is written down again
    this.active = false;
    this.ready = false;
    this.busy = false;
    this.lastAt = 0;
    this.lastLen = 0;
    this.timer = null;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    try {
      // The microphone first: browsers only allow it from a tap, and the model can take a while.
      await this.mic.start((chunk) => { this.h.onAudio?.(chunk); if (this.ready) this.seg.push(chunk); });
      this.transcriber.onProgress = (p) => this.active && this.h.onProgress?.(p);
      await this.transcriber.load();
      if (!this.active) return;
      this.ready = true;
      this.h.onMic?.(this.mic.describe?.());
      this.h.onReady?.();
      this.h.onInfo?.(this.transcriber.info);
      this.timer = setInterval(() => this.tick(), this.tickMs);
    } catch (e) {
      if (!this.active) return;
      this.active = false;
      this.mic.stop();
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      this.h.onFatal(denied
        ? 'Microphone is blocked. Allow it in the browser, then tap Try again.'
        : e?.name === 'NotFoundError' ? 'No microphone found.'
          : `The speech model couldn’t start (${e?.message || 'unknown error'}). You can switch to Browser speech in Settings.`);
    }
  }

  stop() {
    this.active = false;
    this.ready = false;
    clearInterval(this.timer);
    this.mic.stop();
    this.seg.endPhrase();
  }

  /** Final phrases only: ask the model how well the audio fits the song's next few lines, and tell the engine. */
  async scorePhrase(audio, heardText) {
    try {
      const cands = this.h.getCandidates?.();
      if (!cands || !cands.length) return;
      const list = heardText ? [...cands, { id: 'heard', text: heardText }] : cands;
      const t0 = performance.now();
      const res = await this.transcriber.score(audio, list);
      if (this.active && res?.scores) this.h.onScore?.({ scores: res.scores, ms: Math.round(performance.now() - t0), secs: +(audio.length / 16000).toFixed(1), error: res.error });
    } catch { /* scoring is an extra: the normal listening carries on */ }
  }

  async tick() {
    if (!this.active || this.busy) return;
    const st = this.seg.state();
    if (!st.inPhrase || !st.enough) return;
    const finalize = st.pauseOver || st.tooLong;
    const t = performance.now();
    const due = finalize || (t - this.lastAt >= this.refreshMs && st.lengthMs - this.lastLen >= 400);
    if (!due) return;

    const audio = this.seg.phrase();
    this.busy = true;
    this.lastAt = t;
    this.lastLen = st.lengthMs;
    let text = '';
    try {
      const r = await this.transcriber.run(audio);
      text = cleanTranscript(r.text);
      if (finalize && this.lyricAware && this.transcriber.score) await this.scorePhrase(audio, text);
      let sum = 0; let peak = 0;
      for (let i = 0; i < audio.length; i++) { const a = Math.abs(audio[i]); sum += a * a; if (a > peak) peak = a; }
      this.h.onDecode?.({ ms: r.ms, secs: +(audio.length / 16000).toFixed(1), rms: +Math.sqrt(sum / audio.length).toFixed(4), peak: +peak.toFixed(3), raw: String(r.text).slice(0, 200), final: finalize, why: st.tooLong ? 'long' : st.pauseOver ? 'pause' : 'grow', ...this.seg.diag?.() });
      this.h.onInfo?.(`${this.transcriber.info} · ${(r.ms / 1000).toFixed(1)} s per phrase`);
    } catch {
      // One phrase failed to decode; carry on with the next.
    } finally {
      this.busy = false;
    }
    if (!this.active) return;
    if (finalize) {
      this.seg.consume();
      this.lastLen = 0;
      if (text) this.h.onHeard(text, true);
      else this.h.onBoundary();
    } else if (text) {
      this.h.onHeard(text, false);
    }
  }
}
