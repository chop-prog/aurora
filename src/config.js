// Simulation settings: defaults, presets, validation and compact URL encoding so any
// configuration can be shared as a link. Pure module — no DOM, unit-tested.

export const DEFAULTS = Object.freeze({
  velocityDissipation: 0.2,
  densityDissipation: 1,
  curl: 30,
  splatRadius: 0.25,
  pressureIterations: 20,
  shading: true,
  autopilot: true,
  palette: 'aurora',
  display: 'dye',
});

export const PALETTES = ['aurora', 'neon', 'fire', 'ocean', 'mono'];
export const DISPLAY_MODES = ['dye', 'velocity', 'pressure', 'curl'];

/** [min, max] for numeric settings. */
export const LIMITS = Object.freeze({
  velocityDissipation: [0, 4],
  densityDissipation: [0, 4],
  curl: [0, 60],
  splatRadius: [0.02, 1],
  pressureIterations: [1, 80],
});

const ENUMS = { palette: PALETTES, display: DISPLAY_MODES };
const BOOLS = ['shading', 'autopilot'];

// Short keys keep shared URLs tidy: #c=45&pal=fire
const SHORT = {
  velocityDissipation: 'v',
  densityDissipation: 'd',
  curl: 'c',
  splatRadius: 'r',
  pressureIterations: 'p',
  shading: 's',
  autopilot: 'a',
  palette: 'pal',
  display: 'm',
};
const LONG = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, k]));

export const PRESETS = Object.freeze({
  calm: { velocityDissipation: 0.6, densityDissipation: 0.5, curl: 8, splatRadius: 0.35, palette: 'ocean' },
  storm: { velocityDissipation: 0.05, densityDissipation: 1.4, curl: 55, splatRadius: 0.18, palette: 'neon' },
  ink: { velocityDissipation: 0.9, densityDissipation: 0.05, curl: 2, splatRadius: 0.12, palette: 'mono', shading: false },
  inferno: { velocityDissipation: 0.15, densityDissipation: 2, curl: 40, splatRadius: 0.3, palette: 'fire' },
});

/** Coerce one raw value into a valid setting, or return undefined if it can't be. */
export function sanitize(key, raw) {
  if (key in LIMITS) {
    const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (!Number.isFinite(n)) return undefined;
    const [lo, hi] = LIMITS[key];
    const v = Math.min(hi, Math.max(lo, n));
    return key === 'pressureIterations' ? Math.round(v) : v;
  }
  if (key in ENUMS) return ENUMS[key].includes(raw) ? raw : undefined;
  if (BOOLS.includes(key)) {
    if (raw === true || raw === '1' || raw === 'true') return true;
    if (raw === false || raw === '0' || raw === 'false') return false;
    return undefined;
  }
  return undefined;
}

/** Merge a partial config onto a base, dropping anything invalid. */
export function mergeConfig(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    const clean = sanitize(k, v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

/** Serialise only the settings that differ from DEFAULTS. */
export function encodeConfig(cfg) {
  const params = new URLSearchParams();
  for (const [k, short] of Object.entries(SHORT)) {
    const v = cfg[k];
    if (v === undefined || v === DEFAULTS[k]) continue;
    if (typeof v === 'boolean') params.set(short, v ? '1' : '0');
    else if (typeof v === 'number') params.set(short, String(Math.round(v * 1000) / 1000));
    else params.set(short, v);
  }
  return params.toString();
}

export function decodeConfig(str) {
  const params = new URLSearchParams(String(str || '').replace(/^#/, ''));
  const patch = {};
  for (const [short, value] of params) if (LONG[short]) patch[LONG[short]] = value;
  return mergeConfig(DEFAULTS, patch);
}
