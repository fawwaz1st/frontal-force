import * as THREE from 'three';
import type { GameAudio } from '../audio/Audio';
import type { Effects } from '../render/Effects';

/**
 * Pickup kinds.
 *
 * `health` and `ammo` are the arena's fixed stations: they respawn and are part
 * of the map. `salvage` is a DROP: it comes out of a dead enemy, it never
 * respawns, and it expires. The distinction matters because the two have
 * opposite jobs. A station is a destination the player plans around; a drop is
 * a reward that pulls the player forward into the fight.
 */
export type PickupKind = 'health' | 'ammo' | 'salvage';

interface Pickup {
  kind: PickupKind;
  mesh: THREE.Group;
  active: boolean;
  /** Seconds until this respawns. Only used by stations. */
  respawnT: number;
  /**
   * Seconds until this disappears, or Infinity for a station. A drop that
   * lingers forever turns the arena into a carpet of litter and removes the
   * pressure to move; a drop that expires is a small decision.
   */
  lifeT: number;
  /** True for a station (respawns, permanent) vs a drop (expires). */
  station: boolean;
}

const RESPAWN_TIME = 14;
/** How long a dropped item waits to be picked up. */
const DROP_LIFE = 22;
/** Radius a drop is nudged sideways so two kills do not stack exactly. */
const DROP_SCATTER = 0.9;

