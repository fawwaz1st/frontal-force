export interface RadarBlip {
  /** Right offset in radar units (-1..1) */
  x: number;
  /** Forward offset in radar units (-1..1) */
  z: number;
  color: number;
}

export interface HudState {
  health: number;
  maxHealth: number;
  weaponName: string;
  mag: number;
  magSize: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  weaponIndex: number;
  weaponCount: number;
  wave: number;
  enemiesLeft: number;
  phase: string;
  intermission: number;
  score: number;
  kills: number;
  /** 0..1 — drives dynamic crosshair gap */
  spread: number;
  /** False on menu/pause/death screens: suppresses gameplay hints */
  inGame: boolean;
  /** Reused array of pre-rotated radar blips */
  radar: RadarBlip[];
  bestScore: number;
}

export interface DeathStats {
  wave: number;
  kills: number;
  score: number;
  bestScore: number;
  isNewRecord: boolean;
}

export interface SettingsPatch {
  sensitivity?: number;
  volume?: number;
}

const RADAR_SIZE = 144;

export class Hud {
  public readonly root: HTMLDivElement;
  public onStart: (() => void) | null = null;
  public onRestart: (() => void) | null = null;
  public onResume: (() => void) | null = null;
  public onQuit: (() => void) | null = null;
  public onSettings: ((patch: SettingsPatch) => void) | null = null;

  private readonly healthFill: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly weaponName: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoResv: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly waveBanner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly enemiesText: HTMLElement;
  private readonly scoreText: HTMLElement;
  private readonly bestText: HTMLElement;
  private readonly killsText: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly radarCtx: CanvasRenderingContext2D | null;
  private readonly menu: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly death: HTMLElement;
  private readonly deathStats: HTMLElement;
  private readonly menuBest: HTMLElement;
  private readonly recordEl: HTMLElement;
  private readonly damageDirs: HTMLElement[] = [];
  private readonly sensInputs: HTMLInputElement[] = [];
  private readonly volInputs: HTMLInputElement[] = [];
  private bannerTimer = 0;
  private dmgCursor = 0;

  public constructor() {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__vignette" data-vignette></div>
      <div class="hud__dmg-container" data-dmg-container></div>
      <div class="hud__crosshair" data-crosshair>
        <span class="ch ch--t"></span><span class="ch ch--b"></span>
        <span class="ch ch--l"></span><span class="ch ch--r"></span>
        <span class="ch ch--dot"></span>
      </div>
      <div class="hud__hitmarker" data-hitmarker></div>
      <div class="hud__banner" data-banner>
        <div class="hud__banner-title" data-banner-title>WAVE 1</div>
        <div class="hud__banner-sub" data-banner-sub></div>
      </div>
      <div class="hud__top">
        <div class="hud__chip" data-score>SCORE 0</div>
        <div class="hud__chip" data-best>BEST 0</div>
        <div class="hud__chip hud__chip--wave" data-wave>WAVE 1</div>
        <div class="hud__chip" data-kills>KILLS 0</div>
      </div>
      <div class="hud__enemies" data-enemies></div>
      <canvas class="hud__radar" data-radar width="${RADAR_SIZE}" height="${RADAR_SIZE}"></canvas>
      <div class="hud__hint" data-hint hidden></div>
      <div class="hud__bottom">
        <div class="hud__health">
          <div class="hud__health-label">INTEGRITY</div>
          <div class="hud__health-bar"><div class="hud__health-fill" data-health-fill></div></div>
          <div class="hud__health-num" data-health>100</div>
        </div>
        <div class="hud__weapon">
          <div class="hud__slots" data-slots></div>
          <div class="hud__weapon-name" data-weapon-name>Vanguard AR</div>
          <div class="hud__ammo" data-ammo><b data-mag>30</b> <span data-resv>/ 150</span></div>
          <div class="hud__reload"><div class="hud__reload-fill" data-reload></div></div>
        </div>
      </div>
      <div class="hud__menu" data-menu>
        <div class="hud__menu-card">
          <div class="hud__menu-title">FRONTAL FORCE</div>
          <div class="hud__menu-sub">Wave survival arena</div>
          <div class="hud__menu-best" data-menu-best></div>
          <div class="hud__touch-note">Requires mouse &amp; keyboard — desktop only</div>
          <div class="hud__menu-keys">
            <div><b>WASD</b> move</div><div><b>Mouse</b> aim</div>
            <div><b>LMB</b> fire</div><div><b>Space</b> jump</div>
            <div><b>Shift</b> sprint</div><div><b>C / Ctrl</b> crouch &amp; slide</div>
            <div><b>R</b> reload</div><div><b>1-4 / wheel</b> weapons</div>
            <div><b>Esc</b> pause</div><div><b>Headshots</b> 2× damage</div>
          </div>
          <div class="hud__settings">
            <label>SENSITIVITY <input type="range" min="0.2" max="3" step="0.05" data-sens></label>
            <label>VOLUME <input type="range" min="0" max="1" step="0.05" data-vol></label>
          </div>
          <button class="hud__btn" data-start>DEPLOY</button>
        </div>
      </div>
      <div class="hud__pause hidden" data-pause>
        <div class="hud__menu-card">
          <div class="hud__menu-title hud__menu-title--pause">PAUSED</div>
          <div class="hud__settings">
            <label>SENSITIVITY <input type="range" min="0.2" max="3" step="0.05" data-sens></label>
            <label>VOLUME <input type="range" min="0" max="1" step="0.05" data-vol></label>
          </div>
          <div class="hud__btn-row">
            <button class="hud__btn" data-resume>RESUME</button>
            <button class="hud__btn hud__btn--ghost" data-quit>ABANDON RUN</button>
          </div>
        </div>
      </div>
      <div class="hud__death hidden" data-death>
        <div class="hud__menu-card">
          <div class="hud__menu-title hud__menu-title--dead">K.I.A.</div>
          <div class="hud__record" data-record hidden>NEW RECORD</div>
          <div class="hud__death-stats" data-death-stats></div>
          <div class="hud__btn-row">
            <button class="hud__btn" data-restart>REDEPLOY</button>
            <button class="hud__btn hud__btn--ghost" data-to-menu>MAIN MENU</button>
          </div>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string): T => {
      const el = this.root.querySelector<T>(sel);
      if (!el) throw new Error(`HUD element missing: ${sel}`);
      return el;
    };
    const qa = <T extends HTMLElement>(sel: string): T[] =>
      Array.from(this.root.querySelectorAll<T>(sel));

