import * as THREE from 'three';

export type AgentRole = 'enemy-grunt' | 'enemy-sniper' | 'enemy-tank' | 'enemy-boss' | 'enemy-drone' | 'enemy-support' | 'enemy-stealth' | 'ally';
export type AgentState = 'idle' | 'patrol' | 'seek' | 'attack' | 'support' | 'retreat' | 'revive' | 'flank' | 'hold';

export interface AgentBrain {
  id: string;
  role: AgentRole;
  state: AgentState;
  health: number;
  position: THREE.Vector3;
  targetPosition: THREE.Vector3;
  lastVoiceLine: string;
  chat: string[];
  mesh: THREE.Object3D;
}

export class Agents {
  private readonly agents = new Map<string, AgentBrain>();

  public spawn(role: AgentRole, position: THREE.Vector3) {
    const id = `${role}-${crypto.randomUUID()}`;
    const mesh = this.createMesh(role);
    mesh.position.copy(position);
    this.agents.set(id, {
      id,
      role,
      state: role === 'ally' ? 'hold' : 'patrol',
      health: role === 'enemy-tank' || role === 'enemy-boss' ? 220 : 100,
      position: position.clone(),
      targetPosition: position.clone(),
      lastVoiceLine: role === 'ally' ? 'Covering your flank.' : 'Target acquired.',
      chat: [],
      mesh,
    });
    return this.agents.get(id)!;
  }

  public update(delta: number, playerPosition: THREE.Vector3) {
    for (const agent of this.agents.values()) {
      const distance = agent.position.distanceTo(playerPosition);
      if (agent.role === 'ally') {
        agent.state = distance > 8 ? 'seek' : distance < 4 ? 'hold' : 'support';
        agent.targetPosition.copy(playerPosition).add(new THREE.Vector3(1.5, 0, 1.5));
        agent.lastVoiceLine = agent.state === 'support' ? 'I have you.' : 'Moving up.';
      } else {
        if (agent.health < 25) agent.state = 'retreat';
        else if (distance < 6) agent.state = 'attack';
        else if (distance < 14) agent.state = agent.role === 'enemy-sniper' ? 'hold' : 'seek';
        else agent.state = 'patrol';
        agent.targetPosition.copy(playerPosition);
        agent.lastVoiceLine = agent.state === 'attack' ? 'Engaging target.' : 'Searching sector.';
      }
      const move = agent.targetPosition.clone().sub(agent.position);
      if (move.lengthSq() > 0.001) {
        move.normalize().multiplyScalar(delta * (agent.role === 'enemy-tank' ? 1.5 : agent.role === 'enemy-sniper' ? 2.1 : 3.2));
        agent.position.add(move);
        agent.mesh.position.copy(agent.position);
        agent.mesh.rotation.y += delta * 0.5;
      }
    }
  }

  public all() {
    return [...this.agents.values()];
  }

  private createMesh(role: AgentRole) {
    const color = role === 'ally' ? 0x86d4ff : role === 'enemy-boss' ? 0xff6b6b : role === 'enemy-tank' ? 0xc9a227 : 0xd96eff;
    const mesh = new THREE.Mesh(
      role === 'enemy-drone'
        ? new THREE.OctahedronGeometry(0.45, 0)
        : new THREE.CapsuleGeometry(role === 'enemy-tank' ? 0.65 : 0.35, role === 'enemy-tank' ? 1.4 : 1.0, 4, 8),
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 })
    );
    return mesh;
  }
}
