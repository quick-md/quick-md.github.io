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
export function cleanTranscript(text) {
  let t = String(text || '')
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
    this.ring = [];
    this.frames = [];
    this.inPhrase = false;
    this.voiced = 0;
    this.silent = 0;
  }

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
    const voice = rms > this.threshold();
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
