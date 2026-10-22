// Follows a singer through a song's lyrics, built for worship songs where lines repeat.
//
//  1. Walk forward through the lyric one WORD at a time as words are heard.
//  2. Only move the highlighted line once two words of the new line matched AND we are
//     sure which occurrence we are in.
//  3. Only relocate when exactly ONE other place explains the recent words clearly better,
//     and that stays true for a couple more words.
//  4. When ambiguous, hold. Lagging a line behind is fine; jumping ahead isn't.

const LOOKAHEAD = 2;
const RECENT = 6;
const MARGIN = 2;
const INIT_WINDOW = 8;
const PHRASE_WINDOW = 10;
const MIN_INIT_WORDS = 3;
const LOST_REACH = 45; // words ahead a lost tracker may jump to

// ---- word similarity --------------------------------------------------------------------

const phoneticCache = new Map();
const phoneticRules = [
  ['ght', 't'], ['gh', ''], ['ph', 'f'], ['ck', 'k'], ['kn', 'n'], ['wr', 'r'], ['who', 'ho'],
  ['wh', 'w'], ['sh', '$'], ['ch', '$'], ['th', 't'], ['ng', 'n'], ['ce', 'se'], ['ci', 'si'],
  ['cy', 'sy'], ['ge', 'je'], ['gi', 'ji'],
];

/** A rough "how it sounds" key: consonant skeleton with similar sounds merged. */
export function phonetic(word) {
  let cached = phoneticCache.get(word);
  if (cached !== undefined) return cached;
  let w = [...word].filter((c) => c >= 'a' && c <= 'z').join('');
  if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  for (const [from, to] of phoneticRules) w = w.split(from).join(to);
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    if ('aeiou'.includes(ch) || (ch === 'y' && i > 0)) continue;
    let c;
    switch (ch) {
      case 'b': case 'p': c = 'p'; break;
      case 'f': case 'v': c = 'f'; break;
      case 'd': case 't': c = 't'; break;
      case 'g': case 'k': case 'c': case 'q': c = 'k'; break;
      case 's': case 'z': c = 's'; break;
      case 'm': case 'n': c = 'n'; break;
      case 'h': c = ''; break;
      case 'x': c = 'ks'; break;
      default: c = ch;
    }
    if (c && out[out.length - 1] !== c) out += c;
  }
  phoneticCache.set(word, out);
  return out;
}

export function withinOneEdit(a, b) {
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++; j++;
    } else {
      edits++;
      if (edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
  }
  edits += (a.length - i) + (b.length - j);
  return edits <= 1;
}

/** Do two words count as the same? Exact, sound-alike, or one letter apart. */
export function similar(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const ka = phonetic(a);
  const kb = phonetic(b);
  if (ka === kb && ka.length >= 2) return true;
  if (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && withinOneEdit(a, b)) return true;
  return ka.length >= 4 && kb.length >= 4 && Math.abs(ka.length - kb.length) <= 1 && withinOneEdit(ka, kb);
}

const FILLER = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'is', 'i', 'you', 'my', 'me', 'your', 'we', 'he', 'it', 'that', 'as', 'on', 'for', 'with', 'are', 'be', 'will', 'our', 'all', 'his', 'her', 'so', 'oh', 'but', 'am', 'was', 'at', 'by', 'us', 'no', 'not']);
/** How much a word says about which song it is: little words count for less. */
export const weight = (w) => (FILLER.has(w) ? 0.4 : 1);

// ---- the tracker ------------------------------------------------------------------------

export class LyricTracker {
  /** @param {string[][]} lines tokenised lyric lines */
  constructor(lines) {
    this.words = [];
    this.lineOf = [];
    this.lineStart = new Array(lines.length).fill(0);
    this.lineLen = new Array(lines.length).fill(0);
    lines.forEach((l, li) => {
      this.lineStart[li] = this.words.length;
      this.lineLen[li] = l.length;
      for (const w of l) {
        this.words.push(w);
        this.lineOf.push(li);
      }
    });
    this.line = 0;
    this.pos = 0;
    this.consumed = 0;
    this.newUtterance = false;
    this.totalSeen = 0;
    this.recent = []; // [word, matchedSequentially]
    this.pending = null;
    this.certain = true;
    this.relocated = false;
    this.anchored = true; // false for a song opened from the top until the singer is really following it
    this.matches = 0;
    this.run = 0; // words matched one after another, allowing a single miss
    this.missStreak = 0;
    this.lost = 0; // results in a row that moved nothing: the words are too noisy to follow word by word
  }

