import * as RAPIER from '@dimforge/rapier3d-compat';

export class PhysicsWorld {
  private world: RAPIER.World | null = null;
  private ready = false;

  public async init() {
    if (this.ready) return;
    await RAPIER.init();
    if ((RAPIER as typeof RAPIER & { reserveMemory?: () => void }).reserveMemory) {
      (RAPIER as typeof RAPIER & { reserveMemory?: () => void }).reserveMemory?.();
    }
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.ready = true;
  }

  public step(delta: number) {
    this.world?.step();
    return delta;
  }

  public getWorld() {
    if (!this.world) throw new Error('PhysicsWorld not initialized');
    return this.world;
  }
}
