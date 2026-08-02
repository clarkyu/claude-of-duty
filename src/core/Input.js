/**
 * Input — keyboard, mouse (pointer-lock) and gamepad state. Owner: orchestrator (core).
 *
 * Poll-style: systems read `input.action('fire')` / `input.axis('moveX')` in update().
 * Mouse deltas accumulate between frames and are drained by the player controller via
 * `consumeLook()`, so a slow frame never loses aim input.
 *
 * Emits: `input:lock` {locked}
 */

const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  tactical: ['KeyQ'],
  swap: ['Digit1', 'Digit2', 'KeyX'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  inspect: ['KeyI'],
  fireMode: ['KeyB'],
  scoreboard: ['Tab'],
  pause: ['Escape'],
  flashlight: ['KeyT'],
};

export class Input {
  constructor(domElement, bus, settings) {
    this.dom = domElement;
    this.bus = bus;
    this.settings = settings;
    this.binds = { ...DEFAULT_BINDS };
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, wheel: 0 };
    this.prevButtons = 0;
    this.locked = false;
    this.enabled = true;
    this.gamepadIndex = null;
    this._pad = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] };
    this._bind();
  }

  _bind() {
    const onKey = (e, down) => {
      if (!this.enabled) return;
      if (down) {
        if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code);
        this.keys.add(e.code);
      } else {
        this.keys.delete(e.code);
        this.releasedThisFrame.add(e.code);
      }
      // Don't let the browser steal gameplay keys.
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyDown = (e) => onKey(e, true);
    this._onKeyUp = (e) => onKey(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._onMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onDown = (e) => {
      if (!this.enabled) return;
      this.mouse.buttons |= 1 << e.button;
    };
    this._onUp = (e) => {
      this.mouse.buttons &= ~(1 << e.button);
    };
    this._onWheel = (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
    };
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('mousedown', this._onDown);
    document.addEventListener('mouseup', this._onUp);
    document.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.mouse.buttons = 0;
      }
      this.bus?.emit('input:lock', { locked: this.locked });
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.buttons = 0;
    });
  }

  requestLock() {
    this.dom.requestPointerLock?.();
  }

  exitLock() {
    document.exitPointerLock?.();
  }

  /** True while held. */
  action(name) {
    const codes = this.binds[name];
    if (codes) for (const c of codes) if (this.keys.has(c)) return true;
    return this._padAction(name);
  }

  /** True only on the frame the key went down. */
  pressed(name) {
    const codes = this.binds[name];
    if (codes) for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  released(name) {
    const codes = this.binds[name];
    if (codes) for (const c of codes) if (this.releasedThisFrame.has(c)) return true;
    return false;
  }

  get fire() {
    return (this.mouse.buttons & 1) !== 0 || this._pad.rt > 0.5;
  }

  get ads() {
    return (this.mouse.buttons & 2) !== 0 || this._pad.lt > 0.5;
  }

  firePressed() {
    return (this.mouse.buttons & 1) !== 0 && (this.prevButtons & 1) === 0;
  }

  /** Movement vector in local space, magnitude clamped to 1. */
  moveVector(out) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let z = (this.action('back') ? 1 : 0) - (this.action('forward') ? 1 : 0);
    x += this._pad.lx;
    z += this._pad.ly;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    out.set(x, 0, z);
    return out;
  }

  /** Drain accumulated look delta (radians), including gamepad stick. */
  consumeLook(dt) {
    const s = this.settings?.get('sensitivity') ?? 0.0022;
    const padRate = 3.2 * dt;
    const yaw = -this.mouse.dx * s - this._pad.rx * padRate;
    let pitch = -this.mouse.dy * s - this._pad.ry * padRate;
    if (this.settings?.get('invertY')) pitch = -pitch;
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return { yaw, pitch };
  }

  _padAction(name) {
    const b = this._pad.buttons;
    if (!b.length) return false;
    switch (name) {
      case 'jump':
        return !!b[0];
      case 'crouch':
        return !!b[1];
      case 'reload':
        return !!b[2];
      case 'swap':
        return !!b[3];
      case 'sprint':
        return !!b[10];
      case 'melee':
        return !!b[11];
      default:
        return false;
    }
  }

  _pollGamepad() {
    const pads = navigator.getGamepads?.() || [];
    const pad = pads[this.gamepadIndex ?? 0] || pads.find((p) => p);
    if (!pad) {
      this._pad.lx = this._pad.ly = this._pad.rx = this._pad.ry = 0;
      this._pad.lt = this._pad.rt = 0;
      this._pad.buttons = [];
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
    this._pad.lx = dz(pad.axes[0] || 0);
    this._pad.ly = dz(pad.axes[1] || 0);
    this._pad.rx = dz(pad.axes[2] || 0);
    this._pad.ry = dz(pad.axes[3] || 0);
    this._pad.lt = pad.buttons[6]?.value || 0;
    this._pad.rt = pad.buttons[7]?.value || 0;
    this._pad.buttons = pad.buttons.map((b) => b.pressed);
  }

  /** Called by the Engine at the very end of each frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.prevButtons = this.mouse.buttons;
    this.mouse.wheel = 0;
    this._pollGamepad();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mousedown', this._onDown);
    document.removeEventListener('mouseup', this._onUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
