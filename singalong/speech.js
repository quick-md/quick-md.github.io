// Continuous listening through the browser's built-in speech recognition.
// Needs HTTPS and a browser that has it (Chrome, Edge, Safari). Firefox does not.

export const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export class SpeechLoop {
  /**
   * @param {{onHeard:(text:string,isFinal:boolean)=>void, onBoundary:()=>void, onFatal:(msg:string)=>void}} h
   */
  constructor(h) {
    this.h = h;
    this.active = false;
    this.rec = null;
    this.failures = 0;
    this.timer = null;
    this.openUtterance = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    this.begin();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    const r = this.rec;
    this.rec = null;
    if (r) {
      r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch { /* already stopped */ }
    }
  }

  begin() {
    if (!this.active) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return this.h.onFatal("This browser can't listen. Try Chrome, Edge or Safari.");
    const r = new Ctor();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      this.failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = (res[0]?.transcript || '').trim();
        this.openUtterance = !res.isFinal;
        this.h.onHeard(text, res.isFinal);
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.h.onFatal('Microphone is blocked. Allow it in the browser, then tap Try again.');
        return;
      }
      if (e.error === 'audio-capture') {
        this.active = false;
        this.h.onFatal('No microphone found.');
        return;
      }
      if (e.error !== 'no-speech') this.failures++;
    };
    r.onend = () => {
      if (this.openUtterance) {
        this.openUtterance = false;
        this.h.onBoundary();
      }
      if (!this.active) return;
      if (this.failures > 8) {
        this.active = false;
        this.h.onFatal('Listening keeps failing. Check the connection and microphone, then tap Try again.');
        return;
      }
      this.timer = setTimeout(() => this.begin(), this.failures ? 600 : 80);
    };
    this.rec = r;
    try { r.start(); } catch { this.failures++; this.timer = setTimeout(() => this.begin(), 600); }
  }
}