  /** Tracker that starts at the top of the song (picked by title). */
  static start(lines) {
    const t = new LyricTracker(lines);
    if (t.words.length === 0) return null;
    t.anchored = false;
    return t;
  }

  /**
   * First lock-on from the words heard so far. Null if they don't convincingly match anywhere.
   * Several equal matches: the EARLIEST wins and the tracker starts not certain.
   */
  static create(lines, heard, consumedInUtterance = heard.length, strict = false) {
    const t = new LyricTracker(lines);
    if (t.words.length === 0) return null;
    for (const attempt of [heard, heard.slice(0, -1)]) {
      const window = attempt.slice(-INIT_WINDOW);
      if (window.length < MIN_INIT_WORDS) continue;
      let need = window.length <= 3 ? 2 : Math.max(3, Math.ceil(window.length * 0.6));
      // Strict (songs from the shared library, where many songs share words): most words must fit.
      if (strict) need = window.length <= 3 ? window.length : Math.max(4, Math.ceil(window.length * 0.75));
      const cands = t.candidates(window, need);
      if (cands.length === 0) continue;
      const best = Math.max(...cands.map((c) => c.score));
      const tops = cands.filter((c) => c.score === best).map((c) => c.q);
      const q = Math.min(...tops);
      t.pos = q + 1;
      t.line = t.lineOf[q];
      t.consumed = consumedInUtterance;
      for (const w of heard.slice(-RECENT)) t.recent.push([w, true]);
      t.certain = tops.length === 1;
      return t;
    }
    return null;
  }

  /**
   * Start following a song that is already known to be the right one, from noisy words. Goes to the best
   * place the recent words fit, however poorly, and if they fit nowhere starts from the top.
   */
  static createLoose(lines, heard, consumed = heard.length) {
    const t = new LyricTracker(lines);
    if (t.words.length === 0) return null;
    const window = heard.slice(-10);
    const cands = window.length >= 3 ? t.candidates(window, 2.5, true) : [];
    if (cands.length === 0) return LyricTracker.start(lines);
    const best = Math.max(...cands.map((c) => c.score));
    const tops = cands.filter((c) => c.score >= best - 0.01);
    const q = Math.min(...tops.map((c) => c.q));
    t.pos = q + 1;
    t.line = t.lineOf[q];
    t.consumed = consumed;
    t.certain = false;
    t.anchored = false;
    return t;
  }

  /**
   * How well do the heard words fit these lyrics? Forgiving: a misheard word, a dropped word or an
   * extra word costs a little, little words ("the", "and") count for less than distinctive ones, and
   * the last one or two words may be wrong. Returns { score, ratio } (ratio 0..1) or null.
   */
  static rank(lines, heard, span = INIT_WINDOW) {
    const t = new LyricTracker(lines);
    if (t.words.length === 0) return null;
    let best = null;
    for (let drop = 0; drop <= 2; drop++) {
      const window = heard.slice(0, heard.length - drop).slice(-span);
      if (window.length < MIN_INIT_WORDS) continue;
      const total = window.reduce((a, w) => a + weight(w), 0);
      const anchor = window[window.length - 1];
      let top = 0;
      for (let q = 0; q < t.words.length; q++) {
        if (!similar(t.words[q], anchor)) continue;
        const lo = Math.max(0, q - window.length - 2);
        top = Math.max(top, weight(anchor) + t.lcs(window, window.length - 1, lo, q, true));
      }
      const ratio = top / total;
      if (top > 0 && (!best || ratio > best.ratio)) best = { score: top, ratio, words: window.length };
    }
    return best;
  }

  /** Call when the speech engine ends an utterance. */
  endUtterance() {
    this.newUtterance = true;
  }

