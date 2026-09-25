import { clamp } from '../core/math';

export type ShotSound = 'ar' | 'smg' | 'shotgun' | 'rail';

interface ToneOpts {
  freq: number;
  end?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
  /** Stereo position −1 (left) … +1 (right); omitted = center (no panner node). */
  pan?: number;
}

interface NoiseOpts {
  dur: number;
  freq?: number;
  q?: number;
  type?: BiquadFilterType;
  gain?: number;
  delay?: number;
  pan?: number;
}

/** Zero-asset procedural sound effects via WebAudio. */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private heartbeatTimer = 0;
  private targetVolume = 0.42;

  // Adaptive music: persistent drone + lookahead beat scheduler
  private musicGain: GainNode | null = null;
  private musicLevel = 0;
  private musicTarget = 0;
  private bpm = 68;
  private bpmTarget = 68;
  private beatInterval = 60 / 68;
  private nextBeat = 0;
  private beatCount = 0;
  private musicPaused = false;

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
      this.startDrone();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  public setVolume(v: number): void {
    this.targetVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Persistent bass drone under everything — started once on unlock(). */
  private startDrone(): void {
    if (!this.ctx || !this.master || this.musicGain) return;
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 0.7;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    const mk = (freq: number, type: OscillatorType, g: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = g;
      osc.connect(gain);
      gain.connect(lp);
      osc.start();
    };
    mk(41.2, 'sine', 0.55);   // E1 sub
    mk(55, 'sawtooth', 0.5);  // A1 body
    mk(55.35, 'sawtooth', 0.4); // detune beating
    lp.connect(this.musicGain);
    this.musicGain.connect(this.master);
  }

  /**
   * Adaptive score intensity + tempo. level 0..1 drives drone/beat gain;
   * bpm morphs toward target. Call every frame — cheap, no allocations.
   */
  public setMusic(level: number, bpm: number): void {
    this.musicTarget = clamp(level, 0, 1);
    this.bpmTarget = clamp(bpm, 40, 180);
  }

  public setMusicPaused(paused: boolean): void {
    this.musicPaused = paused;
    if (paused && this.musicGain) this.musicGain.gain.value = 0.015;
  }

  /** Lookahead beat scheduler — call once per fixed 60 Hz sim step. */
  public musicTick(): void {
    if (!this.ctx || !this.musicGain) return;
    if (this.musicPaused) return;
    const now = this.ctx.currentTime;
    this.musicLevel += (this.musicTarget - this.musicLevel) * 0.045;
    this.musicGain.gain.value = this.musicLevel * 0.17;
    this.bpm += (this.bpmTarget - this.bpm) * 0.03;
    this.beatInterval = 60 / this.bpm;
    if (this.nextBeat <= now) this.nextBeat = now + 0.06;
    while (this.nextBeat < now + 0.12) {
      this.scheduleBeat(this.nextBeat);
      this.nextBeat += this.beatInterval;
    }
  }

  private scheduleBeat(t: number): void {
    const lvl = this.musicLevel;
    if (lvl < 0.1) { this.beatCount++; return; }
    const delay = Math.max(0, t - (this.ctx as AudioContext).currentTime);
    const beat = this.beatCount++;
    if (beat % 2 === 0) {
      this.tone({ freq: 62, end: 40, dur: 0.13, type: 'sine', gain: 0.5 * lvl, delay });
    }
    if (lvl > 0.35) {
      this.noise({ dur: 0.03, freq: 6800, type: 'highpass', gain: 0.07 * lvl, delay: delay + this.beatInterval * 0.5 });
    }
    if (beat % 8 === 0) {
      const notes = [55, 65.41, 73.42, 87.31, 98]; // A-minor-ish bass line
      const f = notes[Math.floor(beat / 8) % notes.length] ?? 55;
      this.tone({ freq: f, dur: this.beatInterval * 3.5, type: 'triangle', gain: 0.15 * lvl, delay });
    }
  }

  /** Rising heartbeat when health fraction drops. hp01 <= 0.3 range, 0 silences. */
  public heartbeat(hp01: number, dt: number): void {
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
      this.heartbeatTimer -= dt;
    }
  }

  public shot(kind: ShotSound): void {
    // Per-shot jitter keeps repeated fire from sounding like one frozen sample:
    // ±6% pitch and ±10% level on every trigger pull.
    const jitter = 1 + (Math.random() - 0.5) * 0.12;
    const level = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'ar':
        this.noise({ dur: 0.09, freq: 1800 * jitter, type: 'highpass', gain: 0.5 * level });
        this.tone({ freq: 220 * jitter, end: 60, dur: 0.08, type: 'triangle', gain: 0.3 * level });
        break;
      case 'smg':
        this.noise({ dur: 0.06, freq: 2400 * jitter, type: 'highpass', gain: 0.34 * level });
        this.tone({ freq: 320 * jitter, end: 90, dur: 0.05, type: 'triangle', gain: 0.2 * level });
        break;
      case 'shotgun':
        this.noise({ dur: 0.24, freq: 900 * jitter, type: 'lowpass', gain: 0.7 * level });
        this.tone({ freq: 140 * jitter, end: 40, dur: 0.18, type: 'sine', gain: 0.5 * level });
        break;
      case 'rail':
        this.tone({ freq: 1200 * jitter, end: 80, dur: 0.3, type: 'sawtooth', gain: 0.32 * level });
        this.noise({ dur: 0.16, freq: 3000 * jitter, type: 'highpass', gain: 0.3 * level });
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

  public hitmarker(headshot: boolean): void {
    if (headshot) {
      this.tone({ freq: 1568, dur: 0.05, type: 'square', gain: 0.13 });
      this.tone({ freq: 2093, dur: 0.1, type: 'square', gain: 0.11, delay: 0.045 });
    } else {
      this.tone({ freq: 2100, dur: 0.045, type: 'square', gain: 0.1 });
    }
  }

  public charge(pan = 0): void {
    // Attack windup tell — rising sine under the visor spike
    this.tone({ freq: 240, end: 720, dur: 0.3, type: 'sine', gain: 0.11, pan });
  }

  public step(): void {
    this.noise({ dur: 0.05, freq: 240 + Math.random() * 70, type: 'bandpass', q: 1.1, gain: 0.11 });
  }

  public land(): void {
    this.noise({ dur: 0.15, freq: 180, type: 'lowpass', gain: 0.3 });
    this.tone({ freq: 90, end: 55, dur: 0.12, type: 'sine', gain: 0.3 });
  }

  public weaponSwitch(): void {
    this.tone({ freq: 680, dur: 0.03, type: 'square', gain: 0.09 });
    this.tone({ freq: 900, dur: 0.03, type: 'square', gain: 0.08, delay: 0.05 });
  }

  public tick(): void {
    this.tone({ freq: 1200, dur: 0.05, type: 'sine', gain: 0.12 });
  }

  public record(): void {
    this.tone({ freq: 523, dur: 0.1, type: 'triangle', gain: 0.16 });
    this.tone({ freq: 659, dur: 0.1, type: 'triangle', gain: 0.16, delay: 0.1 });
    this.tone({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.17, delay: 0.2 });
    this.tone({ freq: 1046, dur: 0.3, type: 'triangle', gain: 0.18, delay: 0.3 });
  }

  public kill(): void {
    this.tone({ freq: 520, dur: 0.07, type: 'square', gain: 0.16 });
    this.tone({ freq: 784, dur: 0.1, type: 'square', gain: 0.16, delay: 0.06 });
  }

  public hurt(pan = 0): void {
    this.tone({ freq: 110, end: 48, dur: 0.2, type: 'sine', gain: 0.5, pan });
    this.noise({ dur: 0.12, freq: 400, type: 'lowpass', gain: 0.28, pan });
  }

  public pickup(kind: 'health' | 'ammo'): void {
    if (kind === 'ammo') {
      this.tone({ freq: 440, dur: 0.06, type: 'square', gain: 0.16 });
      this.tone({ freq: 587, dur: 0.1, type: 'square', gain: 0.14, delay: 0.06 });
    } else {
      this.tone({ freq: 660, dur: 0.07, type: 'sine', gain: 0.2 });
      this.tone({ freq: 990, dur: 0.1, type: 'sine', gain: 0.2, delay: 0.07 });
    }
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

  public enemyShot(pan = 0): void {
    this.noise({ dur: 0.07, freq: 1400, type: 'bandpass', q: 1.2, gain: 0.16, pan });
  }

  public melee(pan = 0): void {
    this.noise({ dur: 0.08, freq: 700, type: 'bandpass', gain: 0.32, pan });
    this.tone({ freq: 160, end: 70, dur: 0.1, type: 'triangle', gain: 0.28, pan });
  }

  public slam(): void {
    this.tone({ freq: 90, end: 30, dur: 0.3, type: 'sine', gain: 0.55 });
    this.noise({ dur: 0.2, freq: 300, type: 'lowpass', gain: 0.38 });
  }

  public spawn(): void {
    this.tone({ freq: 180, end: 360, dur: 0.18, type: 'triangle', gain: 0.1 });
  }

  public allyShot(pan = 0): void {
    // Distinct from enemy fire: brighter, shorter pew
    this.tone({ freq: 980, end: 360, dur: 0.07, type: 'square', gain: 0.1, pan });
    this.tone({ freq: 1960, dur: 0.04, type: 'sine', gain: 0.05, delay: 0.01, pan });
  }

  public allyDeploy(): void {
    this.tone({ freq: 260, end: 620, dur: 0.28, type: 'triangle', gain: 0.14 });
    this.noise({ dur: 0.18, freq: 2600, type: 'highpass', gain: 0.06, delay: 0.05 });
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
    this.route(gain, opts.pan);
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
    this.route(gain, opts.pan);
    src.start(t0);
    src.stop(t0 + opts.dur + 0.02);
  }

  /** Connect a finished voice: straight to master, or through a StereoPanner when panned. */
  private route(node: AudioNode, pan?: number): void {
    if (!this.master) return;
    if (pan !== undefined && Math.abs(pan) >= 0.02 && this.ctx) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      node.connect(panner);
      panner.connect(this.master);
    } else {
      node.connect(this.master);
    }
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}

