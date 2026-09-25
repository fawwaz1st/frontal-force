import * as THREE from 'three';
import type { Octree } from 'three/addons/math/Octree.js';
import type { EnemyManager, Enemy, Interceptor } from '../enemies/Enemies';
import type { Effects } from '../combat/Effects';
import type { GameAudio } from '../audio/Audio';
import { ARENA_LIMIT } from '../world/World';
import { clamp, damp, dampAngle, randRange } from '../core/math';

const FIRE_CD = 0.7;
const SHOT_DMG = 5;
const MAX_HP = 100;
const RESPAWN_TIME = 18;
const BOUNDS = ARENA_LIMIT;
const FIRE_RANGE = 34;
const SPEED = 7;
const TRACER = 0xffc266;
const SPAWN_OFFSETS: Array<[number, number]> = [
  [-2.4, 1.8],
  [2.4, 1.8],
];

/**
 * Humanoid escort bot — runs on the ground with a real gait, picks its own
 * target (nearest live enemy), flanks the player on its own, checks its own
 * LOS, fires its own rifle, and eats bolts aimed at the player until it drops.
 * Redeploys itself at full strength after 18 s. Zero player input.
 */
class Bot implements Interceptor {
  private readonly group = new THREE.Group();
  public hp = 100;
  public active = false;
  public onShot: ((pan: number) => void) | null = null;

