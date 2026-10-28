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
  /** Dash / air-dash. */
  dashPressed: boolean;
  /** Hold to cook a grenade, release to throw. */
  grenadeHeld: boolean;
  /** Cycle frag / smoke / EMP. */
  grenadeCyclePressed: boolean;
  /** Quick melee / execution. */
  meleePressed: boolean;
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
  | 'fire' | 'aim' | 'jump' | 'sprint' | 'crouch' | 'reload' | 'cycle'
  | 'dash' | 'grenade' | 'melee';

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
  private dashLatch = false;
  private grenadeCycleLatch = false;
  private meleeLatch = false;
  private cycleLatch = 0;
  private slotLatch = 0;
  private hadTouch = false;
  private viewportW = 0;
  /** Player-tuned look multiplier (separate from the mouse sensitivity). */
  private sensitivity = 1;

  /** Set the touch look multiplier from the settings menu. */
  public setSensitivity(mult: number): void {
    this.sensitivity = Math.max(0.2, Math.min(3, mult));
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
    // Safety net: if setPointerCapture failed, a finger lifting over a HUD
    // sibling of the canvas never reaches the canvas listener and the button
    // would stay held. Window-level listeners always fire.
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
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
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
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
    this.dashLatch = false;
    this.grenadeCycleLatch = false;
    this.meleeLatch = false;
    this.cycleLatch = 0;
    this.slotLatch = 0;
  }

  /** Recompute button rects. Call on resize/orientationchange. */
  public layout(): void {
    // The VISUAL viewport is what the pointer coordinates are relative to, and
    // on iOS it differs from innerWidth/innerHeight whenever the address bar
    // is showing or the page is zoomed. Using innerHeight here would offset
    // every hit-rect vertically.
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);
    this.viewportW = w;
    // Notch / home-indicator insets, read from the CSS custom properties so
    // there is exactly one source of truth for the safe area.
    const cs = getComputedStyle(document.documentElement);
    const safeB = parseFloat(cs.getPropertyValue('--safe-b')) || 0;
    const safeT = parseFloat(cs.getPropertyValue('--safe-t')) || 0;
    const safeL = parseFloat(cs.getPropertyValue('--safe-l')) || 0;
    const safeR = parseFloat(cs.getPropertyValue('--safe-r')) || 0;
    // The base floor is the tap minimum, not an aesthetic choice: 30nm of radius
    // renders as a 51px hit-target, which is below the 60px floor DESIGN.md
    // requires of every touch control. 32nm gives 64px at the smallest.
    const BASE_MIN = 32;
    const BASE_MAX = 46;
    // The floor is the tap minimum, not an aesthetic choice: 30nm of radius
    // renders as a 51px hit-target, which is below the 60px floor DESIGN.md
    // requires of every touch control. 32nm gives 64px at the smallest.
    const r = Math.max(BASE_MIN, Math.min(BASE_MAX, w * 0.055));
    const pad = r + Math.max(10, w * 0.02);
    this.buttons.length = 0;
    // The registration helper both clusters use. Keeping it here means the grid
    // solver and the utility row share one insertion path.
    const add = (id: ButtonId, x: number, y: number, radius = r): void => {
      this.buttons.push({ id, x, y, radius, pointerId: null });
    };
    // ---- Right cluster: an adaptive grid, never a hand-placed arc.
    //
    // The six action buttons used to sit on a hand-tuned fan, and the fan could
    // not serve every viewport: it overlapped on a landscape 844x390, pushed the
    // grenade button off a 320x480, and adding the three ability buttons made
    // both worse. Tuning per-phone magic numbers is a treadmill, so the cluster
    // is SOLVED from the room the viewport actually has.
    // ---- Cell geometry constants, shared by the sizing loop and the
    // placement of BOTH clusters. One derivation means the action grid and the
    // utility row cannot disagree about what a tap is worth.
    const FIRE_K = 1.15;
    // Radii as a fraction of the base. SMALL_K >= 0.9375 is what keeps the
    // smallest hit-target at or above the 30nm (60px) floor once base is at its
    // own 32nm floor — 0.85 rendered 54px, below the documented minimum.
    const SMALL_K = 0.95;
    const GAP_K = 0.14;
    // The base floor is the tap minimum, not an aesthetic choice: 30nm of radius
    // renders as a 51px hit-target, which is below the 60px floor DESIGN.md
    // requires of every touch control. 32nm gives 64px at the smallest.
    // ---- Right cluster: an adaptive grid, never a hand-placed arc.
    //
    // The six action buttons used to sit on a hand-tuned fan, and the fan could
    // not serve every viewport: it overlapped on a landscape 844x390, pushed the
    // grenade button off a 320x480, and adding the three ability buttons made
    // both worse. Tuning per-phone magic numbers is a treadmill, so the cluster
    // is SOLVED from the room the viewport actually has:
    //
    //   1. The right-hand region is bounded by the safe insets on the right and
    //      by the left utility row (which owns the bottom-left corner).
    //   2. A button size is chosen, the grid cell is derived FROM that size, and
    //      the number of columns and rows is derived from the region.
    //   3. The size shrinks until the whole cluster fits, so a small phone gets
    //      smaller buttons rather than buttons that overlap or fall off-screen,
    //      and a tablet keeps the large ones.
    //
    // The grid fills bottom-up, right-to-left, so FIRE always lands in the
    // corner where the thumb rests and the abilities fan toward the middle.
    const CLUSTER: ButtonId[] = ['fire', 'jump', 'aim', 'melee', 'dash', 'grenade'];
    // Left edge of the right-hand cluster: the left utility row owns the
    // bottom-left corner, so the action grid starts to its right of it.
    const regionLeft = pad + safeL + BASE_MIN * 3.1;
    const regionRight = w - safeR;
    const regionTop = safeT + BASE_MIN * 0.4;
    const bottom = h - safeB;
    const spaceA = regionRight - regionLeft;
    const spaceB = bottom - regionTop;

    // German for "one place": both clusters read these after the sizing loop.
    let cellStep = 0;
    let fireR = 0;
    let smallR = 0;
    let gapSize = 0;

    const fitM = (base: number): number => {
      fireR = base * FIRE_K;
      smallR = base * SMALL_K;
      gapSize = base * GAP_K;
      cellStep = fireR + smallR + gapSize;
      return Math.max(1, Math.floor(spaceA / cellStep));
    };

    let cols = 0;
    for (let attempt = 0; attempt <= 80; attempt++) {
      const base = BASE_MAX - attempt * 0.25;
      if (base < BASE_MIN) break;
      cols = fitM(base);
      const rows = Math.max(1, Math.floor(spaceB / cellStep));
      if (cols * rows < CLUSTER.length) continue;
      break;
    }
    // Fallback guard: a degenerate viewport (a split-screen phone, say) still
    // keeps every button on screen. The grid already guarantees separation, so
    // this only bites when the viewport is too small for even the floor size.
    fitM(BASE_MIN);
    cols = Math.max(1, cols);

    // FIRE is the thumb anchor and sits in the bottom-right cell; the cluster
    // fills toward the middle so no thumb travel is needed to reach a dash.
    for (let n = 0; n < CLUSTER.length; n++) {
      const id = CLUSTER[n];
      if (id === undefined) continue;
      const col = n % cols;
      const row = Math.floor(n / cols);
      const x = regionRight - fireR - col * cellStep;
      const y = bottom - fireR - row * cellStep;
      const radius = id === 'fire' ? fireR : smallR;
      add(
        id,
        Math.min(w - safeR - radius, Math.max(safeL + radius, x)),
        Math.min(h - safeB - radius, Math.max(safeT + radius, y)),
        radius,
      );
    }

    // ---- Left cluster: utility, above the stick zone.
    // Placed on the SAME cell step as the right cluster, so the two rows cannot
    // collide with each other and both clear the same tap floor.
    const utilR = smallR;
    const utilX = pad + safeL + utilR;
    const ROW1 = bottom - utilR;
    const ROW2 = ROW1 - cellStep;
    add('sprint', utilX, ROW1, utilR);
    add('crouch', utilX + cellStep, ROW1, utilR);
    add('reload', utilX, ROW2, utilR);
    add('cycle', utilX + cellStep, ROW2, utilR);
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
      if (button.id === 'dash') this.dashLatch = true;
      if (button.id === 'grenade') this.grenadeCycleLatch = true;
      if (button.id === 'melee') this.meleeLatch = true;
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
   * Produce and consume this frame's touch state. Look is excluded — it is
   * consumed at render rate by `consumeLook()`.
   */
  public read(): TouchFrame {
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

    const frame: TouchFrame = {
      moveX,
      moveZ,
      // Look is consumed separately by `consumeLook()` once per rendered frame,
      // so it is not part of the fixed-step frame.
      lookX: 0,
      lookY: 0,
      fireHeld: this.isHeld('fire'),
      aimHeld: this.isHeld('aim'),
      jumpPressed: this.jumpLatch,
      sprintHeld: this.isHeld('sprint'),
      crouchHeld: this.isHeld('crouch'),
      reloadPressed: this.reloadLatch,
      dashPressed: this.dashLatch,
      // The grenade button doubles as the type cycler: a short tap changes
      // type, a hold cooks and throws. Read the held state here and let the
      // orchestrator decide which one it was on release.
      grenadeHeld: this.isHeld('grenade'),
      grenadeCyclePressed: this.grenadeCycleLatch,
      meleePressed: this.meleeLatch,
      slotPressed: this.slotLatch,
      cycleSteps: this.cycleLatch,
      active: this.stick.pointerId !== -1 || this.look.pointerId !== -1 || this.held.size > 0,
    };
    this.lookDX = 0;
    this.lookDY = 0;
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.dashLatch = false;
    this.grenadeCycleLatch = false;
    this.meleeLatch = false;
    this.slotLatch = 0;
    this.cycleLatch = 0;
    return frame;
  }

  /**
   * Consume this render frame's drag delta in CSS pixels. Called once per
   * rendered frame by the input layer — see `Input.consumeLook()`.
   */
  public consumeLook(adsScale = 1): { dx: number; dy: number } {
    const scale = LOOK_DEG_PER_PX * this.sensitivity * (1 - (1 - LOOK_ADS_SCALE) * adsScale);
    const dx = this.lookDX * scale;
    const dy = this.lookDY * scale;
    this.lookDX = 0;
    this.lookDY = 0;
    return { dx, dy };
  }

  /** Request a weapon slot from a HUD tap (the slot chips are DOM buttons). */
  public requestSlot(slot: number): void {
    this.slotLatch = slot;
  }
}
