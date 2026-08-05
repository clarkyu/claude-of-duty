/**
 * MoveState.js — the first-person locomotion state machine. Owner: movement agent.
 *
 * Pure data + a tiny machine: no THREE, no ctx, no side effects beyond the callbacks
 * the host installs. Controller.js owns all the physics; this file owns *what state we
 * are in*, which transitions are legal, and the per-state tuning constants that give
 * the movement its Call-of-Duty feel.
 *
 * Public API
 *   STATE                     frozen enum of state ids
 *   STANCE                    'stand' | 'crouch' | 'prone'
 *   STATE_DEFS                per-state tuning table (see field docs below)
 *   defOf(state)              -> STATE_DEF (never null)
 *   MoveStateMachine          the machine itself
 *
 * MoveStateMachine
 *   new MoveStateMachine(host)   host = { onEnter(to, from, def), onExit(from, to, def),
 *                                         onChange(from, to), guard(from, to) -> bool }
 *   .current  .previous  .def  .time  .prevTime  .frames
 *   .can(to)                  legal by the transition table *and* the host guard
 *   .request(to)              -> bool, performs the transition if legal
 *   .force(to)                -> bool, skips the table and the guard (recoveries)
 *   .tick(dt)                 advances the in-state timer
 *   .is(...names)             membership test
 *
 * Tuning notes (metres, seconds, radians)
 *   speed        target ground speed for a full forward input
 *   accel        base ground acceleration; Controller applies a low-speed boost curve
 *   friction     ground friction coefficient applied when there is no input
 *   airControl   multiplier on air acceleration while airborne *from* this state
 *   height/eye   capsule height and eye height above the feet
 *   stride       metres of travel per footstep (0 = silent); step *rate* therefore
 *                scales with speed for free, which is what a real stride cycle does
 */

/** @enum {string} */
export const STATE = Object.freeze({
  IDLE: 'idle',
  WALK: 'walk',
  SPRINT: 'sprint',
  TAC_SPRINT: 'tacSprint',
  CROUCH: 'crouch',
  CROUCH_WALK: 'crouchWalk',
  PRONE: 'prone',
  SLIDE: 'slide',
  VAULT: 'vault',
  MANTLE: 'mantle',
  CLIMB: 'climb',
  JUMP: 'jump',
  FALL: 'fall',
  LAND: 'land',
});

/** @enum {string} */
export const STANCE = Object.freeze({
  STAND: 'stand',
  CROUCH: 'crouch',
  PRONE: 'prone',
});

/* Capsule dimensions. The radius is shared across every stance so the controller never
 * has to grow the shape sideways mid-frame — the classic way to get stuck in a doorway. */
export const RADIUS = 0.34;
export const HEIGHT_STAND = 1.82;
export const HEIGHT_CROUCH = 1.24;
export const HEIGHT_PRONE = 0.74;
export const HEIGHT_SLIDE = 1.06;

export const EYE_STAND = 1.7; // ARCHITECTURE.md §2
export const EYE_CROUCH = 1.05; // ARCHITECTURE.md §2
export const EYE_PRONE = 0.44;
export const EYE_SLIDE = 0.92;

const BASE = {
  stance: STANCE.STAND,
  speed: 4.45,
  accel: 14,
  friction: 9.0,
  airControl: 1.0,
  height: HEIGHT_STAND,
  eye: EYE_STAND,
  stride: 0,
  /** locomotion states read player input; scripted ones are driven by the controller */
  scripted: false,
  airborne: false,
  canJump: true,
  canLean: true,
  canFire: true,
  canSprint: true,
  canSlide: false,
  canMantle: true,
  /** > 0 = the state expires after this many seconds */
  duration: 0,
  /** viewmodel / weapon hint published on ctx.player for other systems */
  weaponLower: 0,
};

const mk = (o) => Object.freeze({ ...BASE, ...o });

