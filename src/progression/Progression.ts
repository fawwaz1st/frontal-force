export interface SkillNode {
  id: string;
  name: string;
  description: string;
  cost: number;
  unlocked: boolean;
  children: string[];
}

export class Progression {
  private xp = 0;
  private level = 1;
  private skillPoints = 0;
  private readonly skills: Map<string, SkillNode> = new Map();

  public addXp(amount: number) {
    this.xp += amount;
    while (this.xp >= this.xpForNext()) {
      this.xp -= this.xpForNext();
      this.level += 1;
      this.skillPoints += 1;
    }
  }

  public spendSkillPoint() {
    if (this.skillPoints <= 0) return false;
    this.skillPoints -= 1;
    return true;
  }

  public xpForNext() {
    return this.level * 100;
  }

  public getLevel() {
    return this.level;
  }

  public getXp() {
    return this.xp;
  }

  public getSkillPoints() {
    return this.skillPoints;
  }

  public unlockSkill(id: string) {
    const skill = this.skills.get(id);
    if (!skill || skill.unlocked) return false;
    if (!this.spendSkillPoint()) return false;
    skill.unlocked = true;
    return true;
  }

  public registerSkills(nodes: SkillNode[]) {
    for (const node of nodes) this.skills.set(node.id, node);
  }

  public listSkills() {
    return [...this.skills.values()];
  }
}