import * as THREE from 'three';
import type { GameAudio } from '../audio/Audio';

export type PickupKind = 'health' | 'ammo';

interface Pickup {
  kind: PickupKind;
  mesh: THREE.Group;
  active: boolean;
  respawnT: number;
  baseY: number;
  seed: number;
}

const RESPAWN_TIME = 14;

export class Pickups {
  public readonly group = new THREE.Group();
  private readonly pickups: Pickup[] = [];
  private readonly healthGeo = new THREE.OctahedronGeometry(0.32, 0);
  private readonly ammoGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  private readonly healthMat = new THREE.MeshStandardMaterial({
    color: 0x2aff8a, emissive: 0x2aff8a, emissiveIntensity: 0.9, roughness: 0.3,
  });
  private readonly ammoMat = new THREE.MeshStandardMaterial({
    color: 0xffc44d, emissive: 0xffc44d, emissiveIntensity: 0.7, roughness: 0.3,
  });

  public constructor(scene: THREE.Scene, private readonly audio: GameAudio) {
    scene.add(this.group);
  }

  public spawnAt(kind: PickupKind, position: THREE.Vector3): void {
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(kind === 'health' ? this.healthGeo : this.ammoGeo, kind === 'health' ? this.healthMat : this.ammoMat);
    core.castShadow = true;
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.5, 24),
      new THREE.MeshBasicMaterial({
        color: kind === 'health' ? 0x2aff8a : 0xffc44d,
        transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.42;
    mesh.add(core, halo);
    mesh.position.set(position.x, position.y + 0.55, position.z);
    this.group.add(mesh);
    this.pickups.push({
      kind, mesh, active: true, respawnT: 0,
      baseY: position.y + 0.55, seed: Math.random() * Math.PI * 2,
    });
  }

  /** Returns the kind collected, or null. */
  public tryCollect(playerPos: THREE.Vector3): PickupKind | null {
    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      const dx = pickup.mesh.position.x - playerPos.x;
      const dz = pickup.mesh.position.z - playerPos.z;
      const dy = pickup.mesh.position.y - (playerPos.y + 1);
      if (dx * dx + dz * dz < 1.4 * 1.4 && Math.abs(dy) < 2) {
        pickup.active = false;
        pickup.mesh.visible = false;
        pickup.respawnT = RESPAWN_TIME;
        this.audio.pickup();
        return pickup.kind;
      }
    }
    return null;
  }

  public update(dt: number): void {
    const t = performance.now() * 0.001;
    for (const pickup of this.pickups) {
      if (!pickup.active) {
        pickup.respawnT -= dt;
        if (pickup.respawnT <= 0) {
          pickup.active = true;
          pickup.mesh.visible = true;
        }
        continue;
      }
      pickup.mesh.position.y = pickup.baseY + Math.sin(t * 2 + pickup.seed) * 0.12;
      pickup.mesh.rotation.y += dt * 1.6;
    }
  }

  public clear(): void {
    for (const pickup of this.pickups) this.group.remove(pickup.mesh);
    this.pickups.length = 0;
  }
}
