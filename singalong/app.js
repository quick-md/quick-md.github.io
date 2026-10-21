// Screens, settings and wiring. The thinking happens in engine.js.
import { Engine } from './engine.js';
import * as api from './api.js';
import { SpeechLoop, speechSupported } from './speech.js';
import { WhisperLoop, whisperSupported } from './whisper.js';
import { vocabularyFromText } from './vocab.js';

const ACCENTS = {
  violet: ['Violet', '#9B8CFF', '#FF6FB1', '#6A4DF0', '#E0368A'],
  rose: ['Rose', '#FF7FB5', '#FFA6C9', '#D6336F', '#F06595'],
  crimson: ['Crimson', '#FF6B6B', '#FF8A5C', '#C62828', '#E4572E'],
  amber: ['Amber', '#FFB020', '#FFD166', '#C77700', '#E0A100'],
  forest: ['Forest', '#6EE08E', '#B5E86B', '#1C9650', '#6A9A0E'],
  teal: ['Teal', '#3FD8D0', '#6EE7E0', '#00838F', '#0AA3A3'],
  ocean: ['Ocean', '#5E9BFF', '#8CB8FF', '#1565D8', '#3D8BEA'],
  graphite: ['Graphite', '#D0D6E2', '#93A0B8', '#455A64', '#78909C'],
};
const SIZES = { S: 21, M: 26, L: 32, XL: 40 };

const store = {
  get: (k) => { try { return localStorage.getItem('sa.' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('sa.' + k, v); } catch { /* private mode */ } },
};

const settings = {
  theme: store.get('theme') || 'auto',
  accent: ACCENTS[store.get('accent')] ? store.get('accent') : 'violet',
  size: SIZES[store.get('size')] ? store.get('size') : 'M',
  showHeard: store.get('showHeard') === '1', // off unless switched on
  engine: store.get('engine') === 'browser' || !whisperSupported() ? 'browser' : 'whisper',
};
let settingsOpen = false;
let vocab = null;

const engine = new Engine({
  api,
  makeSpeech: (h) => (settings.engine === 'whisper' ? new WhisperLoop(h) : new SpeechLoop(h)),
  vocab: () => vocab,
  store,
});
engine.showHeardLive = settings.showHeard;

fetch('words.txt').then((r) => r.text()).then((t) => { vocab = vocabularyFromText(t); }).catch(() => {});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- look ----
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyLook() {
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkMq.matches);
  const root = document.documentElement;
  root.dataset.mode = dark ? 'dark' : 'light';
  const [, da, db, la, lb] = ACCENTS[settings.accent];
  root.style.setProperty('--a', dark ? da : la);
  root.style.setProperty('--b', dark ? db : lb);
  root.style.setProperty('--lyric', SIZES[settings.size] + 'px');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#15113A' : '#EFEAFF');
}
darkMq.addEventListener?.('change', () => { applyLook(); });

// ---- wake lock (keeps the screen on while singing) ----
let wake = null;
async function keepAwake() {
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && engine.speech) keepAwake(); });

// ---- rendering ----
const app = document.getElementById('app');
let lastPhase = null;
let lastLyricsKey = null;

function topBar(s) {
  const lyricsMode = engine.mode === 'lyrics';
  return `<div class="top">
    <button class="burger" data-act="settings" aria-label="Settings"><span></span></button>
    <div class="seg" role="group" aria-label="Search mode">
      <button data-act="mode" data-v="lyrics" aria-pressed="${lyricsMode}">Lyrics</button>
      <button data-act="mode" data-v="title" aria-pressed="${!lyricsMode}">Title</button>
    </div>
    <div style="width:48px"></div>
  </div>`;
}

