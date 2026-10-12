import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { WeaponId } from '../combat/weapons';

export interface ViewmodelFrame {
  /** Player horizontal speed (m/s) — drives weapon bob */
  speed: number;
  sprinting: boolean;
  aimHeld: boolean;
  /** Per-frame look delta (px) — drives sway lag */
  lookX: number;
  lookY: number;
  reloading: boolean;
  /** Reload progress 0..1 driving the mag-swap animation */
  reloadProgress: number;
}

const REST_POS = new THREE.Vector3(0.24, -0.23, -0.62);
const REST_ROT = new THREE.Euler(0.03, 0.07, 0.02);
const ADS_POS = new THREE.Vector3(0, -0.145, -0.52);
const MODEL_SCALE = 0.6;
const SWAY_POS_K = 0.0004;
const SWAY_ROT_K = 0.0009;
const BOB_HZ = 9.5;

interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  mag: THREE.Mesh | null;
  magRest: THREE.Vector3;
  magRot: THREE.Euler;
  pump: THREE.Mesh | null;
  pumpRest: THREE.Vector3;
}

/**
 * First-person weapon rig rendered as a second pass with its own camera
 * (viewmodel FOV stays fixed while world FOV kicks on sprint — the
 * Call of Duty split-camera convention). Own scene, own lighting via
 * scene.environment, never fogged by the arena.
 */