  private idx = 0;
  private fireT = 0;
  private respawnT = 0;
  private yaw = 0;
  private walkPhase = 0;
  private gait = 0;
  private recoilT = 0;
  private simTime = 0;
  private patrolX: number | null = null;
  private patrolZ: number | null = null;
  private readonly torsoMesh: THREE.Mesh;
  private readonly visorMat: THREE.MeshStandardMaterial;
  private readonly rifle: THREE.Object3D;
  private readonly rifleRestZ: number;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly moveTarget = new THREE.Vector2();

  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
  ) {
    const armor = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.55, metalness: 0.25 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x22251c, roughness: 0.7, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14160f, roughness: 0.6, metalness: 0.5 });
    this.visorMat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xff9f1c, emissiveIntensity: 3,
    });
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: 0xff9f1c, emissiveIntensity: 1.4, roughness: 0.4,
    });

    const mesh = (
      geo: THREE.BufferGeometry, mat: THREE.Material,
      x: number, y: number, z: number, parent: THREE.Object3D, shadow = false,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // Pelvis + torso + collar + head (chest strip faces -Z like the enemies)
    mesh(new THREE.BoxGeometry(0.34, 0.18, 0.24), armor, 0, 0.92, 0, this.group, true);
    const torso = mesh(new THREE.BoxGeometry(0.5, 0.52, 0.3), armor, 0, 1.28, 0, this.group, true);
    mesh(new THREE.BoxGeometry(0.28, 0.05, 0.02), stripMat, 0, 0.06, -0.156, torso);
    this.torsoMesh = torso;
    mesh(new THREE.BoxGeometry(0.2, 0.09, 0.18), joint, 0, 1.57, 0, this.group);
    const head = mesh(new THREE.BoxGeometry(0.26, 0.24, 0.24), armor, 0, 1.72, 0, this.group, true);
    mesh(new THREE.BoxGeometry(0.18, 0.06, 0.04), this.visorMat, 0, 0.01, -0.13, head);
    mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 5), dark, 0.1, 0.16, 0.04, head);

    // Rifle carried at the hip, muzzle forward
    this.rifle = new THREE.Group();
    mesh(new THREE.BoxGeometry(0.05, 0.07, 0.42), dark, 0, 0, 0, this.rifle);
    mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.18, 8).rotateX(Math.PI / 2),
      joint, 0, 0.01, -0.28, this.rifle,
    );
    this.rifleRestZ = -0.3;
    this.rifle.position.set(0.26, 0.03, this.rifleRestZ);
    torso.add(this.rifle);

    // Shoulders + jointed arms (pivot at the shoulder, aim pose forward)
    const arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.16, 0.14, 0.22), armor, side * 0.34, 1.47, 0, this.group, true);
      const arm = new THREE.Group();
      arm.position.set(side * 0.33, 1.45, 0);
      this.group.add(arm);
      mesh(new THREE.BoxGeometry(0.11, 0.32, 0.12), armor, 0, -0.16, 0, arm, true);
      mesh(new THREE.SphereGeometry(0.07, 6, 6), joint, 0, -0.32, 0, arm);
      arms.push(arm);
    }

    // Legs (pivot at hip, knee joint, boot)
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.14, 0.9, 0);
      this.group.add(leg);
      mesh(new THREE.BoxGeometry(0.16, 0.42, 0.17), armor, 0, -0.21, 0, leg, true);
      mesh(new THREE.SphereGeometry(0.07, 6, 6), joint, 0, -0.42, 0, leg);
      mesh(new THREE.BoxGeometry(0.14, 0.4, 0.15), joint, 0, -0.62, 0, leg);
      mesh(new THREE.BoxGeometry(0.15, 0.1, 0.26), dark, 0, -0.86, 0.04, leg);
      legs.push(leg);
    }

    const armL = arms[0];
    const armR = arms[1];
    const legL = legs[0];
    const legR = legs[1];
    if (!armL || !armR || !legL || !legR) throw new Error('Bot limb construction failed');
    this.armL = armL;
    this.armR = armR;
    this.legL = legL;
    this.legR = legR;

    this.group.visible = false;
    scene.add(this.group);
  }

  public get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Bolt connected — armor absorbs it; down at 0, redeploy on timer. */
  public takeDamage(amount: number): void {
    if (!this.active) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.active = false;
      this.group.visible = false;
      this.respawnT = RESPAWN_TIME;
      this.effects.burst(this.group.position.clone().setY(1.2), 0xff9f1c, 14, 2);
      this.audio.slam();
    }
  }

  public deploy(at: THREE.Vector3, idx: number): void {
    this.idx = idx;
    this.hp = MAX_HP;
    this.active = true;
    this.group.visible = true;
    this.respawnT = 0;
    this.fireT = 0.7;
    this.simTime = 0;
    this.yaw = 0;
    this.walkPhase = 0;
    this.gait = 0;
    this.recoilT = 0;
    this.patrolX = null;
    this.patrolZ = null;
    this.rifle.position.z = this.rifleRestZ;
    this.rifle.rotation.x = 0;
    const off = SPAWN_OFFSETS[idx % SPAWN_OFFSETS.length] ?? [-2.4, 1.8];
    this.group.position.set(
      clamp(at.x + off[0] + randRange(-0.5, 0.5), -BOUNDS, BOUNDS),
      0,
      clamp(at.z + off[1] + randRange(-0.5, 0.5), -BOUNDS, BOUNDS),
    );
    this.group.rotation.set(0, 0, 0);
    this.effects.ring(this.group.position.clone().setY(0.1), 0xff9f1c, 3, 0.5);
    this.audio.allyDeploy();
  }

  public stow(): void {
    this.active = false;
    this.group.visible = false;
    // Without this the !active branch instantly redeploys on the next frame
    // (respawnT was already 0). deploy() re-arms the timer.
    this.respawnT = Number.POSITIVE_INFINITY;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerYaw: number,
    enemies: EnemyManager,
  ): void {
    if (!this.active) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.deploy(playerPos, this.idx);
      return;
    }

    this.simTime += dt;
    this.visorMat.emissiveIntensity = 2.4 + Math.sin(this.simTime * 5 + this.idx * 2.1) * 0.8;
    const target = enemies.nearestEnemy(this.group.position);
    const playerDistance = Math.hypot(
      playerPos.x - this.group.position.x,
      playerPos.z - this.group.position.z,
    );
    const intent = this.chooseMoveTarget(playerPos, target, playerDistance);
    const moved = this.moveToward(intent.x, intent.y, dt);
    this.updateGait(moved, dt);
    this.faceTarget(playerPos, playerYaw, target, playerDistance, dt);
    this.updateFire(dt, target, playerDistance, playerPos, playerYaw, enemies);
  }

  private chooseMoveTarget(
    playerPos: THREE.Vector3,
    target: Enemy | null,
    playerDistance: number,
  ): THREE.Vector2 {
    const position = this.group.position;
    const strafe = Math.sin(this.simTime * 1.2 + this.idx * 1.7) * 1.6;
    let x: number;
    let z: number;
    if (playerDistance > 22) {
      const dx = playerPos.x - position.x;
      const dz = playerPos.z - position.z;
      const length = Math.hypot(dx, dz) || 1;
      x = playerPos.x - (dx / length) * 6;
      z = playerPos.z - (dz / length) * 6;
    } else if (target) {
      const enemy = target.group.position;
      const dx = position.x - enemy.x;
      const dz = position.z - enemy.z;
      const length = Math.hypot(dx, dz) || 1;
      x = enemy.x + (dx / length) * 9 - (dz / length) * strafe;
      z = enemy.z + (dz / length) * 9 + (dx / length) * strafe;
    } else {
      let patrolX = this.patrolX;
      let patrolZ = this.patrolZ;
      if (patrolX === null || patrolZ === null || Math.hypot(patrolX - position.x, patrolZ - position.z) < 2) {
        patrolX = randRange(-38, 38);
        patrolZ = randRange(-38, 38);
        this.patrolX = patrolX;
        this.patrolZ = patrolZ;
      }
      x = patrolX;
      z = patrolZ;
    }
    return this.moveTarget.set(
      clamp(x, -BOUNDS, BOUNDS),
      clamp(z, -BOUNDS, BOUNDS),
    );
  }

  private moveToward(x: number, z: number, dt: number): boolean {
    const position = this.group.position;
    const distance = Math.hypot(x - position.x, z - position.z);
    if (distance <= 0.15) return false;
    const direction = this.tmpA.set(x - position.x, 0, z - position.z).normalize();
    this.tmpRay.set(this.tmpB.set(position.x, position.y + 1, position.z), direction);
    const hit = this.octree.rayIntersect(this.tmpRay);
    if (hit && hit.distance <= 1.4) return false;
    const speed = distance > 8 ? SPEED * 1.35 : SPEED;
    position.x += direction.x * speed * dt;
    position.z += direction.z * speed * dt;
    return true;
  }

  private updateGait(moved: boolean, dt: number): void {
    this.gait = damp(this.gait, moved ? 1 : 0, 8, dt);
    if (moved || this.gait > 0.02) this.walkPhase += dt * SPEED * 1.9;
    const swing = Math.sin(this.walkPhase) * this.gait * 0.75;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.6;
    this.armR.rotation.x = 1.4 - swing * 0.15;
    this.torsoMesh.rotation.x = damp(this.torsoMesh.rotation.x, moved ? -0.08 : 0, 6, dt);
    this.group.position.y = this.gait > 0.02
      ? Math.abs(Math.sin(this.walkPhase * 2)) * 0.04 * this.gait
      : 0;
  }

  private faceTarget(
    playerPos: THREE.Vector3,
    playerYaw: number,
    target: Enemy | null,
    playerDistance: number,
    dt: number,
  ): void {
    const position = this.group.position;
    let faceX: number;
    let faceZ: number;
    if (playerDistance > 22) {
      faceX = playerPos.x;
      faceZ = playerPos.z;
    } else if (target) {
      faceX = target.group.position.x;
      faceZ = target.group.position.z;
    } else if (this.patrolX !== null && this.patrolZ !== null) {
      faceX = this.patrolX;
      faceZ = this.patrolZ;
    } else {
      faceX = playerPos.x - Math.sin(playerYaw) * 8;
      faceZ = playerPos.z - Math.cos(playerYaw) * 8;
    }
    const dx = faceX - position.x;
    const dz = faceZ - position.z;
    this.yaw = dampAngle(this.yaw, Math.atan2(-dx, -dz), 8, dt);
    this.group.rotation.y = this.yaw;
  }

  private updateFire(
    dt: number,
    target: Enemy | null,
    playerDistance: number,
    playerPos: THREE.Vector3,
    playerYaw: number,
    enemies: EnemyManager,
  ): void {
    this.fireT -= dt;
    this.recoilT = Math.max(0, this.recoilT - dt * 6);
    this.rifle.position.z = this.rifleRestZ + this.recoilT * 0.06;
    this.rifle.rotation.x = this.recoilT * 0.18;
    if (!target || playerDistance > 22 || this.fireT > 0) return;

    const position = this.group.position;
    const center = this.tmpA.set(
      target.collider.start.x,
      (target.collider.start.y + target.collider.end.y) / 2,
      target.collider.start.z,
    );
    const eye = this.tmpB.set(position.x, position.y + 1.5, position.z);
    const toTarget = this.tmpC.copy(center).sub(eye);
    const range = toTarget.length();
    if (range <= 0.6 || range > FIRE_RANGE) {
      this.fireT = 0.25;
      return;
    }
    toTarget.divideScalar(range);
    this.tmpRay.set(eye, toTarget);
    const wall = this.octree.rayIntersect(this.tmpRay);
    if (wall && wall.distance <= range - 0.5) {
      this.fireT = 0.12;
      return;
    }

    this.fireT = FIRE_CD + randRange(0, 0.14);
    this.recoilT = 1;
    const point = center.clone().add(
      this.tmpC.set(randRange(-0.2, 0.2), randRange(-0.25, 0.25), randRange(-0.2, 0.2)),
    );
    enemies.damageEnemy(target, SHOT_DMG, point);
    const forward = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const muzzle = this.tmpC.set(position.x + forward * 0.55, position.y + 1.34, position.z + forwardZ * 0.55);
    this.effects.tracer(muzzle, point, TRACER);
    this.effects.burst(muzzle, TRACER, 2, 1.2);
    this.onShot?.(this.pan(position, playerPos, playerYaw));
  }

  /** Screen-space pan (−1 left … +1 right) of a point for stereo placement. */
  private pan(p: THREE.Vector3, playerPos: THREE.Vector3, yaw: number): number {
    const dx = p.x - playerPos.x;
    const dz = p.z - playerPos.z;
    const len = Math.hypot(dx, dz) || 1;
    return clamp((dx / len) * Math.cos(yaw) - (dz / len) * Math.sin(yaw), -1, 1);
  }
}

