/**
 * Touch controls for the browser FPS.
 *
 * Design (research-backed, 2026):
 *  - PointerEvent + `pointerId` map, never TouchEvent: unified mouse/touch/pen,
 *    supports setPointerCapture, integrates with `touch-action`.
 *  - Look = free drag on the right half (PUBG/Fortnite/Pixel Gun convention):
 *    the finger can lift and re-place anywhere, giving unlimited swipe travel.
 *  - Move = floating (dynamic-origin) virtual stick on the left half: the
 *    origin is wherever the thumb lands, so there is no "missed the stick".
 *  - Buttons are plain hit-rects, checked before the stick/look regions.
 *
 * `touch-action: none` must be set on every element that receives these events
 * (see style.css) — `manipulation` is NOT enough, it still allows pan+pinch.
 */

export interface TouchFrame {
  /** −1..1 strafe, matching InputFrame.moveX semantics. */
  moveX: number;
  /** −1..1 forward/back, matching InputFrame.moveZ (negative = forward). */
  moveZ: number;
  /** Look delta in CSS pixels for this frame. */
  lookX: number;
  lookY: number;
  fireHeld: boolean;
  aimHeld: boolean;
  jumpPressed: boolean;
  sprintHeld: boolean;
  crouchHeld: boolean;
  reloadPressed: boolean;
  /** 1-based slot request, 0 = none. */
  slotPressed: number;
  /** −1/0/+1 wheel-equivalent from the weapon-cycle button. */
  cycleSteps: number;
  /** True while at least one finger is down — replaces pointer-lock `locked`. */
  active: boolean;
}

/** Radial dead zone as a fraction of stick radius. */
const DEAD_ZONE = 0.18;
/** Stick radius in CSS pixels — the travel that maps to full deflection. */
const STICK_RADIUS = 62;
/** Look sensitivity in degrees per CSS pixel (hip); ADS scales it down. */
const LOOK_DEG_PER_PX = 0.25;
const LOOK_ADS_SCALE = 0.45;
/** Fraction of the viewport width that belongs to the movement stick. */
const MOVE_ZONE_FRACTION = 0.45;

interface Stick {
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

interface LookDrag {
  pointerId: number;
  lastX: number;
  lastY: number;
}

type ButtonId =
  | 'fire' | 'aim' | 'jump' | 'sprint' | 'crouch' | 'reload' | 'cycle';

interface TouchButton {
  id: ButtonId;
  /** Centre in CSS px, recomputed on resize. */
  x: number;
  y: number;
  radius: number;
  /** Assigned pointerId while held, or null. */
  pointerId: number | null;
}

export class TouchControls {
  /** Called with the accumulated frame; the owner merges it into InputFrame. */
  public onFrame: ((frame: TouchFrame) => void) | null = null;
  /** Fired on the first touch so the game can unlock audio inside the gesture. */
  public onFirstTouch: (() => void) | null = null;

  private target: HTMLElement | null = null;
  private attached = false;
  private readonly stick: Stick = { pointerId: -1, originX: 0, originY: 0, x: 0, y: 0 };
  private readonly look: LookDrag = { pointerId: -1, lastX: 0, lastY: 0 };
  private readonly buttons: TouchButton[] = [];
  private readonly held = new Map<number, ButtonId>();
  private lookDX = 0;
  private lookDY = 0;
  private jumpLatch = false;
  private reloadLatch = false;
  private cycleLatch = 0;
  private slotLatch = 0;
  private hadTouch = false;
  private viewportW = 0;
  private viewportH = 0;
  /** Player-tuned look multiplier (separate from the mouse sensitivity). */
  private sensitivity = 1;

  /** Set the touch look multiplier from the settings menu. */
  public setSensitivity(mult: number): void {
    this.sensitivity = Math.max(0.2, Math.min(3, mult));
  }

  /** True once a real touch has been seen — used to pick the control scheme. */
  public get isTouchDevice(): boolean {
    return this.hadTouch;
  }

  public attach(target: HTMLElement): void {
    if (this.attached) return;
    this.attached = true;
    this.target = target;
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    // pointercancel fires when the browser steals the gesture — always reset.
    target.addEventListener('pointercancel', this.onPointerUp);
    target.addEventListener('lostpointercapture', this.onPointerUp);
    target.addEventListener('contextmenu', this.onContextMenu);
    this.layout();
  }

  public detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const target = this.target;
    if (!target) return;
    target.removeEventListener('pointerdown', this.onPointerDown);
    target.removeEventListener('pointermove', this.onPointerMove);
    target.removeEventListener('pointerup', this.onPointerUp);
    target.removeEventListener('pointercancel', this.onPointerUp);
    target.removeEventListener('lostpointercapture', this.onPointerUp);
    target.removeEventListener('contextmenu', this.onContextMenu);
    this.target = null;
    this.reset();
  }

  public reset(): void {
    this.stick.pointerId = -1;
    this.look.pointerId = -1;
    this.held.clear();
    for (const b of this.buttons) b.pointerId = null;
    this.lookDX = 0;
    this.lookDY = 0;
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.cycleLatch = 0;
    this.slotLatch = 0;
  }

