import { clamp } from '../core/math';

export interface InputFrame {
  moveX: number;
  moveZ: number;
  lookX: number;
  lookY: number;
  fireHeld: boolean;
  firePressed: boolean;
  aimHeld: boolean;
  jumpPressed: boolean;
  sprintHeld: boolean;
  crouchHeld: boolean;
  reloadPressed: boolean;
  slotPressed: number;
  wheelSteps: number;
  locked: boolean;
}

export class Input {
  public onLockChange: ((locked: boolean) => void) | null = null;
  /** Fired on Esc/P keypress (native Esc also releases pointer lock separately). */
  public onPauseKey: (() => void) | null = null;
  public onFocusLost: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private fireHeld = false;
  private firePressed = false;
  private jumpPressed = false;
  private aimHeld = false;
  private reloadPressed = false;
  private slotPressed = 0;
  private wheelSteps = 0;
  private locked = false;
  private target: HTMLElement | null = null;
  private attached = false;

  public get lockedNow(): boolean {
    return this.locked;
  }

  public attach(target: HTMLElement): void {
    if (this.attached) return;
    this.attached = true;
    this.target = target;
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this.onLockChangeNative);
    // RMB is ADS now — keep the context menu off the canvas
    target.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
  }

  public detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.resetTransient();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChangeNative);
    this.target?.removeEventListener('contextmenu', this.onContextMenu);
    this.target = null;
    window.removeEventListener('blur', this.onBlur);
  }

  /** Clear held and one-frame state after blur, lock loss, pause, or teardown. */
  public resetTransient(): void {
    this.keys.clear();
    this.lookX = 0;
    this.lookY = 0;
    this.fireHeld = false;
    this.firePressed = false;
    this.jumpPressed = false;
    this.aimHeld = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    this.wheelSteps = 0;
  }

  /** Must be called from inside a user gesture (click/keydown). */
  public requestLock(): void {
    if (!this.target || this.locked) return;
    try {
      const el = this.target as HTMLElement & {
        requestPointerLock: (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;
      };
      const result = el.requestPointerLock({ unadjustedMovement: true });
      if (result instanceof Promise) {
        result.catch(() => {
          if (this.locked || !this.target) return;
          try {
            const fallback = this.target.requestPointerLock();
            if (fallback instanceof Promise) fallback.catch(() => undefined);
          } catch {
            /* pointer lock unsupported */
          }
        });
      }
    } catch {
      try {
        this.target.requestPointerLock();
      } catch {
        /* pointer lock unsupported */
      }
    }
  }

  /** Returns accumulated input and resets per-frame deltas. */
  public read(): InputFrame {
    const frame: InputFrame = {
      moveX: (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      moveZ: (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0),
      lookX: this.lookX,
      lookY: this.lookY,
      fireHeld: this.fireHeld,
      firePressed: this.firePressed,
      aimHeld: this.aimHeld,
      jumpPressed: this.jumpPressed,
      sprintHeld: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      crouchHeld: this.keys.has('ControlLeft') || this.keys.has('KeyC'),
      reloadPressed: this.reloadPressed,
      slotPressed: this.slotPressed,
      wheelSteps: this.wheelSteps,
      locked: this.locked,
    };
    this.lookX = 0;
    this.lookY = 0;
    this.firePressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    this.wheelSteps = 0;
    return frame;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // Block Space/Tab only during gameplay — menus keep native keyboard nav
    // (Tab order, Space to activate buttons).
    if (this.locked && (e.code === 'Space' || e.code === 'Tab')) e.preventDefault();
    this.keys.add(e.code);
    if (e.code === 'Space') this.jumpPressed = true;
    if (e.code === 'KeyR') this.reloadPressed = true;
    if (e.code === 'Escape' || e.code === 'KeyP') this.onPauseKey?.();
    if (e.code.startsWith('Digit')) {
      const digit = Number(e.code.slice(5));
      if (digit >= 1 && digit <= 9) this.slotPressed = digit;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.lookX += e.movementX;
    this.lookY += e.movementY;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.locked || (e.button !== 0 && e.button !== 2)) return;
    if (e.button === 0) {
      this.fireHeld = true;
      this.firePressed = true;
    } else {
      this.aimHeld = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.fireHeld = false;
    else if (e.button === 2) this.aimHeld = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.locked || e.deltaY === 0) return;
    this.wheelSteps = clamp(this.wheelSteps + Math.sign(e.deltaY), -8, 8);
  };

  private onLockChangeNative = (): void => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) this.resetTransient();
    this.onLockChange?.(this.locked);
  };

  private onBlur = (): void => {
    this.resetTransient();
    this.onFocusLost?.();
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
}
