// Decides whether a song counts as worship music, for "worship mode".
// A song passes if its artist is on the list, or its lyrics use enough worship words.
import { tokens } from './matcher.js';

const MIN_STRONG_WORDS = 2;

const artistPhrases = [
  'hillsong', 'bethel', 'jesus culture', 'elevation worship', 'maverick city',
  'planetshakers', 'citipointe', 'chris tomlin', 'phil wickham', 'matt redman',
  'kari jobe', 'cody carnes', 'brandon lake', 'housefires', 'vertical worship',
  'darlene zschech', 'israel houghton', 'brooke ligertwood', 'martin smith',
  'delirious', 'michael w. smith', 'don moen', 'paul baloche', 'tim hughes',
  'stuart townend', 'keith & kristyn getty', 'keith and kristyn getty', 'cityalight',
  'shane & shane', 'sinach', 'tasha cobbs', 'we the kingdom', 'red rocks worship',
  'upper room', 'sean feucht', 'rend collective', 'casting crowns', 'lauren daigle',
  'sovereign grace', 'gateway worship', 'united pursuit', 'worship central',
  'all sons & daughters', 'david crowder', 'third day', 'worship',
  'bethel music', 'cece winans', 'zach williams', 'for king & country', 'for king and country',
  'mercyme', 'newsboys', 'francesca battistelli', 'matt maher', 'andrew peterson', 'cory asbury',
  'mosaic msc', 'northridge', 'dante bowe', 'naomi raine', 'travis greene', 'kirk franklin',
  'tauren wells', 'anne wilson', 'jeremy camp', 'natalie grant', 'kutless', 'jesus image',
  'chris tomlin', 'hymn', 'choir', 'cityalight', 'integrity music', 'vineyard', 'sidewalk prophets',
];

const artistExact = new Set(['passion', 'hope', 'life.church worship']);

const strongWords = new Set([
  'jesus', 'christ', 'savior', 'saviour', 'hallelujah', 'alleluia', 'hosanna',
  'redeemer', 'almighty', 'emmanuel', 'messiah', 'amen', 'yahweh', 'jehovah', 'adonai', 'elohim',
]);

const weakWords = new Set([
  'lord', 'holy', 'heaven', 'cross', 'praise', 'worship', 'lamb', 'gospel', 'glory', 'grace',
  'thou', 'thee', 'thy', 'mercy', 'worthy', 'faithful', 'blessed',
]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const artistRegexes = artistPhrases.map((p) => new RegExp(`(^|\\W)${esc(p)}(\\W|$)`));

/** @param {string} artist @param {string[]} lines raw lyric lines */
export function isWorship(artist, lines) {
  const name = String(artist || '').toLowerCase().trim();
  if (artistExact.has(name)) return true;
  if (artistRegexes.some((r) => r.test(name))) return true;

  const words = new Set(lines.flatMap((l) => tokens(l)));
  let strong = 0;
  let weak = 0;
  for (const w of words) {
    if (strongWords.has(w)) strong++;
    if (weakWords.has(w)) weak++;
  }
  return strong >= MIN_STRONG_WORDS || (strong >= 1 && weak >= 1) || weak >= 4;
}
