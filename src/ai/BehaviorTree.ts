export type BehaviorState = 'idle' | 'patrol' | 'seek' | 'attack' | 'support' | 'retreat';

export class BehaviorTree {
  private state: BehaviorState = 'idle';
  private timer = 0;

  public update(delta: number, context: { threat: number; allyNearby: boolean; health: number }) {
    this.timer += delta;
    if (context.health < 25) this.state = 'retreat';
    else if (context.threat > 0.75) this.state = context.allyNearby ? 'support' : 'attack';
    else if (context.threat > 0.35) this.state = 'seek';
    else if (this.timer > 3) this.state = 'patrol';
    else this.state = 'idle';
    return this.state;
  }

  public getState() {
    return this.state;
  }
}