/** @type {Record<string, Readonly<typeof BASE>>} */
export const STATE_DEFS = Object.freeze({
  [STATE.IDLE]: mk({
    speed: 4.45,
    accel: 16,
    friction: 10.5,
    stride: 0,
  }),

  [STATE.WALK]: mk({
    speed: 4.45,
    accel: 14,
    friction: 9.0,
    stride: 1.02,
    canSlide: false,
  }),

  [STATE.SPRINT]: mk({
    speed: 6.35,
    accel: 13,
    friction: 8.0,
    stride: 1.44,
    canSlide: true,
    canLean: false,
    canFire: false,
    weaponLower: 0.6,
  }),

  [STATE.TAC_SPRINT]: mk({
    speed: 8.05,
    accel: 12,
    friction: 8.0,
    stride: 1.66,
    canSlide: true,
    canLean: false,
    canFire: false,
    weaponLower: 1.0,
  }),

  [STATE.CROUCH]: mk({
    stance: STANCE.CROUCH,
    speed: 2.35,
    accel: 13,
    friction: 11.0,
    height: HEIGHT_CROUCH,
    eye: EYE_CROUCH,
    stride: 0,
    canSprint: false,
  }),

  [STATE.CROUCH_WALK]: mk({
    stance: STANCE.CROUCH,
    speed: 2.35,
    accel: 13,
    friction: 11.0,
    height: HEIGHT_CROUCH,
    eye: EYE_CROUCH,
    stride: 0.86,
    canSprint: false,
  }),

  [STATE.PRONE]: mk({
    stance: STANCE.PRONE,
    speed: 1.05,
    accel: 8,
    friction: 13.0,
    height: HEIGHT_PRONE,
    eye: EYE_PRONE,
    stride: 1.15,
    canJump: false,
    canSprint: false,
    canLean: false,
    canMantle: false,
  }),

  [STATE.SLIDE]: mk({
    stance: STANCE.CROUCH,
    // Slides are momentum driven: no input acceleration, only steering + drag.
    // `friction` here is a velocity-proportional drag coefficient; Controller adds
    // a constant SLIDE_DECEL on top, which is what gives the long CoD slide.
    speed: 0,
    accel: 0,
    friction: 0.55,
    height: HEIGHT_SLIDE,
    eye: EYE_SLIDE,
    stride: 0,
    airControl: 0.55,
    canSprint: false,
    canLean: false,
    canFire: true,
    duration: 1.45,
    weaponLower: 0.45,
  }),

  [STATE.JUMP]: mk({
    airborne: true,
    speed: 4.45,
    accel: 0,
    friction: 0,
    airControl: 1.0,
    stride: 0,
    canJump: false,
    canSlide: false,
  }),

  [STATE.FALL]: mk({
    airborne: true,
    speed: 4.45,
    accel: 0,
    friction: 0,
    airControl: 1.0,
    stride: 0,
    canJump: false,
    canSlide: false,
  }),

  [STATE.LAND]: mk({
    // Brief recovery: you keep control but the legs are absorbing the impact.
    speed: 3.5,
    accel: 11,
    friction: 11.5,
    stride: 1.0,
    duration: 0.16,
    canSprint: true,
    canSlide: true,
  }),

  [STATE.VAULT]: mk({
    scripted: true,
    speed: 0,
    accel: 0,
    friction: 0,
    height: HEIGHT_CROUCH,
    eye: EYE_CROUCH + 0.06,
    stride: 0,
    duration: 0.35,
    canJump: false,
    canSprint: false,
    canLean: false,
    canFire: false,
    canMantle: false,
    weaponLower: 0.85,
  }),

  [STATE.MANTLE]: mk({
    scripted: true,
    speed: 0,
    accel: 0,
    friction: 0,
    height: HEIGHT_CROUCH,
    eye: EYE_CROUCH,
    stride: 0,
    duration: 0.75,
    canJump: false,
    canSprint: false,
    canLean: false,
    canFire: false,
    canMantle: false,
    weaponLower: 1.0,
  }),

  [STATE.CLIMB]: mk({
    scripted: true,
    speed: 0,
    accel: 0,
    friction: 0,
    height: HEIGHT_CROUCH,
    eye: EYE_CROUCH,
    stride: 0,
    duration: 1.05,
    canJump: false,
    canSprint: false,
    canLean: false,
    canFire: false,
    canMantle: false,
    weaponLower: 1.0,
  }),
});

/** Never returns null — an unknown id falls back to IDLE so a typo cannot crash a frame. */
export function defOf(state) {
  return STATE_DEFS[state] || STATE_DEFS[STATE.IDLE];
}

/**
 * Legal transitions. Deliberately explicit: an accidental crouch->tacSprint or
 * prone->slide is the kind of thing that only shows up as "the movement feels wrong"
 * three weeks later.
 */
