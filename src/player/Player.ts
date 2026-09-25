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
const SLIDE_SPEED = 5.5; // +3 floor ⇒ 8.5 m/s entry, decays with the timer
const SLIDE_TIME = 0.65;
const COYOTE_TIME = 0.1;
const JUMP_BUFFER_TIME = 0.14;
const STAND_RADIUS = 0.45;
const CROUCH_RADIUS = 0.38;
const STAND_SEGMENT = 0.9;
const CROUCH_SEGMENT = 0.4;
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 17; // ≈5.9 s of sprint
const STAMINA_REGEN = 24;
const STAMINA_RESUME = 30; // sprint re-arms above this
const ADS_FOV = 64; // ~15% zoom under iron sights
const SUBSTEPS = 4;
const LOOK_SENS = 0.0021;
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
  public onDamaged: ((from: THREE.Vector3 | null) => void) | null = null;
  /** First-person body (Game adds it to the scene) — visible when you look down. */
  public readonly body = new THREE.Group();
  /** Fires once per touchdown after an airborne stretch (land sfx + viewmodel dip). */
  public onLanded: (() => void) | null = null;

  private shake = 0;

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

  private readonly velocity = new THREE.Vector3();
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
  private yaw = 0;
  private pitch = 0;
  private recoil = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private eyeHeight = EYE_STAND;
  private slideTimer = 0;
  private wasCrouching = false;
  private stamina = STAMINA_MAX;
  private exhausted = false;
  private sprintLocked = false;
  private sprinting = false;
  private adsT = 0;
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
    return this.yaw;
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

  public eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      this.collider.start.x,
      this.collider.end.y + this.eyeHeight,
      this.collider.start.z,
    );
  }

  public forward(out: THREE.Vector3): THREE.Vector3 {
    this.lookEuler.set(this.pitch, this.yaw, 0);
    return out.set(0, 0, -1).applyEuler(this.lookEuler);
  }

  public reset(spawn: THREE.Vector3, yaw: number): void {
    this.collider.radius = STAND_RADIUS;
    this.collider.start.set(spawn.x, spawn.y + STAND_RADIUS, spawn.z);
    this.collider.end.set(spawn.x, spawn.y + STAND_RADIUS + STAND_SEGMENT, spawn.z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoil = 0;
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
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
  }

  public setSensitivity(mult: number): void {
    this.sensitivity = mult;
  }

  public addRecoil(amount: number): void {
    this.recoil = Math.min(this.recoil + amount, 0.35);
  }

  public damage(amount: number, from: THREE.Vector3 | null = null): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.addShake(Math.min(0.5, amount * 0.03));
    this.onDamaged?.(from);
    if (this.health <= 0) this.dead = true;
  }

  public heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  public update(dt: number, input: InputFrame): void {
    if (this.dead) {
      this.updateCamera(dt, 0, false);
      return;
    }

    const sens = LOOK_SENS * this.sensitivity * (1 - 0.45 * this.adsT);
    this.yaw -= input.lookX * sens;
    this.pitch = clamp(this.pitch - input.lookY * sens, -1.35, 1.35);

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
    const canSprint = wantsSprint && !wantsCrouch && !this.exhausted && !this.sprintLocked;
    this.sprinting = canSprint;
    if (canSprint) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
      if (this.exhausted && this.stamina >= STAMINA_RESUME) this.exhausted = false;
    }
    if (wantsCrouch && this.sprinting && this.grounded && !this.wasCrouching && moving) {
      this.slideTimer = SLIDE_TIME;
    }
    this.wasCrouching = wantsCrouch;
    this.slideTimer = Math.max(0, this.slideTimer - dt);

    let speed = WALK_SPEED;
    if (this.slideTimer > 0) speed = SLIDE_SPEED * (this.slideTimer / SLIDE_TIME) + 3;
    else if (canSprint) speed = WALK_SPEED * SPRINT_MULT;
    else if (wantsCrouch) speed = WALK_SPEED * CROUCH_MULT;
    if (input.moveX !== 0) speed *= input.moveZ === 0 ? 0.85 : 0.93;
    this.adsT = damp(this.adsT, input.aimHeld && !canSprint ? 1 : 0, 10, dt);

    const accel = this.grounded ? (this.slideTimer > 0 ? 2.2 : 14) : 5.5;
    this.velocity.x = damp(this.velocity.x, this.tmpMove.x * speed, accel, dt);
    this.velocity.z = damp(this.velocity.z, this.tmpMove.z * speed, accel, dt);

    this.coyoteTimer = this.grounded ? COYOTE_TIME : Math.max(0, this.coyoteTimer - dt);
    this.jumpBuffer = input.jumpPressed ? JUMP_BUFFER_TIME : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyoteTimer > 0 && !this.crouched) {
      this.velocity.y = JUMP_SPEED;
      this.coyoteTimer = 0;
      this.jumpBuffer = 0;
      this.grounded = false;
    }
    this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -32);

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
      this.onLanded?.();
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

    this.standTest.start.set(feet.x, feet.y + STAND_RADIUS, feet.z);
    this.standTest.end.set(feet.x, feet.y + STAND_RADIUS + STAND_SEGMENT, feet.z);
    if (this.octree.capsuleIntersect(this.standTest)) return;
    this.collider.radius = STAND_RADIUS;
    this.collider.start.copy(this.standTest.start);
    this.collider.end.copy(this.standTest.end);
    this.crouched = false;
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

    const jx = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.07 : 0;
    const jy = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.07 : 0;
    const jz = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.05 : 0;

    this.camera.position.set(
      this.collider.start.x + bobX * Math.cos(this.yaw),
      this.collider.end.y + this.eyeHeight + bobY,
      this.collider.start.z - bobX * Math.sin(this.yaw),
    );
    this.camera.rotation.set(this.pitch + this.recoil + jx, this.yaw + jy, jz, 'YXZ');

    // FOV: sprint kick out, ADS zoom in
    const targetFov = sprinting ? 82 : 75 + (ADS_FOV - 75) * this.adsT;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 8, dt);
      this.camera.updateProjectionMatrix();
    }

    this.updateBodyPose(moveAmount, sprinting);
  }
}