  /** Recompute button rects. Call on resize/orientationchange. */
  public layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.viewportW = w;
    this.viewportH = h;
    const r = Math.max(30, Math.min(46, w * 0.055));
    const pad = r + Math.max(10, w * 0.02);
    this.buttons.length = 0;
    const add = (id: ButtonId, x: number, y: number, radius = r): void => {
      this.buttons.push({ id, x, y, radius, pointerId: null });
    };
    // Right cluster: primary actions, thumb-reachable arc.
    add('fire', w - pad, h - pad, r * 1.22);
    add('aim', w - pad - r * 2.5, h - pad * 1.25);
    add('jump', w - pad - r * 2.2, h - pad * 2.9);
    // Left cluster: utility, above the stick zone.
    add('sprint', pad, h - pad * 3.6, r * 0.86);
    add('crouch', pad + r * 2.2, h - pad * 3.6, r * 0.86);
    add('reload', pad, h - pad * 5.6, r * 0.86);
    add('cycle', pad + r * 2.2, h - pad * 5.6, r * 0.86);
  }

  /** Hit-test the buttons; returns the button under a point, or null. */
  public buttonAt(x: number, y: number): TouchButton | null {
    for (const b of this.buttons) {
      const dx = x - b.x;
      const dy = y - b.y;
      if (dx * dx + dy * dy <= b.radius * b.radius) return b;
    }
    return null;
  }

  public get buttonsForRender(): readonly TouchButton[] {
    return this.buttons;
  }

  public get stickState(): { active: boolean; originX: number; originY: number; x: number; y: number } {
    return {
      active: this.stick.pointerId !== -1,
      originX: this.stick.originX,
      originY: this.stick.originY,
      x: this.stick.x,
      y: this.stick.y,
    };
  }

  /** Is a given button currently held? Drives the pressed styling. */
  public isHeld(id: ButtonId): boolean {
    for (const value of this.held.values()) {
      if (value === id) return true;
    }
    return false;
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (!this.hadTouch) {
      this.hadTouch = true;
      this.onFirstTouch?.();
    }
    const target = this.target;
    if (!target) return;
    // Capture on the shared container so moves keep arriving outside its bounds.
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const x = e.clientX;
    const y = e.clientY;

    const button = this.buttonAt(x, y);
    if (button) {
      button.pointerId = e.pointerId;
      this.held.set(e.pointerId, button.id);
      if (button.id === 'jump') this.jumpLatch = true;
      if (button.id === 'reload') this.reloadLatch = true;
      if (button.id === 'cycle') this.cycleLatch = 1;
      e.preventDefault();
      return;
    }

    // Left 45% = movement stick (floating origin at the touch point).
    if (x < this.viewportW * MOVE_ZONE_FRACTION && this.stick.pointerId === -1) {
      this.stick.pointerId = e.pointerId;
      this.stick.originX = x;
      this.stick.originY = y;
      this.stick.x = x;
      this.stick.y = y;
      e.preventDefault();
      return;
    }

    // Everything else = look drag.
    if (this.look.pointerId === -1) {
      this.look.pointerId = e.pointerId;
      this.look.lastX = x;
      this.look.lastY = y;
      e.preventDefault();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.pointerId) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      e.preventDefault();
      return;
    }
    if (e.pointerId === this.look.pointerId) {
      // Coalesced events preserve 120 Hz sampling between frames.
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      for (const ev of events.length > 0 ? events : [e]) {
        this.lookDX += ev.clientX - this.look.lastX;
        this.lookDY += ev.clientY - this.look.lastY;
        this.look.lastX = ev.clientX;
        this.look.lastY = ev.clientY;
      }
      e.preventDefault();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stick.pointerId) {
      this.stick.pointerId = -1;
      this.stick.x = this.stick.originX;
      this.stick.y = this.stick.originY;
    }
    if (e.pointerId === this.look.pointerId) this.look.pointerId = -1;
    const id = this.held.get(e.pointerId);
    if (id) {
      this.held.delete(e.pointerId);
      for (const b of this.buttons) {
        if (b.pointerId === e.pointerId) b.pointerId = null;
      }
    }
  };

  /**
   * Produce and consume this frame's touch state. `adsScale` shrinks look
   * sensitivity while aiming, matching the mouse path.
   */
  public read(adsScale = 1): TouchFrame {
    const dx = this.stick.x - this.stick.originX;
    const dy = this.stick.y - this.stick.originY;
    const magnitude = Math.hypot(dx, dy);
    let moveX = 0;
    let moveZ = 0;
    if (this.stick.pointerId !== -1 && magnitude > 1e-3) {
      // Scaled radial dead zone: no jump at the threshold, full range preserved.
      const clamped = Math.min(magnitude, STICK_RADIUS) / STICK_RADIUS;
      if (clamped > DEAD_ZONE) {
        const scaled = (clamped - DEAD_ZONE) / (1 - DEAD_ZONE);
        const nx = (dx / magnitude) * scaled;
        const ny = (dy / magnitude) * scaled;
        moveX = nx;
        // Screen-down = backwards, so negate into the InputFrame convention.
        moveZ = -ny;
      }
    }

    const scale = LOOK_DEG_PER_PX * this.sensitivity * (1 - (1 - LOOK_ADS_SCALE) * adsScale);
    const frame: TouchFrame = {
      moveX,
      moveZ,
      // Player applies its own radians-per-pixel constant, so hand it pixels.
      lookX: this.lookDX * scale,
      lookY: this.lookDY * scale,
      fireHeld: this.isHeld('fire'),
      aimHeld: this.isHeld('aim'),
      jumpPressed: this.jumpLatch,
      sprintHeld: this.isHeld('sprint'),
      crouchHeld: this.isHeld('crouch'),
      reloadPressed: this.reloadLatch,
      slotPressed: this.slotLatch,
      cycleSteps: this.cycleLatch,
      active: this.stick.pointerId !== -1 || this.look.pointerId !== -1 || this.held.size > 0,
    };
    this.lookDX = 0;
    this.lookDY = 0;
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.slotLatch = 0;
    this.cycleLatch = 0;
    return frame;
  }

  /** Request a weapon slot from a HUD tap (the slot chips are DOM buttons). */
  public requestSlot(slot: number): void {
    this.slotLatch = slot;
  }

  public get viewport(): { w: number; h: number } {
    return { w: this.viewportW, h: this.viewportH };
  }
}
