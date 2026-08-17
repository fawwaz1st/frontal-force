export interface SkillNode {
  id: string;
  name: string;
  description: string;
  cost: number;
  unlocked: boolean;
}

export class SkillTree {
  private readonly nodes = new Map<string, SkillNode>([
    ['weapon-damage', { id: 'weapon-damage', name: 'Weapon Damage', description: 'Increase all weapon damage.', cost: 1, unlocked: true }],
    ['movement-speed', { id: 'movement-speed', name: 'Movement Speed', description: 'Move faster and strafe better.', cost: 1, unlocked: true }],
    ['armor-core', { id: 'armor-core', name: 'Armor Core', description: 'Higher armor capacity.', cost: 1, unlocked: true }],
    ['ally-ai', { id: 'ally-ai', name: 'Ally AI', description: 'Better squad tactics.', cost: 2, unlocked: false }],
    ['utility-radar', { id: 'utility-radar', name: 'Radar', description: 'Reveal nearby threats.', cost: 2, unlocked: false }],
    ['weapon-recoil', { id: 'weapon-recoil', name: 'Recoil Dampener', description: 'Reduce recoil.', cost: 1, unlocked: false }],
    ['reload-speed', { id: 'reload-speed', name: 'Reload Speed', description: 'Reload faster.', cost: 1, unlocked: false }],
    ['health-core', { id: 'health-core', name: 'Health Core', description: 'Increase max health.', cost: 1, unlocked: false }],
    ['shield-core', { id: 'shield-core', name: 'Shield Core', description: 'Increase max shield.', cost: 1, unlocked: false }],
    ['sprint-bio', { id: 'sprint-bio', name: 'Sprint Bio', description: 'Longer sprint.', cost: 1, unlocked: false }],
  ]);

  public unlock(id: string) {
    const node = this.nodes.get(id);
    if (node) node.unlocked = true;
    return !!node;
  }

  public list() {
    return [...this.nodes.values()];
  }
}
