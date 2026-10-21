// SingAlong Worker: keeps the Genius token private and runs the shared song library.
//
//   GET  /find?q=<heard words>&alt=<distinctive words>&n=4&exclude=key1,key2&skipLibrary=1
//   GET  /title?q=<title, maybe artist>&alt=<repaired>&n=3&exclude=...
//   GET  /close?q=<title>&alt=<repaired>
//   GET  /health
//   POST /admin/add   {title, artist}   (header X-Admin-Key)
//
// Bindings: DB (D1), secrets GENIUS_TOKEN and ADMIN_KEY, var ALLOWED_ORIGIN (comma separated, optional).
// Single file on purpose, so it can be pasted into the Cloudflare dashboard editor.

const GENIUS = 'https://api.genius.com/search';
const LRCLIB = 'https://lrclib.net/api';
const UA = 'SingAlongWeb/1.0 (personal, non-commercial)';

const RATE_PER_MINUTE = 90; // generous, per person: a safety net, not a throttle
const LIBRARY_HITS = 4;
const LIBRARY_CANDIDATES = 15; // pulled from the text index, then ranked by how well they really match
const LIBRARY_MIN_WORDS = 5;  // too few words match too many songs; leave short phrases to Genius
const STORE_PER_QUERY = 2;
const COOLDOWN_MS = 60_000;

let geniusCoolUntil = 0;
const hits = new Map(); // ip -> { start, count }

// ---- small helpers ----------------------------------------------------------------------

export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function songKey(title, artist) {
  return `${tokens(title).join(' ')}|${tokens(artist).join(' ')}`;
}

const timestamp = /^\s*(\[[^\]]*\])+\s*/;

export function linesOf(o) {
  if (!o || o.instrumental) return null;
  const plain = o.plainLyrics && String(o.plainLyrics).trim();
  const raw = plain || String(o.syncedLyrics || '').split('\n').map((l) => l.replace(timestamp, '')).join('\n');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length >= 4 ? lines : null;
}

/** Lenient check that most of the heard words really occur in these lyrics (client does the strict one). */
export function fits(heard, lines) {
  const want = heard.filter((w) => w.length >= 4);
  const list = want.length >= 2 ? want : heard.filter((w) => w.length >= 3);
  if (list.length === 0) return false;
  const have = new Set(lines.flatMap(tokens));
  const stems = new Set([...have].map((w) => w.slice(0, 4)));
  let ok = 0;
  for (const w of list) if (have.has(w) || stems.has(w.slice(0, 4))) ok++;
  return ok >= Math.max(2, Math.ceil(list.length * 0.4)) || (list.length < 2 && ok >= 1);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const list = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  const h = { Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Max-Age': '86400' };
  if (list.length === 0) h['Access-Control-Allow-Origin'] = '*';
  else if (list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env), ...extra },
  });
}

function limited(ip, now) {
  const e = hits.get(ip);
  if (!e || now - e.start > 60_000) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > 60_000) hits.delete(k);
    return false;
  }
  e.count++;
  return e.count > RATE_PER_MINUTE;
}

const fetcher = (env) => env.FETCH || ((...a) => fetch(...a));

// ---- the library (D1 + FTS5) ------------------------------------------------------------

const songOut = (r, source) => ({ key: r.key, title: r.title, artist: r.artist, lines: r.lyrics.split('\n'), source, worship: !!r.worship });

export async function libraryByKey(env, key) {
  const r = await env.DB.prepare('SELECT key, title, artist, lyrics, worship FROM songs WHERE key = ?').bind(key).first();
  return r || null;
}

