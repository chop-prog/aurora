import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, LIMITS, sanitize, mergeConfig, encodeConfig, decodeConfig } from '../src/config.js';

test('defaults encode to an empty string (clean URLs)', () => {
  assert.equal(encodeConfig(DEFAULTS), '');
  assert.deepEqual(decodeConfig(''), { ...DEFAULTS });
});

test('round-trips every preset through the URL', () => {
  for (const preset of Object.values(PRESETS)) {
    const cfg = mergeConfig(DEFAULTS, preset);
    assert.deepEqual(decodeConfig(`#${encodeConfig(cfg)}`), cfg);
  }
});

test('uses short keys', () => {
  const s = encodeConfig(mergeConfig(DEFAULTS, { curl: 45, palette: 'fire', shading: false }));
  assert.equal(s, 'c=45&s=0&pal=fire');
});

test('clamps numbers and rounds iterations', () => {
  assert.equal(sanitize('curl', '999'), LIMITS.curl[1]);
  assert.equal(sanitize('splatRadius', -5), LIMITS.splatRadius[0]);
  assert.equal(sanitize('pressureIterations', '12.7'), 13);
});

test('rejects garbage instead of propagating NaN', () => {
  const cfg = decodeConfig('c=abc&pal=rainbow&s=maybe&m=velocity&zzz=1&v=1e400');
  assert.equal(cfg.curl, DEFAULTS.curl);
  assert.equal(cfg.palette, DEFAULTS.palette);
  assert.equal(cfg.shading, DEFAULTS.shading);
  assert.equal(cfg.display, 'velocity');
  assert.equal(cfg.velocityDissipation, DEFAULTS.velocityDissipation);
  assert.ok(!('zzz' in cfg));
});

test('mergeConfig never mutates its inputs', () => {
  const base = { ...DEFAULTS };
  mergeConfig(base, { curl: 1 });
  assert.deepEqual(base, { ...DEFAULTS });
  assert.ok(Object.isFrozen(DEFAULTS));
});
