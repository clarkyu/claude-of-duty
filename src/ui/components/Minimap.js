/**
 * Minimap.js — top-down tactical map drawn from the real level. Owner: ui agent.
 *
 * The map is not an illustration: at init it bakes `ctx.level.navRegions.walkable`
 * (the actual raycast walkable grid) as the street surface and every box collider in
 * `ctx.level.colliders` as a building footprint into one offscreen canvas. Per frame
 * it blits a rotated crop of that bake — player-up, like CoD — and stamps blips on
 * top. One drawImage plus a dozen tiny paths, at 30 Hz, on a 178 px canvas.
 *
 * API: new Minimap(root, ctx) → { bake(), update(dt), setContacts(list),
 *                                 setZones(list), setUav(bool), dispose() }
 */
import { div, setClass, clamp01 } from './dom.js';

const BAKE = 700; // px across the whole level bake
const VIEW_M = 62; // metres visible across the widget

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
    this.bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    this.contacts = [];
    this.zones = [];
    this.uav = false;
    this.sweep = 0;
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
      // Centre the level in a square bake.
      this.cx = (this.bounds.minX + this.bounds.maxX) * 0.5;
      this.cz = (this.bounds.minZ + this.bounds.maxZ) * 0.5;

      const c = document.createElement('canvas');
      c.width = BAKE;
      c.height = BAKE;
      const g = c.getContext('2d');
      if (!g) return;

      g.fillStyle = '#070a0e';
      g.fillRect(0, 0, BAKE, BAKE);

      this._drawWalkable(g, level);
      this._drawColliders(g, level);
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
    return [
      BAKE * 0.5 + (x - this.cx) * this.pxPerM,
      BAKE * 0.5 + (z - this.cz) * this.pxPerM,
    ];
  }

  _drawWalkable(g, level) {
    const nav = level?.navRegions;
    if (!nav || !nav.walkable || !nav.cols) return;
    const { cols, rows, cell } = nav;
    const origin = nav.origin || [this.bounds.minX, this.bounds.minZ];
    const w = nav.walkable;
    const size = cell * this.pxPerM;
    // Streets: a light wash so the layout reads instantly.
    g.fillStyle = 'rgba(164,186,206,0.22)';
    for (let j = 0; j < rows; j++) {
      let runStart = -1;
      for (let i = 0; i <= cols; i++) {
        const on = i < cols && w[j * cols + i] === 1;
        if (on && runStart < 0) runStart = i;
        else if (!on && runStart >= 0) {
          const [x0, z0] = this._toPx(origin[0] + runStart * cell, origin[1] + j * cell);
          g.fillRect(x0, z0, (i - runStart) * size + 0.6, size + 0.6);
          runStart = -1;
        }
      }
    }
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
        g.fillStyle = f.tall ? 'rgba(228,234,240,0.30)' : 'rgba(228,234,240,0.15)';
        g.fillRect(-w / 2, -d / 2, w, d);
        if (f.tall && (w > 3 || d > 3)) {
          g.strokeStyle = 'rgba(232,238,244,0.46)';
          g.lineWidth = 1;
          g.strokeRect(-w / 2 + 0.5, -d / 2 + 0.5, w - 1, d - 1);
        }
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
      this._drawnOnce;
    if (still) return;
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
          ? 'rgba(207,230,242,0.16)'
          : z.owner === 'foe'
            ? 'rgba(255,68,51,0.16)'
            : 'rgba(255,182,72,0.13)';
      g.fill();
      g.lineWidth = 2 / scale;
      g.strokeStyle =
        z.owner === 'own' ? '#cfe6f2' : z.owner === 'foe' ? '#ff4433' : '#ffb648';
      g.stroke();
    }
    g.restore();

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
      g.fillStyle =
        z.owner === 'own' ? '#cfe6f2' : z.owner === 'foe' ? '#ff4433' : '#ffb648';
      g.fillText(z.label || '?', x, y);
    }
    g.restore();

    // Teammates.
    const local = this.ctx.game?.localPlayer;
    const mates = this.ctx.game?.playersOfTeam?.(local?.team) || [];
    for (const m of mates) {
      if (!m || m === local || !m.alive || !m.position) continue;
      const [x, y] = world2px(m.position.x, m.position.z);
      if (x < -8 || y < -8 || x > size + 8 || y > size + 8) continue;
      chevron(g, x, y, yaw - (m.yaw || 0), 4.4 * this._dpr, '#cfe6f2', 0.9);
    }

    // Enemy contacts (UAV sweep, or gunfire pings pushed in by the HUD).
    const now = this.ctx.time?.elapsed ?? 0;
    for (const c of this.contacts) {
      if (c.until && c.until < now) continue;
      const [x, y] = world2px(c.x, c.z);
      if (x < -8 || y < -8 || x > size + 8 || y > size + 8) continue;
      const fade = c.until ? clamp01((c.until - now) / 1.5) : 1;
      chevron(g, x, y, yaw - (c.yaw || 0), 4.6 * this._dpr, '#ff4433', 0.55 + 0.45 * fade);
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

    // Player: always dead centre, always facing up.
    chevron(g, size / 2, size / 2, 0, 6.4 * this._dpr, '#ffb648', 1, true);

    // Field-of-view cone.
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
    cone.addColorStop(0, 'rgba(255,182,72,0.20)');
    cone.addColorStop(1, 'rgba(255,182,72,0)');
    g.fillStyle = cone;
    g.fill();
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
    g.globalAlpha = alpha * 0.5;
    g.strokeStyle = colour;
    g.lineWidth = 1;
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