function body(s) {
  switch (s.phase) {
    case 'idle':
      return `<main><div class="center">
        <h1>SingAlong</h1>
        <p class="muted">${engine.mode === 'title' ? 'Say a song title and the lyrics appear.' : 'Sing a line or two and the lyrics appear, then follow you.'}</p>
        ${speechSupported() ? '<button class="big" data-act="start">Start listening</button>'
          : '<p class="err">This browser can’t listen to speech. Try Chrome, Edge or Safari.</p>'}
        <p class="note">Your browser will ask to use the microphone.</p>
      </div></main>`;
    case 'listening':
      return `<main><div class="center">
        <div class="bars" aria-hidden="true"><b></b><b></b><b></b><b></b><b></b></div>
        ${s.modelProgress != null ? `<p style="margin:0;font-size:20px">Getting the speech model ready… ${Math.round(s.modelProgress * 100)}%</p><p class="note" style="margin:0">One-time download. After this it starts in a few seconds.</p>` : ''}
        ${s.isHint && !settings.showHeard ? '' : `<p class="${s.isHint ? 'muted' : ''}" style="margin:0;font-size:21px">${esc(s.status)}</p>`}
        ${settings.showHeard ? `<div class="heard">${esc(s.heard)}</div>` : ''}
      </div></main>`;
    case 'suggesting':
      return `<main><div class="center" style="max-width:none;width:100%">
        <p style="margin:0;font-size:21px">Did you mean one of these?</p>
        <div class="opts">${s.options.map((o, i) => `<button class="opt" data-act="pick" data-i="${i}"><b>${esc(o.title)}</b><span>${esc(o.artist)}</span></button>`).join('')}</div>
        <button class="ghost" data-act="another">Try again</button>
      </div></main>`;
    case 'singing': {
      const L = s.lyrics;
      return `<main>
        <div class="song-head"><h2>${esc(L.title)}</h2><div class="muted">${esc(L.artist)}</div></div>
        <div class="lyrics" id="lyrics">${L.lines.map((l, i) => `<p data-i="${i}" class="${i === s.line ? 'now' : i < s.line ? 'done' : ''}">${esc(l)}</p>`).join('')}</div>
        <div class="dock">
          ${settings.showHeard && s.heard ? `<div class="heard-live">${esc(s.heard)}</div>` : ''}
          <div class="row">
            ${s.canDismiss ? '<button class="wrong" data-act="wrong">Wrong song?</button>' : ''}
            <button class="ghost" data-act="another">New song</button>
          </div>
        </div>
      </main>`;
    }
    case 'error':
      return `<main><div class="center"><h1>Hmm.</h1><p class="err">${esc(s.error)}</p><button class="big" data-act="retry">Try again</button>${settings.engine === 'whisper' && speechSupported() ? '<button class="ghost" data-act="useBrowser">Use browser speech instead</button>' : ''}</div></main>`;
    default:
      return '';
  }
}

function settingsPanel() {
  if (!settingsOpen) return '';
  const seg = (name, items, cur) => `<div class="seg">${items.map(([v, label]) => `<button data-act="${name}" data-v="${v}" aria-pressed="${cur === v}">${label}</button>`).join('')}</div>`;
  return `<div class="scrim" data-act="closeSettings"><div class="panel" role="dialog" aria-label="Settings">
    <h3>Settings <button class="x" data-act="closeSettings" aria-label="Close">×</button></h3>
    <div><label class="t">Theme</label>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], settings.theme)}</div>
    <div><label class="t">Colour</label><div class="swatches">${Object.entries(ACCENTS).map(([k, v]) =>
      `<button class="sw" data-act="accent" data-v="${k}" aria-label="${v[0]}" aria-pressed="${settings.accent === k}" style="background:linear-gradient(135deg,${v[3]},${v[4]})"></button>`).join('')}</div></div>
    <div><label class="t">Lyric size</label>${seg('size', [['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL']], settings.size)}</div>
    <div><label class="t">Speech engine</label>${seg('engine', [['whisper', 'Whisper'], ['browser', 'Browser']], settings.engine)}
      <div class="note" style="margin-top:8px">${settings.engine === 'whisper' ? 'Better over a guitar or music. First use downloads a model.' : 'Quick and light, but struggles over background music.'}${engine.state.info ? `<br>${esc(engine.state.info)}` : ''}</div></div>
    <div class="toggle"><div><b>Worship songs only</b><div class="note">Only suggests worship songs, in both Lyrics and Title mode.</div></div>
      <button data-act="worship" aria-pressed="${engine.worship}" aria-label="Worship songs only"></button></div>
    <div class="toggle"><div><b>Show what I sing</b><div class="note">Shows the words as they’re heard, and the “sing a line or two” prompt.</div></div>
      <button data-act="showHeard" aria-pressed="${settings.showHeard}" aria-label="Show heard words"></button></div>
  </div></div>`;
}

