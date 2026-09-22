const STEP = 1 / 60;
const MAX_FRAME = 0.25;
const MAX_CATCHUP_STEPS = 5;

/** Fixed-timestep simulation with per-frame rendering and catch-up spiral protection. */
export class GameLoop {
  private rafId = 0;
  private last = 0;
  private acc = 0;
  private running = false;

  public constructor(
    private readonly update: (dt: number) => void,
    private readonly render: () => void,
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

  private frame = (now: number): void => {
    if (!this.running) return;
    const frameTime = Math.min((now - this.last) / 1000, MAX_FRAME);
    this.last = now;
    this.acc += frameTime;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_CATCHUP_STEPS) {
      this.update(STEP);
      this.acc -= STEP;
      steps += 1;
    }
    if (this.acc > STEP) this.acc = 0; // drop backlog instead of spiraling
    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };
}
