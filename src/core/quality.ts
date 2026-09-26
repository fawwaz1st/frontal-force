/**
 * Adaptive quality: a boot-time device tier plus a runtime frame-time probe
 * that only ever steps DOWN.
 *
 * Research (2026): no single device signal is reliable — `deviceMemory` is
 * Chromium-only and quantised, `userAgentData.mobile` is Chromium-only, and
 * `hardwareConcurrency` is coarse. The robust pattern is a cheap boot heuristic
 * to pick a starting tier, then measure and adapt. Stepping up again after a
 * downgrade is deliberately NOT done: the three.js guidance is that a downgrade
 * must be verified to have helped, and a flip-flopping pixel ratio causes
 * visible resolution pumping plus a framebuffer reallocation each time.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityPreset {
  tier: QualityTier;
  /** Upper bound on `devicePixelRatio`. Fractional values are intentional. */
  pixelRatioCap: number;
  /** MSAA via WebGPU sampleCount — only 1 or 4 are legal. */
  antialias: boolean;
  shadows: boolean;
  /** Shadow map edge in pixels (ignored when `shadows` is false). */
  shadowMapSize: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  // Low: no AA (a sharper native-res image beats a blurry upscaled AA one),
  // no shadows at all, and a sub-1 ratio because the target device is fill-bound.
  low: { tier: 'low', pixelRatioCap: 0.75, antialias: false, shadows: false, shadowMapSize: 512 },
  medium: { tier: 'medium', pixelRatioCap: 1, antialias: false, shadows: true, shadowMapSize: 1024 },
  high: { tier: 'high', pixelRatioCap: 1.5, antialias: true, shadows: true, shadowMapSize: 2048 },
};

/** Desktop gets a higher ceiling than mobile at the same tier. */
const DESKTOP_RATIO_BONUS = 0.5;

/** Is this a handheld-class device? Chromium-only hints, so UA is the fallback. */
export function isMobileDevice(): boolean {
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
    deviceMemory?: number;
  };
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Boot heuristic. WebGPU presence already implies a recent device (Chrome
 * Android 121+, Safari iOS 26+), so a WebGPU-capable phone is treated as
 * `medium` rather than `low` — it will still drop to `low` via the probe if it
 * cannot hold the frame budget.
 */
export function detectTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency || 4;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 8;
  const mobile = isMobileDevice();
  if (mobile) {
    if (cores <= 4 || memory <= 3) return 'low';
    return 'medium';
  }
  if (cores <= 2 || memory <= 2) return 'low';
  if (cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

/** Resolve a preset for a tier, widening the pixel-ratio cap on desktop. */
export function presetFor(tier: QualityTier): QualityPreset {
  const base = QUALITY_PRESETS[tier];
  if (isMobileDevice()) return base;
  return { ...base, pixelRatioCap: base.pixelRatioCap + DESKTOP_RATIO_BONUS };
}

/**
 * Runtime frame-time probe with hysteresis.
 *
 * Retargeted from model-viewer's shipped algorithm (originally tuned for a
 * 60 fps budget) to a 30 fps budget: downgrade above HIGH, upgrade below LOW,
 * and reset the running average on any step so the change is measured before
 * the next decision. Ratio changes reallocate framebuffers, so a step is
 * allowed at most once per second.
 */
export class FrameTimeGovernor {
  /** Multipliers applied to the preset's cap, largest first. */
  private static readonly SCALE_STEPS = [1, 0.79, 0.62, 0.5, 0.4, 0.31, 0.25];
  /** ms above which we step down; the 40..60 band in the original is the hysteresis. */
  private static readonly HIGH_MS = 40;
  private static readonly LOW_MS = 26;
  private static readonly RESET_MS = 33;
  /** Exponential smoothing constant for the running average. */
  private static readonly DECAY = 0.2;
  /** Cap on how fast the average may move per sample. */
  private static readonly MAX_AVG_CHANGE_MS = 5;
  /** Minimum seconds between steps — each one reallocates framebuffers. */
  private static readonly MIN_STEP_INTERVAL = 1;
  /** Seconds continuously below the low-water mark before stepping back up. */
  private static readonly RECOVERY_SECONDS = 5;

  private avg = FrameTimeGovernor.RESET_MS;
  private stepIndex = 0;
  private sinceStep = 0;
  private samples = 0;
  /** Seconds spent continuously below the low-water mark — recovery gate. */
  private fastFor = 0;

  /** Current multiplier to apply on top of the preset's pixel-ratio cap. */
  public get scale(): number {
    return FrameTimeGovernor.SCALE_STEPS[this.stepIndex] ?? 1;
  }

  public reset(): void {
    this.avg = FrameTimeGovernor.RESET_MS;
    this.stepIndex = 0;
    this.sinceStep = 0;
    this.samples = 0;
    this.fastFor = 0;
  }

  /**
   * Feed one frame's duration in milliseconds.
   * Returns true when the caller must re-apply the pixel ratio.
   */
  public sample(deltaMs: number): boolean {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return false;
    this.samples += 1;
    // Sample at least 20 frames before acting — single spikes are noise.
    const change = FrameTimeGovernor.DECAY * (deltaMs - this.avg);
    const clamped = Math.max(
      -FrameTimeGovernor.MAX_AVG_CHANGE_MS,
      Math.min(FrameTimeGovernor.MAX_AVG_CHANGE_MS, change),
    );
    this.avg += clamped;
    this.sinceStep += deltaMs / 1000;
    if (this.samples < 20) return false;
    if (this.sinceStep < FrameTimeGovernor.MIN_STEP_INTERVAL) return false;
    const steps = FrameTimeGovernor.SCALE_STEPS;
    if (this.avg > FrameTimeGovernor.HIGH_MS) {
      this.fastFor = 0;
      if (this.stepIndex >= steps.length - 1) return false;
      this.stepIndex += 1;
      this.avg = FrameTimeGovernor.RESET_MS;
      this.sinceStep = 0;
      return true;
    }
    if (this.avg < FrameTimeGovernor.LOW_MS) {
      // Recovery is gated behind a long sustained fast window, so a device
      // that was only briefly throttled (thermal ramp, another tab) climbs
      // back instead of being stuck at 25% resolution for the session. The
      // 5 s gate is what prevents resolution pumping.
      this.fastFor += this.sinceStep;
      if (this.fastFor < FrameTimeGovernor.RECOVERY_SECONDS) return false;
      if (this.stepIndex === 0) return false;
      this.stepIndex -= 1;
      this.fastFor = 0;
      this.avg = FrameTimeGovernor.RESET_MS;
      this.sinceStep = 0;
      return true;
    }
    this.fastFor = 0;
    return false;
  }
}
