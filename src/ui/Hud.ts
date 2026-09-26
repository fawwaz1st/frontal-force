import { icon, type IconName } from './icons';
import { GAME_MODES, type GameMode, type SaveData } from '../core/storage';
import type { WavePhase } from '../game/Waves';

const MODE_META: Record<GameMode, { icon: IconName; label: string }> = {
  standard: { icon: 'flag', label: 'STANDARD' },
  blitz: { icon: 'sprint', label: 'BLITZ' },
  onslaught: { icon: 'skull', label: 'ONSLAUGHT' },
  rotator: { icon: 'swap', label: 'ROTATION' },
  overrun: { icon: 'infinity', label: 'OVERRUN' },
};

export interface RadarBlip {
  /** Right offset in radar units (-1..1) */
  x: number;
  /** Forward offset in radar units (-1..1) */
  z: number;
  color: number;
  colorCss: string;
}

export interface HudState {
  health: number;
  maxHealth: number;
  mag: number;
  magSize: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  weaponIndex: number;
  /** Display name of the equipped weapon (10-slot arsenal). */
  weaponName: string;
  wave: number;
  enemiesLeft: number;
  phase: WavePhase;
  phaseTimer: number;
  score: number;
  kills: number;
  /** 1..8 — current kill-combo score multiplier */
  comboMult: number;
  /** 0..1 — drives dynamic crosshair gap */
  spread: number;
  /** False on menu/pause/death screens: suppresses gameplay hints */
  inGame: boolean;
  /** Escort-bot squad readout */
  allyActive: boolean;
  allyCount: number;
  allyHp: number;
  allyMax: number;
  /** Reused array of pre-rotated radar blips */
  radar: RadarBlip[];
  /** Active entries at the start of `radar` */
  radarCount: number;
}

export interface DeathStats {
  wave: number;
  kills: number;
  score: number;
  bestScore: number;
  isNewRecord: boolean;
  mode: GameMode;
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
  public onMode: ((mode: GameMode) => void) | null = null;

  private readonly healthFill: HTMLElement;
  private readonly healthHead: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoResv: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly weaponNameEl: HTMLElement;
  private readonly waveBanner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly waveText: HTMLElement;
  private readonly scoreText: HTMLElement;
  private readonly comboEl: HTMLElement;
  private readonly killsText: HTMLElement;
  private readonly enHostiles: HTMLElement;
  private readonly enTimer: HTMLElement;
  private readonly enClear: HTMLElement;
  private readonly enemiesN: HTMLElement;
  private readonly timerN: HTMLElement;
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
  private readonly menuRecords: HTMLElement;
  private readonly recordEl: HTMLElement;
  private readonly damageDirs: HTMLElement[] = [];
  private readonly sensInputs: HTMLInputElement[] = [];
  private readonly volInputs: HTMLInputElement[] = [];
  private readonly modeChips: HTMLButtonElement[] = [];
  /** Icon per weapon slot, in WEAPON_ORDER — drives the 3-slot window. */
  private slotIcons: IconName[] = [];
  private readonly slotCount: HTMLElement;
  private readonly pauseModeEl: HTMLElement;
  private readonly allyEl: HTMLElement;
  private readonly allyFill: HTMLElement;
  private readonly allyN: HTMLElement;
  private lastAllyN = -1;
  private readonly pops: HTMLElement[] = [];
  private popCursor = 0;
  private bannerTimer = 0;
  private dmgCursor = 0;
  private radarVisible = false;
  private readonly txtCache = new Map<string, string>();

  /** Cached DOM write — skips entirely when the value is unchanged (hot path: 60 fps). */
  private setText(key: string, el: HTMLElement, v: string): void {
    if (this.txtCache.get(key) !== v) {
      this.txtCache.set(key, v);
      el.textContent = v;
    }
  }