/** Longest run of heard words that appears back to back in the lyrics, and how many heard words appear at all. */
export function runScore(heard, lyricTokens) {
  const n = heard.length;
  const m = lyricTokens.length;
  let best = 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      if (heard[i - 1] === lyricTokens[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  const have = new Set(lyricTokens);
  return { run: best, covered: heard.filter((w) => have.has(w)).length };
}

/** Library songs that really contain what was heard: a 4-word run, or a 3-word run with most words present. */
export function rankLibrary(heard, rows) {
  const scored = [];
  for (const r of rows) {
    const { run, covered } = runScore(heard, tokens(r.lyrics));
    const ok = run >= 4 || (run >= 3 && covered >= Math.ceil(heard.length * 0.75));
    if (ok) scored.push({ r, run, covered });
  }
  scored.sort((a, b) => b.run - a.run || b.covered - a.covered);
  return scored.map((x) => x.r);
}

/**
 * Decide whether the library can answer yet. Worship songs share phrases, so it commits only when
 * one song clearly stands out (a 5-word run that no other song matches as well), or when a full
 * window of words has been heard. Otherwise it says "waiting" and the app keeps listening.
 */
export function decideLibrary(heard, rows) {
  const scored = [];
  for (const r of rows) {
    const { run, covered } = runScore(heard, tokens(r.lyrics));
    const ok = run >= 4 || (run >= 3 && covered >= Math.ceil(heard.length * 0.75));
    if (ok) scored.push({ r, run, covered });
  }
  if (scored.length === 0) return { songs: [], waiting: false };
  scored.sort((a, b) => b.run - a.run || b.covered - a.covered);
  const top = scored[0].run;
  const rivals = scored.filter((x) => x.run === top).length;
  const clear = top >= 5 && rivals === 1;
  const fullWindow = heard.length >= 8 && top >= 4;
  if (clear || fullWindow) return { songs: scored.map((x) => x.r), waiting: false };
  return { songs: [], waiting: true };
}

export async function librarySearch(env, heard, limit = LIBRARY_CANDIDATES) {
  const terms = [...new Set(heard.filter((w) => w.length >= 4))].slice(0, 12);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  const { results } = await env.DB.prepare(
    `SELECT s.key, s.title, s.artist, s.lyrics, s.worship FROM songs_fts f JOIN songs s ON s.id = f.rowid
     WHERE songs_fts MATCH ? ORDER BY bm25(songs_fts) LIMIT ?`,
  ).bind(match, limit).all();
  return results || [];
}

export async function libraryByTitle(env, titleTokens, limit = 5) {
  if (titleTokens.length === 0) return [];
  const like = `%${titleTokens.join(' ').replace(/[%_]/g, '')}%`;
  const { results } = await env.DB.prepare(
    'SELECT key, title, artist, lyrics, worship FROM songs WHERE key LIKE ? LIMIT ?',
  ).bind(like, limit).all();
  return results || [];
}

/** Saves a song. `curated` marks songs you added yourself on the admin page as worship songs. */
export async function libraryStore(env, title, artist, lines, curated = false) {
  const key = songKey(title, artist);
  const have = await env.DB.prepare('SELECT id FROM songs WHERE key = ?').bind(key).first();
  if (have) {
    if (curated) await env.DB.prepare('UPDATE songs SET worship = 1 WHERE key = ?').bind(key).run();
    return false;
  }
  const lyrics = lines.join('\n');
  const body = [...new Set(tokens(lyrics))].join(' ');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO songs (key, title, artist, lyrics, added, worship) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(key, title, artist, lyrics, Date.now(), curated ? 1 : 0),
    env.DB.prepare('INSERT INTO songs_fts (rowid, body) SELECT id, ? FROM songs WHERE key = ? AND NOT EXISTS (SELECT 1 FROM songs_fts WHERE rowid = songs.id)')
      .bind(body, key),
  ]);
  return true;
}

// ---- Genius and LRCLIB ------------------------------------------------------------------

