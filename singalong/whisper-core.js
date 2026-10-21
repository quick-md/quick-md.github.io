// The audio-side logic for Whisper mode, free of browser APIs so it can be tested:
// finding phrases in a stream of audio, and cleaning up what Whisper returns.

export const RATE = 16000; // Whisper listens at 16 kHz

/** Average-down audio from the microphone's rate to 16 kHz. */
export function resampleTo16k(input, inRate) {
  if (inRate === RATE) return input;
  const ratio = inRate / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = sum / (b - a);
  }
  return out;
}

const dropped = new Set(['you', 'thank you', 'thanks for watching', 'bye', 'okay', 'so']);

/** Whisper invents "[MUSIC]", "(guitar)", "you" and "thanks for watching" over noise: remove those. */
/** Cuts a run of the same 1-4 words repeated many times ("oh my oh my oh my ...") down to two. */
export function collapseRepeats(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const norm = words.map((w) => w.toLowerCase().replace(/[^\p{L}']/gu, ''));
  const out = [];
  for (let i = 0; i < words.length;) {
    let cut = false;
    for (let n = 1; n <= 4 && !cut; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && norm.slice(i, i + n).join(' ') === norm.slice(i + reps * n, i + (reps + 1) * n).join(' ')) reps++;
      if (reps >= 4) { out.push(...words.slice(i, i + 2 * n)); i += reps * n; cut = true; }
    }
    if (!cut) out.push(words[i++]);
  }
  return out.join(' ');
}

export function cleanTranscript(text) {
  let t = collapseRepeats(String(text || ''))
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫♬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\p{L}/u.test(t)) return '';
  const bare = t.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim();
  if (dropped.has(bare)) return '';
  return t;
}

/**
 * Cuts a stream of audio into phrases. A phrase starts when the sound rises clearly above the
 * background (which it learns as it goes, so a steady guitar becomes "background" too), and ends
 * after a pause, or after `maxMs` so a long run of singing is still handed over in pieces.
 */
export class Segmenter {
  constructor({ frameMs = 20, hangoverMs = 800, maxMs = 10000, preRollMs = 300, minVoiceMs = 250 } = {}) {
    this.frame = Math.round((RATE * frameMs) / 1000);
    this.frameMs = frameMs;
    this.hangover = Math.round(hangoverMs / frameMs);
    this.maxFrames = Math.round(maxMs / frameMs);
    this.preRoll = Math.round(preRollMs / frameMs);
    this.minVoice = Math.round(minVoiceMs / frameMs);
    this.pending = new Float32Array(0);
    this.floor = 0.004;
    this.recent = []; // loudness of the last ~3 s, to tell steady music (never quiet) from a voice (has quiet gaps)
    this.loud = false; // steady loud sound: "is something louder than usual" means nothing, so keep everything
    this.ring = [];
    this.frames = [];
    this.inPhrase = false;
    this.voiced = 0;
    this.silent = 0;
    this.tickN = 0;
  }

  /** For the session log: what the cutter thought was going on. */
  diag() { return { loud: this.loud, floor: +this.floor.toFixed(3), quiet: +(this.quietest ?? 0).toFixed(3) }; }

  threshold() { return Math.max(0.008, this.floor * 3); }

  push(chunk) {
    let data = chunk;
    if (this.pending.length) {
      data = new Float32Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
    }
    let i = 0;
    for (; i + this.frame <= data.length; i += this.frame) this.frameIn(data.slice(i, i + this.frame));
    this.pending = data.slice(i);
  }

  frameIn(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    // The background level falls quickly to quiet moments and creeps up slowly.
    this.floor += (rms - this.floor) * (rms < this.floor ? 0.2 : 0.002);
    this.recent.push(rms);
    if (this.recent.length > 150) this.recent.shift();
    if (this.recent.length === 150 && ++this.tickN % 10 === 0) {
      const quietest = [...this.recent].sort((a, b) => a - b)[15]; // the 10th percentile
      this.quietest = quietest;
      if (this.loud ? quietest < 0.025 : quietest > 0.05) this.loud = quietest > 0.05;
    }
    const voice = this.loud || rms > this.threshold();
    if (!this.inPhrase) {
      if (voice) {
        this.inPhrase = true;
        this.frames = [...this.ring, f];
        this.ring = [];
        this.voiced = 1;
        this.silent = 0;
      } else {
        this.ring.push(f);
        if (this.ring.length > this.preRoll) this.ring.shift();
      }
      return;
    }
    this.frames.push(f);
    if (voice) { this.voiced++; this.silent = 0; } else this.silent++;
    // A blip of noise that never became speech: forget it.
    if (this.silent >= this.hangover && this.voiced < this.minVoice) this.endPhrase();
  }

  state() {
    return {
      inPhrase: this.inPhrase,
      lengthMs: this.frames.length * this.frameMs,
      silentMs: this.silent * this.frameMs,
      voicedMs: this.voiced * this.frameMs,
      pauseOver: this.inPhrase && this.silent >= this.hangover,
      tooLong: this.inPhrase && this.frames.length >= this.maxFrames,
      enough: this.voiced >= this.minVoice,
    };
  }

  phrase() {
    this.snap = this.frames.length;
    const out = new Float32Array(this.frames.length * this.frame);
    this.frames.forEach((f, i) => out.set(f, i * this.frame));
    return out;
  }

  /** Finish the phrase last handed out by phrase(); sound that arrived since stays as the start of the next. */
  consume() {
    const rest = this.frames.slice(this.snap ?? this.frames.length);
    this.snap = 0;
    if (rest.length === 0) return this.endPhrase();
    this.frames = rest;
    this.voiced = Math.max(this.minVoice, 1);
  }

  endPhrase() {
    this.inPhrase = false;
    this.frames = [];
    this.voiced = 0;
    this.silent = 0;
  }
}
