import * as THREE from 'three';
import type { GameAudio } from '../audio/Audio';
import type { Effects } from '../combat/Effects';

export type PickupKind = 'health' | 'ammo';

interface Pickup {
  kind: PickupKind;
  mesh: THREE.Group;
  active: boolean;
  respawnT: number;
}

const RESPAWN_TIME = 14;

export class Pickups {
  private readonly group = new THREE.Group();
  private readonly pickups: Pickup[] = [];
  // Shared geometry for both archetypes (allocated once)
  private readonly caseGeo = new THREE.BoxGeometry(0.46, 0.3, 0.34);
  private readonly lidGeo = new THREE.BoxGeometry(0.48, 0.06, 0.36);
  private readonly crossV = new THREE.BoxGeometry(0.09, 0.02, 0.26);
  private readonly crossH = new THREE.BoxGeometry(0.26, 0.02, 0.09);
  private readonly bulletGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.24, 8);
  private readonly strapGeo = new THREE.BoxGeometry(0.48, 0.32, 0.05);
  private readonly caseMat = new THREE.MeshStandardMaterial({
    color: 0x1d2a24, roughness: 0.55, metalness: 0.4,
  });
  private readonly lidMat = new THREE.MeshStandardMaterial({
    color: 0x141c18, roughness: 0.5, metalness: 0.5,
  });
  private readonly healthMat = new THREE.MeshStandardMaterial({
    color: 0x2aff8a, emissive: 0x2aff8a, emissiveIntensity: 1.4, roughness: 0.3,
  });
  private readonly bulletMat = new THREE.MeshStandardMaterial({
    color: 0xffc44d, emissive: 0xffa62b, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.6,
  });
  private readonly strapMat = new THREE.MeshStandardMaterial({
    color: 0x2a3348, roughness: 0.5, metalness: 0.6,
  });
  private readonly haloGeo = new THREE.RingGeometry(0.4, 0.5, 24);
  private readonly haloMats = {
    health: new THREE.MeshBasicMaterial({
      color: 0x2aff8a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }),
    ammo: new THREE.MeshBasicMaterial({
      color: 0xffc44d, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }),
  } as const;

  public constructor(
    scene: THREE.Scene,
    private readonly audio: GameAudio,
    private readonly effects: Effects,
  ) {
    scene.add(this.group);
  }

  public spawnAt(kind: PickupKind, position: THREE.Vector3): void {
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(this.caseGeo, this.caseMat);
    core.castShadow = true;
    const lid = new THREE.Mesh(this.lidGeo, this.lidMat);
    lid.position.y = 0.17;
    if (kind === 'health') {
      // Medical case: glowing cross on the lid
      const cv = new THREE.Mesh(this.crossV, this.healthMat);
      const ch = new THREE.Mesh(this.crossH, this.healthMat);
      cv.position.y = ch.position.y = 0.205;
      mesh.add(core, lid, cv, ch);
    } else {
      // Ammo case: strapped band + rounds bristling from the top
      const strap = new THREE.Mesh(this.strapGeo, this.strapMat);
      mesh.add(core, lid, strap);
      for (let i = -1; i <= 1; i++) {
        const round = new THREE.Mesh(this.bulletGeo, this.bulletMat);
        round.position.set(i * 0.14, 0.3, 0);
        round.castShadow = true;
        mesh.add(round);
      }
    }
    const halo = new THREE.Mesh(
      this.haloGeo,
      kind === 'health' ? this.haloMats.health : this.haloMats.ammo,
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.16; // flush with the floor under the grounded case
    mesh.add(halo);
    // Case sits on the floor — no hover, no spin, no pop-in
    mesh.position.set(position.x, position.y + 0.17, position.z);
    this.group.add(mesh);
    this.pickups.push({ kind, mesh, active: true, respawnT: 0 });
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
        this.audio.pickup(pickup.kind);
        this.effects.ring(
          pickup.mesh.position.clone(),
          pickup.kind === 'health' ? 0x2aff8a : 0xffc44d,
          4,
          0.35,
        );
        return pickup.kind;
      }
    }
    return null;
  }

  public update(dt: number): void {
    for (const pickup of this.pickups) {
      if (!pickup.active) {
        pickup.respawnT -= dt;
        if (pickup.respawnT <= 0) {
          pickup.active = true;
          pickup.mesh.visible = true;
        }
      }
    }
  }

  public clear(): void {
    for (const pickup of this.pickups) this.group.remove(pickup.mesh);
    this.pickups.length = 0;
  }
}