async function geniusSearch(env, q, limit = 8) {
  if (!q.trim()) return [];
  const res = await fetcher(env)(`${GENIUS}?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${env.GENIUS_TOKEN}`, 'User-Agent': UA },
  });
  if (res.status === 429) {
    geniusCoolUntil = Date.now() + COOLDOWN_MS;
    return [];
  }
  if (!res.ok) throw new Error(`Genius ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const h of data?.response?.hits || []) {
    const r = h.result;
    if (h.type !== 'song' || !r?.title || !r?.primary_artist?.name) continue;
    out.push({ title: r.title, artist: r.primary_artist.name });
    if (out.length >= limit) break;
  }
  return out;
}

async function lrclibLines(env, song) {
  const f = fetcher(env);
  const params = `track_name=${encodeURIComponent(song.title)}&artist_name=${encodeURIComponent(song.artist)}`;
  const headers = { 'User-Agent': UA };
  try {
    const r = await f(`${LRCLIB}/get?${params}`, { headers });
    if (r.status === 200) {
      const lines = linesOf(await r.json());
      if (lines) return lines;
    }
    const r2 = await f(`${LRCLIB}/search?${params}`, { headers });
    if (r2.status === 200) {
      for (const o of await r2.json()) {
        const lines = linesOf(o);
        if (lines) return lines;
      }
    }
  } catch { /* treat as no lyrics */ }
  return null;
}

async function lrclibSearch(env, q) {
  try {
    const r = await fetcher(env)(`${LRCLIB}/search?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } });
    if (r.status !== 200) return [];
    const out = [];
    for (const o of await r.json()) {
      if (out.length >= 8) break;
      if (!o.trackName || !o.artistName) continue;
      const lines = linesOf(o);
      if (lines) out.push({ title: o.trackName, artist: o.artistName, lines });
    }
    return out;
  } catch { return []; }
}

/** Lyrics for a song: library first (no outside call), else LRCLIB. */
async function lyricsFor(env, song) {
  const key = songKey(song.title, song.artist);
  const have = await libraryByKey(env, key);
  if (have) return { ...song, key, lines: have.lyrics.split('\n'), worship: !!have.worship };
  const lines = await lrclibLines(env, song);
  return lines ? { ...song, key, lines } : null;
}

const interleave = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
};

