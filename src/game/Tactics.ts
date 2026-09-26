import * as THREE from 'three';

export type TacticalKind = 'grunt' | 'rusher' | 'gunner' | 'warden';

export interface CoverSpotData {
  center: THREE.Vector3;
  left: THREE.Vector3;
  right: THREE.Vector3;
}

export interface CoverPoint extends CoverSpotData {
  id: number;
  owner: number | null;
}

export interface TacticalClaim {
  point: CoverPoint;
  peek: THREE.Vector3;
}

/**
 * Small deterministic cover allocator. World owns geometry/spot data; this class
 * prevents multiple agents from claiming the same firing angle and scores spots
 * by travel, engagement range and verified line of sight.
 */
export class TacticalDirector {
  private points: CoverPoint[] = [];
  private nextId = 1;

  public rebuild(spots: readonly CoverSpotData[]): void {
    this.points = spots.map((spot) => ({
      id: this.nextId++,
      center: spot.center,
      left: spot.left,
      right: spot.right,
      owner: null,
    }));
  }

  public clear(): void {
    this.points.length = 0;
    this.nextId = 1;
  }

  public claim(
    agentId: number,
    origin: THREE.Vector3,
    playerPos: THREE.Vector3,
    kind: TacticalKind,
    canSee: (from: THREE.Vector3, to: THREE.Vector3) => boolean,
  ): TacticalClaim | null {
    let best: TacticalClaim | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const point of this.points) {
      if (point.owner !== null) continue;
      const playerDistance = point.center.distanceTo(playerPos);
      if (playerDistance < (kind === 'rusher' ? 3 : 6) || playerDistance > 30) continue;
      const leftVisible = canSee(point.left, playerPos);
      const rightVisible = canSee(point.right, playerPos);
      if (!leftVisible && !rightVisible) continue;
      const peek = leftVisible ? point.left : point.right;
      const travel = point.center.distanceTo(origin);
      if (travel > 34) continue;
      const roleFit = kind === 'gunner'
        ? Math.abs(playerDistance - 19) * 0.45
        : kind === 'warden'
          ? Math.abs(playerDistance - 14) * 0.45
          : Math.abs(playerDistance - 12) * 0.25;
      const score = travel * 0.72 + roleFit + (leftVisible && rightVisible ? 0 : 1.2);
      if (score >= bestScore) continue;
      bestScore = score;
      best = { point, peek };
    }
    if (!best) return null;
    best.point.owner = agentId;
    return best;
  }

  public release(agentId: number): void {
    for (const point of this.points) {
      if (point.owner === agentId) point.owner = null;
    }
  }

  public get size(): number {
    return this.points.length;
  }
}
