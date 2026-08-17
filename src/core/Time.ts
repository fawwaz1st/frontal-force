export class Time {
  private readonly clock = new THREE.Clock();
  private accumulator = 0;

  public start() {
    this.clock.start();
  }

  public tick() {
    return Math.min(this.clock.getDelta(), 0.05);
  }

  public accumulate(delta: number) {
    this.accumulator += delta;
  }

  public consume(step: number) {
    if (this.accumulator < step) return false;
    this.accumulator -= step;
    return true;
  }
}

import * as THREE from 'three';