  /**
   * Feed the words of the CURRENT utterance (whole utterance so far). `final` ends it.
   * Returns true if the singer made progress.
   */
  update(tokens, final, boundary = final) {
    if (this.newUtterance) {
      this.consumed = 0;
      this.newUtterance = false;
    }
    let progressed = false;
    const stableEnd = final ? tokens.length : Math.max(this.consumed, tokens.length - 1);
    for (let i = this.consumed; i < stableEnd; i++) {
      if (this.consume(tokens[i], tokens[i + 1] ?? null, false)) progressed = true;
    }
    this.consumed = Math.max(this.consumed, stableEnd);
    if (!final && tokens.length > this.consumed) {
      const w = tokens[tokens.length - 1];
      if (this.pos < this.words.length && w === this.words[this.pos]) {
        this.consume(w, null, true);
        this.consumed = tokens.length;
        progressed = true;
      }
    }
    this.lost = progressed ? 0 : this.lost + 1;
    if (this.phraseJump(tokens)) { progressed = true; this.lost = 0; }
    if (boundary) this.newUtterance = true;
    if (this.relocated) {
      progressed = true;
      this.relocated = false;
    }
    return progressed;
  }

  /**
   * A whole phrase arrives at once from Whisper, so judge it as a whole: if the last several words
   * fit one place in the song clearly better than where we are, go there now. If the words fit
   * several places (a repeated chorus), take the nearest one ahead, never one far behind.
   */
  phraseJump(tokens) {
    if (tokens.length < 4) return false;
    // When the last few results moved nothing, the singer is probably somewhere else and the words are
    // noisy (over a guitar): accept a weaker fit, but only a place ahead of where we are.
    const lost = this.lost >= 3;
    let best = null;
    for (const attempt of [tokens, tokens.slice(0, -1)]) {
      const window = attempt.slice(-PHRASE_WINDOW);
      if (window.length < (lost ? 4 : 5)) continue;
      const total = window.reduce((a, w) => a + weight(w), 0);
      const need = lost ? Math.max(2.6, 0.45 * total) : Math.max(3.2, 0.65 * total);
      let cands = this.candidates(window, need, true);
      if (lost) cands = cands.filter((c) => c.q + 1 > this.pos && c.q + 1 <= this.pos + LOST_REACH);
      if (cands.length === 0) continue;
      const top = Math.max(...cands.map((c) => c.score));
      if (this.scoreHere(window, true) + (lost ? 0.5 : 1) >= top) continue; // already where these words are, or no clear gain
      const ratio = top / total;
      if (!best || ratio > best.ratio) best = { ratio, cands: cands.filter((c) => c.score >= top - 0.01) };
    }
    if (!best) return false;
    const rank = (c) => (c.q + 1 >= this.pos ? c.q + 1 - this.pos : 100000 + (this.pos - c.q - 1));
    const pick = best.cands.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    const q = pick.q;
    if (q + 1 === this.pos) return false;
    this.pos = q + 1;
    const l = this.lineOf[q];
    this.line = this.repeatsRecentLine(l, this.pos - this.lineStart[l]) ? Math.max(0, l - 1) : l;
    this.consumed = Math.max(this.consumed, tokens.length);
    this.recent = [];
    this.pending = null;
    this.certain = best.cands.length === 1;
    this.anchored = true;
    this.relocated = true;
    this.run = 0;
    return true;
  }

  consume(w, next, exactOnly) {
    this.totalSeen++;
    if (this.pos >= this.words.length) {
      this.onMiss(w);
      return false;
    }
    const expected = this.words[this.pos];
    const hit = exactOnly ? w === expected : similar(w, expected);
    if (hit) {
      this.pos++;
      this.onMatch(w);
      return true;
    }
    if (!exactOnly) {
      for (let d = 1; d <= LOOKAHEAD; d++) {
        const p = this.pos + d;
        if (p >= this.words.length) break;
        if (d > 1 && this.lineOf[p] !== this.lineOf[this.pos]) break;
        if (similar(w, this.words[p])) {
          const distinct = w.length >= 4;
          const nextOk = next != null && next.length >= 4 && p + 1 < this.words.length &&
            similar(next, this.words[p + 1]);
          if (distinct || nextOk) {
            this.pos = p + 1;
            this.onMatch(w);
            return true;
          }
        }
      }
    }
    this.onMiss(w);
    return false;
  }