/**
 * The escort squad: two humanoid bots that fight beside the player.
 * Game wires this once; every method fans out to the bots.
 */
export class Ally {
  public readonly bots: Bot[];
  public onShot: ((pan: number) => void) | null = null;

  public constructor(
    scene: THREE.Scene,
    octree: Octree,
    effects: Effects,
    audio: GameAudio,
  ) {
    this.bots = [new Bot(scene, octree, effects, audio), new Bot(scene, octree, effects, audio)];
    for (const bot of this.bots) {
      bot.onShot = (pan) => this.onShot?.(pan);
    }
  }

  public get active(): boolean {
    return this.bots.some((b) => b.active);
  }

  public get aliveCount(): number {
    return this.bots.reduce((n, b) => n + (b.active ? 1 : 0), 0);
  }

  public get hp(): number {
    return this.bots.reduce((n, b) => n + b.hp, 0);
  }

  public get maxHp(): number {
    return MAX_HP * this.bots.length;
  }

  public deploy(at: THREE.Vector3): void {
    this.bots.forEach((bot, i) => bot.deploy(at, i));
  }

  public stow(): void {
    for (const bot of this.bots) bot.stow();
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerYaw: number,
    enemies: EnemyManager,
  ): void {
    for (const bot of this.bots) bot.update(dt, playerPos, playerYaw, enemies);
  }
}