const dedupe = (songs, exclude) => {
  const seen = new Set(exclude);
  return songs.filter((s) => {
    const k = songKey(s.title, s.artist);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const clampInt = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));

// ---- endpoints --------------------------------------------------------------------------

async function find(request, env, url) {
  const heard = tokens(url.searchParams.get('q'));
  const alt = tokens(url.searchParams.get('alt'));
  const n = clampInt(url.searchParams.get('n'), 4, 1, 8);
  const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
  if (heard.length < 2) return json(request, env, { songs: [] });

  if (url.searchParams.get('skipLibrary') !== '1' && heard.length >= LIBRARY_MIN_WORDS) {
    const found = (await librarySearch(env, heard)).filter((r) => !exclude.includes(r.key));
    const d = decideLibrary(heard, found);
    if (d.songs.length) return json(request, env, { songs: d.songs.slice(0, LIBRARY_HITS).map((r) => songOut(r, 'library')) });
    if (d.waiting) return json(request, env, { songs: [], waiting: true });
  }

  if (Date.now() < geniusCoolUntil) return json(request, env, { songs: [], cooling: true });

  const [a, b] = await Promise.all([
    geniusSearch(env, heard.join(' ')),
    alt.length >= 2 && alt.join(' ') !== heard.join(' ') ? geniusSearch(env, alt.join(' ')).catch(() => []) : [],
  ]);
  if (Date.now() < geniusCoolUntil) return json(request, env, { songs: [], cooling: true });
  const candidates = dedupe(interleave(a, b), exclude).slice(0, n);
  const fetched = await Promise.all(candidates.map((s) => lyricsFor(env, s)));
  const good = fetched.filter((s) => s && fits(heard, s.lines));
  let stored = 0;
  for (const s of good) {
    if (stored >= STORE_PER_QUERY) break;
    if (await libraryStore(env, s.title, s.artist, s.lines)) stored++;
  }
  return json(request, env, { songs: good.map((s) => ({ key: s.key, title: s.title, artist: s.artist, lines: s.lines, source: 'genius', worship: !!s.worship })) });
}

async function title(request, env, url) {
  const heard = tokens(url.searchParams.get('q'));
  const alt = tokens(url.searchParams.get('alt'));
  const n = clampInt(url.searchParams.get('n'), 3, 1, 8);
  const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
  if (heard.length === 0) return json(request, env, { songs: [] });

  const known = (await libraryByTitle(env, heard)).filter((r) => !exclude.includes(r.key));
  if (known.length) return json(request, env, { songs: known.map((r) => songOut(r, 'library')) });
  if (Date.now() < geniusCoolUntil) return json(request, env, { songs: [], cooling: true });

  const [a, b] = await Promise.all([
    geniusSearch(env, heard.join(' ')),
    alt.length && alt.join(' ') !== heard.join(' ') ? geniusSearch(env, alt.join(' ')).catch(() => []) : [],
  ]);
  const candidates = dedupe(interleave(a, b), exclude).slice(0, n);
  const fetched = (await Promise.all(candidates.map((s) => lyricsFor(env, s)))).filter(Boolean);
  for (const s of fetched.slice(0, STORE_PER_QUERY + 1)) await libraryStore(env, s.title, s.artist, s.lines);
  return json(request, env, { songs: fetched.map((s) => ({ key: s.key, title: s.title, artist: s.artist, lines: s.lines, source: 'genius', worship: !!s.worship })) });
}

async function close(request, env, url) {
  const heard = tokens(url.searchParams.get('q'));
  const alt = tokens(url.searchParams.get('alt'));
  const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
  if (heard.length === 0) return json(request, env, { songs: [] });
  const [x, y] = await Promise.all([
    lrclibSearch(env, heard.join(' ')),
    alt.length && alt.join(' ') !== heard.join(' ') ? lrclibSearch(env, alt.join(' ')) : [],
  ]);
  const seen = new Set(exclude);
  const songs = [];
  for (const s of [...x, ...y]) {
    const key = songKey(s.title, s.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    songs.push({ key, title: s.title, artist: s.artist, lines: s.lines, source: 'lrclib' });
  }
  return json(request, env, { songs: songs.slice(0, 8) });
}

async function adminAdd(request, env) {
  if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
    return json(request, env, { error: 'forbidden' }, 403);
  }
  let body;
  try { body = await request.json(); } catch { return json(request, env, { error: 'bad json' }, 400); }
  const titleText = String(body?.title || '').trim();
  const artist = String(body?.artist || '').trim();
  if (!titleText) return json(request, env, { error: 'title needed' }, 400);

  let song = { title: titleText, artist };
  if (!artist) {
    // Titles only: let Genius say who sings it.
    const found = await geniusSearch(env, titleText, 3).catch(() => []);
    if (!found.length) return json(request, env, { ok: false, reason: 'not found' });
    song = found[0];
  }
  const lines = await lrclibLines(env, song);
  if (!lines) return json(request, env, { ok: false, reason: 'no lyrics', title: song.title, artist: song.artist });
  const stored = await libraryStore(env, song.title, song.artist, lines, true);
  return json(request, env, { ok: true, stored, title: song.title, artist: song.artist });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    const list = allowedOrigins(env);
    const origin = request.headers.get('Origin');
    if (origin && list.length && !list.includes(origin)) return json(request, env, { error: 'origin not allowed' }, 403);

    try {
      if (url.pathname === '/health') return json(request, env, { ok: true });
      if (url.pathname === '/admin/add' && request.method === 'POST') return await adminAdd(request, env);

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (limited(ip, Date.now())) return json(request, env, { error: 'slow down a little' }, 429, { 'Retry-After': '30' });

      if (request.method === 'GET') {
        if (url.pathname === '/find') return await find(request, env, url);
        if (url.pathname === '/title') return await title(request, env, url);
        if (url.pathname === '/close') return await close(request, env, url);
      }
      return json(request, env, { error: 'not found' }, 404);
    } catch (e) {
      return json(request, env, { error: 'lookup failed' }, 502);
    }
  },
};

export const _test = { resetLimits: () => { hits.clear(); geniusCoolUntil = 0; } };
