import { GameMode, gameModes } from './GameModes';

export class ModeManager {
  private index = 0;
  private mode: GameMode = gameModes[0];
  private rounds = 0;

  public next() {
    this.index = (this.index + 1) % gameModes.length;
    this.mode = gameModes[this.index];
    this.rounds += 1;
    return this.mode;
  }

  public current() {
    return this.mode;
  }

  public getRounds() {
    return this.rounds;
  }

  public describe() {
    return this.mode.replace('-', ' ').toUpperCase();
  }
}
