export type ShotSound = 'ar' | 'smg' | 'shotgun' | 'rail';

interface ToneOpts {
  freq: number;
  end?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

interface NoiseOpts {
  dur: number;
  freq?: number;
  q?: number;
  type?: BiquadFilterType;
  gain?: number;
  delay?: number;
}

/** Zero-asset procedural sound effects via WebAudio. */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private heartbeatTimer = 0;
  private targetVolume = 0.42;

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  public unlock(): void {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return;
      this.ctx = new AudioContext();
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 8;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.targetVolume;
      this.master.connect(compressor);
      compressor.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  public setVolume(v: number): void {
    this.targetVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Rising heartbeat when health fraction drops. hp01 <= 0.3 range, 0 silences. */
  public heartbeat(hp01: number): void {
    if (!this.ctx || !this.master) return;
    if (hp01 <= 0 || hp01 > 0.3) {
      this.heartbeatTimer = 0;
      return;
    }
    // Faster as health drops toward zero (1.0s → 0.55s period)
    const period = 0.55 + (hp01 / 0.3) * 0.45;
    if (this.heartbeatTimer <= 0) {
      this.tone({ freq: 65, end: 40, dur: 0.14, type: 'sine', gain: 0.5 });
      this.tone({ freq: 60, end: 38, dur: 0.12, type: 'sine', gain: 0.35, delay: 0.16 });
      this.heartbeatTimer = period;
    } else {
      this.heartbeatTimer -= 1 / 60; // heartbeat() runs once per fixed 60 Hz sim step
    }
  }

  public shot(kind: ShotSound): void {
    switch (kind) {
      case 'ar':
        this.noise({ dur: 0.09, freq: 1800, type: 'highpass', gain: 0.5 });
        this.tone({ freq: 220, end: 60, dur: 0.08, type: 'triangle', gain: 0.3 });
        break;
      case 'smg':
        this.noise({ dur: 0.06, freq: 2400, type: 'highpass', gain: 0.34 });
        this.tone({ freq: 320, end: 90, dur: 0.05, type: 'triangle', gain: 0.2 });
        break;
      case 'shotgun':
        this.noise({ dur: 0.24, freq: 900, type: 'lowpass', gain: 0.7 });
        this.tone({ freq: 140, end: 40, dur: 0.18, type: 'sine', gain: 0.5 });
        break;
      case 'rail':
        this.tone({ freq: 1200, end: 80, dur: 0.3, type: 'sawtooth', gain: 0.32 });
        this.noise({ dur: 0.16, freq: 3000, type: 'highpass', gain: 0.3 });
        break;
    }
  }

  public empty(): void {
    this.tone({ freq: 800, dur: 0.04, type: 'square', gain: 0.07 });
  }

  public reload(): void {
    this.tone({ freq: 500, dur: 0.04, type: 'square', gain: 0.11 });
    this.tone({ freq: 720, dur: 0.04, type: 'square', gain: 0.11, delay: 0.14 });
  }

  public hitmarker(): void {
    this.tone({ freq: 2100, dur: 0.045, type: 'square', gain: 0.1 });
  }

  public kill(): void {
    this.tone({ freq: 520, dur: 0.07, type: 'square', gain: 0.16 });
    this.tone({ freq: 784, dur: 0.1, type: 'square', gain: 0.16, delay: 0.06 });
  }

  public hurt(): void {
    this.tone({ freq: 110, end: 48, dur: 0.2, type: 'sine', gain: 0.5 });
    this.noise({ dur: 0.12, freq: 400, type: 'lowpass', gain: 0.28 });
  }

  public pickup(): void {
    this.tone({ freq: 660, dur: 0.07, type: 'sine', gain: 0.2 });
    this.tone({ freq: 990, dur: 0.1, type: 'sine', gain: 0.2, delay: 0.07 });
  }

  public waveStart(): void {
    this.tone({ freq: 220, end: 440, dur: 0.32, type: 'sawtooth', gain: 0.18 });
    this.tone({ freq: 440, end: 880, dur: 0.28, type: 'sawtooth', gain: 0.1, delay: 0.2 });
  }

  public waveClear(): void {
    this.tone({ freq: 523, dur: 0.1, type: 'triangle', gain: 0.2 });
    this.tone({ freq: 659, dur: 0.1, type: 'triangle', gain: 0.2, delay: 0.1 });
    this.tone({ freq: 784, dur: 0.22, type: 'triangle', gain: 0.22, delay: 0.2 });
  }

  public enemyShot(): void {
    this.noise({ dur: 0.07, freq: 1400, type: 'bandpass', q: 1.2, gain: 0.16 });
  }

  public melee(): void {
    this.noise({ dur: 0.08, freq: 700, type: 'bandpass', gain: 0.32 });
    this.tone({ freq: 160, end: 70, dur: 0.1, type: 'triangle', gain: 0.28 });
  }

  public slam(): void {
    this.tone({ freq: 90, end: 30, dur: 0.3, type: 'sine', gain: 0.55 });
    this.noise({ dur: 0.2, freq: 300, type: 'lowpass', gain: 0.38 });
  }

  public spawn(): void {
    this.tone({ freq: 180, end: 360, dur: 0.18, type: 'triangle', gain: 0.1 });
  }

  private tone(opts: ToneOpts): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, opts.freq), t0);
    if (opts.end !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.end), t0 + opts.dur);
    }
    gain.gain.setValueAtTime(opts.gain ?? 0.2, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  private noise(opts: NoiseOpts): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.value = opts.freq ?? 1000;
    filter.Q.value = opts.q ?? 0.8;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(opts.gain ?? 0.3, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t0);
    src.stop(t0 + opts.dur + 0.02);
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}

