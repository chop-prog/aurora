// Colour helpers for dye splats. Pure functions — unit-tested.

/** HSV (all 0..1) → linear RGB triple (0..1). */
export function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// Each palette maps a random number in [0,1) to [hue, saturation].
const PALETTE_FN = {
  aurora: (r) => [r < 0.65 ? 0.33 + r * 0.33 : 0.72 + (r - 0.65) * 0.5, 0.85],
  neon: (r) => [r, 1],
  fire: (r) => [r * 0.13, 0.95],
  ocean: (r) => [0.5 + r * 0.17, 0.9],
  mono: () => [0, 0],
};

/**
 * Random splat colour from a palette, pre-scaled to the intensity the
 * simulation expects (dye accumulates, so splats are deliberately dim).
 */
export function paletteColor(name, rand = Math.random, intensity = 0.15) {
  const fn = PALETTE_FN[name] || PALETTE_FN.neon;
  const [h, s] = fn(rand());
  const [r, g, b] = hsvToRgb(h, s, 1);
  return [r * intensity, g * intensity, b * intensity];
}

export const paletteNames = Object.keys(PALETTE_FN);