    this.healthFill = q('[data-health-fill]');
    this.healthText = q('[data-health]');
    this.weaponName = q('[data-weapon-name]');
    this.ammoEl = q('[data-ammo]');
    this.ammoMag = q('[data-mag]');
    this.ammoResv = q('[data-resv]');
    this.reloadBar = q('[data-reload]');
    this.waveBanner = q('[data-banner]');
    this.bannerTitle = q('[data-banner-title]');
    this.bannerSub = q('[data-banner-sub]');
    this.waveText = q('[data-wave]');
    this.enemiesText = q('[data-enemies]');
    this.scoreText = q('[data-score]');
    this.bestText = q('[data-best]');
    this.killsText = q('[data-kills]');
    this.crosshair = q('[data-crosshair]');
    this.hitmarker = q('[data-hitmarker]');
    this.vignette = q('[data-vignette]');
    this.hint = q('[data-hint]');
    this.menu = q('[data-menu]');
    this.pause = q('[data-pause]');
    this.death = q('[data-death]');
    this.deathStats = q('[data-death-stats]');
    this.menuBest = q('[data-menu-best]');
    this.recordEl = q('[data-record]');
    this.radarCtx = q<HTMLCanvasElement>('[data-radar]').getContext('2d');

    const slotsEl = q('[data-slots]');
    for (let i = 0; i < 4; i++) {
      const slot = document.createElement('div');
      slot.className = 'hud__slot';
      slot.textContent = String(i + 1);
      slotsEl.appendChild(slot);
      this.slots.push(slot);
    }

    const dmgContainer = q('[data-dmg-container]');
    for (let i = 0; i < 6; i++) {
      const dir = document.createElement('div');
      dir.className = 'hud__dmg-arc';
      dmgContainer.appendChild(dir);
      this.damageDirs.push(dir);
    }

    this.sensInputs = qa<HTMLInputElement>('input[data-sens]');
    this.volInputs = qa<HTMLInputElement>('input[data-vol]');
    for (const input of this.sensInputs) {
      input.addEventListener('input', () =>
        this.onSettings?.({ sensitivity: Number(input.value) }));
    }
    for (const input of this.volInputs) {
      input.addEventListener('input', () =>
        this.onSettings?.({ volume: Number(input.value) }));
    }

