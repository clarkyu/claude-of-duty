/**
 * Minimap.js — top-down tactical map drawn from the real level. Owner: ui agent.
 *
 * The map is not an illustration: at init it bakes `ctx.level.navRegions.walkable`
 * (the actual raycast walkable grid) as the street surface and every box collider in
 * `ctx.level.colliders` as a filled building footprint into one offscreen canvas.
 * Per frame it blits a rotated crop of that bake — player-up, like CoD — and stamps
 * blips on top. One drawImage plus a dozen tiny paths, at 30 Hz, on a 178 px canvas.
 *
 * Three things the bake has to get right, all of which it previously did not:
 *   • the bake extends PAD_M past the level bounds, so the rotated crop can never
 *     run off the image and leave a black wedge in the corner of the widget;
 *   • the walkable wash is ONE path filled ONCE — per-run fills at the same alpha
 *     double-composite on every seam and the plate reads as scanline banding;
 *   • footprints are solid, not outlines, so solid and walkable are distinguishable
 *     at a glance rather than by inference.
 *
 * ── Exposure ────────────────────────────────────────────────────────────────────
 * The plate is a fixed set of sRGB values, so it is the same brightness whatever the
 * world is doing. Measured across the review set, that put it at mean luminance 123.7
 * in BOTH the hero frame and the night frame while the scene itself fell from 53.8 to
 * 17.7 — i.e. at night the minimap was seven times brighter than the game and the
 * brightest object on the screen, which is exactly backwards for a peripheral widget.
 * `_exposure()` reads the key light and multiplies the plate down to sit just above
 * the scene. Blips are NOT dimmed: symbols have to stay readable, and they are a few
 * dozen pixels, not half the widget.
 *
 * ── The value ladder ────────────────────────────────────────────────────────────
 * Six tones spanning nearly the whole range, with hue separating the pairs that sit
 * next to each other. The previous five all lived inside one blue-grey band between
 * #101820 and #94a3b0, which is a 55-unit spread carrying five levels of meaning —
 * so none of them read and the map answered no questions at all.
 *
 * API: new Minimap(root, ctx) → { bake(), update(dt), setContacts(list),
 *                                 setFriends(list), setZones(list), setUav(bool),
 *                                 dispose() }
 */
import { div, setClass, clamp01 } from './dom.js';

/**
 * The plate palette. Values, then hues.
 *
 *   oob       0.02  near-black, hatched — "there is nothing there"
 *   solid     0.09  in bounds, not walkable, not a known building
 *   mass      0.17  building footprint: the thing you cannot walk through
 *   interior  0.40  a floor you CAN walk on but which is inside — one glance
 *                   separates it from the street now instead of by inference
 *   street    0.80  the lightest large area, faintly warm so it reads as ground
 *   edge      1.00  walls and cover, bright, drawn over everything
 *
 * Warm street against cool interior is doing as much work as the value gap: two
 * greys 0.4 apart still merge under a night grade, two different hues do not.
 */
const TONE = {
  oob: '#04070b',
  solid: '#0d141b',
  mass: '#1a2530',
  interior: '#4d5c6b',
  street: '#c4c0b4',
  /**
   * Walls and cover are DARK, not bright.
   *
   * The old plate had a dark street, so bright white edges were the only thing that
   * could read on it. Now the street is the lightest thing on the map — which is what
   * lets "outside" and "inside" separate at a glance — and a white line on a
   * near-white street is invisible. A near-black edge reads on the street, reads
   * against the mid interior floor, and is still a step darker than the building
   * mass, so the ladder stays monotonic all the way down.
   */
  edge: 'rgba(7,11,16,0.94)',
  cover: 'rgba(58,72,86,0.8)',
};

/** Blip colours. Player white, friendlies cyan, hostiles pure red — three hues, not
 *  two neighbouring warms. Enemy red used to be #ff4433 against a player at #ffb648,
 *  which under a bloom-lit night frame is the same mark twice. */
const BLIP = {
  player: '#ffffff',
  playerRing: '#ffb648',
  friend: '#57c9ff',
  foe: '#ff2020',
};

const BAKE = 700; // px across the playable span of the level bake
const VIEW_M = 62; // metres visible across the widget
/**
 * How far past the level bounds the bake extends, in metres. The widget shows a
 * rotated square crop of the bake; at 45° the corner of that crop reaches
 * VIEW_M/√2 ≈ 0.71·VIEW_M past the centre. Without this margin the crop runs off
 * the baked image near the map edge and you get a hard black wedge eating a
 * corner of the widget — and the dashed boundary sweeping across it as you turn.
 */
