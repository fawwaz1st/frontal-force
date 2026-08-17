export class SpatialAudio {
  private readonly context = new AudioContext();

  public async unlock() {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  public playTone(frequency: number, duration = 0.08, gain = 0.05) {
    const osc = this.context.createOscillator();
    const amp = this.context.createGain();
    osc.frequency.value = frequency;
    amp.gain.value = gain;
    osc.connect(amp).connect(this.context.destination);
    osc.start();
    osc.stop(this.context.currentTime + duration);
  }

  public playSpatialTone(frequency: number, x: number, z: number) {
    const pan = this.context.createStereoPanner();
    pan.pan.value = THREE.MathUtils.clamp(x / 20, -1, 1);
    const osc = this.context.createOscillator();
    osc.frequency.value = frequency;
    osc.connect(pan).connect(this.context.destination);
    pan.connect(this.context.destination);
    osc.start();
    osc.stop(this.context.currentTime + 0.05);
  }
}

import * as THREE from 'three';
