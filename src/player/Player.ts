import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { InputFrame } from '../input/Input';
import { clamp, damp } from '../core/math';

const EYE_STAND = 0.72;
const EYE_CROUCH = 0.39;
const GRAVITY = 19;
const JUMP_SPEED = 6.1;
const WALK_SPEED = 4.5;
const SPRINT_MULT = 1.7;
const CROUCH_MULT = 0.5;
const SLIDE_SPEED = 5.5; // decays across SLIDE_TIME
/** Added on top of the decaying slide speed, so entry is a burst. */
const SLIDE_ENTRY_BONUS = 3;
const SLIDE_TIME = 0.65;
const COYOTE_TIME = 0.1;
const JUMP_BUFFER_TIME = 0.14;
const STAND_RADIUS = 0.45;
const CROUCH_RADIUS = 0.38;
const STAND_SEGMENT = 0.9;
const CROUCH_SEGMENT = 0.4;
/**
 * How far the stand-up probe is lifted off the floor, in metres.
 *
 * The probe's bottom cap lands EXACTLY on the floor plane when it is built at
 * `feet.y + STAND_RADIUS`, and `Octree.capsuleIntersect` reports that flush
 * contact as a hit. The result was a player who could crouch and then never
 * stand up again, anywhere in the arena, because the floor was always in the
 * way. A few centimetres of clearance is below any real ceiling and above the
 * floating-point noise of the floor's own triangles.
 */
const STAND_PROBE_LIFT = 0.04;
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 17; // ≈5.9 s of sprint
const STAMINA_REGEN = 24;
const STAMINA_RESUME = 30; // sprint re-arms above this
const ADS_FOV = 64; // ~15% zoom under iron sights
const SUBSTEPS = 4;
/** Radians of yaw/pitch per mouse count at sensitivity 1.0 (CS-like). */
const LOOK_SENS = 0.0021;
/**
 * Aim recoil recovery rate. Research (CS2 / Apex): releasing the trigger must
 * let the view settle back onto the pre-fire aim point within roughly 0.4-0.5 s,
 * which is what makes a spray pattern learnable rather than random.
 */
const RECOIL_RECOVERY = 9;
/**
 * Deterministic recoil pattern. Vertical climb dominates; the horizontal drift
 * alternates and grows, so a long spray walks up and then side to side. These
 * are fractions of the weapon's authored `recoil` value, indexed by shot number
 * within the current trigger group (clamped at the table end).
 */
