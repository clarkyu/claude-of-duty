/**
 * Settings — quality tiers and runtime toggles. Owner: orchestrator (core).
 * Emits `quality:changed` {tier} and `setting:changed` {key, value}.
 * Systems must degrade gracefully; never assume a feature is on.
 */

const TIERS = {
  low: {
    shadows: true,
    shadowCascades: 2,
    shadowResolution: 1024,
    contactShadows: false,
    ssao: false,
    ssr: false,
    taa: false,
    fxaa: true,
    bloom: true,
    bloomQuality: 3,
    motionBlur: false,
    dof: false,
    volumetrics: false,
    volumetricSteps: 0,
    chromaticAberration: false,
    grain: true,
    particleBudget: 1500,
    decalBudget: 48,
    textureResolution: 512,
    detailTextures: false,
    parallax: false,
    anisotropy: 4,
    renderScale: 0.85,
    foliageDensity: 0.3,
    reflectionProbes: 1,
  },
  medium: {
    shadows: true,
    shadowCascades: 3,
    shadowResolution: 1536,
    contactShadows: true,
    ssao: true,
    ssaoQuality: 1,
    ssr: false,
    taa: true,
    fxaa: false,
    bloom: true,
    bloomQuality: 4,
    motionBlur: true,
    dof: false,
    volumetrics: true,
    volumetricSteps: 24,
    chromaticAberration: true,
    grain: true,
    particleBudget: 4000,
    decalBudget: 96,
    textureResolution: 1024,
    detailTextures: true,
    parallax: false,
    anisotropy: 8,
    renderScale: 1.0,
    foliageDensity: 0.6,
    reflectionProbes: 2,
  },
  high: {
    shadows: true,
    shadowCascades: 4,
    shadowResolution: 2048,
    contactShadows: true,
    ssao: true,
    ssaoQuality: 2,
    ssr: true,
    ssrQuality: 1,
    taa: true,
    fxaa: false,
    bloom: true,
    bloomQuality: 5,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 48,
    chromaticAberration: true,
    grain: true,
    particleBudget: 10000,
    decalBudget: 192,
    textureResolution: 2048,
    detailTextures: true,
    parallax: true,
    anisotropy: 16,
    renderScale: 1.0,
    foliageDensity: 1.0,
    reflectionProbes: 4,
  },
  ultra: {
    shadows: true,
    shadowCascades: 4,
    shadowResolution: 3072,
    contactShadows: true,
    ssao: true,
    ssaoQuality: 3,
    ssr: true,
    ssrQuality: 2,
    taa: true,
    fxaa: false,
    bloom: true,
    bloomQuality: 6,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 72,
    chromaticAberration: true,
    grain: true,
    particleBudget: 20000,
    decalBudget: 320,
    textureResolution: 2048,
    detailTextures: true,
    parallax: true,
    anisotropy: 16,
    renderScale: 1.0,
    foliageDensity: 1.35,
    reflectionProbes: 6,
  },
};

export class Settings {
  constructor(bus, overrides = {}) {
    this.bus = bus;
    this.tier = 'high';
    this.values = { ...TIERS.high };
    // Non-tier globals.
    this.values.headless = false;
    this.values.fov = 90;
    this.values.adsFovScale = 0.72;
    this.values.viewmodelFov = 60;
    this.values.sensitivity = 0.0022;
    this.values.exposure = 1.0;
    this.values.invertY = false;
    this.values.showFps = false;
    this.values.maxPixelRatio = 2;
    Object.assign(this.values, overrides);
  }

  static tiers() {
    return Object.keys(TIERS);
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.bus?.emit('setting:changed', { key, value });
  }

  setTier(tier) {
    if (!TIERS[tier]) return;
    this.tier = tier;
    Object.assign(this.values, TIERS[tier]);
    this.bus?.emit('quality:changed', { tier, values: this.values });
  }

  /** Convenience: pick a value based on the active tier. */
  byTier(map, fallback) {
    return map[this.tier] ?? fallback;
  }
}
