/**
 * props/signageTexture.js — the one signage atlas, shared. Owner: props agent.
 *
 * `props/signage.js` is deliberately free of imports so the atlas can be drawn and
 * inspected outside the engine. This module is the thin three.js side of it: it draws
 * the canvas exactly once per session and hands the same `CanvasTexture` to everybody
 * who wants lettering — the prop palette (shop signs, shutters, wall marks, road
 * paint) and the level palette (the building-mounted fascia boards).
 *
 * Sharing matters twice over: one 1024² upload instead of two, and — because the
 * texture is the expensive part, not the material — the two consumers can still have
 * their own material (props do not carry the level's vertex-AO attribute, and the
 * level's does not want polygon offset).
 */
import * as THREE from 'three';
import { signageLayout, drawSignageAtlas } from './signage.js';

let cached = null;

/**
 * @param {object} ctx engine context, for the seeded RNG and the anisotropy cap
 * @returns {{layout: object, texture: THREE.Texture|null}}
 */
export function signageAtlas(ctx) {
  if (cached) return cached;
  const layout = signageLayout();
  let texture = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = layout.W;
    canvas.height = layout.H;
    const g = canvas.getContext('2d');
    if (g) {
      // Deterministic: seeded, never Math.random(), so two runs draw the same wear.
      let s = (0x5164a7 ^ Math.floor((ctx?.rng ? ctx.rng() : 0.5) * 0xffffff)) >>> 0;
      const rnd = () => {
        s = (Math.imul(s ^ (s >>> 15), s | 1) ^ (s + Math.imul(s ^ (s >>> 7), s | 61))) >>> 0;
        return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
      };
      drawSignageAtlas(g, layout, rnd);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = Math.min(8, ctx?.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
      texture.needsUpdate = true;
    }
  } catch (err) {
    console.warn('[signage] atlas failed', err?.message || err);
  }
  cached = { layout, texture };
  return cached;
}

export function disposeSignageAtlas() {
  try {
    cached?.texture?.dispose?.();
  } catch {
    /* best effort */
  }
  cached = null;
}

export default signageAtlas;