const RECOIL_PATTERN_Y = [1, 1.25, 1.15, 1.3, 1.4, 1.2, 1.35, 1.45, 1.25, 1.4];
const RECOIL_PATTERN_X = [0, 0.12, -0.16, 0.26, -0.32, 0.42, -0.5, 0.58, -0.66, 0.74];
/** Shots after which the pattern resets (≈0.5 s at the AR's 8/s cadence). */
const RECOIL_RESET_TIME = 0.45;
const REDUCE_SHAKE =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Player {
  public readonly camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 200);
  public readonly collider = new Capsule(
    new THREE.Vector3(0, STAND_RADIUS, 0),
    new THREE.Vector3(0, STAND_RADIUS + STAND_SEGMENT, 0),
    STAND_RADIUS,
  );

  public health = 100;
  public maxHealth = 100;
  public dead = false;
  /** Absorbing shield bought at the kiosk: soaks damage before health. */
  public shield = 0;
  /** External slow (Glacial affix), 0..1 — multiplies the movement target. */
  private slowFraction = 0;
  /** Active dash: direction and remaining time. Null when not dashing. */
  private dashRemaining = 0;
  private dashSpeed = 0;
  private dashVec = new THREE.Vector3();
  public onDamaged: ((from: THREE.Vector3 | null) => void) | null = null;
  /** Actual health lost by the last hit, for honest damage-taken statistics.
   *  A shield-absorbed hit reports 0 because the health bar did not move. */
  public lastDamageTaken = 0;
  /**
   * Who hurt us last, as a short player-facing label ("EXPLODER", "BURN",
   * "BARREL"). The HUD prints this next to the damage arc, which is the whole
   * answer to "I took damage from nowhere": every source must name itself.
   */
  public lastDamageSource = '';
  /** First-person body (Game adds it to the scene) — visible when you look down. */
  public readonly body = new THREE.Group();
  /** Fires once per touchdown after an airborne stretch (land sfx + viewmodel dip).
   *  `fallSpeed` is the vertical impact speed in m/s at contact. */
  public onLanded: ((fallSpeed: number) => void) | null = null;

  private shake = 0;
  /** Render-interpolation snapshots of the camera position (tick N-1 / N). */
  private readonly camPrev = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();

  // Body-rig groups (pose driven from updateCamera's bob state)
  private readonly bTorso = new THREE.Group();
  private readonly bLegL = new THREE.Group();
  private readonly bLegR = new THREE.Group();
  private readonly bArmL = new THREE.Group();
  private readonly bArmR = new THREE.Group();

  /** Decaying camera jitter — called on damage. Silenced under reduced-motion. */
  public addShake(amount: number): void {
    if (REDUCE_SHAKE) return;
    this.shake = Math.min(this.shake + amount, 0.55);
  }

  /** World-space velocity. Read-only for consumers (enemy ballistic lead). */
  public readonly velocity = new THREE.Vector3();
  private readonly feetPosition = new THREE.Vector3();
  private readonly standTest = new Capsule(
    new THREE.Vector3(),
    new THREE.Vector3(0, STAND_SEGMENT, 0),
    STAND_RADIUS,
  );
  private grounded = false;
  private coyoteTimer = 0;
  private jumpBuffer = 0;
  private crouched = false;
  /** Committed direction of the active slide (see update()). */
  private readonly slideDir = new THREE.Vector3();
  /** Fires once when a slide starts, so the owner can play feedback. */
  public onSlide: (() => void) | null = null;
  private yaw = 0;
  private pitch = 0;
  /** Camera-only kick — never moves the point of aim. */
  private recoil = 0;
  /** Aim-affecting recoil, in radians. Deterministic and recoverable. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  /** Shot index within the current trigger group — drives the pattern. */
  private recoilIndex = 0;
  private recoilResetT = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  /** Current eye height above the capsule end — crouch lowers it. */
  public eyeHeight = EYE_STAND;
  private slideTimer = 0;
  private wasCrouching = false;
  private stamina = STAMINA_MAX;
  private exhausted = false;
  private sprintLocked = false;
  private sprinting = false;
  private adsT = 0;
  /**
   * Aimed field of view for the equipped weapon, in degrees. Set by the weapon
   * controller from the weapon definition, so aiming a scoped rifle is a real
   * change of sight picture and not a cosmetic one.
   */
  public adsFov = ADS_FOV;
  /**
   * Movement speed multiplier from the equipped weapon's weight. Read from the
   * weapon each step by the owner, so a heavy gun really costs mobility.
   */
  public weaponMoveMul = 1;
  private wasAirborne = false;
  private sensitivity = 1;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpMove = new THREE.Vector3();
  private readonly tmpDisp = new THREE.Vector3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  public constructor(private readonly octree: Octree) {
    this.buildBody();
  }

  /** First-person body: chest + collar + arms you can look down at; legs stay on the floor. */
  private buildBody(): void {
    const fatig = new THREE.MeshStandardMaterial({ color: 0x2b2f22, roughness: 0.8, metalness: 0.1 });
    const vest = new THREE.MeshStandardMaterial({ color: 0x171a12, roughness: 0.6, metalness: 0.3 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x14170f, roughness: 0.9, metalness: 0.05 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x0d0f0a, roughness: 0.7, metalness: 0.15 });
    const strip = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: 0xff9f1c, emissiveIntensity: 1.6, roughness: 0.4,
    });
    const mesh = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number, y: number, z: number,
      parent: THREE.Object3D,
      shadow = false,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // Torso block — drops as one unit when crouching (eye sits at ~2.07, so
    // collar/head band must reach just under it; gaps below chest = floating torso)
    mesh(new THREE.BoxGeometry(0.46, 0.5, 0.28), vest, 0, 1.42, 0, this.bTorso, true);
    mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), fatig, 0, 1.07, 0, this.bTorso, true);
    mesh(new THREE.BoxGeometry(0.22, 0.1, 0.2), vest, 0, 1.72, 0, this.bTorso);
    mesh(new THREE.BoxGeometry(0.16, 0.05, 0.02), strip, 0, 1.5, 0.148, this.bTorso);
    for (const side of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.15, 0.13, 0.24), vest, side * 0.3, 1.55, 0, this.bTorso, true);
      const arm = side < 0 ? this.bArmL : this.bArmR;
      arm.position.set(side * 0.3, 1.58, 0);
      this.bTorso.add(arm);
      mesh(new THREE.BoxGeometry(0.11, 0.4, 0.12), fatig, 0, -0.2, 0, arm);
      mesh(new THREE.BoxGeometry(0.1, 0.12, 0.11), glove, 0, -0.45, 0, arm);
    }
    this.body.add(this.bTorso);

    // Legs hang off the root so feet stay planted through crouch
    for (const side of [-1, 1]) {
      const leg = side < 0 ? this.bLegL : this.bLegR;
      leg.position.set(side * 0.14, 1.0, 0);
      this.body.add(leg);
      mesh(new THREE.BoxGeometry(0.15, 0.48, 0.16), fatig, 0, -0.24, 0, leg, true);
      mesh(new THREE.BoxGeometry(0.14, 0.42, 0.15), vest, 0, -0.65, 0, leg);
      mesh(new THREE.BoxGeometry(0.15, 0.1, 0.26), boot, 0, -0.93, 0.04, leg);
    }
  }

  /** Sync body to collider + gait — shares bob state with the camera. */
  private updateBodyPose(moveAmount: number, sprinting: boolean): void {
    this.body.position.set(
      this.collider.start.x,
      this.position.y,
      this.collider.start.z,
    );
    this.body.rotation.y = this.yaw;
    const drop = EYE_STAND - this.eyeHeight; // 0..0.67 while crouched
    this.bTorso.position.y = -drop * 0.5;
    const gait = moveAmount > 0.1 && this.grounded
      ? Math.sin(this.bobPhase * 2) * this.bobAmp * (sprinting ? 1.2 : 1)
      : 0;
    const squat = drop * 0.55;
    this.bLegL.rotation.x = gait * 0.7 + squat * 0.8;
    this.bLegR.rotation.x = -gait * 0.7 + squat * 0.5;
    this.bArmL.rotation.x = -gait * 0.55;
    this.bArmR.rotation.x = gait * 0.55;
    // Shoulders counter-rotate against the hips while striding
    this.bTorso.rotation.y = -gait * 0.1;
  }

  public get position(): THREE.Vector3 {
    return this.feetPosition.set(
      this.collider.start.x,
      this.collider.start.y - this.collider.radius,
      this.collider.start.z,
    );
  }

  public get yawAngle(): number {
    return this.yaw + this.recoilYaw;
  }

  /** Raw mouse yaw without recoil — for HUD elements that must not shake. */
  public get inputYaw(): number {
    return this.yaw;
  }

  /**
   * Aim accuracy input: 0 = perfectly still, 1 = full sprint speed.
   * Spread must be driven by ACTUAL velocity, not by "is a key held" — the
   * whole point of counter-strafing is that releasing the key is not enough;
   * the player must wait for the velocity to bleed off.
   */
  public get moveFraction(): number {
    return clamp(this.horizontalSpeed / (WALK_SPEED * SPRINT_MULT), 0, 1);
  }

  /** True while airborne — spread takes a large penalty. */
  public get airborne(): boolean {
    return !this.grounded;
  }

  public get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  public get isGrounded(): boolean {
    return this.grounded;
  }

  public get isSprinting(): boolean {
    return this.sprinting;
  }

  public get isAiming(): boolean {
    return this.adsT > 0.5;
  }

  /**
   * Ray origin for hitscan. Returns the SIMULATION eye (not the interpolated
   * render camera): a shot is resolved against the tick that fired it, so it
   * must use that tick's pose, never a render-time approximation.
   */
  public eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      this.collider.start.x,
      this.collider.end.y + this.eyeHeight,
      this.collider.start.z,
    );
  }

  public forward(out: THREE.Vector3): THREE.Vector3 {
    this.lookEuler.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0);
    return out.set(0, 0, -1).applyEuler(this.lookEuler);
  }

  /**
   * Apply mouse/touch look. Called ONCE PER RENDERED FRAME, outside the fixed
   * step: mouse deltas are a displacement in counts, not a rate, so there is
   * deliberately no `dt` here. Applying them per tick instead would quantise
   * the view to 60 Hz and re-introduce a 16.7 ms staircase on high-refresh
   * displays.
   */
  public look(dx: number, dy: number): void {
    if (this.dead) return;
    const sens = LOOK_SENS * this.sensitivity * (1 - 0.45 * this.adsT);
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.35, 1.35);
  }

  public reset(spawn: THREE.Vector3, yaw: number): void {
    this.collider.radius = STAND_RADIUS;
    this.collider.start.set(spawn.x, spawn.y + STAND_RADIUS, spawn.z);
    this.collider.end.set(spawn.x, spawn.y + STAND_RADIUS + STAND_SEGMENT, spawn.z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoil = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilIndex = 0;
    this.recoilResetT = 0;
    this.shake = 0;
    this.health = this.maxHealth;
    this.dead = false;
    this.eyeHeight = EYE_STAND;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.slideTimer = 0;
    this.wasCrouching = false;
    this.stamina = STAMINA_MAX;
    this.exhausted = false;
    this.sprintLocked = false;
    this.sprinting = false;
    this.adsT = 0;
    this.wasAirborne = false;
    this.shield = 0;
    this.slowFraction = 0;
    this.dashRemaining = 0;
    this.grounded = true;
    this.coyoteTimer = COYOTE_TIME;
    this.jumpBuffer = 0;
    this.crouched = false;
    this.bTorso.position.y = 0;
    this.bTorso.rotation.y = 0;
    this.bLegL.rotation.x = 0;
    this.bLegR.rotation.x = 0;
    this.bArmL.rotation.x = 0;
    this.bArmR.rotation.x = 0;
    this.body.position.set(spawn.x, spawn.y, spawn.z);
    this.body.rotation.set(0, yaw, 0);
    this.camPrev.set(spawn.x, spawn.y + STAND_RADIUS + STAND_SEGMENT + EYE_STAND, spawn.z);
    this.camPos.copy(this.camPrev);
    this.camera.position.copy(this.camPos);
    this.camera.rotation.set(0, yaw, 0, 'YXZ');
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
  }

  public setSensitivity(mult: number): void {
    this.sensitivity = mult;
  }

  public addRecoil(amount: number): void {
    // Camera-only kick (the gun punches back, the aim does not move).
    this.recoil = Math.min(this.recoil + amount, 0.35);
    // Aim-affecting recoil: deterministic pattern, indexed by shot number.
    if (this.recoilResetT <= 0) this.recoilIndex = 0;
    const i = Math.min(this.recoilIndex, RECOIL_PATTERN_Y.length - 1);
    this.recoilPitch += amount * (RECOIL_PATTERN_Y[i] ?? 1);
    this.recoilYaw += amount * (RECOIL_PATTERN_X[i] ?? 0);
    this.recoilIndex += 1;
    this.recoilResetT = RECOIL_RESET_TIME;
  }

  /** Shot number within the current trigger group — the spread model needs it
   *  to guarantee a perfectly accurate first shot. */
  public get shotIndex(): number {
    return this.recoilIndex;
  }

  /** Force the next shot to count as the first of a group (reload / swap). */
  public resetRecoilGroup(): void {
    this.recoilIndex = 0;
    this.recoilResetT = 0;
  }

  public damage(amount: number, from: THREE.Vector3 | null = null, source = ''): void {
    if (this.dead) return;
    // Challenge wager first: the multiplier is part of the contract the player
    // signed up for, so it applies before armor and the shield.
    const incoming = amount * this.incomingDamageMul;
    // Shield soaks first, then health. The split is applied before the shake
    // and the HUD flash so an absorbed hit still reads as a hit.
    let remaining = incoming;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
    }
    const healthLost = Math.min(this.health, Math.max(0, remaining));
    this.lastDamageTaken = healthLost;
    this.lastDamageSource = source;
    if (remaining > 0) this.health = Math.max(0, this.health - remaining);
    this.addShake(Math.min(0.5, incoming * 0.03));
    this.onDamaged?.(from);
    if (this.health <= 0) this.dead = true;
  }

  public heal(amount: number): void {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Grant an absorbing shield (kiosk purchase). */
  public addShield(amount: number): void {
    this.shield = Math.min(200, this.shield + amount);
  }

  /**
   * Apply the run's max-health multiplier. Called whenever the card pool
   * changes; the current health is scaled with it so a +20% max health card
   * is an immediate, felt benefit rather than a number on a panel.
   */
  public applyMods(maxHealthMul: number): void {
    const next = Math.round(100 * maxHealthMul);
    if (next === this.maxHealth) return;
    const fraction = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    this.maxHealth = next;
    this.health = Math.min(next, Math.round(next * fraction));
  }

  /**
   * Multiplier on every hit the player takes, owned by the run's challenges
   * (Glass Cannon doubles it). Applied in `damage()` so every source — bolts,
   * blasts, burn ticks, hazards — goes through exactly one place.
   */
  public incomingDamageMul = 1;

  /** External slow applied by the Glacial affix (0 = none, 1 = fully slowed). */
  public setSlow(fraction: number): void {
    this.slowFraction = clamp(fraction, 0, 0.9);
  }

  /** Begin a dash: the player is driven along `dir` for `time` seconds. */
  public startDash(dir: THREE.Vector3, speed: number, time: number): void {
    this.dashVec.copy(dir).setY(0);
    if (this.dashVec.lengthSq() < 1e-6) this.dashVec.set(0, 0, -1);
    this.dashVec.normalize();
    this.dashSpeed = speed;
    this.dashRemaining = time;
  }

  public clearDash(): void {
    this.dashRemaining = 0;
  }

  public get isDashing(): boolean {
    return this.dashRemaining > 0;
  }

  public update(dt: number, input: InputFrame, dashDir: THREE.Vector3 | null = null): void {
    if (this.dead) {
      this.updateCamera(dt, 0, false);
      return;
    }

    // Look is applied per rendered frame (see `look()`), not here.
    this.tmpDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.tmpRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.tmpMove.set(0, 0, 0)
      .addScaledVector(this.tmpDir, -input.moveZ)
      .addScaledVector(this.tmpRight, input.moveX);
    const moving = this.tmpMove.lengthSq() > 0.001;
    if (moving) this.tmpMove.normalize();

    const wantsCrouch = input.crouchHeld;
    const wantsSprint = input.sprintHeld && input.moveZ < 0 && moving;
    if (this.stamina <= 0) this.exhausted = true;
    if (!input.sprintHeld) this.sprintLocked = false;
    if (wantsSprint && this.stamina <= 0) this.sprintLocked = true;
    // Sprint is evaluated WITHOUT the crouch term. Crouch used to cancel
    // sprint, which made the slide condition below (`sprinting && crouch`)
    // impossible to satisfy: the slide could never fire. Sprint now stays
    // true for the frame the crouch key lands, which is what starts a slide.
    const canSprint = wantsSprint && !this.exhausted && !this.sprintLocked;
    this.sprinting = canSprint;
    if (canSprint) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
      if (this.exhausted && this.stamina >= STAMINA_RESUME) this.exhausted = false;
    }
    // Slide entry: crouch pressed while sprinting, grounded, moving, and not
    // already crouched. `wasCrouching` guards the edge so holding C does not
    // re-trigger the slide every tick.
    if (wantsCrouch && this.sprinting && this.grounded && !this.wasCrouching && moving) {
      this.slideTimer = SLIDE_TIME;
      this.slideDir.copy(this.tmpMove);
      this.onSlide?.();
    }
    this.wasCrouching = wantsCrouch;
    this.slideTimer = Math.max(0, this.slideTimer - dt);

    let speed = WALK_SPEED;
    if (this.slideTimer > 0) {
      // The slide keeps its own direction, so steering mid-slide does not
      // curve the path: a slide is a committed movement, which is what makes
      // it a dodge rather than a speed boost.
      speed = SLIDE_SPEED * (this.slideTimer / SLIDE_TIME) + SLIDE_ENTRY_BONUS;
    } else if (canSprint && !wantsCrouch) speed = WALK_SPEED * SPRINT_MULT;
    else if (wantsCrouch) speed = WALK_SPEED * CROUCH_MULT;
    if (input.moveX !== 0 && this.slideTimer <= 0) speed *= input.moveZ === 0 ? 0.85 : 0.93;
    // Weapon weight applies to every ground speed, including the slide: a
    // launcher must not slide as far as a pistol, or the loadout would have no
    // cost and the choice would collapse to "most damage".
    speed *= this.weaponMoveMul;
    this.adsT = damp(this.adsT, input.aimHeld && !canSprint ? 1 : 0, 10, dt);

    const accel = this.grounded ? (this.slideTimer > 0 ? 2.2 : 14) : 5.5;
    // The Glacial affix scales the TARGET speed, not the acceleration: a slowed
    // player still reaches a stable speed rather than sliding into a wall.
    const slowK = 1 - this.slowFraction;
    // While sliding the velocity is driven along the committed slide direction,
    // so the slide cannot be steered into a circle.
    if (this.slideTimer > 0 && this.grounded) {
      this.velocity.x = damp(this.velocity.x, this.slideDir.x * speed * slowK, accel, dt);
      this.velocity.z = damp(this.velocity.z, this.slideDir.z * speed * slowK, accel, dt);
    } else {
      this.velocity.x = damp(this.velocity.x, this.tmpMove.x * speed * slowK, accel, dt);
      this.velocity.z = damp(this.velocity.z, this.tmpMove.z * speed * slowK, accel, dt);
    }
    // A dash overrides the movement target entirely: it is a committed move
    // with its own duration, which is what makes it a positioning tool rather
    // than a speed boost.
    if (dashDir && this.dashRemaining > 0) {
      this.dashRemaining = Math.max(0, this.dashRemaining - dt);
      this.velocity.x = dashDir.x * this.dashSpeed;
      this.velocity.z = dashDir.z * this.dashSpeed;
      // Dashing also cancels the crouch-slide, so the two cannot stack.
      this.slideTimer = 0;
    }

    this.coyoteTimer = this.grounded ? COYOTE_TIME : Math.max(0, this.coyoteTimer - dt);
    this.jumpBuffer = input.jumpPressed ? JUMP_BUFFER_TIME : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyoteTimer > 0 && !this.crouched) {
      this.velocity.y = JUMP_SPEED;
      this.coyoteTimer = 0;
      this.jumpBuffer = 0;
      this.grounded = false;
    }
    this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -32);

    // Capture impact speed before the solver zeroes vertical velocity on contact.
    const fallSpeed = Math.max(0, -this.velocity.y);
    const stepDt = dt / SUBSTEPS;
    let groundedNow = false;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.tmpDisp.copy(this.velocity).multiplyScalar(stepDt);
      this.collider.translate(this.tmpDisp);
      const hit = this.octree.capsuleIntersect(this.collider);
      if (hit) {
        if (hit.normal.y > 0.4) groundedNow = true;
        const into = this.velocity.dot(hit.normal);
        if (into < 0) this.velocity.addScaledVector(hit.normal, -into);
        this.tmpDisp.copy(hit.normal).multiplyScalar(hit.depth);
        this.collider.translate(this.tmpDisp);
      }
    }
    this.grounded = groundedNow;
    if (!groundedNow) this.wasAirborne = true;
    else if (this.wasAirborne) {
      this.wasAirborne = false;
      this.onLanded?.(fallSpeed);
    }

    this.updateCrouch(wantsCrouch);
    this.eyeHeight = damp(this.eyeHeight, this.crouched ? EYE_CROUCH : EYE_STAND, 12, dt);
    this.updateCamera(dt, moving ? 1 : 0, canSprint && moving);
  }

