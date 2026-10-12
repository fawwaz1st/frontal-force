import { clamp } from '../core/math';

export type ShotSound =
  | 'ar' | 'smg' | 'shotgun' | 'rail'
  | 'dmr' | 'lmg' | 'pistol' | 'launcher' | 'beam' | 'burst';

interface ToneOpts {
  freq: number;
  end?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
  /** Stereo position −1 (left) … +1 (right); omitted = center (no panner node). */
  pan?: number;
  /** Attack time in seconds. Defaults to a short click-free ramp. */
  attack?: number;
  /** How much of this voice is sent to the room reverb, 0..1. */
  room?: number;
}

interface NoiseOpts {
  dur: number;
  freq?: number;
  q?: number;
  type?: BiquadFilterType;
  gain?: number;
  delay?: number;
  pan?: number;
  attack?: number;
  room?: number;
  /** Sweep the filter cutoff to this value over the voice's life. */
  freqEnd?: number;
}

/**
 * Zero-asset procedural sound effects via WebAudio.
 *
 * The whole kit is built from five primitives that are layered into every
 * sound: a transient click, a filtered noise body, a pitched thump, a tonal
 * tail, and a room send. A gunshot that is only one of those reads as a
 * "pew"; a gunshot built from all five reads as a gun. That layering, plus a
 * real room and distance attenuation, is the entire difference between the
 * old thin blips and this kit.
 *
 * Signal path:
 *
 *   voice -> [panner] -> dryBus ------------------+
 *                    \-> roomSend -> convolver --+--> saturation -> master -> compressor -> out
 *
 * The saturation stage is what stops a 24-enemy firefight from turning into a
 * clipped mess: it is a soft knee, so many simultaneous voices compress into
 * each other instead of summing into a square wave.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dryBus: GainNode | null = null;
  private roomSend: GainNode | null = null;
  private room: ConvolverNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private heartbeatTimer = 0;
  private targetVolume = 0.42;
  /** Room tone bed. Started with the drone, faded in only inside a run. */
  private ambienceGain: GainNode | null = null;
  /** Lowpass on the whole mix, driven by distance to the loudest recent event.
   *  Stands in for air absorption and the low-passing effect of distance. */
  private airFilter: BiquadFilterNode | null = null;

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
      const ctx = this.ctx;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 12;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.18;

      // Soft saturation: many voices summing at once compress into each other
      // instead of clipping. This is what makes a full firefight sound dense
      // rather than broken.
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.makeSaturationCurve(1.6);
      shaper.oversample = '2x';

      this.master = ctx.createGain();
      this.master.gain.value = this.targetVolume;

      // A gentle low-pass on the master stands in for distance. Everything is
      // routed through it, so a distant explosion is muffled while a nearby
      // one stays bright, without per-voice filter bookkeeping.
      this.airFilter = ctx.createBiquadFilter();
      this.airFilter.type = 'lowpass';
      this.airFilter.frequency.value = 20000;
      this.airFilter.Q.value = 0.0001;

      this.dryBus = ctx.createGain();
      this.dryBus.gain.value = 1;

      // Procedural room. The arena is concrete and open, so the impulse is
      // short and hard: a slap off the walls, not a cathedral.
      this.room = ctx.createConvolver();
      this.room.buffer = this.makeImpulse(1.05, 2.6);
      this.roomSend = ctx.createGain();
      this.roomSend.gain.value = 0.32;

      this.dryBus.connect(this.airFilter);
      this.roomSend.connect(this.room);
      this.room.connect(this.airFilter);
      this.airFilter.connect(shaper);
      shaper.connect(this.master);
      this.master.connect(compressor);
      compressor.connect(ctx.destination);

      this.noiseBuffer = this.makeNoise();
      this.startDrone();
      this.startAmbience();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  public setVolume(v: number): void {
    this.targetVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Attenuate the master low-pass with distance. Call with the distance to the
   * loudest thing happening; the filter eases toward the target so it never
   * zippers. Only the air absorption is modelled here (the gain falloff is per
   * voice), because a single shared filter is far cheaper than one per sound.
   */
  public setListenerDistance(metres: number): void {
    if (!this.airFilter || !this.ctx) return;
    // 18 kHz right next to you, down to 2.2 kHz at the far wall.
    const cutoff = clamp(18000 - metres * 340, 2200, 18000);
    this.airFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.12);
  }

  // -------------------------------------------------------------------------
  // Spatialisation. The listener frame lives here rather than at each call
  // site, because every call site that computed its own pan got it wrong in
  // the same way: it panned along the world X axis, which is only the player's
  // right if they happen to be facing -Z. Turn around and a sound on your
  // right arrives on your left.
  // -------------------------------------------------------------------------
  private readonly listener = { x: 0, z: 0, yaw: 0 };

  /** Update the listener frame. Call once per rendered frame. */
  public setListener(x: number, z: number, yaw: number): void {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  /**
   * Stereo pan of a world point: -1 hard left, +1 hard right, in the player's
   * own frame. The listener yaw is applied here so a sound stays on the same
   * side of the player's head as they turn, which is the whole point.
   */
  public panOf(x: number, z: number): number {
    const dx = x - this.listener.x;
    const dz = z - this.listener.z;
    if (dx * dx + dz * dz < 1e-6) return 0;
    // Rotate the offset into the listener's frame. The camera looks down -Z at
    // yaw 0, so "right" is +X rotated by yaw.
    const cos = Math.cos(this.listener.yaw);
    const sin = Math.sin(this.listener.yaw);
    const right = dx * cos - dz * sin;
    return clamp(right / Math.hypot(dx, dz), -1, 1);
  }

  /** Distance in metres from the listener to a world point. */
  public distanceOf(x: number, z: number): number {
    return Math.hypot(x - this.listener.x, z - this.listener.z);
  }

  /**
   * A gunshot at a world point. Handles pan, distance attenuation, and the
   * distance-dependent darkness in one place, so no call site has to think
   * about it.
   */
  public shotAt(kind: ShotSound, x: number, z: number): void {
    const distance = this.distanceOf(x, z);
    const pan = this.panOf(x, z);
    this.setListenerDistance(distance);
    this.shot(kind, pan, distance);
  }

  public enemyShotAt(x: number, z: number): void {
    const distance = this.distanceOf(x, z);
    this.setListenerDistance(distance);
    this.enemyShot(this.panOf(x, z), distance);
  }

  public blastAt(x: number, z: number): void {
    const distance = this.distanceOf(x, z);
    this.setListenerDistance(distance);
    this.blast(this.panOf(x, z), distance);
  }

  public barrelBlastAt(x: number, z: number): void {
    const distance = this.distanceOf(x, z);
    this.setListenerDistance(distance);
    this.barrelBlast(this.panOf(x, z), distance);
  }

  public impactAt(kind: 'concrete' | 'metal' | 'soft' | 'glass', x: number, z: number): void {
    const distance = this.distanceOf(x, z);
    this.impact(kind, this.panOf(x, z), distance);
  }

  public nearMissAt(x: number, z: number): void {
    this.nearMiss(this.panOf(x, z));
  }

  public killAt(x: number, z: number): void {
    this.kill(this.panOf(x, z), this.distanceOf(x, z));
  }

  /** Persistent bass drone under everything — started once on unlock(). */
  private startDrone(): void {
    if (!this.ctx || !this.dryBus || this.musicGain) return;
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
    this.musicGain.connect(this.dryBus);
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

  /**
   * A gunshot, built from four layers. Every weapon uses all four and differs
   * only in the numbers, which is what keeps ten guns in one family while each
   * stays identifiable:
   *
   *   1. TRANSIENT  a 2 ms high crack. This is the shot, not the body.
   *   2. BODY       filtered noise that sweeps dark as the air eats the highs.
   *   3. THUMP      a pitched sine dropping fast. This is the chest hit.
   *   4. TAIL       a low noise wash that carries into the room.
   *
   * `room` is deliberately high for the player's own gun: the room send is
   * what makes firing feel like it happens in the arena rather than in a
   * vacuum.
   */
  public shot(kind: ShotSound, pan = 0, distance = 0): void {
    // Per-shot jitter: ±6% pitch, ±10% level. Without it repeated fire sounds
    // like one frozen sample, which is the single strongest "cheap audio" tell.
    const jitter = 1 + (Math.random() - 0.5) * 0.12;
    // Distance attenuation. A shot 40 m away is roughly a quarter as loud and
    // loses its room tail, because the tail IS the distance cue: a far shot
    // that keeps its reverb sounds close but quiet, which is worse than either.
    const near = clamp(1 - distance / 55, 0.16, 1);
    const roomK = near * near;
    const level = (0.9 + Math.random() * 0.2) * near;
    const L = (v: number): number => v * level;
    const R = (v: number): number => v * roomK;
    switch (kind) {
      case 'ar':
        this.noise({ dur: 0.006, freq: 5200 * jitter, type: 'highpass', gain: L(0.5), attack: 0.001, pan });
        this.noise({ dur: 0.085, freq: 2200 * jitter, freqEnd: 380, type: 'bandpass', q: 0.9, gain: L(0.46), room: R(0.5), pan });
        this.tone({ freq: 190 * jitter, end: 48, dur: 0.09, type: 'triangle', gain: L(0.34), attack: 0.002, pan });
        this.noise({ dur: 0.2, freq: 320, type: 'lowpass', gain: L(0.14), room: R(0.7), pan });
        break;
      case 'smg':
        this.noise({ dur: 0.004, freq: 6200 * jitter, type: 'highpass', gain: L(0.4), attack: 0.001, pan });
        this.noise({ dur: 0.05, freq: 2800 * jitter, freqEnd: 700, type: 'bandpass', q: 1.1, gain: L(0.32), room: R(0.42), pan });
        this.tone({ freq: 300 * jitter, end: 110, dur: 0.05, type: 'triangle', gain: L(0.2), attack: 0.002, pan });
        this.noise({ dur: 0.12, freq: 500, type: 'lowpass', gain: L(0.1), room: R(0.6), pan });
        break;
      case 'shotgun':
        // The only gun whose BODY is longer than its transient: the shot is
        // the blast, so the noise leads and the crack supports it.
        this.noise({ dur: 0.012, freq: 3600 * jitter, type: 'highpass', gain: L(0.5), attack: 0.001, pan });
        this.noise({ dur: 0.3, freq: 1500 * jitter, freqEnd: 160, type: 'lowpass', gain: L(0.72), room: R(0.8), pan });
        this.tone({ freq: 120 * jitter, end: 32, dur: 0.22, type: 'sine', gain: L(0.6), attack: 0.003, pan });
        this.noise({ dur: 0.45, freq: 240, type: 'lowpass', gain: L(0.2), room: R(0.9), pan });
        break;
      case 'rail':
        // A capacitor discharge, not a powder charge: the tone leads.
        this.tone({ freq: 1500 * jitter, end: 120, dur: 0.26, type: 'sawtooth', gain: L(0.3), attack: 0.003, room: R(0.6), pan });
        this.tone({ freq: 760 * jitter, end: 90, dur: 0.3, type: 'sine', gain: L(0.26), attack: 0.004, room: R(0.6), pan });
        this.noise({ dur: 0.04, freq: 6400 * jitter, type: 'highpass', gain: L(0.4), attack: 0.001, pan });
        this.noise({ dur: 0.5, freq: 900, freqEnd: 180, type: 'bandpass', q: 0.7, gain: L(0.2), room: R(0.9), pan });
        break;
      case 'dmr':
        this.noise({ dur: 0.008, freq: 5600 * jitter, type: 'highpass', gain: L(0.55), attack: 0.001, pan });
        this.noise({ dur: 0.14, freq: 1900 * jitter, freqEnd: 300, type: 'bandpass', q: 0.8, gain: L(0.5), room: R(0.6), pan });
        this.tone({ freq: 165 * jitter, end: 44, dur: 0.16, type: 'triangle', gain: L(0.38), attack: 0.002, pan });
        this.noise({ dur: 0.34, freq: 380, type: 'lowpass', gain: L(0.16), room: R(0.85), pan });
        break;
      case 'lmg':
        this.noise({ dur: 0.008, freq: 4600 * jitter, type: 'highpass', gain: L(0.44), attack: 0.001, pan });
        this.noise({ dur: 0.12, freq: 1700 * jitter, freqEnd: 260, type: 'bandpass', q: 0.85, gain: L(0.48), room: R(0.62), pan });
        this.tone({ freq: 140 * jitter, end: 46, dur: 0.12, type: 'square', gain: L(0.26), attack: 0.003, pan });
        this.noise({ dur: 0.26, freq: 280, type: 'lowpass', gain: L(0.16), room: R(0.8), pan });
        break;
      case 'pistol':
        this.noise({ dur: 0.004, freq: 7000 * jitter, type: 'highpass', gain: L(0.4), attack: 0.001, pan });
        this.noise({ dur: 0.05, freq: 3000 * jitter, freqEnd: 800, type: 'bandpass', q: 1.2, gain: L(0.3), room: R(0.4), pan });
        this.tone({ freq: 380 * jitter, end: 130, dur: 0.05, type: 'square', gain: L(0.18), attack: 0.002, pan });
        this.noise({ dur: 0.1, freq: 600, type: 'lowpass', gain: L(0.08), room: R(0.55), pan });
        break;
      case 'launcher':
        // A thump, not a crack. The payload does the talking, so the launch is
        // all low end and no transient.
        this.tone({ freq: 105 * jitter, end: 30, dur: 0.3, type: 'sine', gain: L(0.65), attack: 0.006, room: R(0.7), pan });
        this.noise({ dur: 0.34, freq: 900, freqEnd: 140, type: 'lowpass', gain: L(0.5), room: R(0.8), pan });
        this.noise({ dur: 0.5, freq: 200, type: 'lowpass', gain: L(0.24), room: R(0.95), pan });
        break;
      case 'beam':
        // At 20 Hz this must not smear into a drone: a very short tonal tick
        // with no body and no tail, or 20 of them per second become a chord.
        this.tone({ freq: 1900 * jitter, end: 1560, dur: 0.028, type: 'sawtooth', gain: L(0.17), attack: 0.002, pan });
        this.noise({ dur: 0.02, freq: 5000, type: 'highpass', gain: L(0.1), attack: 0.001, pan });
        break;
      case 'burst':
        this.noise({ dur: 0.006, freq: 5400 * jitter, type: 'highpass', gain: L(0.44), attack: 0.001, pan });
        this.noise({ dur: 0.075, freq: 2400 * jitter, freqEnd: 460, type: 'bandpass', q: 0.95, gain: L(0.4), room: R(0.5), pan });
        this.tone({ freq: 240 * jitter, end: 80, dur: 0.07, type: 'triangle', gain: L(0.28), attack: 0.002, pan });
        this.noise({ dur: 0.18, freq: 340, type: 'lowpass', gain: L(0.12), room: R(0.65), pan });
        break;
    }
  }
  /**
   * Explosive detonation. A real blast has three separable parts and they must
   * arrive in order: the crack (the shock front), the boom (the low pressure
   * wave), and the debris tail (everything falling out of the air). Only
   * having the middle one is why the old blast read as a kick drum.
   */
  public blast(pan = 0, distance = 0): void {
    // Distance attenuates and darkens: a far blast is a thud, not a bang.
    const near = clamp(1 - distance / 60, 0.18, 1);
    this.noise({ dur: 0.02, freq: 5000, type: 'highpass', gain: 0.5 * near, attack: 0.001, pan });
    this.tone({ freq: 84, end: 24, dur: 0.6, type: 'sine', gain: 0.72 * near, attack: 0.004, pan, room: 0.9 * near });
    this.noise({ dur: 0.62, freq: 700, freqEnd: 90, type: 'lowpass', gain: 0.6 * near, room: near, pan });
    this.noise({ dur: 0.9, freq: 260, type: 'lowpass', gain: 0.28 * near, room: near, pan });
    if (near > 0.5) {
      // Debris only audible up close, which is what makes proximity matter.
      this.noise({ dur: 0.5, freq: 3200, freqEnd: 1400, type: 'bandpass', q: 0.6, gain: 0.16 * near, delay: 0.06, pan });
    }
  }

  public empty(): void {
    this.tone({ freq: 900, end: 620, dur: 0.05, type: 'square', gain: 0.07, attack: 0.002 });
    this.noise({ dur: 0.03, freq: 3000, type: 'highpass', gain: 0.05, attack: 0.001 });
  }

  public reload(): void {
    // Three separate mechanical events, not two beeps: magazine out, magazine
    // in, bolt. The gaps are what make it read as a sequence.
    this.noise({ dur: 0.05, freq: 1800, type: 'bandpass', q: 1.4, gain: 0.13, attack: 0.002 });
    this.tone({ freq: 480, end: 300, dur: 0.05, type: 'square', gain: 0.09, attack: 0.002 });
    this.noise({ dur: 0.06, freq: 2400, type: 'bandpass', q: 1.6, gain: 0.12, delay: 0.14, attack: 0.002 });
    this.tone({ freq: 340, end: 200, dur: 0.06, type: 'square', gain: 0.1, delay: 0.15, attack: 0.002 });
    this.noise({ dur: 0.05, freq: 3200, type: 'bandpass', q: 2, gain: 0.11, delay: 0.3, attack: 0.002 });
  }

  public hitmarker(headshot: boolean): void {
    if (headshot) {
      this.tone({ freq: 1568, dur: 0.05, type: 'square', gain: 0.13, attack: 0.002 });
      this.tone({ freq: 2093, dur: 0.12, type: 'square', gain: 0.11, delay: 0.045, attack: 0.002 });
    } else {
      this.tone({ freq: 2100, dur: 0.045, type: 'square', gain: 0.1, attack: 0.002 });
    }
  }

  /** Armour-plate impact: a short metallic clang, deliberately unlike the
   *  clean hitmarker so the player hears that the shot was absorbed. */
  public blocked(): void {
    this.tone({ freq: 320, dur: 0.06, type: 'triangle', gain: 0.13, attack: 0.002 });
    this.tone({ freq: 214, dur: 0.12, type: 'sawtooth', gain: 0.07, delay: 0.02, attack: 0.003 });
    this.noise({ dur: 0.08, freq: 2600, type: 'bandpass', q: 2.4, gain: 0.1, attack: 0.001 });
  }

  public charge(pan = 0): void {
    // Attack windup tell: a rising sine plus a rising filter sweep, so it is
    // audible even in a firefight where a pure tone would be masked.
    this.tone({ freq: 240, end: 720, dur: 0.3, type: 'sine', gain: 0.11, pan, attack: 0.01 });
    this.noise({ dur: 0.3, freq: 400, freqEnd: 2600, type: 'bandpass', q: 3, gain: 0.06, pan, attack: 0.01 });
  }

  public step(): void {
    this.noise({ dur: 0.06, freq: 240 + Math.random() * 70, type: 'bandpass', q: 1.1, gain: 0.11, attack: 0.002 });
  }

  public land(): void {
    this.noise({ dur: 0.16, freq: 900, freqEnd: 140, type: 'lowpass', gain: 0.32, room: 0.5 });
    this.tone({ freq: 88, end: 48, dur: 0.16, type: 'sine', gain: 0.34, attack: 0.003, room: 0.5 });
  }

  public weaponSwitch(): void {
    this.noise({ dur: 0.04, freq: 2200, type: 'bandpass', q: 1.8, gain: 0.1, attack: 0.002 });
    this.tone({ freq: 680, dur: 0.035, type: 'square', gain: 0.09, attack: 0.002 });
    this.tone({ freq: 900, dur: 0.035, type: 'square', gain: 0.08, delay: 0.055, attack: 0.002 });
  }

  public tick(): void {
    this.tone({ freq: 1200, dur: 0.05, type: 'sine', gain: 0.12, attack: 0.002 });
  }

  public record(): void {
    this.tone({ freq: 523, dur: 0.1, type: 'triangle', gain: 0.16, attack: 0.006, room: 0.4 });
    this.tone({ freq: 659, dur: 0.1, type: 'triangle', gain: 0.16, delay: 0.1, attack: 0.006, room: 0.4 });
    this.tone({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.17, delay: 0.2, attack: 0.006, room: 0.4 });
    this.tone({ freq: 1046, dur: 0.34, type: 'triangle', gain: 0.18, delay: 0.3, attack: 0.008, room: 0.5 });
  }

  /**
   * A kill. Two layers, because a kill is two pieces of information: it
   * happened (the crunch) and it counted (the chime).
   */
  public kill(pan = 0, distance = 0): void {
    const near = clamp(1 - distance / 50, 0.2, 1);
    this.noise({ dur: 0.09, freq: 1400, freqEnd: 300, type: 'lowpass', gain: 0.24 * near, attack: 0.001, pan });
    this.tone({ freq: 90, end: 44, dur: 0.12, type: 'sine', gain: 0.3 * near, attack: 0.003, pan });
    // The confirmation chime stays at full level regardless of distance: it is
    // interface feedback, not a diegetic sound, so it must not fade with range.
    this.tone({ freq: 660, dur: 0.09, type: 'square', gain: 0.13, delay: 0.02, attack: 0.003 });
    this.tone({ freq: 990, dur: 0.12, type: 'square', gain: 0.12, delay: 0.08, attack: 0.003 });
  }

  public hurt(pan = 0): void {
    this.tone({ freq: 110, end: 44, dur: 0.22, type: 'sine', gain: 0.5, pan, attack: 0.004 });
    this.noise({ dur: 0.16, freq: 900, freqEnd: 220, type: 'lowpass', gain: 0.3, pan, attack: 0.002 });
    // A short mid crack gives the hit an edge: pure low end reads as a thud
    // somewhere else, and the player needs to know it landed on THEM.
    this.noise({ dur: 0.05, freq: 2600, type: 'bandpass', q: 1.5, gain: 0.14, pan, attack: 0.001 });
  }

  public pickup(kind: 'health' | 'ammo'): void {
    if (kind === 'ammo') {
      this.tone({ freq: 440, dur: 0.06, type: 'square', gain: 0.16, attack: 0.003 });
      this.tone({ freq: 587, dur: 0.12, type: 'square', gain: 0.14, delay: 0.06, attack: 0.003 });
    } else {
      this.tone({ freq: 660, dur: 0.07, type: 'sine', gain: 0.2, attack: 0.004, room: 0.3 });
      this.tone({ freq: 990, dur: 0.14, type: 'sine', gain: 0.2, delay: 0.07, attack: 0.004, room: 0.3 });
    }
  }

  public waveStart(): void {
    this.tone({ freq: 110, end: 220, dur: 0.5, type: 'sawtooth', gain: 0.2, attack: 0.02, room: 0.5 });
    this.tone({ freq: 220, end: 440, dur: 0.44, type: 'sawtooth', gain: 0.12, delay: 0.2, attack: 0.02, room: 0.5 });
    this.noise({ dur: 0.8, freq: 300, freqEnd: 120, type: 'lowpass', gain: 0.14, room: 0.8 });
  }

  public waveClear(): void {
    this.tone({ freq: 523, dur: 0.12, type: 'triangle', gain: 0.2, attack: 0.006, room: 0.4 });
    this.tone({ freq: 659, dur: 0.12, type: 'triangle', gain: 0.2, delay: 0.1, attack: 0.006, room: 0.4 });
    this.tone({ freq: 784, dur: 0.28, type: 'triangle', gain: 0.22, delay: 0.2, attack: 0.008, room: 0.5 });
  }

  public enemyShot(pan = 0, distance = 0): void {
    const near = clamp(1 - distance / 60, 0.12, 1);
    this.noise({ dur: 0.05, freq: 1700, freqEnd: 500, type: 'bandpass', q: 1.3, gain: 0.17 * near, pan, attack: 0.002, room: 0.45 * near });
    this.tone({ freq: 260, end: 90, dur: 0.06, type: 'triangle', gain: 0.1 * near, pan, attack: 0.002 });
  }

  public melee(pan = 0): void {
    this.noise({ dur: 0.09, freq: 1200, freqEnd: 320, type: 'bandpass', q: 1.2, gain: 0.32, pan, attack: 0.002 });
    this.tone({ freq: 150, end: 60, dur: 0.12, type: 'triangle', gain: 0.3, pan, attack: 0.003 });
  }

  public slam(): void {
    this.tone({ freq: 84, end: 26, dur: 0.36, type: 'sine', gain: 0.58, attack: 0.005, room: 0.8 });
    this.noise({ dur: 0.26, freq: 500, freqEnd: 110, type: 'lowpass', gain: 0.4, room: 0.8 });
  }

  public spawn(): void {
    this.tone({ freq: 180, end: 360, dur: 0.18, type: 'triangle', gain: 0.1, attack: 0.01, room: 0.4 });
    this.noise({ dur: 0.22, freq: 600, freqEnd: 1800, type: 'bandpass', q: 1.6, gain: 0.07, room: 0.5 });
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

  /** Grenade leaves the hand — a cloth-and-metal swish. */
  public grenadeThrow(): void {
    this.noise({ dur: 0.12, freq: 900, type: 'bandpass', q: 0.8, gain: 0.14 });
    this.tone({ freq: 420, end: 260, dur: 0.09, type: 'triangle', gain: 0.08 });
  }

  /** Dash: a short filtered whoosh. Pitch rises with charge for readability. */
  public dash(): void {
    this.noise({ dur: 0.24, freq: 600, freqEnd: 1500, type: 'bandpass', q: 0.7, gain: 0.24, attack: 0.01, room: 0.5 });
    this.tone({ freq: 160, end: 520, dur: 0.2, type: 'sine', gain: 0.1, attack: 0.008, room: 0.4 });
  }

  /** Quick melee swing — a whip of band-passed noise. */
  public swing(): void {
    this.noise({ dur: 0.16, freq: 2200, freqEnd: 700, type: 'bandpass', q: 1.4, gain: 0.22, attack: 0.008 });
  }

  /** Blade connects: meaty thud plus a metal tick. */
  public slashHit(): void {
    this.tone({ freq: 180, end: 56, dur: 0.14, type: 'triangle', gain: 0.34, attack: 0.002 });
    this.noise({ dur: 0.07, freq: 3400, freqEnd: 1800, type: 'highpass', gain: 0.16, attack: 0.001 });
    this.noise({ dur: 0.12, freq: 700, type: 'lowpass', gain: 0.2, attack: 0.002 });
  }

  /** Glory-kill window opened: a rising two-note sting. */
  public stagger(): void {
    this.tone({ freq: 880, dur: 0.06, type: 'square', gain: 0.14, attack: 0.003 });
    this.tone({ freq: 1320, dur: 0.14, type: 'square', gain: 0.12, delay: 0.05, attack: 0.003 });
  }

  /** Card taken from the draft — a clean two-tone confirm. */
  public upgrade(): void {
    this.tone({ freq: 660, dur: 0.09, type: 'triangle', gain: 0.18, attack: 0.005, room: 0.4 });
    this.tone({ freq: 990, dur: 0.18, type: 'triangle', gain: 0.2, delay: 0.07, attack: 0.006, room: 0.4 });
  }

  /** Reroll / kiosk purchase. */
  public purchase(): void {
    this.tone({ freq: 520, dur: 0.05, type: 'square', gain: 0.14, attack: 0.003 });
    this.tone({ freq: 780, dur: 0.05, type: 'square', gain: 0.14, delay: 0.05, attack: 0.003 });
    this.tone({ freq: 1040, dur: 0.12, type: 'square', gain: 0.14, delay: 0.1, attack: 0.004 });
  }

  /** Insufficient salvage / rejected action. */
  public denied(): void {
    this.tone({ freq: 220, dur: 0.1, type: 'sawtooth', gain: 0.12, attack: 0.003 });
    this.tone({ freq: 165, dur: 0.16, type: 'sawtooth', gain: 0.12, delay: 0.08, attack: 0.003 });
  }

  /** Boss / elite arrival: a low horn stab. */
  public bossSpawn(): void {
    this.tone({ freq: 110, end: 82, dur: 0.75, type: 'sawtooth', gain: 0.3, attack: 0.05, room: 0.8 });
    this.tone({ freq: 55, end: 41, dur: 0.95, type: 'sine', gain: 0.34, attack: 0.06, room: 0.8 });
    this.noise({ dur: 0.7, freq: 600, freqEnd: 180, type: 'lowpass', gain: 0.22, room: 0.9 });
  }

  /** Elite kill: the record fanfare, but shorter and darker. */
  public eliteKill(): void {
    this.tone({ freq: 392, dur: 0.1, type: 'triangle', gain: 0.2, attack: 0.005, room: 0.4 });
    this.tone({ freq: 523, dur: 0.1, type: 'triangle', gain: 0.2, delay: 0.08, attack: 0.005, room: 0.4 });
    this.tone({ freq: 659, dur: 0.26, type: 'triangle', gain: 0.22, delay: 0.16, attack: 0.006, room: 0.5 });
  }

  /** New achievement unlocked. */
  public achievement(): void {
    this.tone({ freq: 784, dur: 0.08, type: 'sine', gain: 0.18, attack: 0.005, room: 0.4 });
    this.tone({ freq: 1046, dur: 0.08, type: 'sine', gain: 0.18, delay: 0.08, attack: 0.005, room: 0.4 });
    this.tone({ freq: 1318, dur: 0.34, type: 'sine', gain: 0.2, delay: 0.16, attack: 0.008, room: 0.5 });
  }

  /**
   * Ambient hazard cue: tesla coil about to fire. A rising tone under a rising
   * filter sweep, so it cuts through a firefight instead of being masked.
   */
  public hazardCharge(): void {
    this.tone({ freq: 300, end: 1200, dur: 0.45, type: 'sawtooth', gain: 0.1, attack: 0.02, room: 0.5 });
    this.noise({ dur: 0.45, freq: 800, freqEnd: 4200, type: 'bandpass', q: 3, gain: 0.07, attack: 0.02, room: 0.5 });
  }

  /** Barrel detonation: a bigger, dirtier blast than a grenade. */
  public barrelBlast(pan = 0, distance = 0): void {
    const near = clamp(1 - distance / 70, 0.15, 1);
    this.noise({ dur: 0.03, freq: 4200, type: 'highpass', gain: 0.45 * near, attack: 0.001, pan });
    this.tone({ freq: 66, end: 22, dur: 0.85, type: 'sine', gain: 0.8 * near, attack: 0.005, pan, room: 1 });
    this.noise({ dur: 0.8, freq: 560, freqEnd: 80, type: 'lowpass', gain: 0.68 * near, room: 1, pan });
    this.noise({ dur: 1.1, freq: 220, type: 'lowpass', gain: 0.3 * near, room: 1, pan });
    if (near > 0.45) {
      this.noise({ dur: 0.6, freq: 2800, freqEnd: 1200, type: 'bandpass', q: 0.6, gain: 0.2 * near, delay: 0.08, pan });
    }
  }

  /**
   * A bullet passing close by: a short, sharp whizz that pans across. This is
   * the single most valuable missing cue in an FPS, because it is how a player
   * learns they are being shot at from a direction they are not looking.
   */
  public nearMiss(pan = 0): void {
    const p = clamp(pan, -1, 1);
    this.noise({ dur: 0.11, freq: 2600, freqEnd: 700, type: 'bandpass', q: 4.5, gain: 0.26, pan: p, attack: 0.004 });
    this.tone({ freq: 1500, end: 420, dur: 0.09, type: 'sine', gain: 0.1, pan: p, attack: 0.003 });
  }

  /**
   * A surface impact. The material is the whole point: the player uses the
   * sound to tell concrete from steel from fabric without looking.
   */
  public impact(kind: 'concrete' | 'metal' | 'soft' | 'glass', pan = 0, distance = 0): void {
    const near = clamp(1 - distance / 45, 0.2, 1);
    switch (kind) {
      case 'metal':
        // Ringing partials: metal is the only material that sustains a pitch.
        this.noise({ dur: 0.03, freq: 5200, type: 'highpass', gain: 0.32 * near, attack: 0.001, pan });
        this.tone({ freq: 1180, end: 900, dur: 0.34, type: 'sine', gain: 0.16 * near, attack: 0.002, pan, room: 0.7 });
        this.tone({ freq: 1780, end: 1500, dur: 0.24, type: 'sine', gain: 0.1 * near, attack: 0.002, pan, room: 0.7 });
        break;
      case 'soft':
        // No transient at all: fabric and flesh absorb the crack.
        this.noise({ dur: 0.07, freq: 700, freqEnd: 260, type: 'lowpass', gain: 0.3 * near, attack: 0.004, pan });
        break;
      case 'glass':
        this.noise({ dur: 0.02, freq: 7000, type: 'highpass', gain: 0.3 * near, attack: 0.001, pan });
        this.noise({ dur: 0.4, freq: 5200, freqEnd: 2600, type: 'bandpass', q: 1.4, gain: 0.16 * near, attack: 0.002, pan });
        break;
      default:
        // Concrete: a dry crack with a short grit tail and no ring.
        this.noise({ dur: 0.02, freq: 4600, type: 'highpass', gain: 0.3 * near, attack: 0.001, pan });
        this.noise({ dur: 0.1, freq: 1500, freqEnd: 500, type: 'bandpass', q: 1, gain: 0.26 * near, attack: 0.002, pan, room: 0.5 });
        this.tone({ freq: 220, end: 110, dur: 0.06, type: 'triangle', gain: 0.14 * near, attack: 0.002, pan });
        break;
    }
  }

  /**
   * The room tone of the arena: a very quiet filtered noise bed plus a slow
   * sub. Without it, silence between waves reads as "the game stopped" rather
   * than "the arena is quiet", and every gunshot sounds like it is outdoors.
   */
  public startAmbience(): void {
    if (!this.ctx || !this.dryBus || this.ambienceGain) return;
    const ctx = this.ctx;
    const bed = ctx.createBufferSource();
    bed.buffer = this.noiseBuffer;
    bed.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.5;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0;
    bed.connect(lp);
    lp.connect(hp);
    hp.connect(this.ambienceGain);
    this.ambienceGain.connect(this.dryBus);
    bed.start();

    // Slow sub: the arena itself breathing. Two detuned sines beat against
    // each other, which is what makes it feel like a space and not a hiss.
    for (const freq of [38, 38.6]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = 0.05;
      osc.connect(g);
      g.connect(this.ambienceGain);
      osc.start();
    }
  }

  /** Fade the room tone in or out (menu vs arena). */
  public setAmbience(on: boolean): void {
    if (!this.ambienceGain || !this.ctx) return;
    this.ambienceGain.gain.setTargetAtTime(on ? 0.05 : 0, this.ctx.currentTime, 0.6);
  }

  /**
   * A pitched voice with a real ADSR envelope.
   *
   * The old version ramped gain straight down from the peak with no attack,
   * which is why every sound had a click at the front and no body: a waveform
   * that jumps to full amplitude instantly produces a broadband transient, and
   * a listener hears that as a tick, not as a hit. A 3-8 ms attack removes the
   * click and, more importantly, lets the note bloom.
   */
  private tone(opts: ToneOpts): void {
    if (!this.ctx || !this.dryBus) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const peak = Math.max(0.0002, opts.gain ?? 0.2);
    const attack = Math.max(0.002, Math.min(opts.attack ?? 0.005, opts.dur * 0.5));
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, opts.freq), t0);
    if (opts.end !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.end), t0 + opts.dur);
    }
    // attack -> exponential decay. The exponential tail is what makes a sound
    // feel like it is in a space rather than gated off.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(gain);
    this.route(gain, opts.pan, opts.room);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  /**
   * A filtered noise voice. `freqEnd` sweeps the cutoff, which is what turns a
   * static hiss into a crack: a gunshot's noise body is bright at the front
   * and dark by the tail as the air and the room eat the highs.
   */
  private noise(opts: NoiseOpts): void {
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const peak = Math.max(0.0002, opts.gain ?? 0.3);
    const attack = Math.max(0.001, Math.min(opts.attack ?? 0.003, opts.dur * 0.5));
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    // A random offset per voice: without it every noise voice plays the SAME
    // second of noise, so repeated shots phase-lock and sound like one sample.
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.setValueAtTime(Math.max(20, opts.freq ?? 1000), t0);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, opts.freqEnd),
        t0 + opts.dur,
      );
    }
    filter.Q.value = opts.q ?? 0.8;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(filter);
    filter.connect(gain);
    this.route(gain, opts.pan, opts.room);
    const offset = Math.random() * (this.noiseBuffer.duration - opts.dur - 0.05);
    src.start(t0, Math.max(0, offset));
    src.stop(t0 + opts.dur + 0.02);
  }

  /**
   * Connect a finished voice. Every voice goes to the dry bus; `room` adds a
   * send to the convolver, which is what puts the sound in the arena instead
   * of in the player's head.
   */
  private route(node: AudioNode, pan?: number, room?: number): void {
    if (!this.dryBus || !this.roomSend) return;
    let tail: AudioNode = node;
    if (pan !== undefined && Math.abs(pan) >= 0.02 && this.ctx) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      node.connect(panner);
      tail = panner;
    }
    tail.connect(this.dryBus);
    if (room && room > 0) {
      const send = this.ctx?.createGain();
      if (!send) return;
      send.gain.value = clamp(room, 0, 1);
      tail.connect(send);
      send.connect(this.roomSend);
    }
  }

  /** Soft-clip transfer curve for the saturation stage. */
  private makeSaturationCurve(drive: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    return curve;
  }

  /**
   * Procedural impulse response: exponentially decaying noise with a short
   * early-reflection cluster. No asset, and the decay is tunable per arena.
   */
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Early reflections in the first 60 ms, then a smooth exponential tail.
        const early = t < 0.06 ? (Math.random() * 2 - 1) * 0.6 : 0;
        const tail = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        data[i] = early + tail;
      }
    }
    return buffer;
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}

