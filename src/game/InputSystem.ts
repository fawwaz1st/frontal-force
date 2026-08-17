export interface InputSnapshot {
  moveX: number;
  moveZ: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  shoot: boolean;
  reload: boolean;
  interact: boolean;
  weaponSlot: number;
  locked: boolean;
}

export class InputSystem {
  private readonly keys = new Set<string>();
  private readonly mouse = { x: 0, y: 0 };
  private locked = false;
  private element: HTMLElement | null = null;
  private hudRoot: HTMLElement | null = null;

  public attach(element: HTMLElement, hud: { root: HTMLElement }) {
    this.element = element;
    this.hudRoot = hud.root;
    element.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('keyup', this.onKey);
    document.addEventListener('mousemove', this.onMouse);
  }

  public detach() {
    this.element?.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('keyup', this.onKey);
    document.removeEventListener('mousemove', this.onMouse);
  }

  public requestLock() {
    if (!this.locked && this.element) {
      void this.element.requestPointerLock({ unadjustedMovement: true } as any);
    }
  }

  public getStatus(): { locked: boolean } {
    return { locked: this.locked };
  }

  public snapshot(): InputSnapshot {
    const moveX = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
    const moveZ = (this.keys.has('s') ? 1 : 0) - (this.keys.has('w') ? 1 : 0);
    const weaponSlot = this.keys.has('1') ? 1 : this.keys.has('2') ? 2 : this.keys.has('3') ? 3 : 0;
    return {
      moveX,
      moveZ,
      lookX: this.locked ? this.mouse.x : 0,
      lookY: this.locked ? this.mouse.y : 0,
      jump: this.keys.has(' '),
      sprint: this.keys.has('shift'),
      crouch: this.keys.has('control'),
      shoot: this.keys.has('z'),
      reload: this.keys.has('r'),
      interact: this.keys.has('e'),
      weaponSlot,
      locked: this.locked,
    };
  }

  private onClick = () => {
    if (!this.locked) this.requestLock();
  };

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.element;
    if (this.hudRoot) {
      this.hudRoot.classList.toggle('pointer-locked', this.locked);
    }
  };

  private onLockError = () => {
    this.locked = false;
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') {
      this.keys.add(e.key.toLowerCase());
    } else {
      this.keys.delete(e.key.toLowerCase());
    }
  };

  private onMouse = (e: MouseEvent) => {
    this.mouse.x = e.movementX;
    this.mouse.y = e.movementY;
  };
}