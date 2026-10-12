const STEP = 1 / 60;
const MAX_FRAME = 0.25;
const MAX_CATCHUP_STEPS = 5;

/**
 * Fixed-timestep simulation with render interpolation.
 *
 * `update(dt)` runs at exactly 60 Hz. `render(frameDt, alpha)` runs once per
 * animation frame, where `alpha = accumulator / STEP` in `[0, 1)`. Consumers
 * lerp between the previous and current simulation snapshot with it, so a
 * 144 Hz display shows 2.4 distinct positions per tick instead of 1.4 repeated
 * ones. This is the single largest "movement feels precise" win available.
 *
 * Interpolation is deliberately NOT applied to view angles: the mouse already
 * generates those at frame rate, so interpolating them would add a frame of
 * latency and re-introduce the judder interpolation exists to remove.
 */
export class GameLoop {
  private rafId = 0;
  private last = 0;
  private acc = 0;
  private running = false;
  /** Smoothed frame duration in ms — drives the quality governor. */
  private avgFrameMs = 16.7;

  public constructor(
    private readonly update: (dt: number) => void,
    private readonly render: (frameDt: number, alpha: number) => void,
  ) {}

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  public stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Interpolation weight the last render used — for tests and diagnostics. */
  public get alpha(): number {
    return this.acc / STEP;
  }

  /** Mean frame time over the last few hundred frames (ms). */
  public get frameTimeMs(): number {
    return this.avgFrameMs;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    // Clamp against tab-switch stalls; the catch-up cap below handles the rest.
    const frameTime = Math.min((now - this.last) / 1000, MAX_FRAME);
    this.last = now;
    this.avgFrameMs = this.avgFrameMs * 0.95 + frameTime * 1000 * 0.05;
    this.acc += frameTime;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_CATCHUP_STEPS) {
      this.update(STEP);
      this.acc -= STEP;
      steps += 1;
    }
    if (this.acc > STEP) this.acc = 0; // drop backlog instead of spiraling
    this.render(frameTime, this.acc / STEP);
    this.rafId = requestAnimationFrame(this.frame);
  };
}