export class Viewmodel {
  public readonly scene = new THREE.Scene();
  public readonly camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.01, 8);

  private readonly rig = new THREE.Group();
  private readonly models = new Map<WeaponId, WeaponModel>();
  private current: WeaponModel | null = null;
  // Carriers filled by builders during buildModel, then consumed
  private tmpMag: THREE.Mesh | null = null;
  private tmpPump: THREE.Mesh | null = null;

  // Animation state
  private swayX = 0;
  private swayY = 0;
  private swayRotY = 0;
  private swayRotX = 0;
  private bobT = 0;
  private bobAmp = 0;
  private kickZ = 0;
  private reloadPose = 0;
  private sprintPose = 0;
  private switchT = 1;
  private flashT = 0;
  private breathT = 0;
  private adsT = 0;

  // Muzzle flash (reparented to the active weapon's muzzle)
  private readonly flashGroup = new THREE.Group();
  private readonly flashPlane: THREE.Mesh;
  private readonly flashLight: THREE.PointLight;

  private readonly gunMetal: THREE.MeshStandardMaterial;
  private readonly darkMetal: THREE.MeshStandardMaterial;
  private readonly muzzleCap: THREE.MeshStandardMaterial;
  private readonly gripMat: THREE.MeshStandardMaterial;
  private readonly gloveMat: THREE.MeshStandardMaterial;
  private readonly sleeveMat: THREE.MeshStandardMaterial;

  public constructor() {
    this.scene.add(this.rig);
    this.rig.scale.setScalar(MODEL_SCALE);
    // RoomEnvironment + the 2.2 world exposure blew pale parts to white.
    // Keep the viewmodel lit but well below clipping: dark shell, readable edges.
    this.scene.environmentIntensity = 0.05;
    const key = new THREE.DirectionalLight(0xdfe8ff, 0.24);
    key.position.set(-0.6, 1.2, 0.4);
    const rim = new THREE.DirectionalLight(0x5f8cff, 0.14);
    rim.position.set(1, 0.2, -1);
    this.scene.add(key, rim);

    this.gunMetal = new THREE.MeshStandardMaterial({
      color: 0x0e1219, roughness: 0.95, metalness: 0.05,
    });
    this.darkMetal = new THREE.MeshStandardMaterial({
      color: 0x080b10, roughness: 1, metalness: 0,
    });
    this.muzzleCap = new THREE.MeshStandardMaterial({
      color: 0x05070a, roughness: 1, metalness: 0,
    });
    this.gripMat = new THREE.MeshStandardMaterial({
      color: 0x12151f, roughness: 0.85, metalness: 0.1,
    });
    this.gloveMat = new THREE.MeshStandardMaterial({
      color: 0x090b10, roughness: 0.95, metalness: 0,
    });
    this.sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x151b26, roughness: 0.9, metalness: 0.1,
    });

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.flashPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
    this.flashPlane.visible = false;
    this.flashLight = new THREE.PointLight(0xffc47a, 0, 4.5, 2);
    this.flashGroup.add(this.flashPlane, this.flashLight);
    this.scene.add(this.flashGroup);

    this.buildModel('ar', this.buildRifle.bind(this));
    this.buildModel('smg', this.buildSmg.bind(this));
    this.buildModel('shotgun', this.buildShotgun.bind(this));
    this.buildModel('rail', this.buildRail.bind(this));
    this.buildModel('dmr', this.buildDmr.bind(this));
    this.buildModel('lmg', this.buildLmg.bind(this));
    this.buildModel('pistol', this.buildPistol.bind(this));
    this.buildModel('launcher', this.buildLauncher.bind(this));
    this.buildModel('beam', this.buildBeam.bind(this));
    this.buildModel('burst', this.buildBurst.bind(this));
    this.setWeapon('ar');
  }

  /** Two-pass render: main scene already drawn; clear depth, draw weapon on top.
   * Renderer param is structural so the rig works with WebGLRenderer or WebGPURenderer. */
  public render(renderer: {
    clearDepth(): void;
    render(scene: THREE.Object3D, camera: THREE.Camera): void;
  }): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  public setEnvironment(env: THREE.Texture): void {
    this.scene.environment = env;
  }

  public setSize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Current muzzle position in VIEWMODEL space (≈ camera-space: vm camera sits at the origin,
   * looking -Z, same axes as the world camera's local frame). Rotate by the camera quaternion
   * and add the eye to get the world muzzle — bullets visually leave the barrel. */
  public muzzleOffset(out: THREE.Vector3): THREE.Vector3 {
    const muzzle = this.current?.muzzle;
    if (!muzzle) return out.copy(REST_POS);
    this.scene.updateMatrixWorld(true);
    return muzzle.getWorldPosition(out);
  }

  public setWeapon(id: WeaponId): void {
    const model = this.models.get(id);
    if (!model || model === this.current) return;
    this.clearFlash();
    if (this.current) this.current.group.visible = false;
    this.current = model;
    model.group.visible = true;
    // Reparent flash to this weapon's muzzle (local space already correct)
    this.flashGroup.position.set(0, 0, 0);
    this.flashGroup.rotation.set(0, 0, 0);
    model.muzzle.add(this.flashGroup);
  }

  /** Recoil kick — instant impulse, critically-damped settle in update(). */
  public kick(power: number): void {
    this.kickZ = Math.min(this.kickZ + power, 0.14);
    this.flashT = 0.045;
    this.flashPlane.rotation.z = Math.random() * Math.PI;
    this.switchT = Math.max(this.switchT, 0.995); // firing cancels switch pose
  }

  /** Lower-raise pose when swapping weapons. */
  public notifySwitch(): void {
    this.switchT = 0;
  }

  /** Clear animation state between runs so no pose/effect leaks into REDEPLOY. */
  public reset(): void {
    this.swayX = this.swayY = this.swayRotX = this.swayRotY = 0;
    this.bobT = this.bobAmp = this.kickZ = 0;
    this.reloadPose = this.sprintPose = this.adsT = 0;
    this.switchT = 1;
    this.flashT = 0;
    this.breathT = 0;
    this.rig.position.copy(REST_POS);
    this.rig.rotation.copy(REST_ROT);
    for (const model of this.models.values()) {
      if (model.mag) {
        model.mag.position.copy(model.magRest);
        model.mag.rotation.copy(model.magRot);
      }
      if (model.pump) model.pump.position.copy(model.pumpRest);
    }
    this.flashPlane.visible = false;
    this.flashLight.intensity = 0;
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
    this.setWeapon('ar');
  }

  private clearFlash(): void {
    this.flashT = 0;
    this.flashPlane.visible = false;
    this.flashLight.intensity = 0;
  }

  public update(dt: number, f: ViewmodelFrame): void {
    const switchPose = this.updateMotionState(dt, f);
    this.applyRigPose(switchPose);
    this.updateReloadProps(f);
    this.updateMuzzleFlash(dt);
  }

  private updateMotionState(dt: number, f: ViewmodelFrame): number {
    this.swayX = damp(this.swayX, clamp(-f.lookX * SWAY_POS_K, -0.035, 0.035), 11, dt);
    this.swayY = damp(this.swayY, clamp(f.lookY * SWAY_POS_K, -0.03, 0.03), 11, dt);
    this.swayRotY = damp(this.swayRotY, clamp(f.lookX * SWAY_ROT_K, -0.06, 0.06), 11, dt);
    this.swayRotX = damp(this.swayRotX, clamp(f.lookY * SWAY_ROT_K, -0.05, 0.05), 11, dt);

    const bobTarget = Math.min(f.speed / 7.6, 1);
    this.bobAmp = damp(this.bobAmp, bobTarget, 8, dt);
    this.bobT += dt * BOB_HZ * (0.6 + 0.5 * this.bobAmp);
    this.breathT += dt;
    this.kickZ *= Math.exp(-12 * dt);

    this.reloadPose = damp(this.reloadPose, f.reloading ? 1 : 0, 13, dt);
    const sprinting = f.sprinting ? 1 : 0;
    this.sprintPose = damp(this.sprintPose, sprinting, 13, dt);
    this.adsT = damp(this.adsT, f.aimHeld && !sprinting ? 1 : 0, 13, dt);

    const fov = 58 - 8 * this.adsT;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (this.switchT < 1) this.switchT = Math.min(1, this.switchT + dt / 0.24);
    return Math.sin(this.switchT * Math.PI);
  }

  private applyRigPose(switchPose: number): void {
    const bob = this.bobAmp;
    const breath = 1 - bob;
    const hipX = REST_POS.x + this.swayX + Math.cos(this.bobT) * 0.01 * bob
      + Math.cos(this.breathT * 0.9) * 0.0022 * breath;
    const hipY = REST_POS.y + this.swayY + Math.sin(this.bobT * 2) * 0.007 * bob
      + Math.sin(this.breathT * 1.4) * 0.0035 * breath
      - this.reloadPose * 0.07 - this.sprintPose * 0.06 - switchPose * 0.28;
    const hipZ = REST_POS.z + this.kickZ + this.reloadPose * 0.05;
    const aim = this.adsT;
    this.rig.position.set(
      hipX * (1 - aim) + ADS_POS.x * aim,
      hipY * (1 - aim) + ADS_POS.y * aim,
      hipZ * (1 - aim) + ADS_POS.z * aim,
    );
    this.rig.rotation.set(
      (REST_ROT.x + this.swayRotX + this.swayRotY * 0.3
        + this.reloadPose * 0.36 + this.sprintPose * 0.55 + switchPose * 0.7
        - this.kickZ * 1.6) * (1 - aim * 0.85),
      (REST_ROT.y + this.swayRotY + Math.sin(this.bobT) * 0.012 * bob) * (1 - aim * 0.85),
      (REST_ROT.z + Math.sin(this.bobT) * 0.02 * bob + this.reloadPose * 0.35
        + this.sprintPose * 0.25) * (1 - aim * 0.85),
    );
  }

  private updateReloadProps(f: ViewmodelFrame): void {
    const current = this.current;
    if (current?.mag) {
      const p = f.reloading ? f.reloadProgress : 0;
      const rest = current.magRest;
      const rot = current.magRot;
      if (p <= 0.001) {
        current.mag.position.copy(rest);
        current.mag.rotation.copy(rot);
      } else if (p < 0.45) {
        const k = clamp((p - 0.1) / 0.35, 0, 1);
        current.mag.position.y = rest.y - k * 0.3;
        current.mag.rotation.x = rot.x + k * 0.55;
        current.mag.rotation.z = rot.z + k * 0.35;
      } else if (p < 0.55) {
        current.mag.position.y = rest.y - 0.32;
        current.mag.rotation.x = rot.x + 0.55;
        current.mag.rotation.z = rot.z + 0.35;
      } else {
        const k = (p - 0.55) / 0.45;
        current.mag.position.y = rest.y - 0.32 * (1 - k);
        current.mag.rotation.x = rot.x + 0.55 * (1 - k);
        current.mag.rotation.z = rot.z + 0.35 * (1 - k);
      }
    }
    if (current?.pump) {
      const p = f.reloading ? Math.sin(Math.min(f.reloadProgress, 1) * Math.PI) : 0;
      current.pump.position.z = current.pumpRest.z + p * 0.13;
    }
  }

  private updateMuzzleFlash(dt: number): void {
    if (this.flashT <= 0) return;
    this.flashT -= dt;
    const k = Math.max(0, this.flashT / 0.045);
    this.flashPlane.visible = true;
    this.flashPlane.scale.setScalar(0.7 + k * 0.6);
    this.flashLight.intensity = 7 * k;
    if (this.flashT <= 0) {
      this.flashPlane.visible = false;
      this.flashLight.intensity = 0;
    }
  }

  // ---------- Construction helpers ----------

  private box(
    parent: THREE.Object3D,
    size: [number, number, number],
    mat: THREE.Material,
    pos: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    parent.add(mesh);
    return mesh;
  }

  private barrel(
    parent: THREE.Object3D,
    radius: number,
    length: number,
    mat: THREE.Material,
    pos: [number, number, number],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(...pos);
    parent.add(mesh);
    return mesh;
  }

  private accentMat(color: number): THREE.MeshStandardMaterial {
    // ei 1.6 clipped to white under the 2.2 ACES exposure — even 0.6 still
    // reaches ~1.0 after exposure, so keep it low enough to stay saturated.
    return new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: color, emissiveIntensity: 0.25, roughness: 0.4,
    });
  }

  private buildModel(id: WeaponId, builder: (g: THREE.Group) => THREE.Object3D): void {
    const group = new THREE.Group();
    const muzzle = builder(group);
    const mag = this.tmpMag;
    const pump = this.tmpPump;
    this.tmpMag = null;
    this.tmpPump = null;
    this.addHands(group);
    group.visible = false;
    group.name = id;
    this.rig.add(group);
    this.models.set(id, {
      group,
      muzzle,
      mag,
      pump,
      magRest: mag ? mag.position.clone() : new THREE.Vector3(),
      magRot: mag ? mag.rotation.clone() : new THREE.Euler(),
      pumpRest: pump ? pump.position.clone() : new THREE.Vector3(),
    });
  }

  /** Operator hands: gloves on grip/fore, sleeves trailing off the bottom-right. */
  private addHands(g: THREE.Group): void {
    // Right glove wrapped around the pistol grip
    const right = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.1, 0.075), this.gloveMat);
    right.position.set(0.005, -0.095, 0.13);
    right.rotation.x = -0.25;
    g.add(right);
    this.limb(g, [0.05, -0.14, 0.19], [0.34, -0.62, 0.62], 0.075, this.sleeveMat);
    // Left glove under the fore
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.09), this.gloveMat);
    left.position.set(0, -0.06, -0.21);
    g.add(left);
    this.limb(g, [0.04, -0.1, -0.16], [-0.1, -0.6, 0.45], 0.07, this.sleeveMat);
  }

  /** Box limb from a to b, oriented in parent-local space (immune to the rig's world scale). */
  private limb(
    parent: THREE.Object3D,
    from: [number, number, number],
    to: [number, number, number],
    thick: number,
    mat: THREE.Material,
  ): void {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, len), mat);
    parent.add(mesh);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
  }

  /** U-shaped trigger guard + trigger under the receiver (shared by all long guns). */
  private triggerGuard(g: THREE.Group): void {
    this.box(g, [0.006, 0.05, 0.06], this.gunMetal, [-0.017, -0.05, 0.055]);
    this.box(g, [0.006, 0.05, 0.06], this.gunMetal, [0.017, -0.05, 0.055]);
    this.box(g, [0.04, 0.007, 0.06], this.gunMetal, [0, -0.075, 0.055]);
  }

  private trigger(g: THREE.Group): void {
    this.box(g, [0.007, 0.032, 0.012], this.darkMetal, [0, -0.05, 0.045], [0.2, 0, 0]);
  }

  /** Vanguard AR — M4 pattern: rail, red-dot optic, collapsible stock, brake. */
  private buildRifle(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0x9fd0ff);
    this.box(g, [0.062, 0.08, 0.3], this.gunMetal, [0, 0, 0.02]);           // receiver
    this.box(g, [0.05, 0.03, 0.07], this.darkMetal, [0, -0.05, -0.02]);     // magwell
    this.tmpMag = this.box(g, [0.04, 0.16, 0.06], this.darkMetal, [0, -0.135, -0.03], [0.14, 0, 0]);
    this.box(g, [0.055, 0.055, 0.22], this.darkMetal, [0, 0.004, -0.26]);   // handguard
    for (let i = 0; i < 3; i++) {                                           // vent slots
      const z = -0.2 + i * 0.06;
      this.box(g, [0.006, 0.02, 0.032], this.gunMetal, [-0.029, 0.004, z]);
      this.box(g, [0.006, 0.02, 0.032], this.gunMetal, [0.029, 0.004, z]);
    }
    this.box(g, [0.03, 0.03, 0.035], this.gunMetal, [0, 0.03, -0.36]);      // gas block
    this.barrel(g, 0.013, 0.18, this.gunMetal, [0, 0.008, -0.45]);
    this.barrel(g, 0.019, 0.05, this.muzzleCap, [0, 0.008, -0.57]);         // muzzle brake
    this.barrel(g, 0.019, 0.008, this.muzzleCap, [0, 0.008, -0.60]);
    this.box(g, [0.01, 0.012, 0.05], this.darkMetal, [-0.033, 0.02, 0.03]); // ejection port
    this.box(g, [0.014, 0.02, 0.03], this.darkMetal, [-0.038, 0.033, 0.11]); // charging handle
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.1, 0.05], this.gripMat, [0, -0.078, 0.145], [-0.35, 0, 0]);
    this.box(g, [0.03, 0.02, 0.05], this.darkMetal, [0, 0.055, -0.02]);     // optic riser
    this.barrel(g, 0.021, 0.09, this.muzzleCap, [0, 0.078, -0.02]);        // red-dot tube
    this.box(g, [0.012, 0.03, 0.02], this.gunMetal, [0, 0.055, -0.35]);     // front post
    this.barrel(g, 0.017, 0.14, this.gunMetal, [0, 0.004, 0.2]);            // buffer tube
    this.box(g, [0.048, 0.06, 0.11], this.darkMetal, [0, -0.004, 0.31]);    // collapsible stock
    this.box(g, [0.05, 0.085, 0.026], this.gripMat, [0, -0.005, 0.375]);    // butt pad
    this.box(g, [0.04, 0.018, 0.1], this.gripMat, [0, 0.042, 0.3]);         // cheek riser
    this.box(g, [0.064, 0.01, 0.14], accent, [0, 0.043, -0.08]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.6);
    g.add(muzzle);
    return muzzle;
  }

  /** Hornet SMG — MP5 pattern: top rail + dot, folding wire stock, brake. */
  private buildSmg(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xffd28a);
    this.box(g, [0.055, 0.075, 0.28], this.gunMetal, [0, 0, 0.03]);          // receiver
    this.box(g, [0.045, 0.028, 0.06], this.darkMetal, [0, -0.048, -0.03]);  // magwell
    this.tmpMag = this.box(g, [0.036, 0.155, 0.055], this.darkMetal, [0, -0.125, -0.05], [0.12, 0, 0]);
    this.barrel(g, 0.012, 0.14, this.gunMetal, [0, 0.01, -0.26]);
    this.barrel(g, 0.013, 0.18, this.gunMetal, [0, 0.008, -0.45]);
    this.barrel(g, 0.017, 0.05, this.muzzleCap, [0, 0.01, -0.36]);          // brake
    this.barrel(g, 0.016, 0.008, this.muzzleCap, [0, 0.01, -0.4]);
    this.box(g, [0.026, 0.075, 0.04], this.gripMat, [0, -0.062, -0.19], [0.18, 0, 0]); // fore grip
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.095, 0.05], this.gripMat, [0, -0.072, 0.13], [-0.32, 0, 0]);
    this.barrel(g, 0.014, 0.05, this.muzzleCap, [-0.03, 0.04, -0.12]);       // charging knob
    this.box(g, [0.04, 0.014, 0.24], this.gunMetal, [0, 0.046, 0]);         // top rail
    this.box(g, [0.024, 0.018, 0.04], this.darkMetal, [0, 0.06, -0.02]);    // dot mount
    this.barrel(g, 0.017, 0.06, this.muzzleCap, [0, 0.075, -0.02]);          // compact dot
    this.box(g, [0.012, 0.012, 0.17], this.darkMetal, [-0.02, 0.02, 0.23]);  // folding stock
    this.box(g, [0.012, 0.012, 0.17], this.darkMetal, [0.02, 0.02, 0.23]);
    this.box(g, [0.05, 0.055, 0.022], this.darkMetal, [0, 0.005, 0.32]);
    this.box(g, [0.058, 0.01, 0.12], accent, [0, 0.044, 0]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.01, -0.4);
    g.add(muzzle);
    return muzzle;
  }

  /** Breaker SG — pump gun: twin barrels, rib, shell holder, straight stock. */
  private buildShotgun(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xffb36b);
    const brass = new THREE.MeshStandardMaterial({ color: 0x8a6a2c, roughness: 0.5, metalness: 0.55 });
    this.box(g, [0.06, 0.075, 0.24], this.gunMetal, [0, 0, 0.05]);          // receiver
    this.barrel(g, 0.016, 0.46, this.gunMetal, [-0.017, 0.018, -0.24]);      // twin barrels
    this.barrel(g, 0.016, 0.46, this.gunMetal, [0.017, 0.018, -0.24]);
    this.barrel(g, 0.015, 0.008, this.muzzleCap, [-0.017, 0.018, -0.47]);
    this.barrel(g, 0.015, 0.008, this.muzzleCap, [0.017, 0.018, -0.47]);
    this.box(g, [0.04, 0.01, 0.44], this.darkMetal, [0, 0.036, -0.24]);      // top rib
    this.barrel(g, 0.013, 0.4, this.darkMetal, [0, -0.028, -0.24]);         // magazine tube
    this.tmpPump = this.box(g, [0.056, 0.05, 0.1], this.darkMetal, [0, -0.048, -0.29], [0.05, 0, 0]);
    this.box(this.tmpPump, [0.06, 0.012, 0.014], this.gunMetal, [0, 0, -0.03]); // pump ribs
    this.box(this.tmpPump, [0.06, 0.012, 0.014], this.gunMetal, [0, 0, 0.03]);
    this.box(g, [0.01, 0.034, 0.17], this.gripMat, [0.033, 0.012, 0.03]);    // shell holder
    for (let i = 0; i < 4; i++) {                                            // brass rounds
      const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.009, 0.009, 0.028, 8).rotateZ(Math.PI / 2),
        brass,
      );
      shell.position.set(0.038, 0.012, -0.03 + i * 0.04);
      g.add(shell);
    }
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.038, 0.1, 0.05], this.gripMat, [0, -0.078, 0.145], [-0.35, 0, 0]);
    this.box(g, [0.05, 0.07, 0.17], this.gripMat, [0, -0.01, 0.27]);         // straight stock
    this.box(g, [0.052, 0.09, 0.026], this.darkMetal, [0, -0.008, 0.36]);
    this.box(g, [0.072, 0.012, 0.1], accent, [0, 0.043, 0.05]);
    this.box(g, [0.014, 0.026, 0.02], this.gunMetal, [0, 0.05, -0.02]);      // bead sight
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.018, -0.49);
    g.add(muzzle);
    return muzzle;
  }

  /** Lance Rail — accelerator coils, scoped optic, skeleton stock, energy cell. */
  private buildRail(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0x7dffd4);
    this.box(g, [0.06, 0.08, 0.28], this.gunMetal, [0, 0, 0.07]);            // receiver
    this.box(g, [0.046, 0.028, 0.06], this.darkMetal, [0, -0.05, 0.02]);    // magwell
    this.tmpMag = this.box(g, [0.04, 0.13, 0.06], this.darkMetal, [0, -0.115, 0.01], [0.12, 0, 0]);
    this.barrel(g, 0.015, 0.62, this.gunMetal, [0, 0.01, -0.36]);           // heavy barrel
    this.barrel(g, 0.014, 0.008, this.muzzleCap, [0, 0.01, -0.675]);
    for (const z of [-0.18, -0.32, -0.46]) {                                 // accelerator coils
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 8, 20), accent);
      coil.position.set(0, 0.01, z);
      g.add(coil);
    }
    this.box(g, [0.036, 0.05, 0.1], this.darkMetal, [0, 0.05, 0.02]);       // scope riser
    this.barrel(g, 0.024, 0.2, this.muzzleCap, [0, 0.088, 0.02]);            // scope tube
    for (const z of [-0.05, 0.09]) {                                         // scope rings
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 8, 18), this.gunMetal);
      ring.position.set(0, 0.088, z);
      g.add(ring);
    }
    this.barrel(g, 0.03, 0.03, this.muzzleCap, [0, 0.088, 0.13]);            // ocular bell
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.1, 0.05], this.gripMat, [0, -0.078, 0.16], [-0.35, 0, 0]);
    this.box(g, [0.045, 0.045, 0.12], accent, [-0.045, 0.012, 0.07]);       // energy cell
    this.box(g, [0.012, 0.05, 0.18], this.darkMetal, [-0.02, 0.018, 0.28]); // skeleton stock
    this.box(g, [0.012, 0.05, 0.18], this.darkMetal, [0.02, 0.018, 0.28]);
    this.box(g, [0.05, 0.08, 0.024], this.gripMat, [0, 0, 0.38]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.01, -0.69);
    g.add(muzzle);
    return muzzle;
  }

  /** Harrier DMR — long barrel, tall magnification optic, fixed stock. */
  private buildDmr(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xffe08a);
    this.box(g, [0.06, 0.082, 0.34], this.gunMetal, [0, 0, 0.06]);          // long receiver
    this.box(g, [0.046, 0.028, 0.06], this.darkMetal, [0, -0.05, 0]);       // magwell
    this.tmpMag = this.box(g, [0.038, 0.13, 0.058], this.darkMetal, [0, -0.115, -0.01], [0.12, 0, 0]);
    this.box(g, [0.05, 0.05, 0.3], this.darkMetal, [0, 0.004, -0.34]);      // free-float handguard
    for (let i = 0; i < 4; i++) {                                            // handguard ports
      const z = -0.24 - i * 0.06;
      this.box(g, [0.005, 0.016, 0.028], this.gunMetal, [-0.026, 0.004, z]);
      this.box(g, [0.005, 0.016, 0.028], this.gunMetal, [0.026, 0.004, z]);
    }
    this.barrel(g, 0.012, 0.34, this.gunMetal, [0, 0.008, -0.66]);           // long barrel
    this.barrel(g, 0.021, 0.07, this.muzzleCap, [0, 0.008, -0.84]);          // muzzle brake
    this.barrel(g, 0.021, 0.008, this.muzzleCap, [0, 0.008, -0.88]);
    this.box(g, [0.03, 0.02, 0.05], this.gunMetal, [0, 0.036, -0.42]);      // gas block
    this.box(g, [0.034, 0.045, 0.09], this.darkMetal, [0, 0.056, 0.02]);    // scope riser
    this.barrel(g, 0.026, 0.26, this.muzzleCap, [0, 0.108, 0.02]);           // scope tube
    for (const z of [-0.07, 0.11]) {                                          // rings
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 18), this.gunMetal);
      ring.position.set(0, 0.108, z);
      g.add(ring);
    }
    this.barrel(g, 0.032, 0.032, this.muzzleCap, [0, 0.108, 0.155]);         // ocular bell
    this.barrel(g, 0.03, 0.03, this.muzzleCap, [0, 0.108, -0.115]);          // objective bell
    this.box(g, [0.014, 0.024, 0.026], this.darkMetal, [0, 0.132, 0.02]);   // elevation turret
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.1, 0.05], this.gripMat, [0, -0.078, 0.17], [-0.35, 0, 0]);
    this.box(g, [0.052, 0.07, 0.24], this.gripMat, [0, -0.006, 0.34]);      // fixed stock
    this.box(g, [0.054, 0.088, 0.026], this.gripMat, [0, -0.004, 0.47]);    // butt pad
    this.box(g, [0.044, 0.02, 0.12], this.gripMat, [0, 0.045, 0.33]);       // cheek riser
    this.box(g, [0.062, 0.01, 0.12], accent, [0, 0.044, 0.06]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.89);
    g.add(muzzle);
    return muzzle;
  }

  /** Bastion LMG — box drum, heavy shroud, bipod folded, carry handle. */
  private buildLmg(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xc9d4ff);
    this.box(g, [0.075, 0.1, 0.42], this.gunMetal, [0, 0, 0.08]);           // fat receiver
    this.box(g, [0.06, 0.03, 0.07], this.darkMetal, [0, -0.062, 0.04]);     // feed tray
    this.tmpMag = this.box(g, [0.09, 0.14, 0.16], this.darkMetal, [0, -0.13, 0.02], [0.1, 0, 0]); // drum
    this.box(g, [0.014, 0.1, 0.16], this.gunMetal, [0.048, -0.13, 0.02]);   // drum rim
    this.box(g, [0.014, 0.1, 0.16], this.gunMetal, [-0.048, -0.13, 0.02]);
    this.box(g, [0.062, 0.062, 0.26], this.darkMetal, [0, 0.004, -0.32]);   // shroud
    for (let i = 0; i < 4; i++) {                                            // shroud vents
      const z = -0.22 - i * 0.06;
      this.box(g, [0.068, 0.014, 0.03], this.gunMetal, [0, 0.02, z]);
      this.box(g, [0.068, 0.014, 0.03], this.gunMetal, [0, -0.014, z]);
    }
    this.barrel(g, 0.016, 0.3, this.gunMetal, [0, 0.008, -0.6]);
    this.barrel(g, 0.024, 0.08, this.muzzleCap, [0, 0.008, -0.79]);          // heavy brake
    this.barrel(g, 0.024, 0.008, this.muzzleCap, [0, 0.008, -0.835]);
    this.box(g, [0.03, 0.014, 0.24], this.gunMetal, [0, 0.058, 0.06]);      // top cover
    this.box(g, [0.014, 0.03, 0.2], this.darkMetal, [0, 0.086, 0.08]);      // carry handle
    this.barrel(g, 0.02, 0.07, this.muzzleCap, [0, 0.082, -0.06]);           // rear sight
    this.box(g, [0.012, 0.036, 0.02], this.gunMetal, [0, 0.058, -0.36]);    // front post
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.038, 0.105, 0.055], this.gripMat, [0, -0.082, 0.2], [-0.32, 0, 0]);
    this.box(g, [0.012, 0.012, 0.2], this.darkMetal, [-0.03, -0.075, -0.4], [0.5, 0, 0]); // bipod leg
    this.box(g, [0.012, 0.012, 0.2], this.darkMetal, [0.03, -0.075, -0.4], [0.5, 0, 0]);
    this.box(g, [0.05, 0.07, 0.2], this.darkMetal, [0, -0.006, 0.36]);      // solid stock
    this.box(g, [0.052, 0.09, 0.026], this.gripMat, [0, -0.004, 0.47]);
    this.box(g, [0.08, 0.01, 0.14], accent, [0, 0.055, 0.08]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.845);
    g.add(muzzle);
    return muzzle;
  }

  /** Sidewinder — compact slide pistol, no stock, short barrel. */
  private buildPistol(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xffffff);
    this.box(g, [0.042, 0.058, 0.24], this.gunMetal, [0, 0.01, 0.02]);      // slide
    this.box(g, [0.036, 0.03, 0.2], this.darkMetal, [0, -0.022, 0.02]);     // frame
    for (let i = 0; i < 4; i++) {                                            // slide serrations
      this.box(g, [0.045, 0.036, 0.008], this.darkMetal, [0, 0.012, 0.09 + i * 0.022]);
    }
    this.barrel(g, 0.011, 0.08, this.gunMetal, [0, 0.01, -0.14]);
    this.barrel(g, 0.013, 0.02, this.muzzleCap, [0, 0.01, -0.18]);
    this.tmpMag = this.box(g, [0.028, 0.1, 0.04], this.darkMetal, [0, -0.085, 0.045], [0.06, 0, 0]);
    this.box(g, [0.03, 0.09, 0.046], this.gripMat, [0, -0.075, 0.1], [-0.28, 0, 0]);
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.008, 0.02, 0.012], this.gunMetal, [0, 0.044, -0.05]);    // front sight
    this.box(g, [0.024, 0.018, 0.014], this.darkMetal, [0, 0.046, 0.1]);    // rear notch
    this.box(g, [0.04, 0.008, 0.06], accent, [0, 0.036, 0.0]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.01, -0.19);
    g.add(muzzle);
    return muzzle;
  }

  /** Siegebreaker — fat tube, wide bore, drum cylinder, no stock to speak of. */
  private buildLauncher(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xff8a3c);
    this.box(g, [0.085, 0.095, 0.3], this.gunMetal, [0, 0, 0.06]);          // breech housing
    this.barrel(g, 0.042, 0.46, this.gunMetal, [0, 0.008, -0.34]);           // fat tube
    this.barrel(g, 0.048, 0.06, this.muzzleCap, [0, 0.008, -0.6]);           // bore collar
    this.barrel(g, 0.05, 0.008, this.muzzleCap, [0, 0.008, -0.64]);
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.1, 14).rotateZ(Math.PI / 2),
      this.darkMetal,
    );
    drum.position.set(0, -0.01, 0.02);
    g.add(drum);
    for (let i = 0; i < 3; i++) {                                            // chamber mouths
      const a = (i / 3) * Math.PI * 2;
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.11, 10).rotateZ(Math.PI / 2), this.muzzleCap);
      hole.position.set(0, -0.01 + Math.sin(a) * 0.042, 0.02 + Math.cos(a) * 0.042);
      g.add(hole);
    }
    this.box(g, [0.03, 0.05, 0.14], this.gunMetal, [0, 0.06, -0.14]);       // sight rail
    this.box(g, [0.01, 0.03, 0.014], this.gunMetal, [0, 0.09, -0.3]);       // front post
    this.box(g, [0.026, 0.02, 0.016], this.darkMetal, [0, 0.088, -0.02]);   // rear notch
    this.box(g, [0.05, 0.02, 0.09], this.darkMetal, [0, 0.062, 0.14]);      // top handle
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.042, 0.105, 0.06], this.gripMat, [0, -0.088, 0.18], [-0.3, 0, 0]);
    this.box(g, [0.012, 0.012, 0.24], this.darkMetal, [0.055, 0.02, 0.1], [0, 0, 0.18]); // side rail
    this.box(g, [0.07, 0.012, 0.16], accent, [0, -0.05, -0.2]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.65);
    g.add(muzzle);
    return muzzle;
  }

  /** Helios Beam — emitter coil array with an open bore, minimal moving parts. */
  private buildBeam(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0xff5cf0);
    this.box(g, [0.058, 0.078, 0.3], this.gunMetal, [0, 0, 0.07]);          // receiver
    this.box(g, [0.044, 0.028, 0.06], this.darkMetal, [0, -0.05, 0.02]);    // cellwell
    this.tmpMag = this.box(g, [0.036, 0.12, 0.055], this.darkMetal, [0, -0.105, 0.01], [0.12, 0, 0]);
    this.barrel(g, 0.019, 0.34, this.gunMetal, [0, 0.008, -0.32]);           // emitter housing
    for (const z of [-0.2, -0.3, -0.4]) {                                     // coil array
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.009, 8, 20), accent);
      coil.position.set(0, 0.008, z);
      g.add(coil);
    }
    this.barrel(g, 0.022, 0.05, this.muzzleCap, [0, 0.008, -0.5]);
    this.barrel(g, 0.024, 0.008, this.muzzleCap, [0, 0.008, -0.53]);
    // Glowing core visible down the bore — the weapon's read at a glance.
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.3, 10).rotateX(Math.PI / 2),
      accent,
    );
    core.position.set(0, 0.008, -0.36);
    g.add(core);
    this.box(g, [0.05, 0.012, 0.2], this.gunMetal, [0, 0.048, -0.06]);      // heat rail
    this.box(g, [0.02, 0.026, 0.05], this.darkMetal, [0, 0.064, 0.02]);     // holo riser
    this.box(g, [0.03, 0.02, 0.03], accent, [0, 0.086, 0.02]);              // holo pane
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.1, 0.05], this.gripMat, [0, -0.078, 0.17], [-0.34, 0, 0]);
    this.box(g, [0.045, 0.05, 0.16], this.darkMetal, [0, 0.004, 0.29]);     // battery stock
    this.box(g, [0.048, 0.062, 0.024], this.gripMat, [0, 0, 0.38]);
    this.box(g, [0.058, 0.01, 0.1], accent, [0, 0.042, 0.07]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.54);
    g.add(muzzle);
    return muzzle;
  }

  /** Trident Burst — three-port muzzle cluster, compact receiver. */
  private buildBurst(g: THREE.Group): THREE.Object3D {
    const accent = this.accentMat(0x9dffb0);
    this.box(g, [0.062, 0.082, 0.3], this.gunMetal, [0, 0, 0.05]);          // receiver
    this.box(g, [0.048, 0.028, 0.06], this.darkMetal, [0, -0.05, -0.01]);   // magwell
    this.tmpMag = this.box(g, [0.038, 0.14, 0.058], this.darkMetal, [0, -0.12, -0.02], [0.12, 0, 0]);
    this.box(g, [0.058, 0.058, 0.2], this.darkMetal, [0, 0.004, -0.28]);    // handguard
    // Three barrels in a triangular cluster — the burst count, made visible.
    const offsets: Array<[number, number]> = [[-0.019, 0.012], [0.019, 0.012], [0, -0.017]];
    for (const [ox, oy] of offsets) {
      this.barrel(g, 0.011, 0.3, this.gunMetal, [ox, oy, -0.46]);
      this.barrel(g, 0.013, 0.03, this.muzzleCap, [ox, oy, -0.61]);
    }
    this.box(g, [0.05, 0.014, 0.18], this.gunMetal, [0, 0.048, -0.02]);     // top rail
    this.barrel(g, 0.02, 0.08, this.muzzleCap, [0, 0.08, 0]);                // optic tube
    this.box(g, [0.012, 0.03, 0.018], this.gunMetal, [0, 0.056, -0.3]);     // front post
    this.box(g, [0.014, 0.022, 0.026], this.darkMetal, [-0.034, 0.024, 0.04]); // charging handle
    this.triggerGuard(g);
    this.trigger(g);
    this.box(g, [0.036, 0.1, 0.05], this.gripMat, [0, -0.078, 0.15], [-0.35, 0, 0]);
    this.barrel(g, 0.016, 0.12, this.gunMetal, [0, 0.004, 0.24]);           // buffer tube
    this.box(g, [0.046, 0.06, 0.1], this.darkMetal, [0, -0.004, 0.34]);     // compact stock
    this.box(g, [0.048, 0.082, 0.024], this.gripMat, [0, -0.004, 0.4]);
    this.box(g, [0.064, 0.01, 0.12], accent, [0, 0.043, 0.04]);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, -0.63);
    g.add(muzzle);
    return muzzle;
  }
}
