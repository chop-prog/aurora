import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsvToRgb, paletteColor, paletteNames } from '../src/color.js';

const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));

test('hsvToRgb hits the primaries', () => {
  close(hsvToRgb(0, 1, 1), [1, 0, 0]);
  close(hsvToRgb(1 / 3, 1, 1), [0, 1, 0]);
  close(hsvToRgb(2 / 3, 1, 1), [0, 0, 1]);
  close(hsvToRgb(0.5, 0, 0.4), [0.4, 0.4, 0.4]);
});

test('hue wraps around', () => {
  close(hsvToRgb(1.25, 1, 1), hsvToRgb(0.25, 1, 1));
  close(hsvToRgb(-0.75, 1, 1), hsvToRgb(0.25, 1, 1));
});

test('palette colours stay in range and respect intensity', () => {
  for (const name of paletteNames) {
    for (let i = 0; i < 200; i++) {
      const c = paletteColor(name, Math.random, 0.15);
      for (const v of c) assert.ok(v >= 0 && v <= 0.15 + 1e-9, `${name}: ${c}`);
    }
  }
});

test('fire is warm and mono is grey', () => {
  for (let i = 0; i < 100; i++) {
    const [r, g, b] = paletteColor('fire', Math.random, 1);
    assert.ok(r >= g && g >= b, 'fire should be red-dominant');
    const [x, y, z] = paletteColor('mono', Math.random, 1);
    assert.ok(x === y && y === z);
  }
});
