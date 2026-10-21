// The app's brain: hearing -> identifying -> following. No DOM, so it can be tested.
import { tokens, distinctive, mostlyLatin } from './matcher.js';
import { LyricTracker, similar } from './tracker.js';
import { isWorship } from './worship.js';

export const DISMISS_WINDOW_MS = 6000;
export const TITLE_PAUSE_MS = 1500; // how long you must be quiet before a spoken title is searched
export const HINT = {
  lyrics: "Sing a line or two and I'll find the song.",
  title: 'Say the song title. Add the artist if you like.',
};

/**
 * Does this song's title match what was said? ("How Great Thou Art (Live)" matches "how great thou art"
 * and "how great thou art elvis".) Used so worship mode doesn't throw out the song you named.
 */
export function titleMatches(songTitle, heard) {
  const clean = String(songTitle || '').replace(/[(\[].*?[)\]]/g, ' ').replace(/\s[-–].*$/, ' ');
  const want = tokens(clean);
  if (want.length === 0) return false;
  return want.every((w) => heard.some((h) => similar(w, h)));
}

const startsWith = (a, b) => b.length <= a.length && b.every((w, i) => a[i] === w);
const DUP_MS = 900; // an "extended" repeat of a just-finished phrase this soon is the same phrase, not a new one

/** Join phrases, dropping echoes: some phones report "king", "king of", "king of kings" as separate results. */
export function mergeParts(parts) {
  const out = [];
  for (const p of parts.filter(Boolean)) {
    const last = out[out.length - 1];
    if (last) {
      const a = tokens(last);
      const b = tokens(p);
      if (startsWith(b, a)) { out[out.length - 1] = p; continue; }
      if (startsWith(a, b)) continue;
    }
    out.push(p);
  }
  return out;
}

export class Engine {
  /**
   * @param {{api:{find,title,close}, makeSpeech:(h)=>{start,stop}, vocab?:()=>any, store?:{get,set}, now?:()=>number}} deps
   */
  constructor(deps) {
    this.api = deps.api;
    this.makeSpeech = deps.makeSpeech;
    this.getVocab = deps.vocab || (() => null);
    this.store = deps.store || { get: () => null, set: () => {} };
    this.listeners = new Set();
    this.mode = this.store.get('mode') === 'title' ? 'title' : 'lyrics';
    this.worship = this.store.get('worship') !== '0'; // on unless switched off
    this.state = { phase: 'idle', heard: '', status: '', isHint: true };
    this.speech = null;
    this.rejected = new Set();
    this.committed = [];
    this.utteranceStable = [];
    this.boundaries = 0;
    this.lastQueryTail = [];
    this.tracker = null;
    this.lookupBusy = false;
    this.epoch = 0; // bumps whenever the listening session is reset, so stale lookups are dropped
    this.dismissTimer = null;
    this.now = deps.now || (() => Date.now());
    this.lastFinal = []; // words of the phrase that just finished, to spot echoes of it
    this.lastFinalAt = 0;
    this.skipPrefix = 0; // while following: leading words of this result that were already counted
    this.titleDelay = deps.titleDelayMs ?? TITLE_PAUSE_MS;
    this.titleTimer = null;
    this.titleFinals = []; // finished phrases of the title being spoken
    this.titleCurrent = ''; // the phrase still in progress
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(patch) { this.state = { ...this.state, ...patch }; this.listeners.forEach((f) => f(this.state)); }
  get hint() { return HINT[this.mode]; }

  // ---- lifecycle ----
  start() {
    if (this.speech) return;
    if (this.state.phase === 'idle' || this.state.phase === 'error') {
      this.set({ phase: 'listening', heard: '', status: this.hint, isHint: true, error: null });
    }
    this.speech = this.makeSpeech({
      onHeard: (t, f) => this.onHeard(t, f),
      onBoundary: () => this.onBlank(),
      onFatal: (m) => this.fatal(m),
      onProgress: (p) => this.set({ modelProgress: p }),
      onReady: () => this.set({ modelProgress: null }),
      onInfo: (info) => { this.state = { ...this.state, info }; }, // shown in Settings; no redraw needed
    });
    this.speech.start();
  }
  /** Switch speech engine (Whisper / browser) while running: stop the old one and start the new. */
  restartSpeech() {
    if (!this.speech) return;
    this.speech.stop();
    this.speech = null;
    this.set({ modelProgress: null, info: '' });
    this.start();
  }
  stop() { this.speech?.stop(); this.speech = null; clearTimeout(this.dismissTimer); this.clearTitle(); this.epoch++; }
  clearTitle() { clearTimeout(this.titleTimer); this.titleFinals = []; this.titleCurrent = ''; }
  fatal(message) { this.stop(); this.set({ phase: 'error', error: message }); }
  retry() { this.stop(); this.set({ phase: 'idle' }); this.start(); }

  // ---- settings ----
  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.store.set('mode', m);
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') this.backToListening(this.hint);
    else this.set({});
  }
  setWorship(on) {
    this.worship = on;
    this.store.set('worship', on ? '1' : '0');
    this.lastQueryTail = [];
    this.set({});
  }