const TRANSITIONS = Object.freeze({
  [STATE.IDLE]: [
    STATE.WALK, STATE.SPRINT, STATE.TAC_SPRINT, STATE.CROUCH, STATE.CROUCH_WALK,
    STATE.PRONE, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.VAULT, STATE.MANTLE,
    STATE.CLIMB,
  ],
  [STATE.WALK]: [
    STATE.IDLE, STATE.SPRINT, STATE.TAC_SPRINT, STATE.CROUCH, STATE.CROUCH_WALK,
    STATE.PRONE, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.VAULT, STATE.MANTLE,
    STATE.CLIMB,
  ],
  [STATE.SPRINT]: [
    STATE.IDLE, STATE.WALK, STATE.TAC_SPRINT, STATE.CROUCH, STATE.CROUCH_WALK,
    STATE.PRONE, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.SLIDE, STATE.VAULT,
    STATE.MANTLE, STATE.CLIMB,
  ],
  [STATE.TAC_SPRINT]: [
    STATE.IDLE, STATE.WALK, STATE.SPRINT, STATE.CROUCH, STATE.CROUCH_WALK,
    STATE.PRONE, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.SLIDE, STATE.VAULT,
    STATE.MANTLE, STATE.CLIMB,
  ],
  [STATE.CROUCH]: [
    STATE.IDLE, STATE.WALK, STATE.CROUCH_WALK, STATE.PRONE, STATE.SPRINT,
    STATE.TAC_SPRINT, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.VAULT,
    STATE.MANTLE, STATE.CLIMB,
  ],
  [STATE.CROUCH_WALK]: [
    STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.PRONE, STATE.SPRINT,
    STATE.TAC_SPRINT, STATE.JUMP, STATE.FALL, STATE.LAND, STATE.SLIDE,
    STATE.VAULT, STATE.MANTLE, STATE.CLIMB,
  ],
  [STATE.PRONE]: [STATE.CROUCH, STATE.CROUCH_WALK, STATE.FALL, STATE.LAND],
  [STATE.SLIDE]: [
    STATE.CROUCH, STATE.CROUCH_WALK, STATE.IDLE, STATE.WALK, STATE.JUMP,
    STATE.FALL, STATE.PRONE, STATE.VAULT, STATE.MANTLE,
  ],
  [STATE.JUMP]: [
    STATE.FALL, STATE.LAND, STATE.VAULT, STATE.MANTLE, STATE.CLIMB, STATE.IDLE,
    STATE.WALK, STATE.CROUCH, STATE.CROUCH_WALK,
  ],
  [STATE.FALL]: [
    STATE.LAND, STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.CROUCH_WALK,
    STATE.VAULT, STATE.MANTLE, STATE.CLIMB, STATE.SPRINT,
  ],
  [STATE.LAND]: [
    STATE.IDLE, STATE.WALK, STATE.SPRINT, STATE.TAC_SPRINT, STATE.CROUCH,
    STATE.CROUCH_WALK, STATE.PRONE, STATE.JUMP, STATE.FALL, STATE.SLIDE,
    STATE.VAULT, STATE.MANTLE, STATE.CLIMB,
  ],
  [STATE.VAULT]: [
    STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.CROUCH_WALK, STATE.FALL,
    STATE.LAND, STATE.SPRINT,
  ],
  [STATE.MANTLE]: [
    STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.CROUCH_WALK, STATE.FALL,
    STATE.LAND, STATE.SPRINT,
  ],
  [STATE.CLIMB]: [
    STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.CROUCH_WALK, STATE.FALL,
    STATE.LAND, STATE.SPRINT,
  ],
});

/** Prebuilt Sets — `includes()` on a 12-entry array, 120 times a second, is silly. */
const TRANSITION_SETS = Object.freeze(
  Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, new Set(v)]))
);

export class MoveStateMachine {
  /**
   * @param {{onEnter?:Function, onExit?:Function, onChange?:Function, guard?:Function}} host
   */
  constructor(host = {}) {
    this.host = host;
    this.current = STATE.IDLE;
    this.previous = STATE.IDLE;
    this.def = defOf(STATE.IDLE);
    /** seconds spent in `current` */
    this.time = 0;
    /** seconds spent in `previous` before it was left */
    this.prevTime = 0;
    /** frames spent in `current` — cheap way to detect "just entered" */
    this.frames = 0;
    /** monotonically increasing transition counter, useful for debouncing */
    this.version = 0;
    /** the state we were in when we last left the ground; drives air control */
    this.airFrom = STATE.IDLE;
  }

  is(...names) {
    for (let i = 0; i < names.length; i++) if (names[i] === this.current) return true;
    return false;
  }

  /** Legal by the table *and* accepted by the host guard. */
  can(to) {
    if (to === this.current) return false;
    if (!STATE_DEFS[to]) return false;
    const set = TRANSITION_SETS[this.current];
    if (set && !set.has(to)) return false;
    const g = this.host.guard;
    if (g && !g(this.current, to, defOf(to))) return false;
    return true;
  }

  request(to) {
    if (!this.can(to)) return false;
    return this._go(to);
  }

  /**
   * Bypasses both the transition table and the host guard. Recovery paths only —
   * a teleport, a finished mantle, a respawn. Those must always land somewhere
   * valid, so they cannot be allowed to fail and strand the machine.
   */
  force(to) {
    if (to === this.current || !STATE_DEFS[to]) return false;
    return this._go(to);
  }

  _go(to) {
    const from = this.current;
    const fromDef = this.def;
    const toDef = defOf(to);
    try {
      this.host.onExit?.(from, to, fromDef);
    } catch {
      /* a host hook must never strand the machine mid-transition */
    }
    this.previous = from;
    this.prevTime = this.time;
    this.current = to;
    this.def = toDef;
    this.time = 0;
    this.frames = 0;
    this.version++;
    if (toDef.airborne && !fromDef.airborne) this.airFrom = from;
    try {
      this.host.onEnter?.(to, from, toDef);
    } catch {
      /* ditto */
    }
    try {
      this.host.onChange?.(from, to);
    } catch {
      /* ditto */
    }
    return true;
  }

  tick(dt) {
    this.time += dt;
    this.frames++;
  }

  /** True once the current state's `duration` has elapsed (0 duration never expires). */
  get expired() {
    return this.def.duration > 0 && this.time >= this.def.duration;
  }

  /** 0..1 progress through a timed state. */
  get progress() {
    return this.def.duration > 0 ? Math.min(1, this.time / this.def.duration) : 0;
  }
}

export default MoveStateMachine;
