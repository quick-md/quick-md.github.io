// Talks to the SingAlong Worker. The Genius token lives there; nothing secret is in this file.
import { WORKER_URL } from './config.js';

async function call(path, params, base = WORKER_URL) {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
  }
  let res;
  try {
    res = await fetch(u);
  } catch {
    throw new Error("Can't reach the song service. Check your connection.");
  }
  if (res.status === 429) throw new Error('A lot of lookups at once. Give it a few seconds.');
  if (!res.ok) throw new Error('The song service had a problem. Try again.');
  return res.json();
}

/** Songs whose lyrics contain the heard words: { songs: [{key,title,artist,lines,source}], cooling? } */
export const find = (p) => call('/find', p);
/** Songs matching a spoken title (maybe with artist). */
export const title = (p) => call('/title', p);
/** Songs with close titles, for suggestions. */
export const close = (p) => call('/close', p);