export class Pickups {
  private readonly group = new THREE.Group();
  private readonly pickups: Pickup[] = [];
  // Shared geometry (allocated once)
  private readonly caseGeo = new THREE.BoxGeometry(0.46, 0.3, 0.34);
  private readonly lidGeo = new THREE.BoxGeometry(0.48, 0.06, 0.36);
  private readonly crossV = new THREE.BoxGeometry(0.09, 0.02, 0.26);
  private readonly crossH = new THREE.BoxGeometry(0.26, 0.02, 0.09);
  private readonly bulletGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.24, 8);
  private readonly strapGeo = new THREE.BoxGeometry(0.48, 0.32, 0.05);
  private readonly shardGeo = new THREE.OctahedronGeometry(0.17, 0);
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
  private readonly salvageMat = new THREE.MeshStandardMaterial({
    color: 0xffd76b, emissive: 0xffb03a, emissiveIntensity: 1.6, roughness: 0.25, metalness: 0.7,
  });
  private readonly haloGeo = new THREE.RingGeometry(0.4, 0.5, 24);
  private readonly haloMats: Record<PickupKind, THREE.MeshBasicMaterial> = {
    health: new THREE.MeshBasicMaterial({
      color: 0x2aff8a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }),
    ammo: new THREE.MeshBasicMaterial({
      color: 0xffc44d, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }),
    salvage: new THREE.MeshBasicMaterial({
      color: 0xffd76b, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }),
  };

  public constructor(
    scene: THREE.Scene,
    private readonly audio: GameAudio,
    private readonly effects: Effects,
  ) {
    scene.add(this.group);
  }

  /**
   * A fixed arena station. It respawns, so it is a destination rather than a
   * reward, and it never expires.
   */
  public spawnAt(kind: PickupKind, position: THREE.Vector3): void {
    this.build(kind, position, true);
  }

  /**
   * A drop from a dead enemy. Expires, never respawns, and scatters slightly so
   * a cluster of kills does not stack every item on one point.
   *
   * `rnd` is injected rather than using Math.random so a seeded run drops
   * identically every time the seed is replayed, which is the whole promise of
   * the seed code.
   */
  public dropAt(kind: PickupKind, position: THREE.Vector3, rnd: () => number): void {
    const angle = rnd() * Math.PI * 2;
    const radius = rnd() * DROP_SCATTER;
    const scattered = position.clone();
    scattered.x += Math.cos(angle) * radius;
    scattered.z += Math.sin(angle) * radius;
    this.build(kind, scattered, false);
  }

  private build(kind: PickupKind, position: THREE.Vector3, station: boolean): void {
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
    } else if (kind === 'ammo') {
      // Ammo case: strapped band + rounds bristling from the top
      const strap = new THREE.Mesh(this.strapGeo, this.strapMat);
      mesh.add(core, lid, strap);
      for (let i = -1; i <= 1; i++) {
        const round = new THREE.Mesh(this.bulletGeo, this.bulletMat);
        round.position.set(i * 0.14, 0.3, 0);
        round.castShadow = true;
        mesh.add(round);
      }
    } else {
      // Salvage: a cut shard on a small plate, not a case. A different
      // silhouette because it is a different KIND of thing: currency, not
      // supply, and the player should read that from across the arena.
      const plate = new THREE.Mesh(this.lidGeo, this.lidMat);
      plate.scale.set(0.7, 1, 0.7);
      const shard = new THREE.Mesh(this.shardGeo, this.salvageMat);
      shard.position.y = 0.3;
      shard.rotation.y = 0.6;
      shard.castShadow = true;
      mesh.add(plate, shard);
    }
    const halo = new THREE.Mesh(this.haloGeo, this.haloMats[kind]);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.16; // flush with the floor under the grounded case
    mesh.add(halo);
    // Sits on the floor — no hover, no spin, no pop-in
    mesh.position.set(position.x, position.y + 0.17, position.z);
    this.group.add(mesh);
    this.pickups.push({
      kind,
      mesh,
      active: true,
      respawnT: 0,
      lifeT: station ? Number.POSITIVE_INFINITY : DROP_LIFE,
      station,
    });
  }

  /**
   * Collect the nearest pickup the player can actually USE.
   *
   * `usable` gates health and ammo on real need: a health drop walked over at
   * full HP stays where it is instead of being destroyed. Consuming a reward
   * that grants nothing is a punishment for winning the fight that produced
   * it, and it is invisible — the item simply ceases to exist as you touch it.
   * Salvage is currency and is always usable.
   *
   * Stations obey the same rule, which is strictly better for them too: a
   * station touched at full health stays standing, ready for the scratch
   * seconds later, instead of vanishing into its respawn timer.
   */
  public tryCollect(
    playerPos: THREE.Vector3,
    usable: (kind: PickupKind) => boolean,
  ): PickupKind | null {
    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      const dx = pickup.mesh.position.x - playerPos.x;
      const dz = pickup.mesh.position.z - playerPos.z;
      const dy = pickup.mesh.position.y - (playerPos.y + 1);
      if (dx * dx + dz * dz < 1.4 * 1.4 && Math.abs(dy) < 2) {
        if (!usable(pickup.kind)) continue;
        pickup.active = false;
        pickup.mesh.visible = false;
        pickup.respawnT = RESPAWN_TIME;
        this.audio.pickup(pickup.kind);
        this.effects.ring(
          pickup.mesh.position.clone(),
          pickup.kind === 'health' ? 0x2aff8a
            : pickup.kind === 'ammo' ? 0xffc44d : 0xffd76b,
          4,
          0.35,
        );
        return pickup.kind;
      }
    }
    return null;
  }

  public update(dt: number): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pickup = this.pickups[i];
      if (!pickup) continue;
      if (pickup.active) {
        if (pickup.lifeT === Number.POSITIVE_INFINITY) continue;
        pickup.lifeT -= dt;
        // Blink out over the last three seconds so the expiry is announced
        // rather than surprising.
        if (pickup.lifeT < 3) {
          pickup.mesh.visible = Math.floor(pickup.lifeT * 6) % 2 === 0;
        }
        if (pickup.lifeT <= 0) this.removeAt(i);
        continue;
      }
      // A collected drop is done: it never comes back.
      if (!pickup.station) {
        this.removeAt(i);
        continue;
      }
      pickup.respawnT -= dt;
      if (pickup.respawnT <= 0) {
        pickup.active = true;
        pickup.mesh.visible = true;
      }
    }
  }

  /** Live drop count, for diagnostics. */
  public get dropCount(): number {
    return this.pickups.reduce((n, p) => n + (p.station ? 0 : 1), 0);
  }

  /**
   * Every ACTIVE drop, for the radar. Stations are excluded on purpose: they
   * are permanent fixtures the player learns once, while a drop is a temporary
   * object whose position the player cannot know without being told. The
   * callback receives the kind and the world position; the position is the
   * mesh's own vector and must not be retained.
   */
  public forEachDrop(fn: (kind: PickupKind, at: THREE.Vector3) => void): void {
    for (const pickup of this.pickups) {
      if (!pickup.active || pickup.station) continue;
      fn(pickup.kind, pickup.mesh.position);
    }
  }

  private removeAt(index: number): void {
    const pickup = this.pickups[index];
    if (!pickup) return;
    this.group.remove(pickup.mesh);
    // Per-pickup meshes share the module's geometries and materials, so only
    // the group itself is discarded. Disposing the shared resources here would
    // blank every other pickup on the field.
    this.pickups.splice(index, 1);
  }

  public clear(): void {
    for (const pickup of this.pickups) this.group.remove(pickup.mesh);
    this.pickups.length = 0;
  }
}
