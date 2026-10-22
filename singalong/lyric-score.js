// "Which of the song's next lines fits this audio best?" Pure logic, free of the model and the browser.
// The worker scores each candidate text against the audio (average log-probability per token);
// this module builds the candidates and decides what, if anything, the scores justify.

const clean = (l) => String(l).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\s']/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Candidate stretches of the song the singer may just have sung: 1 to `maxLines` lines in a row,
 * ending between `back` lines behind and `ahead` lines past the current one.
 * @param {string[]} lines the song's lines as displayed
 * @param {number} line the tracker's current line
 */
export function buildCandidates(lines, line, { back = 1, ahead = 4, maxLines = 3, maxChars = 220 } = {}) {
  const out = [];
  const last = lines.length - 1;
  for (let end = Math.max(0, line - back); end <= Math.min(last, line + ahead); end++) {
    for (let n = 1; n <= maxLines; n++) {
      const from = end - n + 1;
      if (from < 0) break;
      const text = lines.slice(from, end + 1).map(clean).filter(Boolean).join(' ');
      if (!text || text.length > maxChars) continue;
      out.push({ id: `${from}-${end}`, from, to: end, text });
    }
  }
  return out;
}

/** Average log-probability of `targets` given the model's logits, one row of `vocab` numbers per position. */
export function averageLogProb(logits, vocab, firstRow, targets) {
  let sum = 0;
  for (let i = 0; i < targets.length; i++) {
    const row = (firstRow + i) * vocab;
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (logits[row + v] > max) max = logits[row + v];
    let z = 0;
    for (let v = 0; v < vocab; v++) z += Math.exp(logits[row + v] - max);
    sum += logits[row + targets[i]] - max - Math.log(z);
  }
  return targets.length ? sum / targets.length : -Infinity;
}

/**
 * What do the scores say? Returns {action, ...}. Candidates that read the same (a repeated chorus line)
 * are one choice, and the copy nearest ahead of the current line is taken.
 * `heard` is how well the model's own transcript scores: the best any text could be expected to do.
 */
export function decide(scores, cands, line, { margin = 0.35, gap = 1.0, floor = -2.2, back = 1 } = {}) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const heard = scores.find((s) => s.id === 'heard');
  const rows = scores.filter((s) => s.id !== 'heard' && byId.has(s.id) && Number.isFinite(s.avg))
    .map((s) => ({ ...byId.get(s.id), avg: s.avg }));
  if (rows.length < 2) return { action: 'none', why: 'too few candidates' };
  const groups = new Map();
  for (const r of rows) {
    const k = norm(r.text);
    const g = groups.get(k);
    const dist = (c) => (c.to >= line ? c.to - line : 1000 + (line - c.to));
    if (!g || dist(r) < dist(g)) groups.set(k, r);
  }
  const ranked = [...groups.values()].sort((a, b) => b.avg - a.avg);
  const best = ranked[0];
  const second = ranked[1];
  const info = { best: best.id, bestAvg: +best.avg.toFixed(3), second: second ? second.id : null, secondAvg: second ? +second.avg.toFixed(3) : null, heardAvg: heard && Number.isFinite(heard.avg) ? +heard.avg.toFixed(3) : null, line };
  if (best.avg < floor) return { action: 'none', why: 'no candidate fits well', ...info };
  if (info.heardAvg !== null && info.heardAvg - best.avg > gap) return { action: 'none', why: 'far worse than what was heard', ...info };
  if (second && best.avg - second.avg < margin) return { action: 'none', why: 'too close to call', ...info };
  if (best.to === line) return { action: 'confirm', ...info, to: best.to };
  return { action: 'move', ...info, to: best.to, forward: best.to > line, backBy: Math.max(0, line - best.to), back };
}