    q('[data-start]').addEventListener('click', () => this.onStart?.());
    q('[data-restart]').addEventListener('click', () => this.onRestart?.());
    q('[data-resume]').addEventListener('click', () => this.onResume?.());
    q('[data-quit]').addEventListener('click', () => this.onQuit?.());
    q('[data-to-menu]').addEventListener('click', () => this.onQuit?.());
  }

  public update(dt: number, s: HudState): void {
    const hpPct = Math.max(0, s.health / s.maxHealth) * 100;
    this.healthFill.style.width = `${hpPct}%`;
    this.healthFill.classList.toggle('low', hpPct <= 30);
    this.healthText.textContent = String(Math.ceil(s.health));
    this.vignette.classList.toggle('lowhp', hpPct <= 30 && hpPct > 0);

    this.weaponName.textContent = s.weaponName;
    this.ammoEl.classList.toggle('reloading', s.reloading);
    this.ammoEl.classList.toggle('empty', !s.reloading && s.mag === 0);
    if (!s.reloading) {
      this.ammoMag.textContent = String(s.mag);
      this.ammoResv.textContent = `/ ${s.reserve}`;
    }
    this.reloadBar.style.transform = `scaleX(${s.reloading ? s.reloadProgress : 0})`;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot) slot.classList.toggle('active', i === s.weaponIndex);
    }

    this.waveText.textContent = `WAVE ${s.wave}`;
    this.scoreText.textContent = `SCORE ${s.score}`;
    this.bestText.textContent = `BEST ${s.bestScore}`;
    this.killsText.textContent = `KILLS ${s.kills}`;
    this.enemiesText.textContent =
      s.phase === 'combat' || s.phase === 'spawning'
        ? `${s.enemiesLeft} HOSTILES`
        : s.phase === 'intermission'
          ? `NEXT WAVE IN ${Math.ceil(s.intermission)}`
          : 'AREA CLEAR';

    this.updateHint(s);
    this.drawRadar(s);

    // Dynamic crosshair spread
    const gap = 4 + s.spread * 14;
    this.crosshair.style.setProperty('--ch-gap', `${gap.toFixed(1)}px`);

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.waveBanner.classList.remove('show');
    }
  }

  private updateHint(s: HudState): void {
    if (!s.inGame) {
      this.hint.hidden = true;
      return;
    }
    let text = '';
    if (s.phase === 'intermission') text = 'Resupply — pickups are respawning';
    else if (s.mag === 0 && s.reserve > 0) text = 'MAG EMPTY — press R';
    else if (s.mag / Math.max(1, s.magSize) <= 0.25) text = 'LOW AMMO — R to reload';
    else if (s.health / s.maxHealth <= 0.3) text = 'INTEGRITY CRITICAL — find health';
    if (text) {
      this.hint.textContent = text;
      this.hint.hidden = false;
    } else {
      this.hint.hidden = true;
    }
  }

  private drawRadar(s: HudState): void {
    const ctx = this.radarCtx;
    if (!ctx) return;
    const r = RADAR_SIZE / 2;
    ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    ctx.save();
    ctx.translate(r, r);

    // Grid rings + sweep wedge
    ctx.strokeStyle = 'rgba(140, 170, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, r - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(140, 170, 255, 0.14)';
    ctx.beginPath(); ctx.arc(0, 0, (r - 2) * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(95, 140, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r - 2, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();

    // Player marker
    ctx.fillStyle = 'rgba(232, 238, 255, 0.95)';
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(3, 3); ctx.lineTo(0, 1.4); ctx.lineTo(-3, 3);
    ctx.closePath(); ctx.fill();

    for (const blip of s.radar) {
      const px = blip.x * (r - 7);
      const py = -blip.z * (r - 7);
      ctx.fillStyle = `#${blip.color.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  public showBanner(title: string, sub: string): void {
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.waveBanner.classList.add('show');
    this.bannerTimer = 2.4;
  }

  public hitmarkerFlash(kind: 'hit' | 'headshot' | 'kill' = 'hit'): void {
    this.hitmarker.classList.remove('flash', 'flash--head', 'flash--kill');
    void this.hitmarker.offsetWidth; // restart animation
    if (kind === 'headshot') this.hitmarker.classList.add('flash--head');
    if (kind === 'kill') this.hitmarker.classList.add('flash--kill');
    this.hitmarker.classList.add('flash');
  }

  public damageFlash(): void {
    this.vignette.classList.remove('hit');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('hit');
  }

  /** angleRad: 0 = damage from straight ahead, +right, -left. */
  public damageFrom(angleRad: number): void {
    const el = this.damageDirs[this.dmgCursor];
    this.dmgCursor = (this.dmgCursor + 1) % this.damageDirs.length;
    if (!el) return;
    el.style.transform = `translate(-50%, -50%) rotate(${angleRad}rad)`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  public setLocked(locked: boolean): void {
    this.crosshair.classList.toggle('dim', !locked);
  }

  public showMenu(visible: boolean): void {
    this.menu.classList.toggle('hidden', !visible);
    this.syncOverlay();
  }

  public showPause(visible: boolean): void {
    this.pause.classList.toggle('hidden', !visible);
    this.syncOverlay();
  }

  public showDeath(visible: boolean, stats?: DeathStats): void {
    this.death.classList.toggle('hidden', !visible);
    if (stats) {
      this.deathStats.innerHTML =
        `<div>Wave reached <b>${stats.wave}</b></div>` +
        `<div>Kills <b>${stats.kills}</b></div>` +
        `<div>Score <b>${stats.score}</b></div>` +
        `<div>Best <b>${stats.bestScore}</b></div>`;
      this.recordEl.hidden = !stats.isNewRecord;
    }
    this.syncOverlay();
  }

  /** Gameplay HUD (chips, radar, bars) hides while a full-screen overlay is up. */
  private syncOverlay(): void {
    const open =
      !this.menu.classList.contains('hidden') ||
      !this.pause.classList.contains('hidden') ||
      !this.death.classList.contains('hidden');
    this.root.classList.toggle('hud--overlay', open);
  }

  public setMenuBest(score: number, wave: number): void {
    this.menuBest.textContent =
      score > 0 ? `BEST — ${score} PTS · WAVE ${wave}` : 'NO RUNS YET — DEPLOY TO SET A RECORD';
  }

  public syncSettings(sensitivity: number, volume: number): void {
    for (const input of this.sensInputs) input.value = String(sensitivity);
    for (const input of this.volInputs) input.value = String(volume);
  }
}