function render() {
  const s = engine.state;
  const keepScroll = s.phase === 'singing' && lastPhase === 'singing' && s.lyrics?.key === lastLyricsKey;
  if (keepScroll) {
    // Only the highlight changed: update classes in place so scrolling stays smooth.
    const ps = app.querySelectorAll('#lyrics p');
    ps.forEach((p, i) => { p.className = i === s.line ? 'now' : i < s.line ? 'done' : ''; });
    const dock = app.querySelector('.dock');
    if (dock) dock.outerHTML = dockHtml(s);
    ps[s.line]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    app.innerHTML = topBar(s) + body(s) + settingsPanel();
    if (s.phase === 'singing') app.querySelector(`#lyrics p[data-i="${s.line}"]`)?.scrollIntoView({ block: 'center' });
  }
  if (keepScroll && settingsOpen !== !!app.querySelector('.scrim')) {
    app.querySelector('.scrim')?.remove();
    app.insertAdjacentHTML('beforeend', settingsPanel());
  }
  lastPhase = s.phase;
  lastLyricsKey = s.lyrics?.key ?? null;
}

function dockHtml(s) {
  return `<div class="dock">
    ${settings.showHeard && s.heard ? `<div class="heard-live">${esc(s.heard)}</div>` : ''}
    <div class="row">
      ${s.canDismiss ? '<button class="wrong" data-act="wrong">Wrong song?</button>' : ''}
      <button class="ghost" data-act="another">New song</button>
    </div></div>`;
}

engine.subscribe(render);

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const v = el.dataset.v;
  if (act === 'closeSettings' && e.target.closest('.panel') && el.classList.contains('scrim')) return;
  switch (act) {
    case 'start': keepAwake(); engine.start(); break;
    case 'retry': keepAwake(); engine.retry(); break;
    case 'mode': engine.setMode(v); break;
    case 'worship': engine.setWorship(!engine.worship); break;
    case 'wrong': engine.dismissWrongSong(); break;
    case 'another': engine.listenForAnother(); break;
    case 'pick': engine.chooseSuggestion(engine.state.options[Number(el.dataset.i)]); break;
    case 'settings': settingsOpen = true; render(); return;
    case 'closeSettings': settingsOpen = false; render(); return;
    case 'theme': settings.theme = v; store.set('theme', v); applyLook(); break;
    case 'accent': settings.accent = v; store.set('accent', v); applyLook(); break;
    case 'engine': if (v === 'whisper' && !whisperSupported()) break; settings.engine = v; store.set('engine', v); engine.restartSpeech(); break;
    case 'useBrowser': settings.engine = 'browser'; store.set('engine', 'browser'); keepAwake(); engine.retry(); break;
    case 'size': settings.size = v; store.set('size', v); applyLook(); break;
    case 'showHeard': settings.showHeard = !settings.showHeard; engine.showHeardLive = settings.showHeard; store.set('showHeard', settings.showHeard ? '1' : '0'); break;
  }
  lastLyricsKey = null; // a settings or button change: redraw fully
  render();
});

applyLook();
render();
window.__engine = engine; // handy for debugging in the console
