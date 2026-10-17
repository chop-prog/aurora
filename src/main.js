import { FluidSim } from './fluid.js';
import { DEFAULTS, PRESETS, LIMITS, mergeConfig, encodeConfig, decodeConfig } from './config.js';
import { paletteColor, hsvToRgb } from './color.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#canvas');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let cfg = location.hash.length > 1 ? decodeConfig(location.hash) : mergeConfig(DEFAULTS, reducedMotion ? { autopilot: false } : {});
let sim;
try {
  sim = new FluidSim(canvas);
} catch (err) {
  $('#fallback-reason').textContent = err.message;
  document.body.classList.add('no-webgl');
  throw err;
}

const SPLAT_FORCE = 6000;
const state = { paused: false, lastInput: performance.now(), fps: 60, slowFrames: 0, last: performance.now() };

// ── Pointers ──────────────────────────────────────────────────────────────────
const pointers = new Map();
const toUv = (e) => [e.clientX / canvas.clientWidth, 1 - e.clientY / canvas.clientHeight];

function trackPointer(e) {
  const [x, y] = toUv(e);
  let p = pointers.get(e.pointerId);
  if (!p) {
    p = { x, y, dx: 0, dy: 0, moved: false, color: paletteColor(cfg.palette), colorT: 0 };
    pointers.set(e.pointerId, p);
    return p;
  }
  const aspect = canvas.width / canvas.height;
  p.dx = (x - p.x) * (aspect < 1 ? aspect : 1);
  p.dy = (y - p.y) / (aspect > 1 ? aspect : 1);
  p.x = x;
  p.y = y;
  p.moved = Math.abs(p.dx) + Math.abs(p.dy) > 0;
  return p;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = trackPointer(e);
  const c = paletteColor(cfg.palette, Math.random, 1.2);
  sim.splat(p.x, p.y, (Math.random() - 0.5) * 600, (Math.random() - 0.5) * 600, c, cfg.splatRadius * 1.6);
  state.lastInput = performance.now();
});
canvas.addEventListener('pointermove', (e) => {
  // Mouse paints on hover; touch/pen paint while in contact.
  if (e.pointerType !== 'mouse' && e.pressure === 0) return;
  trackPointer(e);
  state.lastInput = performance.now();
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(ev, (e) => {
    if (e.pointerType !== 'mouse' || ev === 'pointerleave') pointers.delete(e.pointerId);
  });
}

// ── Effects ───────────────────────────────────────────────────────────────────
function splash(count = 5 + Math.floor(Math.random() * 15)) {
  for (let i = 0; i < count; i++) {
    const c = paletteColor(cfg.palette, Math.random, 1.5);
    sim.splat(Math.random(), Math.random(), 1000 * (Math.random() - 0.5), 1000 * (Math.random() - 0.5), c, cfg.splatRadius);
  }
}

// Idle "autopilot": two invisible brushes trace Lissajous curves so the page is never still.
let autoT = 0;
function autopilot(dt) {
  autoT += dt;
  for (let k = 0; k < 2; k++) {
    const t = autoT * 0.35 + k * Math.PI;
    const x = 0.5 + 0.32 * Math.sin(t * 1.3 + k);
    const y = 0.5 + 0.3 * Math.sin(t * 0.9);
    const vx = 0.32 * 1.3 * Math.cos(t * 1.3 + k);
    const vy = 0.3 * 0.9 * Math.cos(t * 0.9);
    const hue = (autoT * 0.03 + k * 0.5) % 1;
    const [r, g, b] = cfg.palette === 'neon' ? hsvToRgb(hue, 1, 1) : paletteColor(cfg.palette, () => (Math.sin(autoT * 0.2 + k * 2) + 1) / 2, 1);
    const s = 0.1;
    sim.splat(x, y, vx * 900, vy * 900, [r * s, g * s, b * s], cfg.splatRadius * 0.6);
  }
}

// ── Microphone-reactive mode ─────────────────────────────────────────────────
const mic = { on: false, analyser: null, data: null, stream: null, ctx: null, avg: 0, cooldown: 0 };
async function toggleMic(btn) {
  if (mic.on) {
    mic.stream.getTracks().forEach((t) => t.stop());
    mic.ctx.close();
    mic.on = false;
    btn.setAttribute('aria-pressed', 'false');
    toast('Microphone off');
    return;
  }
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.ctx = new AudioContext();
    mic.analyser = mic.ctx.createAnalyser();
    mic.analyser.fftSize = 512;
    mic.data = new Uint8Array(mic.analyser.frequencyBinCount);
    mic.ctx.createMediaStreamSource(mic.stream).connect(mic.analyser);
    mic.on = true;
    btn.setAttribute('aria-pressed', 'true');
    toast('Microphone on — make some noise');
  } catch {
    toast('Microphone permission was denied');
  }
}