private updateCrouch(wantsCrouch: boolean): void {
    const feet = this.position;
    if (!this.crouched && wantsCrouch) {
      this.collider.radius = CROUCH_RADIUS;
      this.collider.start.set(feet.x, feet.y + CROUCH_RADIUS, feet.z);
      this.collider.end.set(feet.x, feet.y + CROUCH_RADIUS + CROUCH_SEGMENT, feet.z);
      this.crouched = true;
      return;
    }
    if (!this.crouched || wantsCrouch) return;

    // Stand-up test: the probe must use the STANDING radius, because that is
    // the shape the player is asking to become. Building it with a stale or
    // wrong radius is what made standing up fail under low cover: the probe
    // reported a hit that the real standing capsule would not have hit.
    //
    // The probe is also lifted off the floor (see STAND_PROBE_LIFT): without
    // that clearance the bottom cap sits flush on the floor plane and the
    // octree reports the floor itself as an obstruction.
    this.standTest.radius = STAND_RADIUS;
    this.standTest.start.set(feet.x, feet.y + STAND_RADIUS + STAND_PROBE_LIFT, feet.z);
    this.standTest.end.set(feet.x, feet.y + STAND_RADIUS + STAND_PROBE_LIFT + STAND_SEGMENT, feet.z);
    if (this.octree.capsuleIntersect(this.standTest)) {
      // Still blocked. The player is under something real, so they stay
      // crouched and the next step re-tests: walking out from under it stands
      // them up automatically, with no extra input.
      return;
    }
    this.collider.radius = STAND_RADIUS;
    this.collider.start.copy(this.standTest.start);
    this.collider.end.copy(this.standTest.end);
    // Settle onto the floor: the probe was lifted, the real capsule is not.
    this.collider.start.y -= STAND_PROBE_LIFT;
    this.collider.end.y -= STAND_PROBE_LIFT;
    this.crouched = false;
  }

  /** True while crouched (HUD + camera use it for the low-posture read). */
  public get isCrouched(): boolean {
    return this.crouched;
  }

  /** 0..1 progress into the aim, for the scope overlay fade. */
  public get aimFraction(): number {
    return this.adsT;
  }

  /** True while a crouch-slide is in progress. */
  public get isSliding(): boolean {
    return this.slideTimer > 0;
  }

  private updateCamera(dt: number, moveAmount: number, sprinting: boolean): void {
    // Head bob
    const bobTarget = this.grounded && moveAmount > 0.1 ? 1 : 0;
    this.bobAmp = damp(this.bobAmp, bobTarget, 8, dt);
    this.bobPhase += dt * (sprinting ? 13 : 9.5) * moveAmount;
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * 0.02 * this.bobAmp;

    // Recoil decays and pushes pitch up
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.shake = damp(this.shake, 0, 7, dt);
    // Aim recoil recovers toward the pre-fire aim point. The player's own pull
    // is subtracted implicitly: `pitch`/`yaw` hold the input aim, and the
    // offset is added on top, so pulling down cancels the climb.
    this.recoilPitch = damp(this.recoilPitch, 0, RECOIL_RECOVERY, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, RECOIL_RECOVERY, dt);
    this.recoilResetT = Math.max(0, this.recoilResetT - dt);

    const jx = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.07 : 0;
    const jy = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.07 : 0;
    const jz = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.05 : 0;

    // Camera-only jitter (shake) is added here and NEVER reaches the aim ray,
    // so getting shot cannot silently ruin a shot in flight.
    this.camPrev.copy(this.camPos);
    this.camPos.set(
      this.collider.start.x + bobX * Math.cos(this.yaw),
      this.collider.end.y + this.eyeHeight + bobY,
      this.collider.start.z - bobX * Math.sin(this.yaw),
    );
    this.camera.position.copy(this.camPos);
    this.camera.rotation.set(
      this.pitch + this.recoil + this.recoilPitch + jx,
      this.yaw + this.recoilYaw + jy,
      jz,
      'YXZ',
    );
    // Aiming narrows the FOV toward the WEAPON's optic. A scoped rifle goes far
    // enough that the HUD's scope overlay takes over; iron sights only tighten
    // the view a little. Sprinting always widens it, because the read the
    // player needs while sprinting is "what is around me", not "what is far"
    // — but aim wins over sprint, or a scoped walk would fight its own zoom.
    const aimFov = 75 + (this.adsFov - 75) * this.adsT;
    const targetFov = sprinting && this.adsT < 0.02 ? 82 : aimFov;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 8, dt);
      this.camera.updateProjectionMatrix();
    }

    this.updateBodyPose(moveAmount, sprinting);
  }

  /**
   * Interpolate the RENDERED camera position between the last two simulation
   * ticks. Rotation is deliberately left alone: the mouse already drives it at
   * frame rate, so blending it would add a frame of aim latency.
   */
  public syncCamera(alpha: number): void {
    this.camera.position.set(
      this.camPrev.x + (this.camPos.x - this.camPrev.x) * alpha,
      this.camPrev.y + (this.camPos.y - this.camPrev.y) * alpha,
      this.camPrev.z + (this.camPos.z - this.camPrev.z) * alpha,
    );
  }
}
