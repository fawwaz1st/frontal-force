import * as THREE from 'three';
import { itemCatalog } from './ItemSystem';

export interface PickupEntity {
  id: string;
  mesh: THREE.Mesh;
  kind: string;
  name: string;
  respawn: number;
}

export class PickupSystem {
  private readonly pickups: PickupEntity[] = [];

  public spawn(scene: THREE.Scene, position: THREE.Vector3) {
    const item = itemCatalog[this.pickups.length % itemCatalog.length];
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.35, 0),
      new THREE.MeshStandardMaterial({ color: item.rarity === 'legendary' ? 0xffd166 : 0x7ec8ff, emissive: 0x112244 })
    );
    mesh.position.copy(position);
    scene.add(mesh);
    const pickup = { id: crypto.randomUUID(), mesh, kind: item.kind, name: item.name, respawn: 0 };
    this.pickups.push(pickup);
    return pickup;
  }

  public update(delta: number) {
    for (const pickup of this.pickups) {
      pickup.mesh.rotation.y += delta;
      pickup.mesh.position.y += Math.sin(performance.now() * 0.002) * 0.001;
      if (pickup.respawn > 0) pickup.respawn = Math.max(0, pickup.respawn - delta);
    }
  }

  public all() {
    return this.pickups;
  }
}