function micStep(dt) {
  if (!mic.on) return;
  mic.analyser.getByteFrequencyData(mic.data);
  let bass = 0;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < mic.data.length; i++) {
    const v = mic.data[i] / 255;
    if (i < 12) bass += v;
    weighted += v * i;
    total += v;
  }
  bass /= 12;
  const centroid = total > 0 ? weighted / total / mic.data.length : 0;
  mic.avg += (bass - mic.avg) * Math.min(1, dt * 2);
  mic.cooldown -= dt;
  if (bass > 0.25 && bass > mic.avg * 1.3 && mic.cooldown <= 0) {
    mic.cooldown = 0.12;
    const n = 1 + Math.round(bass * 6);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = hsvToRgb(centroid * 3 + Math.random() * 0.1, 0.9, 1);
      const a = Math.random() * Math.PI * 2;
      const f = 800 * bass;
      sim.splat(0.5 + (Math.random() - 0.5) * 0.6, 0.5 + (Math.random() - 0.5) * 0.6, Math.cos(a) * f, Math.sin(a) * f, [r * bass, g * bass, b * bass], cfg.splatRadius);
    }
    state.lastInput = performance.now();
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function frame(now) {
  const elapsed = (now - state.last) / 1000;
  state.last = now;
  const dt = Math.min(elapsed, 1 / 60);
  if (elapsed > 0) state.fps += (1 / elapsed - state.fps) * 0.05;
  adaptQuality();
  sim.resize();

  for (const p of pointers.values()) {
    p.colorT += elapsed;
    if (p.colorT > 0.8) {
      p.colorT = 0;
      p.color = paletteColor(cfg.palette);
    }
    if (p.moved) {
      p.moved = false;
      sim.splat(p.x, p.y, p.dx * SPLAT_FORCE, p.dy * SPLAT_FORCE, p.color, cfg.splatRadius);
    }
  }
  if (!state.paused) {
    if (cfg.autopilot && now - state.lastInput > 3000) autopilot(dt);
    micStep(dt);
    sim.step(dt, cfg);
  }
  sim.render(cfg);
  updateStats(now);
  requestAnimationFrame(frame);
}

// Halve dye resolution (down to 256) if the GPU can't keep up.
function adaptQuality() {
  state.slowFrames = state.fps < 38 ? state.slowFrames + 1 : Math.max(0, state.slowFrames - 2);
  if (state.slowFrames > 120 && sim.dyeResolution > 256) {
    sim.setDyeResolution(sim.dyeResolution / 2);
    state.slowFrames = 0;
    toast(`Adaptive quality: dye ${sim.dyeResolution}px`);
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────
const form = $('#controls');
const fmt = (k, v) => (k === 'pressureIterations' ? String(v) : Number(v).toFixed(2));

function syncForm() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in cfg)) continue;
    if (el.type === 'checkbox') el.checked = cfg[el.name];
    else el.value = cfg[el.name];
    const out = form.querySelector(`output[for="${el.id}"]`);
    if (out) out.textContent = fmt(el.name, cfg[el.name]);
  }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const el = form.elements[k];
    if (el) el.style.setProperty('--fill', `${((cfg[k] - lo) / (hi - lo)) * 100}%`);
  }
}

let hashTimer = 0;
function persist() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = encodeConfig(cfg);
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }, 250);
}

form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  cfg = mergeConfig(cfg, { [el.name]: el.type === 'checkbox' ? el.checked : el.value });
  syncForm();
  persist();
});
form.addEventListener('submit', (e) => e.preventDefault());

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    cfg = mergeConfig(DEFAULTS, PRESETS[btn.dataset.preset]);
    syncForm();
    persist();
    sim.clear();
    splash(12);
    toast(`Preset: ${btn.textContent}`);
  });
}

const actions = {
  splash: () => splash(),
  clear: () => sim.clear(),
  pause: (btn) => {
    state.paused = !state.paused;
    btn.setAttribute('aria-pressed', String(state.paused));
    btn.textContent = state.paused ? 'Resume' : 'Pause';
  },
  mic: (btn) => toggleMic(btn),
  snapshot: () => {
    sim.render(cfg);
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `aurora-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  },
  share: async () => {
    const h = encodeConfig(cfg);
    const url = `${location.origin}${location.pathname}${h ? `#${h}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link with your settings copied');
    } catch {
      toast(url);
    }
  },
  hide: () => document.body.classList.toggle('ui-hidden'),
};
for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => actions[btn.dataset.action](btn));
}

$('#panel-toggle').addEventListener('click', (e) => {
  const open = document.body.classList.toggle('panel-open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

const about = $('#about');
$('#about-open').addEventListener('click', () => about.showModal());
$('#about-close').addEventListener('click', () => about.close());
about.addEventListener('click', (e) => {
  if (e.target === about) about.close();
});

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || about.open) return;
  const key = e.key.toLowerCase();
  if (key === ' ') { e.preventDefault(); actions.pause(document.querySelector('[data-action="pause"]')); }
  else if (key === 'r') splash();
  else if (key === 'c') sim.clear();
  else if (key === 'h') actions.hide();
  else if (['1', '2', '3', '4'].includes(key)) {
    cfg = mergeConfig(cfg, { display: ['dye', 'velocity', 'pressure', 'curl'][+key - 1] });
    syncForm();
    persist();
    toast(`View: ${cfg.display}`);
  }
});

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

let statsT = 0;
function updateStats(now) {
  if (now - statsT < 500) return;
  statsT = now;
  const s = sim.stats;
  $('#stat-fps').textContent = Math.round(state.fps);
  $('#stat-sim').textContent = s.sim;
  $('#stat-dye').textContent = s.dye;
}

if (innerWidth < 640) {
  document.body.classList.remove('panel-open');
  $('#panel-toggle').setAttribute('aria-expanded', 'false');
}
syncForm();
splash(reducedMotion ? 6 : 18);
requestAnimationFrame(frame);
window.aurora = { sim, get cfg() { return cfg; }, splash };