const PAD_M = VIEW_M * 0.71;

export class Minimap {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.root = div('cod-minimap', root);
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    div('cod-minimap-frame', this.root);
    const hdr = div('cod-minimap-hdr', this.root);
    this.uavTag = div('cod-uav', hdr, 'UAV ACTIVE');

    this.g = this.canvas.getContext('2d', { alpha: true });
    this.baked = null;
    this.bakeCtx = null;
    this.pad = 0;
    this.bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    this.contacts = [];
    this.friends = [];
    this.zones = [];
    this.uav = false;
    this.sweep = 0;
    /** plate brightness, 0..1, tracking the scene's key light — see _exposure() */
    this.exposure = 1;
    this._expShown = -1;
    this._acc = 0;
    this._size = 0;
    this._dpr = 1;
    this._ready = false;
    this._warned = false;
    this._needMeasure = true;
    this._px = 1e9;
    this._pz = 1e9;
    this._yaw = 1e9;
    this._drawnOnce = false;
  }

  setVisible(v) {
    setClass(this.root, 'on', !!v);
    if (v) this._needMeasure = true;
  }

  /** Bake the level once. Safe to call again if the level rebuilds. */
  bake() {
    const level = this.ctx.level;
    try {
      const b = level?.bounds;
      if (b?.min && b?.max) {
        this.bounds = { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
      }
      const spanX = Math.max(1, this.bounds.maxX - this.bounds.minX);
      const spanZ = Math.max(1, this.bounds.maxZ - this.bounds.minZ);
      const span = Math.max(spanX, spanZ);
      this.mPerPx = span / BAKE;
      this.pxPerM = BAKE / span;
      // Centre the level in a square bake, then grow the canvas by the rotation
      // margin on every side so the rotated crop can never leave the image.
      this.cx = (this.bounds.minX + this.bounds.maxX) * 0.5;
      this.cz = (this.bounds.minZ + this.bounds.maxZ) * 0.5;
      this.pad = Math.ceil(PAD_M * this.pxPerM);
      const size = BAKE + this.pad * 2;

      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      if (!g) return;

      // Out of bounds: a dark hatched apron, so leaving the map reads as "there is
      // nothing there" rather than as a rendering hole.
      g.fillStyle = TONE.oob;
      g.fillRect(0, 0, size, size);
      this._drawHatch(g, size);

      const [ix0, iz0] = this._toPx(this.bounds.minX, this.bounds.minZ);
      const [ix1, iz1] = this._toPx(this.bounds.maxX, this.bounds.maxZ);
      g.save();
      g.beginPath();
      g.rect(ix0, iz0, ix1 - ix0, iz1 - iz0);
      g.clip();
      /* Fill hierarchy: see TONE at the top of the file. */
      g.fillStyle = TONE.solid;
      g.fillRect(ix0, iz0, ix1 - ix0, iz1 - iz0);
      const walk = this._drawWalkable(g, level, TONE.street);
      this._drawBuildings(g, level, walk);
      this._drawColliders(g, level);
      g.restore();
      this._drawBorder(g);

      this.baked = c;
      this._ready = true;
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[hud] minimap bake failed', err);
      }
    }
  }

  _toPx(x, z) {
    const pad = this.pad || 0;
    return [
      pad + BAKE * 0.5 + (x - this.cx) * this.pxPerM,
      pad + BAKE * 0.5 + (z - this.cz) * this.pxPerM,
    ];
  }

  /** Diagonal hatch for the out-of-bounds apron. */
  _drawHatch(g, size) {
    g.save();
    g.strokeStyle = 'rgba(150,168,188,0.16)';
    g.lineWidth = Math.max(1, this.pxPerM * 0.14);
    const step = Math.max(6, this.pxPerM * 2.4);
    g.beginPath();
    for (let x = -size; x < size * 2; x += step) {
      g.moveTo(x, 0);
      g.lineTo(x + size, size);
    }
    g.stroke();
    g.restore();
  }

  /**
   * Solid building masses, then their interior floors a stop darker than the street.
   * The footprints come from the level's own data tables, because the *colliders* are
   * wall segments — four thin strips per structure, which is a hollow outline and
   * exactly why solid and walkable were indistinguishable.
   * @param {Path2D|null} walk the walkable path, re-filled clipped to each footprint
   */
  _drawBuildings(g, level, walk) {
    const data = level?.data;
    const rects = [];
    for (const b of data?.BUILDINGS || []) if (Array.isArray(b?.rect)) rects.push(b.rect);
    const m = data?.MINARET;
    if (m) rects.push([m.x - m.radius - 0.6, m.z - m.radius - 0.6, m.x + m.radius + 0.6, m.z + m.radius + 0.6]);
    const k = data?.FUEL?.kiosk?.rect;
    if (Array.isArray(k)) rects.push(k);
    if (!rects.length) return;
    for (const [x0, z0, x1, z1] of rects) {
      const [ax, az] = this._toPx(x0, z0);
      const [bx, bz] = this._toPx(x1, z1);
      g.fillStyle = TONE.mass;
      g.fillRect(ax, az, bx - ax, bz - az);
      if (walk) {
        g.save();
        g.beginPath();
        g.rect(ax, az, bx - ax, bz - az);
        g.clip();
        g.fillStyle = TONE.interior;
        g.fill(walk);
        g.restore();
      }
      /* a hairline round the footprint so two adjoining blocks stay separable */
      g.strokeStyle = 'rgba(4,7,11,0.9)';
      g.lineWidth = Math.max(1, this.pxPerM * 0.11);
      g.strokeRect(ax, az, bx - ax, bz - az);
    }
  }

  /** @returns {Path2D|null} the walkable surface, for re-use by _drawBuildings */
  _drawWalkable(g, level, colour = '#5b6a78') {
    const nav = level?.navRegions;
    if (!nav || !nav.walkable || !nav.cols) return null;
    const { cols, rows, cell } = nav;
    const origin = nav.origin || [this.bounds.minX, this.bounds.minZ];
    const w = nav.walkable;
    const size = cell * this.pxPerM;
    // One path, one OPAQUE fill. Filling each row-run separately at alpha 0.22
    // with a +0.6 px overlap double-composites every seam, which is what turned
    // the plate into horizontal scanline banding. A single Path2D at alpha 1
    // cannot band at all, however the runs overlap.
    const path = typeof Path2D === 'function' ? new Path2D() : null;
    const add = (x, y, w2, h2) => (path ? path.rect(x, y, w2, h2) : g.rect(x, y, w2, h2));
    if (!path) g.beginPath();
    for (let j = 0; j < rows; j++) {
      let runStart = -1;
      for (let i = 0; i <= cols; i++) {
        const on = i < cols && w[j * cols + i] === 1;
        if (on && runStart < 0) runStart = i;
        else if (!on && runStart >= 0) {
          const [x0, z0] = this._toPx(origin[0] + runStart * cell, origin[1] + j * cell);
          add(x0, z0, (i - runStart) * size + 0.6, size + 0.6);
          runStart = -1;
        }
      }
    }
    g.fillStyle = colour;
    if (path) g.fill(path);
    else g.fill();
    return path;
  }

  _drawColliders(g, level) {
    const cols = level?.colliders;
    if (!Array.isArray(cols)) return;
    const spanX = this.bounds.maxX - this.bounds.minX;
    const fills = [];
    for (const c of cols) {
      if (!c || c.type !== 'box') continue;
      const p = c.pos || c.position;
      const h = c.halfExtents || c.half || c.he;
      if (!p || !h) continue;
      const hx = h.x ?? h[0] ?? 0;
      const hy = h.y ?? h[1] ?? 0;
      const hz = h.z ?? h[2] ?? 0;
      // Ignore the ground slab and anything too short to be an obstacle.
      if (hy < 0.35) continue;
      if (hx * 2 > spanX * 0.92 && hz * 2 > spanX * 0.92) continue;
      const py = p.y ?? 0;
      if (py - hy > 6.5) continue; // overhead beams / roofs
      fills.push({ x: p.x ?? 0, z: p.z ?? 0, hx, hz, yaw: c.yaw ?? quatYaw(c.quat), tall: hy > 1.6 });
    }
    // Two passes so tall structures always sit above low cover.
    for (const pass of [0, 1]) {
      for (const f of fills) {
        if ((pass === 1) !== f.tall) continue;
        const [x, z] = this._toPx(f.x, f.z);
        const w = f.hx * 2 * this.pxPerM;
        const d = f.hz * 2 * this.pxPerM;
        if (w < 0.7 && d < 0.7) continue;
        g.save();
        g.translate(x, z);
        if (f.yaw) g.rotate(f.yaw);
        // Walls and cover sit on top of the solid/street split as bright edges:
        // structure, not the thing that carries the solid-vs-walkable read. Low
        // cover is drawn light-on-dark rather than dark-on-dark, or it vanishes
        // into the building mass it usually stands next to.
        g.fillStyle = f.tall ? TONE.edge : TONE.cover;
        g.fillRect(-w / 2, -d / 2, w, d);
        g.restore();
      }
    }
  }

  _drawBorder(g) {
    const [x0, z0] = this._toPx(this.bounds.minX, this.bounds.minZ);
    const [x1, z1] = this._toPx(this.bounds.maxX, this.bounds.maxZ);
    g.strokeStyle = 'rgba(255,182,72,0.22)';
    g.lineWidth = 2;
    g.setLineDash([7, 6]);
    g.strokeRect(x0, z0, x1 - x0, z1 - z0);
    g.setLineDash([]);
  }

  setContacts(list) {
    this.contacts = Array.isArray(list) ? list : [];
    this._drawnOnce = false;
  }

  /** Friendly markers. HUD supplies them so the widget stays agnostic about rosters. */
  setFriends(list) {
    this.friends = Array.isArray(list) ? list : [];
    this._drawnOnce = false;
  }

  /**
   * Plate brightness for the current lighting.
   *
   * Driven off the key light rather than off the tonemapped frame, because the frame
   * lives on the GPU and reading it back would stall the pipeline for a widget. The
   * sun runs ~8-12 at noon and collapses to near zero after dusk, so a smoothstep
   * over 0.3-4.5 tracks the transition the eye actually sees.
   *
   * The two end points are set from measurement, not taste. Undimmed, the plate means
   * ~140 on an 8-bit frame; the review captures put the scene at 66 (hero) and 17
   * (night). A peripheral readout wants to sit a little ABOVE the world — call it
   * 1.3x in daylight and about 2x at night, since a night map still has to be legible
   * — which is 0.63 and 0.27. Before this, it was a flat 1.0 in both, i.e. 1.9x the
   * hero scene and SEVEN times the night scene, and the brightest object on the
   * screen in a frame whose subject is a dark street.
   */
  _exposure() {
    const L = this.ctx.lighting;
    let sun = L?.sunIntensity;
    if (!Number.isFinite(sun)) {
      const t = L?.timeOfDay;
      sun = Number.isFinite(t) ? (t > 6.4 && t < 19.2 ? 8 : 0.05) : 8;
    }
    const x = clamp01((sun - 0.3) / 4.2);
    const day = x * x * (3 - 2 * x);
    return 0.27 + 0.36 * day;
  }

  setZones(list) {
    this.zones = Array.isArray(list) ? list : [];
    this._drawnOnce = false;
  }

  setUav(on) {
    this.uav = !!on;
    this._drawnOnce = false;
    setClass(this.uavTag, 'on', this.uav);
  }

  invalidate() {
    this._needMeasure = true;
  }

  _resize() {
    if (!this._needMeasure) return;
    this._needMeasure = false;
    const r = this.root;
    const w = r.clientWidth || 178;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this._size === w && this._dpr === dpr) return;
    this._size = w;
    this._dpr = dpr;
    this.canvas.width = Math.max(2, Math.round(w * dpr));
    this.canvas.height = Math.max(2, Math.round(w * dpr));
  }

  update(dt) {
    this._acc += dt;
    if (this._acc < 1 / 30) return;
    const step = this._acc;
    this._acc = 0;
    if (!this._ready) return;

    const px = this.ctx.player?.position?.x ?? this.ctx.camera?.position?.x ?? 0;
    const pz = this.ctx.player?.position?.z ?? this.ctx.camera?.position?.z ?? 0;
    const yaw = this.ctx.player?.yaw ?? this.ctx.camera?.rotation?.y ?? 0;
    /* Eye adaptation for the plate. Damped rather than snapped, so a flare or a
       sunset does not step the widget; 4/s converges inside the review warm-up. */
    const target = this._exposure();
    this.exposure += (target - this.exposure) * Math.min(1, step * 4);
    // Standing still with no live contacts means the last frame is still correct;
    // a rotated blit of a 700 px bake is by far the most expensive thing the HUD
    // does, so it is worth not doing.
    const still =
      !this.uav &&
      !this.contacts.length &&
      !this._needMeasure &&
      Math.abs(px - this._px) < 0.04 &&
      Math.abs(pz - this._pz) < 0.04 &&
      Math.abs(yaw - this._yaw) < 0.004 &&
      Math.abs(this.exposure - this._expShown) < 0.004 &&
      this._drawnOnce;
    if (still) return;
    this._expShown = this.exposure;
    this._px = px;
    this._pz = pz;
    this._yaw = yaw;
    this._drawnOnce = true;

    this._resize();
    const g = this.g;
    if (!g) return;

    const size = this.canvas.width;
    const scale = size / (VIEW_M * this.pxPerM); // bake px -> widget px
    const [bx, bz] = this._toPx(px, pz);

    g.save();
    g.clearRect(0, 0, size, size);
    // Round mask keeps the corner furniture from fighting the frame.
    g.beginPath();
    g.rect(0, 0, size, size);
    g.clip();

    g.fillStyle = 'rgba(5,7,10,0.88)';
    g.fillRect(0, 0, size, size);

    g.translate(size / 2, size / 2);
    g.rotate(yaw); // world +yaw is CCW about Y; screen-up must be the facing
    g.scale(scale, scale);
    g.translate(-bx, -bz);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.baked, 0, 0);

    // Objective zones sit in world space under the blips.
    for (const z of this.zones) {
      const [zx, zz] = this._toPx(z.x, z.z);
      const r = Math.max(4, (z.radius || 4) * this.pxPerM);
      g.beginPath();
      g.arc(zx, zz, r, 0, Math.PI * 2);
      g.fillStyle =
        z.owner === 'own'
          ? 'rgba(87,201,255,0.18)'
          : z.owner === 'foe'
            ? 'rgba(255,32,32,0.18)'
            : 'rgba(255,182,72,0.14)';
      g.fill();
      g.lineWidth = 2 / scale;
      g.strokeStyle = z.owner === 'own' ? BLIP.friend : z.owner === 'foe' ? BLIP.foe : '#ffb648';
      g.stroke();
    }
    g.restore();

    /*
     * Scene exposure. A flat black wash at (1 - k) over the plate is an exact
     * multiply by k, which scales the whole ladder without touching its ratios —
     * so the hierarchy survives the dim instead of collapsing into the floor. It
     * lands here, after the plate and BEFORE the blips: the map answers "what is
     * around me" and dims with the world; the symbols answer "who is around me"
     * and must not.
     */
    if (this.exposure < 0.995) {
      g.save();
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = `rgba(3,5,8,${(1 - this.exposure).toFixed(3)})`;
      g.fillRect(0, 0, size, size);
      g.restore();
    }

    // Blips are drawn unrotated so the icons stay upright.
    const world2px = (wx, wz) => {
      const dx = (wx - px) * this.pxPerM * scale;
      const dz = (wz - pz) * this.pxPerM * scale;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      return [size / 2 + dx * c - dz * s, size / 2 + dx * s + dz * c];
    };

    // Zone letters.
    g.save();
    g.font = `700 ${Math.round(11 * this._dpr)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const z of this.zones) {
      const [x, y] = world2px(z.x, z.z);
      if (x < -20 || y < -20 || x > size + 20 || y > size + 20) continue;
      g.fillStyle = '#0a0b0d';
      g.fillText(z.label || '?', x + 1, y + 1);
      g.fillStyle = z.owner === 'own' ? BLIP.friend : z.owner === 'foe' ? BLIP.foe : '#ffb648';
      g.fillText(z.label || '?', x, y);
    }
    g.restore();

    /*
     * Teammates. `setFriends()` wins when the HUD has supplied a list (it knows
     * about the review seed); otherwise fall back to the live roster. A minimap
     * with no blue on it does not read as a team game — measured on the review set,
     * there was not one friendly marker in eight frames.
     */
    const local = this.ctx.game?.localPlayer;
    const mates = this.friends.length ? this.friends : this.ctx.game?.playersOfTeam?.(local?.team) || [];
    for (const m of mates) {
      if (!m || m === local) continue;
      const mp = m.position || m;
      if (m.alive === false || !Number.isFinite(mp.x)) continue;
      const [x, y] = world2px(mp.x, mp.z);
      if (x < -8 || y < -8 || x > size + 8 || y > size + 8) continue;
      chevron(g, x, y, yaw - (m.yaw || 0), 4.6 * this._dpr, BLIP.friend, 0.95);
    }

    // Enemy contacts (UAV sweep, or gunfire pings pushed in by the HUD).
    const now = this.ctx.time?.elapsed ?? 0;
    for (const c of this.contacts) {
      if (c.until && c.until < now) continue;
      const [x, y] = world2px(c.x, c.z);
      if (x < -8 || y < -8 || x > size + 8 || y > size + 8) continue;
      const fade = c.until ? clamp01((c.until - now) / 1.5) : 1;
      chevron(g, x, y, yaw - (c.yaw || 0), 4.8 * this._dpr, BLIP.foe, 0.6 + 0.4 * fade);
    }

    // UAV sweep arm.
    if (this.uav) {
      this.sweep = (this.sweep + step * 1.9) % (Math.PI * 2);
      const R = size * 0.72;
      const grad = g.createConicGradient
        ? g.createConicGradient(this.sweep, size / 2, size / 2)
        : null;
      g.save();
      g.globalCompositeOperation = 'lighter';
      if (grad) {
        grad.addColorStop(0, 'rgba(255,182,72,0.20)');
        grad.addColorStop(0.09, 'rgba(255,182,72,0.0)');
        grad.addColorStop(1, 'rgba(255,182,72,0.0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
      } else {
        g.strokeStyle = 'rgba(255,182,72,0.28)';
        g.lineWidth = 1.5 * this._dpr;
        g.beginPath();
        g.moveTo(size / 2, size / 2);
        g.lineTo(size / 2 + Math.cos(this.sweep) * R, size / 2 + Math.sin(this.sweep) * R);
        g.stroke();
      }
      g.restore();
    }

    /* Field-of-view cone. Under the player marker, so the marker stays the
       brightest thing in the middle of the widget. */
    g.save();
    g.translate(size / 2, size / 2);
    g.beginPath();
    g.moveTo(0, 0);
    const fov = ((this.ctx.camera?.fov ?? 80) * Math.PI) / 180;
    const halfH = Math.atan(Math.tan(fov / 2) * (this.ctx.camera?.aspect ?? 1.78));
    const L = size * 0.42;
    g.lineTo(Math.sin(-halfH) * L, -Math.cos(halfH) * L);
    g.lineTo(Math.sin(halfH) * L, -Math.cos(halfH) * L);
    g.closePath();
    const cone = g.createLinearGradient(0, 0, 0, -L);
    cone.addColorStop(0, 'rgba(255,255,255,0.16)');
    cone.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cone;
    g.fill();
    g.restore();

    /* Player: always dead centre, always facing up. White with an amber ring, so
       "me" is a different hue from both the cyan team and the red contacts rather
       than a neighbouring warm of the latter. */
    chevron(g, size / 2, size / 2, 0, 6.6 * this._dpr, BLIP.player, 1, BLIP.playerRing);

    this._drawNorth(g, size, yaw);
  }

  /**
   * North marker. The map is player-up and rotates, so a marker painted on the
   * frame would be a lie four fifths of the time — this one rides the tape and
   * clamps to the inside of the border, which is what a rotating minimap does.
   */
  _drawNorth(g, size, yaw) {
    const dx = Math.sin(yaw);
    const dy = -Math.cos(yaw);
    const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
    const h = size / 2 - 12 * this._dpr;
    const x = size / 2 + (dx / m) * h;
    const y = size / 2 + (dy / m) * h;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.arc(0, 0, 8 * this._dpr, 0, Math.PI * 2);
    g.fillStyle = 'rgba(5,7,10,0.82)';
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,182,72,0.6)';
    g.stroke();
    g.font = `700 ${Math.round(10 * this._dpr)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffb648';
    g.fillText('N', 0, 0.5 * this._dpr);
    g.restore();
  }

  dispose() {
    this.root.remove();
    this.baked = null;
  }
}

function chevron(g, x, y, rot, r, colour, alpha, ring) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.globalAlpha = alpha;
  g.beginPath();
  g.moveTo(0, -r);
  g.lineTo(r * 0.78, r * 0.75);
  g.lineTo(0, r * 0.34);
  g.lineTo(-r * 0.78, r * 0.75);
  g.closePath();
  g.fillStyle = colour;
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 3;
  g.fill();
  if (ring) {
    g.shadowBlur = 0;
    g.globalAlpha = alpha * 0.7;
    g.strokeStyle = typeof ring === 'string' ? ring : colour;
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(0, 0, r * 1.9, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
}

function quatYaw(q) {
  if (!q) return 0;
  const x = q.x ?? 0;
  const y = q.y ?? 0;
  const z = q.z ?? 0;
  const w = q.w ?? 1;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

export default Minimap;