  note(w, matched) {
    this.recent.push([w, matched]);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  onMatch(w) {
    this.run++;
    this.missStreak = 0;
    if (++this.matches >= 3) this.anchored = true;
    this.note(w, true);
    this.advanceDisplay();
    this.checkAlignment();
  }

  onMiss(w) {
    if (++this.missStreak >= 2) this.run = 0; // one misheard word doesn't break the flow
    this.note(w, false);
    this.checkAlignment();
  }

  advanceDisplay() {
    const last = this.pos - 1;
    if (last < 0) return;
    const l = this.lineOf[last];
    if (l > this.line) {
      const matched = this.pos - this.lineStart[l];
      const need = Math.min(2, this.lineLen[l]);
      if (matched >= need) {
        // Singing straight on from the end of the line we were on is proof enough, even when the lines
        // repeat. Anything else (a jump, or a line that looks like a recent one) needs to be certain.
        const flowed = l === this.line + 1 && this.run >= matched + Math.min(2, this.lineLen[this.line]);
        if (flowed || (!this.repeatsRecentLine(l, matched) && (this.certain || this.supportedUniquely()))) this.line = l;
      }
    }
  }

  /** True if line l opens, for `matched` words, exactly like one of the two lines before it. */
  repeatsRecentLine(l, matched) {
    for (let m = Math.max(0, l - 2); m < l; m++) {
      if (this.lineLen[m] < matched) continue;
      let same = true;
      for (let i = 0; i < matched; i++) {
        if (!similar(this.words[this.lineStart[l] + i], this.words[this.lineStart[m] + i])) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
    return false;
  }

  supportedUniquely() {
    const window = this.recent.map((r) => r[0]);
    if (window.length < 4) return false;
    const here = this.scoreHere(window);
    if (here < Math.max(3, Math.ceil(window.length * 0.6))) return false;
    for (const c of this.candidates(window, Math.max(3, here))) {
      if (c.q + 1 !== this.pos && c.score >= here) return false;
    }
    return true;
  }

  scoreHere(window, weighted = false) {
    const lo = Math.max(0, this.pos - window.length - 1);
    return this.lcs(window, window.length, lo, this.pos, weighted);
  }

  checkAlignment() {
    if (this.recent.length < 5) return;
    if (this.recent.filter((r) => !r[1]).length < 2) {
      this.pending = null;
      return;
    }
    this.certain = false;
    const window = this.recent.map((r) => r[0]);
    if (this.supportedUniquely()) {
      this.certain = true;
      this.pending = null;
      return;
    }
    const here = this.scoreHere(window);
    const cands = this.candidates(window, Math.max(4, here + MARGIN));
    if (cands.length === 0) {
      this.pending = null;
      return;
    }
    const best = Math.max(...cands.map((c) => c.score));
    let top = cands.filter((c) => c.score === best);
    let tie = false;
    if (top.length !== 1) {
      if (this.anchored) {
        this.pending = null;
        return;
      }
      // Opened from the top but the singer is somewhere else, and the words fit several places
      // (a repeated chorus): take the earliest, and stay unsure so it can only lag, not jump.
      top = [top.reduce((a, b) => (b.q < a.q ? b : a))];
      tie = true;
    }
    const q = top[0].q;
    if (q + 1 === this.pos) return;
    const key = q - this.totalSeen;
    const p = this.pending;
    if (p && Math.abs(p.key - key) <= 1) p.count++;
    else this.pending = { key, count: 1 };
    const forward = q + 1 - this.pos;
    const confirm = forward > 6 ? 3 : 2;
    if ((this.pending?.count ?? 0) >= confirm) {
      this.pos = q + 1;
      const l = this.lineOf[q];
      this.line = this.repeatsRecentLine(l, this.pos - this.lineStart[l]) ? Math.max(0, l - 1) : l;
      this.recent = [];
      this.pending = null;
      this.certain = !tie;
      this.anchored = true;
      this.relocated = true;
    }
  }

  candidates(window, minScore, weighted = false) {
    const out = [];
    const w = window.length;
    const last = window[w - 1];
    for (let q = 0; q < this.words.length; q++) {
      if (!similar(this.words[q], last)) continue;
      const lo = Math.max(0, q - w - 1);
      const s = (weighted ? weight(last) : 1) + this.lcs(window, w - 1, lo, q, weighted);
      if (s >= minScore) out.push({ q, score: s });
    }
    return out;
  }

  lcs(window, n, lo, hi, weighted = false) {
    if (n <= 0 || hi <= lo) return 0;
    const m = hi - lo;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) {
        cur[j] = similar(window[i - 1], this.words[lo + j - 1])
          ? prev[j - 1] + (weighted ? weight(window[i - 1]) : 1)
          : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[m];
  }
}