  // ---- user actions ----
  dismissWrongSong() {
    if (this.state.phase === 'singing') this.rejected.add(this.state.lyrics.key);
    this.backToListening(this.mode === 'title' ? 'Okay, say it again.' : 'Okay, keep singing and I’ll try another.');
  }
  listenForAnother() { this.backToListening(this.hint); }
  backToListening(status) {
    clearTimeout(this.dismissTimer);
    this.clearTitle();
    this.epoch++;
    this.tracker = null;
    this.committed = [];
    this.utteranceStable = [];
    this.lastQueryTail = [];
    this.lookupBusy = false;
    this.set({ phase: 'listening', heard: '', status, isHint: true, options: null, lyrics: null });
  }
  chooseSuggestion(song) {
    if (this.state.phase !== 'suggesting') return;
    const t = LyricTracker.start(song.lines.map(tokens));
    if (t) this.present(song, t);
  }

  // ---- hearing ----
  repair(words) { const v = this.getVocab(); return v ? v.snapAll(words) : words; }

  /** Is this result an echo of the phrase that just finished? 'same' (nothing new), 'longer' (same start, more words) or null. */
  echoOf(toks) {
    const f = this.lastFinal;
    if (!f.length || this.now() - this.lastFinalAt > DUP_MS) return null;
    if (startsWith(f, toks)) return 'same';
    if (startsWith(toks, f)) return 'longer';
    return null;
  }

  onBlank() {
    this.lastFinal = [];
    this.skipPrefix = 0;
    if (this.titleCurrent) { this.titleFinals.push(this.titleCurrent); this.titleCurrent = ''; }
    this.boundaries++;
    this.utteranceStable = [];
    this.tracker?.endUtterance();
  }

  onHeard(text, isFinal) {
    if (!text) return this.onBlank();
    const s = this.state;
    if (s.phase === 'listening') {
      if (this.mode === 'title') {
        // Wait for a real pause, and join phrases, so "king of kings ... bethel" is one title.
        if (isFinal) { this.titleFinals.push(text); this.titleCurrent = ''; } else this.titleCurrent = text;
        const said = mergeParts([...this.titleFinals, this.titleCurrent]).join(' ');
        this.set({ heard: said });
        clearTimeout(this.titleTimer);
        this.titleTimer = setTimeout(() => {
          this.titleFinals = [];
          this.titleCurrent = '';
          if (this.state.phase === 'listening') this.searchTitle(said);
        }, this.titleDelay);
        return;
      }
      const toks = this.repair(tokens(text));
      const echo = this.echoOf(toks);
      if (echo === 'same') return; // the phone repeating what it just reported
      if (echo === 'longer') { // the same phrase, now with more words: replace it, don't add it twice
        this.committed.splice(Math.max(0, this.committed.length - this.lastFinal.length));
        this.lastFinal = [];
      }
      this.set({ heard: text });
      const v = this.getVocab();
      const lastIsWord = toks.length && v ? v.isWord(toks[toks.length - 1]) : false;
      this.utteranceStable = isFinal || lastIsWord ? toks : toks.slice(0, -1);
      this.maybeLookup();
      if (isFinal) {
        this.committed.push(...toks);
        while (this.committed.length > 16) this.committed.shift();
        this.lastFinal = toks;
        this.lastFinalAt = this.now();
        this.utteranceStable = [];
        this.boundaries++;
      }
    } else if (s.phase === 'singing') {
      const t = this.tracker;
      if (!t) return;
      let toks = tokens(text);
      const echo = this.echoOf(toks);
      if (echo === 'same') return;
      if (echo === 'longer') { this.skipPrefix = this.lastFinal.length; this.lastFinal = []; }
      const fresh = toks.slice(this.skipPrefix);
      if (fresh.length || isFinal) t.update(fresh, isFinal);
      if (isFinal) { this.lastFinal = toks; this.lastFinalAt = this.now(); this.skipPrefix = 0; }
      if (t.line !== s.line) this.set({ line: t.line });
      if (this.showHeardLive) this.set({ heard: text });
    }
  }

