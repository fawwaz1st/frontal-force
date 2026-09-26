import { clamp } from '../core/math';
import { TouchControls } from './TouchControls';

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
  /** True when the current input came from touch (drives HUD scheme). */
  touch: boolean;
}

export class Input {
  public onLockChange: ((locked: boolean) => void) | null = null;
  /** Fired on Esc/P keypress (native Esc also releases pointer lock separately). */
  public onPauseKey: (() => void) | null = null;
  public onFocusLost: (() => void) | null = null;
  /** Fired once the input layer switches to the touch scheme. */
  public onTouchMode: (() => void) | null = null;
  /** Touch state, merged into every frame when a touch device is in use. */
  public readonly touch = new TouchControls();

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
  /**
   * Pointer lock is unavailable on iOS Safari (and pre-144 Android). When the
   * lock request does not take, we fall back to touch look instead of gating
   * every input behind a lock that will never arrive.
   */
  private touchLook = false;
  private touchMode = false;
  private lockAttemptT = 0;
  private target: HTMLElement | null = null;
  private attached = false;

  public get lockedNow(): boolean {
    return this.locked || this.touchLook;
  }

  /** True once the player has actually used touch — used to pick the scheme. */
  public get isTouchMode(): boolean {
    return this.touchMode;
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
    this.touch.attach(target);
    this.touch.onFirstTouch = () => this.engageTouchMode();
  }

  /** Switch to the touch scheme exactly once, from a real touch gesture. */
  private engageTouchMode(): void {
    if (this.touchMode) return;
    this.touchMode = true;
    // A touch user never gets pointer lock, so drive look from the touch path.
    this.touchLook = true;
    this.onTouchMode?.();
    this.onLockChange?.(true);
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
    this.touch.detach();
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
    this.touch.reset();
  }

  /**
   * Request pointer lock. On platforms where it never arrives (iOS Safari,
   * Android < 144) this must NOT gate the game — the caller falls through to
   * the touch path, which needs no permission.
   */
  public requestLock(): void {
    if (!this.target || this.locked) return;
    // A touch user never needs the lock; unlocking the audio is enough.
    if (this.touchMode) {
      this.onLockChange?.(true);
      return;
    }
    this.lockAttemptT = performance.now();
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
    // If the lock has not landed shortly after the request, assume the platform
    // will never grant it and switch to touch look. Silent no-op is the
    // documented behaviour on pre-144 Android, so a timeout is the only signal.
    window.setTimeout(() => {
      if (this.locked || this.touchMode) return;
      if (document.pointerLockElement === this.target) return;
      if (performance.now() - this.lockAttemptT < 250) return;
      this.touchLook = true;
      this.onLockChange?.(true);
    }, 320);
  }

  /** Returns accumulated input and resets per-frame deltas. */
  public read(): InputFrame {
    const touchFrame = this.touchMode ? this.touch.read() : null;
    const frame: InputFrame = {
      moveX: touchFrame ? touchFrame.moveX : (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      moveZ: touchFrame ? touchFrame.moveZ : (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0),
      lookX: touchFrame ? touchFrame.lookX : this.lookX,
      lookY: touchFrame ? touchFrame.lookY : this.lookY,
      fireHeld: touchFrame ? touchFrame.fireHeld : this.fireHeld,
      firePressed: touchFrame ? touchFrame.fireHeld && !this.prevTouchFire : this.firePressed,
      aimHeld: touchFrame ? touchFrame.aimHeld : this.aimHeld,
      jumpPressed: touchFrame ? touchFrame.jumpPressed : this.jumpPressed,
      sprintHeld: touchFrame ? touchFrame.sprintHeld : (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      crouchHeld: touchFrame ? touchFrame.crouchHeld : (this.keys.has('ControlLeft') || this.keys.has('KeyC')),
      reloadPressed: touchFrame ? touchFrame.reloadPressed : this.reloadPressed,
      slotPressed: touchFrame ? touchFrame.slotPressed : this.slotPressed,
      wheelSteps: touchFrame ? touchFrame.cycleSteps : this.wheelSteps,
      // Touch needs no lock: report engaged so the weapon/reload paths run.
      locked: this.locked || this.touchMode,
      touch: this.touchMode,
    };
    this.prevTouchFire = touchFrame ? touchFrame.fireHeld : false;
    this.lookX = 0;
    this.lookY = 0;
    this.firePressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.slotPressed = 0;
    this.wheelSteps = 0;
    return frame;
  }

  /** Previous frame's touch fire state — derives firePressed from a held edge. */
  private prevTouchFire = false;

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