  private setStyle(key: string, el: HTMLElement, prop: string, v: string): void {
    const k = `s:${key}`;
    if (this.txtCache.get(k) !== v) {
      this.txtCache.set(k, v);
      el.style.setProperty(prop, v);
    }
  }

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
      <div class="hud__pops" data-pops></div>
      <div class="hud__banner" data-banner>
        <div class="hud__banner-title" data-banner-title>WAVE 1</div>
        <div class="hud__banner-sub" data-banner-sub></div>
      </div>
      <div class="hud__top">
        <div class="hud__chip" data-score>${icon('score')}<b data-score-n>0</b></div>
        <div class="hud__chip hud__chip--combo" data-combo hidden>×1</div>
        <div class="hud__chip hud__chip--wave" data-wave>${icon('flag')}<b data-wave-n>1</b></div>
        <div class="hud__chip" data-kills>${icon('skull')}<b data-kills-n>0</b></div>
      </div>
      <div class="hud__enemies" data-enemies>
        <span data-en-hostiles>${icon('target')}<b data-enemies-n>0</b></span>
        <span data-en-timer hidden>${icon('clock')}<b data-timer-n>0</b></span>
        <span data-en-clear hidden>${icon('check')}</span>
      </div>
      <canvas class="hud__radar" data-radar width="${RADAR_SIZE}" height="${RADAR_SIZE}"></canvas>
      <div class="hud__hint" data-hint hidden></div>
      <div class="hud__bottom">
        <div class="hud__health">
          <div class="hud__health-head">${icon('shield', 'hud__health-ic')}<span class="hud__health-num" data-health>100</span></div>
          <div class="hud__health-bar"><div class="hud__health-fill" data-health-fill></div></div>
          <div class="hud__ally" data-ally hidden>
            ${icon('bot')}
            <b class="hud__ally-n" data-ally-n></b>
            <div class="hud__ally-bar"><i data-ally-fill></i></div>
          </div>
        </div>
        <div class="hud__weapon">
          <div class="hud__weapon-row">
            <span class="hud__weapon-name" data-weapon-name></span>
            <span class="hud__slot-count" data-slot-count>1/10</span>
          </div>
          <div class="hud__slots" data-slots></div>
          <div class="hud__ammo" data-ammo>
            ${icon('bullet', 'hud__ammo-ic')}
            <b data-mag>30</b> <span data-resv>/ 150</span>
            <span class="hud__reload-spin" data-reload-spin>${icon('reload')}</span>
          </div>
          <div class="hud__reload"><div class="hud__reload-fill" data-reload></div></div>
        </div>
      </div>
      <div class="hud__menu" data-menu>
        <div class="hud__menu-card">
          <div class="hud__menu-title">FRONTAL FORCE</div>
          <div class="hud__menu-best" data-menu-best></div>
          <div class="hud__menu-records" data-menu-records hidden></div>
          <div class="hud__touch-note">Requires mouse &amp; keyboard — desktop only</div>
          <div class="hud__modes" role="group" aria-label="Game mode">
            <button type="button" class="hud__mode-chip active" data-mode="standard" title="Classic waves, steady ramp">${icon('flag')}<span>STANDARD</span></button>
            <button type="button" class="hud__mode-chip" data-mode="blitz" title="Short breaks, denser spawns, ×1.35 score">${icon('sprint')}<span>BLITZ</span></button>
            <button type="button" class="hud__mode-chip" data-mode="onslaught" title="Heavy waves from wave 2, ×1.75 score">${icon('skull')}<span>ONSLAUGHT</span></button>
            <button type="button" class="hud__mode-chip" data-mode="rotator" title="Weapon swaps every kill, ×1.5 score">${icon('swap')}<span>ROTATION</span></button>
            <button type="button" class="hud__mode-chip" data-mode="overrun" title="Endless: 24-alive cap, HP ×1.12 per wave, ×1.5 score, own best-wave record">${icon('infinity')}<span>OVERRUN</span></button>
          </div>
          <div class="hud__keys" data-keys></div>
          <div class="hud__settings">
            <label title="Sensitivity">${icon('target')}<input type="range" min="0.2" max="3" step="0.05" data-sens aria-label="Sensitivity"></label>
            <label title="Volume">${icon('speaker')}<input type="range" min="0" max="1" step="0.05" data-vol aria-label="Volume"></label>
          </div>
          <button class="hud__btn" data-start>${icon('play')}<span>DEPLOY</span></button>
        </div>
      </div>
      <div class="hud__pause hidden" data-pause>
        <div class="hud__menu-card">
          <div class="hud__menu-title hud__menu-title--pause">${icon('pause')}<span>PAUSED</span></div>
          <div class="hud__pause-mode" data-pause-mode></div>
          <div class="hud__settings">
            <label title="Sensitivity">${icon('target')}<input type="range" min="0.2" max="3" step="0.05" data-sens aria-label="Sensitivity"></label>
            <label title="Volume">${icon('speaker')}<input type="range" min="0" max="1" step="0.05" data-vol aria-label="Volume"></label>
          </div>
          <div class="hud__btn-row">
            <button class="hud__btn" data-resume>${icon('play')}<span>RESUME</span></button>
            <button class="hud__btn hud__btn--ghost" data-quit>${icon('exit')}<span>ABANDON RUN</span></button>
          </div>
        </div>
      </div>
      <div class="hud__death hidden" data-death>
        <div class="hud__menu-card">
          <div class="hud__menu-title hud__menu-title--dead">K.I.A.</div>
          <div class="hud__record" data-record hidden>${icon('trophy')}<span>NEW RECORD</span></div>
          <div class="hud__death-stats" data-death-stats></div>
          <div class="hud__btn-row">
            <button class="hud__btn" data-restart>${icon('reload')}<span>REDEPLOY</span></button>
            <button class="hud__btn hud__btn--ghost" data-to-menu>${icon('grid')}<span>MAIN MENU</span></button>
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
    this.healthHead = q('.hud__health-head');
    this.healthText = q('[data-health]');
    this.ammoEl = q('[data-ammo]');
    this.ammoMag = q('[data-mag]');
    this.ammoResv = q('[data-resv]');
    this.reloadBar = q('[data-reload]');
    this.waveBanner = q('[data-banner]');
    this.bannerTitle = q('[data-banner-title]');
    this.bannerSub = q('[data-banner-sub]');
    this.waveText = q('[data-wave-n]');
    this.scoreText = q('[data-score-n]');
    this.comboEl = q('[data-combo]');
    this.killsText = q('[data-kills-n]');
    this.crosshair = q('[data-crosshair]');
    this.hitmarker = q('[data-hitmarker]');
    this.vignette = q('[data-vignette]');
    this.hint = q('[data-hint]');
    this.menu = q('[data-menu]');
    this.pause = q('[data-pause]');
    this.death = q('[data-death]');
    this.deathStats = q('[data-death-stats]');
    this.menuBest = q('[data-menu-best]');
    this.menuRecords = q('[data-menu-records]');
    this.recordEl = q('[data-record]');
    this.pauseModeEl = q('[data-pause-mode]');
    this.allyEl = q('[data-ally]');
    this.allyFill = q('[data-ally-fill]');
    this.allyN = q('[data-ally-n]');
    this.radarCtx = q<HTMLCanvasElement>('[data-radar]').getContext('2d');

