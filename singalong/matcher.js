// Text helpers shared by lyric matching and the worship filter.

/** Lowercase words with punctuation and apostrophes removed ("Don't stop!" -> dont, stop). */
export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

const filler = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'am', 'was', 'be', 'it', 'its',
  'you', 'your', 'i', 'me', 'my', 'we', 'our', 'he', 'she', 'they', 'oh', 'yeah', 'ooh', 'all', 'for',
  'with', 'that', 'this', 'so', 'no', 'not', 'but', 'as', 'at', 'by', 'from', 'will', 'can', 'do',
  'ah', 'na', 'la', 'hey', 'now', 'up', 'out', 'there', 'here', 'when', 'what', 'how', 'just',
]);

/** The words that identify a song best: everyday filler removed. */
export function distinctive(words) {
  return words.filter((w) => w.length >= 3 && !filler.has(w));
}

/** True if the lyrics are written mostly in the Latin alphabet (so not Arabic, Cyrillic, Chinese...). */
export function mostlyLatin(lines) {
  const text = lines.join(' ');
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  const latin = text.match(/\p{Script=Latin}/gu);
  return (latin ? latin.length : 0) / letters.length >= 0.85;
}