  // ---- lyrics mode ----
  async maybeLookup() {
    const words = [...this.committed, ...this.utteranceStable].slice(-12);
    if (words.length < 3 || this.lookupBusy) return;
    const tail = words.slice(-8);
    if (tail.join(' ') === this.lastQueryTail.join(' ')) return;
    this.lastQueryTail = tail;
    const boundariesAtQuery = this.boundaries;
    const consumedAtQuery = this.utteranceStable.length;
    const epoch = this.epoch;
    const vocab = this.getVocab();
    this.lookupBusy = true;
    try {
      const worship = this.worship;
      const searchable = vocab ? tail.filter((w) => vocab.isWord(w)) : tail;
      let distinct = distinctive(words);
      if (vocab) distinct = distinct.filter((w) => vocab.isWord(w));
      const skip = new Set(this.rejected);
      let skipLibrary = false;
      for (let pass = 0; pass < 2; pass++) {
        const r = await this.api.find({
          q: searchable.join(' '),
          alt: distinct.length >= 2 && distinct.join(' ') !== searchable.join(' ') ? distinct.join(' ') : '',
          n: worship ? 6 : 4,
          exclude: [...skip],
          skipLibrary,
        });
        if (epoch !== this.epoch) return;
        if (r.cooling) {
          this.setListeningStatus('Busy for a moment. Keep singing, or try Title mode.');
          return;
        }
        if (r.waiting) { // several songs fit so far: wait for more words rather than guess
          this.setListeningStatus('Keep singing...');
          return;
        }
        for (const song of r.songs) {
          skip.add(song.key);
          if (!mostlyLatin(song.lines)) continue; // e.g. an Arabic version
          if (worship && !song.worship && !isWorship(song.artist, song.lines)) continue;
          const t = LyricTracker.create(song.lines.map(tokens), words, consumedAtQuery, song.source === 'library');
          if (!t) continue;
          if (this.boundaries !== boundariesAtQuery) t.endUtterance();
          this.present(song, t);
          return;
        }
        // Library suggestions didn't survive checking: ask the wider search once.
        if (r.songs.length && r.songs.every((s) => s.source === 'library') && !skipLibrary) { skipLibrary = true; continue; }
        break;
      }
      this.setListeningStatus(this.worship ? 'No worship song matched yet. Keep singing.' : 'Not sure yet. Keep singing.');
    } catch (e) {
      if (epoch === this.epoch) this.setListeningStatus(e.message || 'Lookup failed. Retrying as you sing.');
    } finally {
      if (epoch === this.epoch) this.lookupBusy = false;
    }
  }

  setListeningStatus(status) {
    if (this.state.phase === 'listening') this.set({ status, isHint: false });
  }

  // ---- title mode ----
  async searchTitle(text) {
    const raw = tokens(text);
    if (!raw.length || this.lookupBusy) return;
    this.lookupBusy = true;
    const epoch = this.epoch;
    this.setListeningStatus('Searching...');
    try {
      const worship = this.worship;
      const fixed = this.repair(raw);
      const alt = fixed.join(' ') !== raw.join(' ') ? fixed.join(' ') : '';
      const r = await this.api.title({ q: raw.join(' '), alt, n: worship ? 6 : 3, exclude: [...this.rejected] });
      if (epoch !== this.epoch) return;
      if (r.cooling) { this.setListeningStatus('Busy for a moment. Say the title again.'); return; }
      // Worship mode keeps worship songs, and also the song you actually named.
      const said = [...new Set([...raw, ...fixed])];
      const ok = (song) => mostlyLatin(song.lines) &&
        (!worship || song.worship || isWorship(song.artist, song.lines) || titleMatches(song.title, said));
      for (const song of r.songs) {
        if (!ok(song)) continue;
        const t = LyricTracker.start(song.lines.map(tokens));
        if (!t) continue;
        this.present(song, t);
        return;
      }
      const c = await this.api.close({ q: raw.join(' '), alt, exclude: [...this.rejected] });
      if (epoch !== this.epoch) return;
      const options = c.songs.filter((x) => !this.rejected.has(x.key) && ok(x)).slice(0, 4);
      // The top close match is exactly the title you said: open it, as with any first match.
      const first = options[0];
      if (first && titleMatches(first.title, said)) {
        const t = LyricTracker.start(first.lines.map(tokens));
        if (t) { this.present(first, t); return; }
      }
      if (options.length) this.set({ phase: 'suggesting', heard: text, options });
      else this.setListeningStatus(worship ? 'No worship song found for that. Say the title again.' : "Couldn't find that one. Say the title again.");
    } catch (e) {
      if (epoch === this.epoch) this.setListeningStatus(e.message || 'Search failed. Say the title again.');
    } finally {
      if (epoch === this.epoch) this.lookupBusy = false;
    }
  }

  // ---- singing ----
  present(song, tracker) {
    this.tracker = tracker;
    this.lookupBusy = false;
    clearTimeout(this.dismissTimer);
    this.set({ phase: 'singing', lyrics: song, line: tracker.line, canDismiss: true, options: null });
    this.dismissTimer = setTimeout(() => {
      if (this.state.phase === 'singing' && this.state.lyrics === song) this.set({ canDismiss: false });
    }, DISMISS_WINDOW_MS);
  }
}