    this.buildKeys(q('[data-keys]'));
    const popsEl = q('[data-pops]');
    for (let i = 0; i < 6; i++) {
      const pop = document.createElement('div');
      pop.className = 'hud__pop';
      popsEl.appendChild(pop);
      this.pops.push(pop);
    }
    this.modeChips.push(...qa<HTMLButtonElement>('[data-mode]'));
    for (const chip of this.modeChips) {
      chip.addEventListener('click', () => {
        const m = chip.dataset.mode as GameMode | undefined;
        if (m && Object.hasOwn(MODE_META, m)) this.onMode?.(m);
      });
    }
    this.enHostiles = q('[data-en-hostiles]');
    this.enTimer = q('[data-en-timer]');
    this.enClear = q('[data-en-clear]');
    this.enemiesN = q('[data-enemies-n]');
    this.timerN = q('[data-timer-n]');

    const slotsEl = q('[data-slots]');
    const slotIcons: IconName[] = [
      'rifle', 'smg', 'shotgun', 'railgun', 'dmr',
      'lmg', 'pistol', 'launcher', 'beam', 'burst',
    ];
    // Ten weapons would be an unreadable icon wall, so the HUD shows a
    // three-slot window (previous / current / next) plus an index counter.
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement('div');
      slot.className = 'hud__slot';
      slot.innerHTML = icon(slotIcons[i] ?? 'rifle');
      slotsEl.appendChild(slot);
      this.slots.push(slot);
    }
    this.slotIcons = slotIcons;
    this.slotCount = q('[data-slot-count]');
    this.weaponNameEl = q('[data-weapon-name]');

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
    this.setStyle('hpw', this.healthFill, 'width', `${hpPct}%`);
    this.healthFill.classList.toggle('low', hpPct <= 30);
    this.healthHead.classList.toggle('low', hpPct <= 30);
    this.setText('hp', this.healthText, String(Math.ceil(s.health)));
    this.vignette.classList.toggle('lowhp', hpPct <= 30 && hpPct > 0);

    this.ammoEl.classList.toggle('reloading', s.reloading);
    this.ammoEl.classList.toggle('empty', !s.reloading && s.mag === 0);
    if (!s.reloading) {
      this.setText('mag', this.ammoMag, String(s.mag));
      this.setText('resv', this.ammoResv, `/ ${s.reserve}`);
    }
    this.setStyle(
      'rlx',
      this.reloadBar,
      'transform',
      `scaleX(${s.reloading ? s.reloadProgress : 0})`,
    );

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      // Window of three around the active weapon: prev / current / next.
      const total = this.slotIcons.length;
      const offset = i - 1;
      const idx = ((s.weaponIndex + offset) % total + total) % total;
      slot.innerHTML = icon(this.slotIcons[idx] ?? 'rifle');
      slot.classList.toggle('active', i === 1);
      slot.classList.toggle('hud__slot--edge', i !== 1);
    }
    this.setText('slotn', this.slotCount, `${s.weaponIndex + 1}/${this.slotIcons.length}`);
    this.setText('wname', this.weaponNameEl, s.weaponName);

    this.setText('wave', this.waveText, String(s.wave));
    this.setText('score', this.scoreText, String(s.score));
    this.setText('kills', this.killsText, String(s.kills));
    this.comboEl.hidden = s.comboMult <= 1;
    if (!this.comboEl.hidden) this.setText('combo', this.comboEl, `×${s.comboMult}`);
    this.allyEl.hidden = !s.allyActive;
    if (s.allyActive) {
      const pct = Math.max(0, Math.min(100, (s.allyHp / Math.max(1, s.allyMax)) * 100));
      this.setStyle('allyw', this.allyFill, 'width', `${pct}%`);
      if (this.lastAllyN !== s.allyCount) {
        this.lastAllyN = s.allyCount;
        this.allyN.textContent = s.allyCount > 0 ? `×${s.allyCount}` : '';
      }
    }

    // Status line: hostiles count / next-wave timer / area clear — icon states
    const combat = s.phase === 'combat' || s.phase === 'spawning';
    const inter = s.phase === 'intermission';
    this.enHostiles.hidden = !combat;
    this.enTimer.hidden = !inter;
    this.enClear.hidden = combat || inter;
    if (combat) this.setText('enemiesN', this.enemiesN, String(s.enemiesLeft));
    if (inter) this.setText('timerN', this.timerN, String(Math.max(0, Math.ceil(s.phaseTimer))));

    this.updateHint(s);
    if (s.inGame) {
      this.drawRadar(s);
      this.radarVisible = true;
    } else if (this.radarVisible) {
      this.radarCtx?.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
      this.radarVisible = false;
    }

    // Dynamic crosshair spread
    const gap = 4 + s.spread * 14;
    this.setStyle('chgap', this.crosshair, '--ch-gap', `${gap.toFixed(1)}px`);

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
    let html = '';
    let tone = '';
    if (s.mag === 0 && s.reserve === 0) {
      html = `${icon('bullet')}`; // dry — no R prompt, reload would be rejected
      tone = 'hud__hint--warn';
    } else if (s.mag === 0 && s.reserve > 0) {
      html = `${icon('reload')}<kbd>R</kbd>`;
      tone = 'hud__hint--warn';
    } else if (s.reserve > 0 && s.mag / Math.max(1, s.magSize) <= 0.25) {
      html = `${icon('bullet')}<kbd>R</kbd>`;
      tone = 'hud__hint--warn';
    } else if (s.health / s.maxHealth <= 0.3) {
      html = `${icon('shield')}`;
      tone = 'hud__hint--danger';
    } else if (s.phase === 'intermission') {
      html = `${icon('crate')}`;
      tone = '';
    }
    if (html) {
      if (this.hint.dataset.sig !== html) {
        this.hint.innerHTML = html;
        this.hint.dataset.sig = html;
      }
      const className = `hud__hint ${tone}`.trim();
      if (this.hint.className !== className) this.hint.className = className;
      this.hint.hidden = false;
    } else {
      this.hint.hidden = true;
    }
  }

  /** Keycap-glyph control diagram — one row per action, no prose (Kenney/IxDF). */
  private buildKeys(container: HTMLElement): void {
    const cap = (label: string): string => `<kbd>${label}</kbd>`;
    const rows: Array<[IconName, string, string]> = [
      ['move', `${cap('W')}${cap('A')}${cap('S')}${cap('D')}`, 'Move'],
      ['mouse', `${cap('LMB')}`, 'Fire'],
      ['target', `${cap('RMB')}`, 'Aim down sights'],
      ['jump', `${cap('SPACE')}`, 'Jump'],
      ['sprint', `${cap('SHIFT')}`, 'Sprint'],
      ['crouch', `${cap('C')}`, 'Crouch & slide'],
      ['reload', `${cap('R')}`, 'Reload'],
      ['swap', `${cap('1')}–${cap('4')}`, 'Switch weapon'],
      ['swap', `${cap('WHEEL')}`, 'Cycle weapon'],
      ['pause', `${cap('ESC')}`, 'Pause'],
      ['crosshair', `${cap('×2')}`, 'Headshot damage'],
    ];
    container.innerHTML = rows
      .map(
        ([ic, keys, label]) =>
          `<div class="hud__key" title="${label}">${icon(ic)}` +
          `<span class="hud__key-caps">${keys}</span>` +
          `<span class="sr-only">${label}</span></div>`,
      )
      .join('');
  }

  private drawRadar(s: HudState): void {
    const ctx = this.radarCtx;
    if (!ctx) return;
    const r = RADAR_SIZE / 2;
    ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    ctx.save();
    ctx.translate(r, r);

    // Grid rings + sweep wedge
    ctx.strokeStyle = 'rgba(222, 210, 170, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, r - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(222, 210, 170, 0.15)';
    ctx.beginPath(); ctx.arc(0, 0, (r - 2) * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255, 159, 28, 0.16)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r - 2, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();

    // Player marker
    ctx.fillStyle = 'rgba(236, 231, 216, 0.95)';
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(3, 3); ctx.lineTo(0, 1.4); ctx.lineTo(-3, 3);
    ctx.closePath(); ctx.fill();

    for (let i = 0; i < s.radarCount; i++) {
      const blip = s.radar[i];
      if (!blip) continue;
      const px = blip.x * (r - 7);
      const py = -blip.z * (r - 7);
      ctx.fillStyle = blip.colorCss;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  public showBanner(title: string, sub: string): void {
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.bannerSub.hidden = !sub;
    this.waveBanner.classList.add('show');
    this.bannerTimer = 2.4;
  }

  public hitmarkerFlash(kind: 'hit' | 'headshot' | 'kill' | 'blocked' = 'hit'): void {
    this.hitmarker.classList.remove('flash', 'flash--head', 'flash--kill', 'flash--blocked');
    void this.hitmarker.offsetWidth; // restart animation
    if (kind === 'headshot') this.hitmarker.classList.add('flash--head');
    if (kind === 'kill') this.hitmarker.classList.add('flash--kill');
    if (kind === 'blocked') this.hitmarker.classList.add('flash--blocked');
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

  public showFatal(message: string): void {
    this.menu.classList.remove('hidden');
    const card = this.menu.querySelector('.hud__menu-card');
    if (!card) return;
    card.replaceChildren();
    const title = document.createElement('div');
    title.className = 'hud__menu-title';
    title.textContent = 'RENDERER OFFLINE';
    const detail = document.createElement('p');
    detail.className = 'hud__fatal';
    detail.textContent = message;
    card.append(title, detail);
    this.syncOverlay();
  }

  public showPause(visible: boolean): void {
    this.pause.classList.toggle('hidden', !visible);
    this.syncOverlay();
  }

  public showDeath(visible: boolean, stats?: DeathStats): void {
    this.death.classList.toggle('hidden', !visible);
    if (stats) {
      const row = (ic: IconName, label: string, value: number | string): string =>
        `<div title="${label}">${icon(ic)}<span>${value}</span>` +
        `<span class="sr-only">${label}</span></div>`;
      const meta = MODE_META[stats.mode];
      this.deathStats.innerHTML =
        (meta ? row(meta.icon, 'Mode', meta.label) : '') +
        row('flag', 'Wave reached', stats.wave) +
        row('skull', 'Kills', stats.kills) +
        row('score', 'Score', stats.score) +
        row('trophy', 'Best', stats.bestScore);
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
    this.menu.inert = this.menu.classList.contains('hidden');
    this.pause.inert = this.pause.classList.contains('hidden');
    this.death.inert = this.death.classList.contains('hidden');
  }

  public setMenuBest(score: number, wave: number): void {
    this.menuBest.innerHTML =
      score > 0
        ? `${icon('trophy')}<span>${score} · WAVE ${Math.max(1, wave)}</span>`
        : `${icon('trophy')}<span>NO RECORD</span>`;
  }

  /** Lifetime records under the menu best line — stencil rows, no cards. */
  public setMenuRecords(save: SaveData): void {
    if (save.totalRuns <= 0) {
      this.menuRecords.hidden = true;
      return;
    }
    const row = (label: string, value: number): string =>
      `<div class="hud__menu-stat"><span>${label}</span><i></i><b>${value}</b></div>`;
    const rows = [
      row('KILLS', save.totalKills),
      row('RUNS', save.totalRuns),
      row('WAVES CLEARED', save.totalWavesCleared),
    ];
    for (const mode of GAME_MODES) {
      const n = save.killsPerMode[mode];
      if (n) rows.push(row(MODE_META[mode].label, n));
    }
    this.menuRecords.innerHTML = rows.join('');
    this.menuRecords.hidden = false;
  }

  /** Reflect the selected mode on menu chips + the pause-card readout. */
  public syncMode(mode: GameMode): void {
    for (const chip of this.modeChips) {
      chip.classList.toggle('active', chip.dataset.mode === mode);
    }
    const m = MODE_META[mode];
    if (m) this.pauseModeEl.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
  }

  /** Floating +points at the crosshair on a kill — number only, fades up. */
  public popScore(amount: number): void {
    const el = this.pops[this.popCursor];
    this.popCursor = (this.popCursor + 1) % this.pops.length;
    if (!el) return;
    el.textContent = `+${amount}`;
    el.style.setProperty('--pop-x', `${Math.round(Math.random() * 44 - 22)}px`);
    el.classList.remove('show');
    void el.offsetWidth; // restart animation
    el.classList.add('show');
  }

  public syncSettings(sensitivity: number, volume: number): void {
    for (const input of this.sensInputs) input.value = String(sensitivity);
    for (const input of this.volInputs) input.value = String(volume);
  }
}
