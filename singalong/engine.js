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
const VOTE_WINDOW = 8; // lookups remembered
const VOTES_NEEDED = 5; // lookups in which one song must have been the best fit
const LONG_SPAN = 32; // words of recent singing compared against a song, not only the last line
const LONG_FIT = 0.6; // how well a song must fit those
const WIDE_GAP_MS = 5000; // at most one wider (Genius) search this often
const SAME_PHRASE_MS = 3000; // a finished phrase this long ago is over: more words after it start a new phrase
const REPEAT_MS = 1200; // the very same words again after this long are the singer repeating the line

/** How many words of `a` appear, in order, in `b` (sound-alikes count). */
function fuzzyLcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = similar(a[i - 1], b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

/** Join phrases, dropping echoes: some phones report "king", "king of", "king of kings" as separate results. */
const titleKey = (song) => tokens(String(song.title).replace(/[(\[].*?[)\]]/g, ' ').replace(/\s[-–].*$/, ' ')).join(' ');

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
    this.prev = null; // the previous result {toks, final, at}: how a new result relates to it decides everything
    this.phrase = []; // words of the phrase being sung right now
    this.lastWide = -1e9;
    this.votes = []; // which library song was the best fit in each recent lookup: noisy singing still points the same way
    this.recording = false; // when on, every result and every highlight move is kept so a session can be replayed
    this.log = [];
    this.logStart = 0;
    this.titleDelay = deps.titleDelayMs ?? TITLE_PAUSE_MS;
    this.titleTimer = null;
    this.titleFinals = []; // finished phrases of the title being spoken
    this.titleCurrent = ''; // the phrase still in progress
  }

  // ---- session log (for debugging with real phones) ----
  startRecording() { this.log = []; this.logStart = this.now(); this.recording = true; this.note('start', { mode: this.mode, worship: this.worship }); }
  stopRecording() { this.recording = false; }
  note(k, data = {}) { if (this.recording) this.log.push({ t: this.now() - this.logStart, k, ...data }); }
  /** Everything needed to replay the session: the results as heard, the song and where the highlight went. */
  exportLog(extra = {}) {
    return { app: 'singalong-session-log', version: 1, savedAt: new Date().toISOString(), ...extra, events: this.log };
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
      onDecode: (d) => this.note('decode', d),
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
    this.prev = null;
    this.phrase = [];
    this.votes = [];
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

  /**
   * How does this result relate to the one before? Judged by the words, not the clock, because phones
   * differ: some send "king", "king of", "king of kings" as separate results (each growing the last),
   * others send each phrase once. Returns 'new' (a new phrase), 'grow' (the same phrase with more
   * words) or 'same' (nothing new).
   */
  relate(toks, isFinal) {
    const p = this.prev;
    const now = this.now();
    this.prev = { toks, final: isFinal, at: now };
    if (!p || p.toks.length === 0) return 'new';
    if (toks.length < p.toks.length - 1) return 'new';
    if (fuzzyLcs(p.toks, toks) < Math.ceil(0.6 * p.toks.length)) return 'new';
    const gap = now - p.at;
    const identical = toks.length === p.toks.length && fuzzyLcs(p.toks, toks) === toks.length;
    if (p.final && (gap > SAME_PHRASE_MS || (identical && gap > REPEAT_MS))) return 'new';
    return toks.length > p.toks.length ? 'grow' : 'same';
  }

  onBlank() {
    this.note('blank');
    if (this.phrase.length) { this.committed.push(...this.phrase); this.trimCommitted(); }
    this.phrase = [];
    this.prev = null;
    if (this.titleCurrent) { this.titleFinals.push(this.titleCurrent); this.titleCurrent = ''; }
    this.boundaries++;
    this.utteranceStable = [];
    this.tracker?.endUtterance();
  }
  trimCommitted() { while (this.committed.length > 40) this.committed.shift(); }

  onHeard(text, isFinal) {
    if (!text) return this.onBlank();
    this.note('heard', { text, final: !!isFinal, phase: this.state.phase });
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
      const rel = this.relate(toks, isFinal);
      if (rel === 'new') { // the phrase before is finished: keep its words, start a fresh phrase
        if (this.phrase.length) { this.committed.push(...this.phrase); this.trimCommitted(); }
        this.boundaries++;
      }
      this.phrase = toks;
      this.set({ heard: text });
      const v = this.getVocab();
      const lastIsWord = toks.length && v ? v.isWord(toks[toks.length - 1]) : false;
      this.utteranceStable = isFinal || lastIsWord ? toks : toks.slice(0, -1);
      this.maybeLookup();
    } else if (s.phase === 'singing') {
      const t = this.tracker;
      if (!t) return;
      const toks = tokens(text);
      const was = this.prev;
      const rel = this.relate(toks, isFinal);
      if (rel === 'new') t.endUtterance();
      // Same words again are skipped, except to settle the last word once the phrase is final.
      if (rel !== 'same' || (isFinal && was && !was.final)) t.update(toks, isFinal, false);
      if (t.line !== s.line) { this.note('line', { line: t.line, pos: t.pos }); this.set({ line: t.line }); }
      if (this.showHeardLive) this.set({ heard: text });
    }
  }

  // ---- lyrics mode ----
  async maybeLookup() {
    const words32 = [...this.committed, ...this.utteranceStable].slice(-LONG_SPAN);
    const words = words32.slice(-12);
    if (words.length < 3 || this.lookupBusy) return;
    if (new Set(distinctive(words)).size < 2) return; // "oh my oh my" says nothing about which song
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
      // Library search: the 12 newest distinctive words from the last 32. Over a noisy guitar only some
      // words are right, so more words give the right song more chances to stand out (the 8-word tail
      // ranked the true song 9th, 3rd or nowhere on a real log; this ranks it first).
      let spread = [...new Set(distinctive(words32))];
      if (vocab) spread = spread.filter((w) => vocab.isWord(w));
      spread = spread.slice(-12);
      // Genius search: the newest whole phrase as heard, which reads like a real lyric line.
      let phraseWords = this.utteranceStable.length >= 4 ? this.utteranceStable.slice(-10) : [];
      if (vocab) phraseWords = phraseWords.filter((w) => vocab.isWord(w));
      const skip = new Set(this.rejected);
      let skipLibrary = false;
      let waiting = false;
      let votedKey = null;
      let votedDone = false;
      let heldLoose = false;
      let held = null; // a library song that fits well enough, waiting to see if the wider search finds better
      const canWide = (r) => r.songs.length > 0 && r.songs.every((x) => x.source === 'library') && !skipLibrary && words.length >= 6 && this.now() - this.lastWide >= WIDE_GAP_MS;
      for (let pass = 0; pass < 2; pass++) {
        const tailQ = searchable.join(' ');
        let q = tailQ;
        let alt = distinct.length >= 2 && distinct.join(' ') !== tailQ ? distinct.join(' ') : '';
        if (skipLibrary) {
          if (phraseWords.length >= 4 && phraseWords.join(' ') !== tailQ) alt = phraseWords.join(' ');
        } else if (spread.length >= 4) {
          q = spread.join(' ');
          alt = tailQ !== q ? tailQ : '';
        }
        const r = await this.api.find({ q, alt, n: worship ? 6 : 4, exclude: [...skip], skipLibrary });
        if (epoch !== this.epoch) return;
        this.note('lookup', { pass, wide: skipLibrary, q, alt, found: r.songs.map((x) => `${x.title} (${x.source})`), cooling: !!r.cooling });
        if (r.cooling) {
          this.setListeningStatus('Busy for a moment. Keep singing, or try Title mode.');
          return;
        }
        const usable = r.songs.filter((song) => {
          skip.add(song.key);
          return mostlyLatin(song.lines) && (!worship || song.worship || isWorship(song.artist, song.lines));
        });
        const library = usable.filter((song) => song.source === 'library');
        // How well does each song fit the last line (r) and the last several lines together (long)?
        // A song that only shares one refrain with what was sung fits the first but not the second.
        const judge = (song) => {
          const lines = song.lines.map(tokens);
          return { song, lines, r: LyricTracker.rank(lines, words), long: LyricTracker.rank(lines, words32, LONG_SPAN) };
        };
        const longOf = (x) => (x.long ? x.long.ratio : 0);

        // Library songs: score each one forgivingly against what was heard and take the clear winner.
        if (library.length) {
          const ranked = library.map(judge).filter((x) => x.r)
            .sort((a, b) => (b.r.ratio + longOf(b)) - (a.r.ratio + longOf(a)) || b.r.score - a.r.score);
          if (ranked.length) {
            this.debugRank?.({ words, ranked: ranked.map((x) => ({ title: x.song.title, ...x.r, long: longOf(x) })) });
            const top = ranked[0];
            // Noisy singing (over a guitar) never fits one lookup well, but it keeps pointing at the same song.
            if (!skipLibrary) {
              this.votes.push(top.r.ratio >= 0.4 && top.r.score >= 1.8 ? { k: titleKey(top.song), ratio: top.r.ratio } : null);
              if (this.votes.length > VOTE_WINDOW) this.votes.shift();
              const tally = new Map();
              for (const v of this.votes) if (v) tally.set(v.k, [...(tally.get(v.k) || []), v.ratio]);
              const [lead, rival] = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
              if (lead && lead[1].length >= VOTES_NEEDED && (!rival || rival[1].length <= lead[1].length / 2)
                && lead[1].reduce((a, b) => a + b, 0) / lead[1].length >= 0.5) {
                votedKey = lead[0];
              }
            }
            // Other recordings of the same song fit equally well and don't count as rivals.
            const rival = ranked.find((x) => titleKey(x.song) !== titleKey(top.song));
            const gap = rival ? top.r.ratio - rival.r.ratio : 1;
            // Commit when one song clearly fits best and enough was heard to be sure of it. "Enough" is
            // real evidence: several distinctive words in order, over the last few lines and not just
            // a couple of words that happen to appear in many songs ("I'm coming back to ...").
            const enough = words.length >= 6 && top.r.score >= 5 && top.r.ratio >= 0.6 && longOf(top) >= LONG_FIT;
            const clear = gap >= (words.length >= 9 ? 0.15 : 0.3);
            if (enough && (clear || (words.length >= 10 && top.r.ratio >= 0.7))) {
              // A very good fit is taken at once. A moderate one is held back while the wider search
              // is asked, because a song that only shares a refrain with the real one fits like this.
              const strong = top.r.ratio >= 0.75 && longOf(top) >= 0.75;
              if (strong || skipLibrary) { if (this.openSong(top, words, consumedAtQuery, boundariesAtQuery)) return; }
              else if (canWide(r)) held = top;
              else waiting = true;
            } else if (top.r.ratio >= 0.5 && top.r.score >= 3) {
              waiting = true; // something fits a little: say so, but still look wider (below)
            }
            if (votedKey && !held) {
              const v = ranked.find((x) => titleKey(x.song) === votedKey);
              if (v && !votedDone) { // held like any moderate fit: the wider search gets a chance to find better first
                if (skipLibrary || !canWide(r)) { /* no wider search to wait for */ }
                held = v; heldLoose = true;
              }
            }
          }
        }

        // Songs found by Genius: the best fit wins, unless a library song held back fits better.
        const wide = usable.filter((x) => x.source !== 'library').map(judge)
          .filter((x) => x.r && x.r.ratio >= 0.55 && x.r.score >= 3 && longOf(x) >= LONG_FIT)
          .sort((a, b) => (b.r.ratio + longOf(b)) - (a.r.ratio + longOf(a)));
        if (wide.length && (!held || wide[0].r.ratio + longOf(wide[0]) > held.r.ratio + longOf(held) + 0.1)) {
          if (this.openSong(wide[0], words, consumedAtQuery, boundariesAtQuery)) return;
        }
        if (held && skipLibrary) { // the wider search found nothing better
          if (this.openSong(held, words, consumedAtQuery, boundariesAtQuery, heldLoose)) return;
        }
        // The library had candidates but none fitted well: the song is probably not in it. Ask the wider search.
        if (canWide(r)) {
          this.lastWide = this.now(); // the wider search is slower and shared: not on every new word
          skipLibrary = true;
          continue;
        }
        break;
      }
      this.setListeningStatus(waiting ? 'Keep singing...' : this.worship ? 'No worship song matched yet. Keep singing.' : 'Not sure yet. Keep singing.');
    } catch (e) {
      if (epoch === this.epoch) this.setListeningStatus(e.message || 'Lookup failed. Retrying as you sing.');
    } finally {
      if (epoch === this.epoch) {
        this.lookupBusy = false;
        // Words may have moved on (a phrase got finalised) while this lookup was out: look again now
        // rather than waiting for the next phrase, so a clean final phrase is never skipped.
        if (this.state.phase === 'listening') setTimeout(() => { if (epoch === this.epoch && this.state.phase === 'listening') this.maybeLookup(); }, 0);
      }
    }
  }

  /** Start following a judged song. False if it can't be followed from these words. */
  openSong(x, words, consumed, boundariesAtQuery, loose = false) {
    const t = LyricTracker.create(x.lines, words, consumed) || (loose ? LyricTracker.createLoose(x.lines, words, consumed) : null);
    if (!t) return false;
    if (this.boundaries !== boundariesAtQuery) t.endUtterance();
    this.present(x.song, t);
    return true;
  }

  setListeningStatus(status) {
    this.note('status', { status });
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
    this.votes = [];
    this.note('song', { key: song.key, title: song.title, artist: song.artist, source: song.source, line: tracker.line, lines: song.lines });
    clearTimeout(this.dismissTimer);
    this.set({ phase: 'singing', lyrics: song, line: tracker.line, canDismiss: true, options: null });
    this.dismissTimer = setTimeout(() => {
      if (this.state.phase === 'singing' && this.state.lyrics === song) this.set({ canDismiss: false });
    }, DISMISS_WINDOW_MS);
  }
}
