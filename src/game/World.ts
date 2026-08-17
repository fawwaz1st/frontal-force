import * as THREE from 'three';
import { InputSystem } from './InputSystem';

export class World {
  private readonly objects: THREE.Object3D[] = [];
  private readonly ambient = new THREE.AmbientLight(0x9fb4ff, 1.8);
  private readonly dir = new THREE.DirectionalLight(0xffffff, 4);
  private readonly player = { hp: 100, armor: 50, ammo: 30, reserve: 120, ally: 'A.I. ally online', mode: 'Deathmatch' };
  private readonly playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.45, 1.1, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x9aa8ff, metalness: 0.05, roughness: 0.35 })
  );
  private readonly ground = new THREE.Mesh(
    new THREE.BoxGeometry(80, 1, 80),
    new THREE.MeshStandardMaterial({ color: 0x162033, roughness: 1 })
  );

  public constructor(private readonly scene: THREE.Scene) {
    this.ambient.intensity = 1.6;
    this.dir.position.set(6, 18, 10);
    this.scene.add(this.ambient, this.dir);
  }

  public buildArena() {
    this.ground.position.y = -1.5;
    this.scene.add(this.ground);
    for (let i = 0; i < 18; i += 1) {
      const size = 0.8 + (i % 4) * 0.4;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(size, 1 + (i % 3), size),
        new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.58, 0.22, 0.25 + i * 0.01), roughness: 0.75 })
      );
      block.position.set(Math.sin(i) * 10, -0.5 + (i % 2), Math.cos(i * 0.8) * 10);
      this.scene.add(block);
      this.objects.push(block);
    }
    this.scene.add(this.playerMesh);
  }

  public update(delta: number, input: InputSystem) {
    const snap = input.snapshot();
    this.playerMesh.rotation.y += snap.lookX * 0.0025;
    this.playerMesh.position.x += snap.moveX * delta * 4;
    this.playerMesh.position.z += snap.moveZ * delta * 4;
    this.playerMesh.position.x = THREE.MathUtils.clamp(this.playerMesh.position.x, -18, 18);
    this.playerMesh.position.z = THREE.MathUtils.clamp(this.playerMesh.position.z, -18, 18);
    this.player.ally = snap.locked ? 'A.I. ally coordinated' : 'Click to engage';
    this.player.mode = snap.locked ? 'Deathmatch' : this.player.mode;
    if (snap.shoot && this.player.ammo > 0) {
      this.player.ammo -= 1;
    }
    if (snap.reload && this.player.reserve > 0) {
      const needed = 30 - this.player.ammo;
      const load = Math.min(needed, this.player.reserve);
      this.player.ammo += load;
      this.player.reserve -= load;
    }
  }

  public getStatus() {
    return {
      hp: this.player.hp,
      armor: this.player.armor,
      ammo: `${this.player.ammo} / ${this.player.reserve}`,
      ally: this.player.ally,
      currentMode: this.player.mode,
    };
  }
}
