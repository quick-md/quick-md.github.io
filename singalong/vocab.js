// A list of real English words, most common first, used to repair what the recogniser heard.
// snap() swaps a suspect word for the closest real common one; isWord() tells nonsense from words.
import { phonetic, withinOneEdit } from './tracker.js';

const COMMON = 15000; // words ranked above this are trusted as they are

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(Math.min(cur[j - 1], prev[j]) + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export class Vocabulary {
  constructor(words) {
    this.rank = new Map();
    this.bySound = new Map();
    this.byLength = new Map();
    this.cache = new Map();
    words.forEach((w, i) => {
      if (this.rank.has(w)) return;
      this.rank.set(w, i);
      if (!this.byLength.has(w.length)) this.byLength.set(w.length, []);
      this.byLength.get(w.length).push(w);
      const key = phonetic(w);
      if (key.length >= 2) {
        if (!this.bySound.has(key)) this.bySound.set(key, []);
        this.bySound.get(key).push(w);
      }
    });
  }

  isWord(w) {
    return this.rank.has(w);
  }

  snap(w) {
    if (w.length <= 2) return w;
    const r = this.rank.get(w);
    if (r !== undefined && r < COMMON) return w;
    let hit = this.cache.get(w);
    if (hit === undefined) {
      hit = this.find(w, r);
      this.cache.set(w, hit);
    }
    return hit;
  }

  snapAll(words) {
    return words.map((w) => this.snap(w));
  }

  find(w, r) {
    const limit = r === undefined ? Infinity : Math.floor(r / 10);
    let best = null;
    let bestDist = Infinity;
    let bestRank = Infinity;
    const consider = (c) => {
      const cr = this.rank.get(c);
      if (cr === undefined || cr >= limit || c === w) return;
      const d = distance(w, c);
      if (d > 2) return;
      if (d < bestDist || (d === bestDist && cr < bestRank)) {
        best = c; bestDist = d; bestRank = cr;
      }
    };
    (this.bySound.get(phonetic(w)) || []).slice(0, 300).forEach(consider);
    if (best === null) {
      for (let len = w.length - 1; len <= w.length + 1; len++) {
        for (const c of (this.byLength.get(len) || []).slice(0, COMMON)) {
          if (withinOneEdit(w, c)) consider(c);
        }
      }
    }
    return best ?? w;
  }
}

/** Parse words.txt content into a Vocabulary. */
export function vocabularyFromText(text) {
  return new Vocabulary(text.split('\n').map((s) => s.trim()).filter(Boolean));
}
