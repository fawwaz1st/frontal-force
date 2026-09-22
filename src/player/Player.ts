import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { InputFrame } from '../input/Input';
import { clamp, damp } from '../core/math';

const EYE_STAND = 1.62;
const EYE_CROUCH = 0.95;
const GRAVITY = 26;
const JUMP_SPEED = 8.4;
const WALK_SPEED = 6.2;
const SPRINT_MULT = 1.55;
const CROUCH_MULT = 0.5;
const SLIDE_SPEED = 11;
const SLIDE_TIME = 0.65;
const SUBSTEPS = 4;
const LOOK_SENS = 0.0021;

export class Player {
  public readonly camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 200);
  public readonly collider = new Capsule(
    new THREE.Vector3(0, 0.45, 0),
    new THREE.Vector3(0, 1.35, 0),
    0.45,
  );

  public health = 100;
  public maxHealth = 100;
  public dead = false;
  public onDamaged: ((from: THREE.Vector3 | null) => void) | null = null;

  private readonly velocity = new THREE.Vector3();
  private grounded = false;
  private yaw = 0;
  private pitch = 0;
  private recoil = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private eyeHeight = EYE_STAND;
  private slideTimer = 0;
  private wasCrouching = false;
  private sensitivity = 1;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpMove = new THREE.Vector3();
  private readonly tmpDisp = new THREE.Vector3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  public constructor(private readonly octree: Octree) {}

  public get position(): THREE.Vector3 {
    return this.collider.start;
  }

  public get yawAngle(): number {
    return this.yaw;
  }

  public get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  public eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.collider.start.x, this.collider.start.y + this.eyeHeight, this.collider.start.z);
  }

  public forward(out: THREE.Vector3): THREE.Vector3 {
    this.lookEuler.set(this.pitch, this.yaw, 0);
    return out.set(0, 0, -1).applyEuler(this.lookEuler);
  }

  public reset(spawn: THREE.Vector3, yaw: number): void {
    this.collider.start.set(spawn.x, spawn.y, spawn.z);
    this.collider.end.set(spawn.x, spawn.y + 0.9, spawn.z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoil = 0;
    this.health = this.maxHealth;
    this.dead = false;
    this.eyeHeight = EYE_STAND;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.slideTimer = 0;
    this.wasCrouching = false;
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

    // Look
    this.yaw -= input.lookX * LOOK_SENS * this.sensitivity;
    this.pitch = clamp(this.pitch - input.lookY * LOOK_SENS * this.sensitivity, -1.35, 1.35);

    // Movement intent in world space
    this.tmpDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.tmpRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.tmpMove.set(0, 0, 0)
      .addScaledVector(this.tmpDir, -input.moveZ)
      .addScaledVector(this.tmpRight, input.moveX);
    const moving = this.tmpMove.lengthSq() > 0.001;
    if (moving) this.tmpMove.normalize();

    const crouching = input.crouchHeld;
    const sprinting = input.sprintHeld && !crouching && input.moveZ < 0;

    // Slide: crouch while sprinting on the ground keeps momentum briefly
    if (crouching && sprinting && this.grounded && !this.wasCrouching && moving) {
      this.slideTimer = SLIDE_TIME;
    }
    this.wasCrouching = crouching;
    this.slideTimer = Math.max(0, this.slideTimer - dt);

    let speed = WALK_SPEED;
    if (this.slideTimer > 0) speed = SLIDE_SPEED * (this.slideTimer / SLIDE_TIME) + 3;
    else if (sprinting) speed = WALK_SPEED * SPRINT_MULT;
    else if (crouching) speed = WALK_SPEED * CROUCH_MULT;

    const accel = this.grounded ? (this.slideTimer > 0 ? 2.2 : 14) : 3.2;
    this.velocity.x = damp(this.velocity.x, this.tmpMove.x * speed, accel, dt);
    this.velocity.z = damp(this.velocity.z, this.tmpMove.z * speed, accel, dt);

    // Jump + gravity
    if (input.jumpHeld && this.grounded) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -32);

    // Integrate with collision substeps
    const stepDt = dt / SUBSTEPS;
    let groundedNow = false;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.tmpDisp.copy(this.velocity).multiplyScalar(stepDt);
      this.collider.translate(this.tmpDisp);
      const hit = this.octree.capsuleIntersect(this.collider);
      if (hit) {
        if (hit.normal.y > 0.4) groundedNow = true;
        // Remove velocity into the surface, then push out
        const into = this.velocity.dot(hit.normal);
        if (into < 0) this.velocity.addScaledVector(hit.normal, -into);
        this.tmpDisp.copy(hit.normal).multiplyScalar(hit.depth);
        this.collider.translate(this.tmpDisp);
      }
    }
    this.grounded = groundedNow;

    // Camera height (crouch/slide)
    this.eyeHeight = damp(this.eyeHeight, crouching ? EYE_CROUCH : EYE_STAND, 12, dt);

    this.updateCamera(dt, moving ? this.tmpMove.length() : 0, sprinting && moving);
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

    this.camera.position.set(
      this.collider.start.x + bobX * Math.cos(this.yaw),
      this.collider.start.y + this.eyeHeight + bobY,
      this.collider.start.z - bobX * Math.sin(this.yaw),
    );
    this.camera.rotation.set(this.pitch + this.recoil, this.yaw, 0, 'YXZ');

    // FOV kick while sprinting
    const targetFov = sprinting ? 82 : 75;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 8, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
