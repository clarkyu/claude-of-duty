/**
 * Review pose set. Owner: ORCHESTRATOR ONLY — ask before adding.
 * Each pose is a deterministic camera + game-state setup that the critics judge.
 * `warm` frames are simulated before capture so TAA converges and particles settle.
 */
export const POSES = {
  hero: {
    desc: 'Signature marketing shot: street canyon, weapon up, low sun raking across facades',
    pos: [8.5, 1.68, 22.0],
    look: [-6.0, 3.2, -14.0],
    fov: 78,
    time: 7.4,
    warm: 48,
    state: { sunAzimuth: 24, sunAltitude: 15.4, sunKelvin: 3300, weapon: 'ar_wolverine', ads: false, sprint: false },
  },
  ads: {
    desc: 'Aiming down sight through the optic, target downrange',
    pos: [2.0, 1.62, 10.0],
    look: [1.0, 1.75, -26.0],
    fov: 56,
    time: 7.4,
    warm: 48,
    state: { sunAzimuth: 24, sunAltitude: 15.4, sunKelvin: 3300, weapon: 'ar_wolverine', ads: true },
  },
  interior: {
    desc: 'Indoor lighting: window shafts, bounce, contact shadows, dust motes',
    pos: [-14.4, 1.62, -3.2],
    look: [-4.0, 1.9, -9.0],
    fov: 82,
    time: 8.2,
    warm: 64,
    state: { sunAzimuth: 52, sunAltitude: 19.0, sunKelvin: 3800, weapon: 'smg_viper', ads: false },
  },
  firefight: {
    desc: 'Combat frame: muzzle flash, tracers, impact sparks, smoke, enemies in cover',
    pos: [10.0, 1.66, -6.0],
    look: [-10.0, 2.0, -20.0],
    fov: 80,
    time: 7.4,
    warm: 30,
    state: { sunAzimuth: 38, sunAltitude: 16.5, sunKelvin: 3400, weapon: 'ar_wolverine', firing: true, bots: 'engaged' },
  },
  materials: {
    desc: 'Close-up material study: concrete, rusted metal, painted wood, glass, decals',
    pos: [-2.2, 1.35, 4.4],
    look: [-3.6, 1.15, 1.0],
    fov: 46,
    time: 9.0,
    warm: 40,
    state: { sunAzimuth: 78, sunAltitude: 38.0, sunKelvin: 4200, weapon: 'none' },
  },
  vista: {
    desc: 'Long-range vista: sky, clouds, aerial perspective, distant LODs, volumetrics',
    pos: [4.0, 9.5, 30.0],
    look: [-8.0, 2.0, -48.0],
    fov: 70,
    time: 6.6,
    warm: 48,
    state: { sunAzimuth: 20, sunAltitude: 12.0, sunKelvin: 3050, weapon: 'none' },
  },
  weapon: {
    desc: 'Viewmodel inspect: weapon geometry, machining, wear, optic glass, hands',
    pos: [-8.0, 1.6, 14.0],
    look: [-8.4, 1.6, 6.0],
    fov: 74,
    time: 8.0,
    warm: 40,
    state: { sunAzimuth: 60, sunAltitude: 18.0, sunKelvin: 3700, weapon: 'ar_wolverine', inspect: true },
  },
  night: {
    desc: 'Night lighting: practicals, emissives, bloom discipline, shadowed streets',
    pos: [8.5, 1.68, 22.0],
    look: [-6.0, 3.2, -14.0],
    fov: 78,
    time: 21.5,
    warm: 48,
    state: { weapon: 'ar_wolverine', flashlight: true },
  },
};

export const DEFAULT_SET = ['hero', 'ads', 'interior', 'firefight', 'materials', 'vista', 'weapon', 'night'];
