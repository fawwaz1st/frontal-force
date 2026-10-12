import { icon, type IconName } from './icons';
import { GAME_MODES, type GameMode, type SaveData } from '../core/storage';
import type { WavePhase } from '../game/Waves';
import type { QualitySetting } from '../core/storage';
import { ACHIEVEMENTS, AchievementTracker } from '../game/Achievements';
import type { AchievementDef, AchievementId, AchievementMetric } from '../game/Achievements';
import { UPGRADES } from '../game/Upgrades';
import type { UpgradeCard, UpgradeId } from '../game/Upgrades';
import {
  CHALLENGES,
  CHALLENGE_IDS,
  challengeScoreMul,
  type ChallengeId,
} from '../game/Challenges';

const MODE_META: Record<GameMode, { icon: IconName; label: string }> = {
  standard: { icon: 'flag', label: 'STANDARD' },
  blitz: { icon: 'sprint', label: 'BLITZ' },
  onslaught: { icon: 'skull', label: 'ONSLAUGHT' },
  rotator: { icon: 'swap', label: 'ROTATION' },
  overrun: { icon: 'infinity', label: 'OVERRUN' },
};

/** Grenade kind labels. Keyed off the HudState union so the two cannot drift. */
const GRENADE_LABEL: Record<HudState['grenadeKind'], string> = {
  frag: 'FRAG',
  smoke: 'SMOKE',
  emp: 'EMP',
};

/** Tier display order for the achievement ledger. */
const ACH_TIER_ORDER = ['bronze', 'silver', 'gold'] as const;
/** How long an achievement toast holds before it fades (ms). */
const TOAST_HOLD_MS = 3400;
/** Toast fade length; the node is removed after it (ms). */
const TOAST_FADE_MS = 260;
/** Stack cap: a fourth toast pushes the oldest one out. */
const TOAST_LIMIT = 3;
/** How long a copy confirmation stays on a label (ms). */
const COPY_FLASH_MS = 900;
/** Deny flash on the seed field (ms). */
const SEED_DENY_MS = 300;

/** Clamp to 0..1. Non-finite input reads as 0: a corrupt snapshot must not paint a wild bar. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Trim a trailing `.0` so `1M` never prints as `1.0M`. */
function trim1(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Compact integer for progress readouts: a 1e6 target must still fit a row. */
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const v = Math.max(0, value);
  if (v >= 1e6) return `${trim1(v / 1e6)}M`;
  if (v >= 1e4) return `${trim1(v / 1e3)}k`;
  return String(Math.round(v));
}

/**
 * `n/target` readout for one achievement row. Targets below 1 are fractional
 * rates (accuracy), so those keep one decimal; every whole-count metric goes
 * through the compact formatter, because a 1e6 damage target must still fit a
 * row without turning the panel into a wall of digits.
 */
function formatProgress(value: number, target: number): string {
  const safeTarget = Number.isFinite(target) ? target : 0;
  if (safeTarget <= 0) return '0/0';
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  // Clamp the numerator: an overshooting counter must not print 1.2/0.9.
  const shown = Math.min(safeValue, safeTarget);
  if (safeTarget < 1) return `${shown.toFixed(1)}/${safeTarget.toFixed(1)}`;
  return `${formatCount(shown)}/${formatCount(safeTarget)}`;
}

/** m:ss. Hours are not a thing in a wave shooter. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Card name for an upgrade id; unknown ids fall back to the raw id. */
function upgradeName(id: string): string {
  const def: UpgradeCard | undefined = UPGRADES[id as UpgradeId];
  return def ? def.name : id;
}

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
  /** Exact crosshair gap in CSS px, derived from the real cone + FOV. */
  crosshairGapPx: number;
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
  /** Absorbing shield on top of health (kiosk plating). */
  shield: number;
  /** Ability readouts. */
  dashCharges: number;
  dashMax: number;
  /** 0..1 recharge progress toward the next dash charge. */
  dashFraction: number;
  grenadeCharges: number;
  grenadeMax: number;
  grenadeFraction: number;
  /** Selected grenade type, for the HUD label. */
  grenadeKind: 'frag' | 'smoke' | 'emp';
  /** 0..1 cook strength while the throw is held. */
  grenadeCook: number;
  /** Run currency and upgrade count. */
  salvage: number;
  upgrades: number;
  /** Shareable seed code for the live run. */
  seedCode: string;
  /** True when this run is the daily challenge. */
  isDaily: boolean;
  /** Active arena mutation (empty when none). */
  mutationName: string;
  mutationDesc: string;
  /** Active challenge wagers: count, total payout, and a label for the tooltip. */
  wagerCount?: number;
  wagerScoreMul?: number;
  wagerLabel?: string;
  /** Player affliction timers. */
  burnT: number;
  slowT: number;
  /** Achievement popups still queued. */
  achievementsQueued: number;
  /** Live elite count, for the threat readout. */
  eliteAlive: number;
  /** Boss bar state. */
  bossActive: boolean;
  bossHealth: number;
  bossMax: number;
  bossName: string;
  bossPhase: number;
  /** True while the boss rear core is intact. */
  bossWeakPoint: boolean;
}

export interface DeathStats {
  wave: number;
  kills: number;
  score: number;
  bestScore: number;
  isNewRecord: boolean;
  mode: GameMode;
  /** Run summary, all optional so a legacy call site still compiles. */
  accuracy?: number;
  headshots?: number;
  timeSurvived?: number;
  damageDealt?: number;
  damageTaken?: number;
  longestCombo?: number;
  elitesKilled?: number;
  bossesKilled?: number;
  salvageEarned?: number;
  upgrades?: readonly string[];
  noHitWaves?: number;
  seedCode?: string;
  isDaily?: boolean;
  mutationsSeen?: readonly string[];
}

export interface SettingsPatch {
  sensitivity?: number;
  /** Touch look multiplier — separate from the mouse sensitivity. */
  touchSensitivity?: number;
  /** 'auto' lets the boot heuristic + frame-time governor decide. */
  quality?: QualitySetting;
  volume?: number;
}

const RADAR_SIZE = 144;
/** Radar redraw period in seconds. 20 Hz reads as continuous motion. */
const RADAR_INTERVAL = 0.05;

export class Hud {
  public readonly root: HTMLDivElement;
  public onStart: (() => void) | null = null;
  public onRestart: (() => void) | null = null;
  public onResume: (() => void) | null = null;
  public onQuit: (() => void) | null = null;
  public onSettings: ((patch: SettingsPatch) => void) | null = null;
  public onMode: ((mode: GameMode) => void) | null = null;
  /** Touch: tapping a slot chip requests that weapon (1-based). */
  public onSlotTap: ((slot: number) => void) | null = null;
  /** Menu: start a run from a shareable seed code. */
  public onSeedRun: ((code: string) => void) | null = null;
  /** Menu: start today's shared-seed daily run. */
  public onDailyRun: (() => void) | null = null;
  /** Menu: toggle one challenge wager (see game/Challenges.ts). */
  public onChallengeToggle: ((id: ChallengeId) => void) | null = null;

  private readonly healthFill: HTMLElement;
  private readonly healthHead: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoResv: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  /** Last icon index written per slot, so the innerHTML rebuild is skipped
   *  while the window is unchanged. -1 means "never written". */
  private readonly slotIconCache: number[] = [-1, -1, -1];
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
  /** Challenge wager chips plus the live payout readout. */
  private readonly challengeChips: HTMLButtonElement[] = [];
  private readonly challengePayout: HTMLElement;
  private readonly challengeIds: ChallengeId[] = [];
  /** Icon per weapon slot, in WEAPON_ORDER — drives the 3-slot window. */
  private slotIcons: IconName[] = [];
  private readonly slotCount: HTMLElement;
  /** Touch overlay elements — shown only in touch mode. */
  private readonly touchRoot: HTMLElement;
  private readonly stickEl: HTMLElement;
  private readonly stickNub: HTMLElement;
  private readonly touchButtons = new Map<string, HTMLElement>();
  private readonly touchSensInputs: HTMLInputElement[];
  private readonly qualitySelects: HTMLSelectElement[];
  private touchMode = false;
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
  /** Seconds since the last radar redraw (throttle, see RADAR_INTERVAL). */
  private radarAccum = 0;
  private readonly txtCache = new Map<string, string>();

  /** Ability chips (bottom bar). */
  private readonly abilitiesEl: HTMLElement;
  private readonly dashChip: HTMLElement;
  private readonly dashN: HTMLElement;
  private readonly dashBar: HTMLElement;
  private readonly grenChip: HTMLElement;
  private readonly grenN: HTMLElement;
  private readonly grenKindEl: HTMLElement;
  private readonly grenBar: HTMLElement;
  /** Run chips (top row). */
  private readonly salvageChip: HTMLElement;
  private readonly salvageN: HTMLElement;
  private readonly upgradeChip: HTMLElement;
  private readonly upgradeN: HTMLElement;
  private readonly mutationChip: HTMLElement;
  private readonly mutationText: HTMLElement;
  private readonly wagerChip: HTMLElement;
  private readonly wagerN: HTMLElement;
  private readonly seedChip: HTMLButtonElement;
  private readonly seedN: HTMLElement;
  private readonly menuSeedInput: HTMLInputElement;
  private seedValue = '';
  private seedIsDaily = false;
  /** Pending "COPIED"/"COPY FAILED" restore timers, one per flashing label. */
  private readonly copyTimers = new Map<HTMLElement, number>();
  private seedDenyTimer = 0;
  /** Boss bar. */
  private readonly bossBar: HTMLElement;
  private readonly bossNameEl: HTMLElement;
  private readonly bossPhaseEl: HTMLElement;
  private readonly bossFill: HTMLElement;
  /** Status pips beside the health numeral. */
  private readonly burnPip: HTMLElement;
  private readonly burnPipN: HTMLElement;
  private readonly slowPip: HTMLElement;
  private readonly slowPipN: HTMLElement;
  /** Shield readout on the health bar. */
  private readonly shieldFill: HTMLElement;
  private readonly shieldText: HTMLElement;
  /** Achievement toast stack. */
  private readonly toastHost: HTMLElement;
  private readonly toasts: HTMLElement[] = [];
  private readonly toastTimers = new Map<HTMLElement, number>();
  /** Achievement ledger in the menu. */
  private readonly achPanel: HTMLElement;
  private readonly achSummary: HTMLElement;
  private readonly achList: HTMLElement;
  private readonly achTracker = new AchievementTracker();
  /** True once setAchievements has rendered a list (legacy saves stay hidden). */
  private achievementsSeen = false;
  /** Last signature of the ledger inputs; the list is only rebuilt when it moves. */
  private achSignature = '';

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

  /**
   * Class write that only touches the DOM on a change. The update loop runs
   * every frame, so an unconditional classList.toggle would force a style
   * invalidation 60 times a second for state that changes a handful of times.
   */
  private setClass(key: string, el: HTMLElement, cls: string, on: boolean): void {
    const k = `c:${key}`;
    const v = on ? '1' : '0';
    if (this.txtCache.get(k) !== v) {
      this.txtCache.set(k, v);
      el.classList.toggle(cls, on);
    }
  }

  /**
   * Copy text to the clipboard. `navigator.clipboard` is the modern path but it
   * rejects on insecure contexts and without permission, and this game can be
   * served over plain HTTP, so a hidden textarea + execCommand is the fallback.
   * Resolves to false when both paths fail, which the caller turns into
   * "COPY FAILED" rather than a silently dead button.
   */
  private async copyText(text: string): Promise<boolean> {
    if (!text) return false;
    const clip = navigator.clipboard;
    if (clip) {
      try {
        await clip.writeText(text);
        return true;
      } catch {
        // Fall through to the legacy path.
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      // Off-screen but still focusable: execCommand only copies a selection
      // that lives in the document.
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Flash a label to a result word for COPY_FLASH_MS, then fall back to
   * whatever the label's real text is. The restore re-renders from state
   * instead of remembering the old string, so a second click mid-flash cannot
   * leave the label stuck on a stale word. One timer per element, because the
   * seed chip and the death card both use this path.
   */
  private flashLabel(el: HTMLElement, result: string, render: () => void): void {
    el.textContent = result;
    const prior = this.copyTimers.get(el);
    if (prior !== undefined) window.clearTimeout(prior);
    const id = window.setTimeout(() => {
      this.copyTimers.delete(el);
      render();
    }, COPY_FLASH_MS);
    this.copyTimers.set(el, id);
  }

  public constructor() {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__vignette" data-vignette></div>
      <div class="hud__frame" data-frame></div>
      <div class="hud__dmg-container" data-dmg-container></div>
      <div class="hud__crosshair" data-crosshair>
        <span class="ch ch--tl"></span><span class="ch ch--tr"></span>
        <span class="ch ch--bl"></span><span class="ch ch--br"></span>
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
        <!-- Run chips: salvage, upgrade count, arena mutation, seed. Each one
             hides when it has nothing to say, so a plain run stays a 4-chip row. -->
        <div class="hud__chip hud__chip--gold" data-salvage hidden>
          <span class="hud__chip-tag">SAL</span><b data-salvage-n>0</b>
        </div>
        <div class="hud__chip" data-upgrades hidden>
          <span class="hud__chip-tag">MOD</span><b data-upgrades-n>0</b>
        </div>
        <div class="hud__chip hud__chip--mutation" data-mutation hidden>
          <b data-mutation-n></b>
        </div>
        <!-- Active wager: only shown when the run was deployed with challenges,
             so a normal run keeps its four-chip row. -->
        <div class="hud__chip hud__chip--wager" data-wager hidden>
          <span class="hud__chip-tag">WAGER</span><b data-wager-n></b>
        </div>
        <!-- A real button: the seed is the one chip with an action (copy). -->
        <button type="button" class="hud__chip hud__chip--seed" data-seed hidden>
          <span class="hud__chip-tag" data-seed-label>SEED</span><b data-seed-n></b>
        </button>
      </div>
      <!-- Achievement toasts: top-right, under the radar, never clickable. -->
      <div class="hud__toasts" data-toasts aria-live="polite"></div>
      <!-- Boss bar: centered, sits above the bottom bar and ignores pointers. -->
      <div class="hud__boss" data-boss hidden>
        <div class="hud__boss-head">
          <span class="hud__boss-name" data-boss-name></span>
          <span class="hud__boss-phase" data-boss-phase></span>
        </div>
        <div class="hud__boss-bar"><div class="hud__boss-fill" data-boss-fill></div></div>
      </div>
      <div class="hud__enemies" data-enemies>
        <span data-en-hostiles>${icon('target')}<b data-enemies-n>0</b></span>
        <span data-en-timer hidden>${icon('clock')}<b data-timer-n>0</b></span>
        <span data-en-clear hidden>${icon('check')}</span>
      </div>
      <canvas class="hud__radar" data-radar width="${RADAR_SIZE}" height="${RADAR_SIZE}"></canvas>
      <div class="hud__hint" data-hint hidden></div>
      <!-- Touch overlay: only shown once a real touch is seen. Positioned by
           layoutTouch() so the button rects match the input hit-tests. -->
      <div class="hud__touch" data-touch hidden>
        <div class="hud__stick" data-stick hidden><i data-stick-nub></i></div>
        <div class="hud__tbtn" data-tbtn="fire" hidden>${icon('crosshair')}</div>
        <div class="hud__tbtn" data-tbtn="aim" hidden>${icon('target')}</div>
        <div class="hud__tbtn" data-tbtn="jump" hidden>${icon('jump')}</div>
        <div class="hud__tbtn" data-tbtn="sprint" hidden>${icon('sprint')}</div>
        <div class="hud__tbtn" data-tbtn="crouch" hidden>${icon('crouch')}</div>
        <div class="hud__tbtn" data-tbtn="reload" hidden>${icon('reload')}</div>
        <div class="hud__tbtn" data-tbtn="cycle" hidden>${icon('swap')}</div>
      </div>
      <div class="hud__bottom">
        <div class="hud__health">
          <div class="hud__health-head">
            ${icon('shield', 'hud__health-ic')}<span class="hud__health-num" data-health>100</span>
            <!-- Shield numeral: the bar segment is clamped to the room health
                 leaves, so at full health the segment is zero-width and the
                 number is the only thing that can report the plating. -->
            <span class="hud__shield-n" data-shield-n hidden>+0</span>
            <!-- Status pips: round by the Chamfer Rule (a pip is a dot). -->
            <span class="hud__pip hud__pip--burn" data-burn-pip hidden><b data-burn-n>0</b></span>
            <span class="hud__pip hud__pip--slow" data-slow-pip hidden><b data-slow-n>0</b></span>
          </div>
          <!-- Shield rides ON the health bar as a second segment, so the bar
               reads as one pool of damage absorption: health, then plating. -->
          <div class="hud__health-bar">
            <div class="hud__health-fill" data-health-fill></div>
            <div class="hud__shield-fill" data-shield-fill></div>
          </div>
          <div class="hud__ally" data-ally hidden>
            ${icon('bot')}
            <b class="hud__ally-n" data-ally-n></b>
            <div class="hud__ally-bar"><i data-ally-fill></i></div>
          </div>
        </div>
        <!-- Ability chips: charges plus the recharge ramp, beside the ammo readout. -->
        <div class="hud__abilities" data-abilities hidden>
          <div class="hud__ability" data-dash-chip>
            <div class="hud__ability-top"><span class="hud__ability-tag">DASH</span><b data-dash-n>0/0</b></div>
            <div class="hud__ability-bar"><i data-dash-fill></i></div>
          </div>
          <div class="hud__ability" data-gren-chip>
            <div class="hud__ability-top">
              <span class="hud__ability-tag">GRENADE</span><b data-gren-kind>FRAG</b><b data-gren-n>0/0</b>
            </div>
            <div class="hud__ability-bar"><i data-gren-fill></i></div>
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
          <!-- Achievement ledger: grouped by tier, capped height, own scroller. -->
          <div class="hud__ach" data-ach hidden>
            <div class="hud__ach-summary" data-ach-summary>UNLOCKED 0/0</div>
            <div class="hud__ach-list" data-ach-list></div>
          </div>
          <div class="hud__modes" role="group" aria-label="Game mode">
            <button type="button" class="hud__mode-chip active" data-mode="standard" title="Classic waves, steady ramp">${icon('flag')}<span>STANDARD</span></button>
            <button type="button" class="hud__mode-chip" data-mode="blitz" title="Short breaks, denser spawns, ×1.35 score">${icon('sprint')}<span>BLITZ</span></button>
            <button type="button" class="hud__mode-chip" data-mode="onslaught" title="Heavy waves from wave 2, ×1.75 score">${icon('skull')}<span>ONSLAUGHT</span></button>
            <button type="button" class="hud__mode-chip" data-mode="rotator" title="Weapon swaps every kill, ×1.5 score">${icon('swap')}<span>ROTATION</span></button>
            <button type="button" class="hud__mode-chip" data-mode="overrun" title="Endless: 24-alive cap, HP ×1.12 per wave, ×1.5 score, own best-wave record">${icon('infinity')}<span>OVERRUN</span></button>
          </div>
          <!-- Challenge wagers: opt-in difficulty that pays score. Each chip
               toggles independently, and the readout states the total payout
               so the trade is visible before DEPLOY. -->
          <div class="hud__challenges" data-challenges role="group" aria-label="Challenge wagers">
            <div class="hud__challenges-head">
              <span class="hud__challenges-title">WAGERS</span>
              <span class="hud__challenges-payout" data-challenge-payout>NO WAGER</span>
            </div>
            <div class="hud__challenges-row">
              ${CHALLENGE_IDS.map((id) => {
                const def = CHALLENGES[id];
                return (
                  `<button type="button" class="hud__challenge" data-challenge="${id}" ` +
                  `title="${def.description}" aria-pressed="false">` +
                  `${icon('skull')}<span>${def.name.toUpperCase()}</span></button>`
                );
              }).join('')}
            </div>
          </div>
          <!-- Seed row: a code the player was given, or today's shared daily.
               Both live inside the menu overlay, which carries the hidden
               class outside the menu, so this input cannot hold focus mid-run. -->
          <div class="hud__seed-row">
            <input
              class="hud__seed-input"
              type="text"
              data-seed-input
              maxlength="8"
              inputmode="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="SEED CODE"
              aria-label="Seed code"
            >
            <button type="button" class="hud__btn hud__btn--seed" data-seed-run>${icon('flag')}<span>DEPLOY SEED</span></button>
            <button type="button" class="hud__btn hud__btn--ghost" data-daily-run>${icon('clock')}<span>DAILY RUN</span></button>
          </div>
          <div class="hud__keys" data-keys></div>
          <div class="hud__settings">
            <label title="Sensitivity">${icon('target')}<input type="range" min="0.2" max="3" step="0.05" data-sens aria-label="Sensitivity"></label>
            <label title="Touch look" class="hud__setting-touch">${icon('move')}<input type="range" min="0.2" max="3" step="0.05" data-touch-sens aria-label="Touch sensitivity"></label>
            <label title="Volume">${icon('speaker')}<input type="range" min="0" max="1" step="0.05" data-vol aria-label="Volume"></label>
            <label title="Graphics quality" class="hud__setting-quality">${icon('grid')}<select data-quality aria-label="Graphics quality"><option value="auto">AUTO</option><option value="low">LOW</option><option value="medium">MEDIUM</option><option value="high">HIGH</option></select></label>
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
            <label title="Touch look" class="hud__setting-touch">${icon('move')}<input type="range" min="0.2" max="3" step="0.05" data-touch-sens aria-label="Touch sensitivity"></label>
            <label title="Volume">${icon('speaker')}<input type="range" min="0" max="1" step="0.05" data-vol aria-label="Volume"></label>
            <label title="Graphics quality" class="hud__setting-quality">${icon('grid')}<select data-quality aria-label="Graphics quality"><option value="auto">AUTO</option><option value="low">LOW</option><option value="medium">MEDIUM</option><option value="high">HIGH</option></select></label>
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

    // Ability chips.
    this.abilitiesEl = q('[data-abilities]');
    this.dashChip = q('[data-dash-chip]');
    this.dashN = q('[data-dash-n]');
    this.dashBar = q('[data-dash-fill]');
    this.grenChip = q('[data-gren-chip]');
    this.grenN = q('[data-gren-n]');
    this.grenKindEl = q('[data-gren-kind]');
    this.grenBar = q('[data-gren-fill]');
    // Run chips.
    this.salvageChip = q('[data-salvage]');
    this.salvageN = q('[data-salvage-n]');
    this.upgradeChip = q('[data-upgrades]');
    this.upgradeN = q('[data-upgrades-n]');
    this.mutationChip = q('[data-mutation]');
    this.mutationText = q('[data-mutation-n]');
    this.wagerChip = q('[data-wager]');
    this.wagerN = q('[data-wager-n]');
    this.seedChip = q<HTMLButtonElement>('[data-seed]');
    this.seedN = q('[data-seed-n]');
    this.menuSeedInput = q<HTMLInputElement>('[data-seed-input]');
    // Challenge wagers.
    this.challengePayout = q('[data-challenge-payout]');
    for (const chip of qa<HTMLButtonElement>('[data-challenge]')) {
      const id = chip.dataset.challenge as ChallengeId | undefined;
      if (!id || !Object.hasOwn(CHALLENGES, id)) continue;
      this.challengeChips.push(chip);
      chip.addEventListener('click', () => this.toggleChallenge(id));
    }
    this.renderChallengePayout();
    // Boss bar.
    this.bossBar = q('[data-boss]');
    this.bossNameEl = q('[data-boss-name]');
    this.bossPhaseEl = q('[data-boss-phase]');
    this.bossFill = q('[data-boss-fill]');
    // Status pips.
    this.burnPip = q('[data-burn-pip]');
    this.burnPipN = q('[data-burn-n]');
    this.slowPip = q('[data-slow-pip]');
    this.slowPipN = q('[data-slow-n]');
    // Shield segment on the health bar.
    this.shieldFill = q('[data-shield-fill]');
    this.shieldText = q('[data-shield-n]');
    // Toast host + achievement ledger.
    this.toastHost = q('[data-toasts]');
    this.achPanel = q('[data-ach]');
    this.achSummary = q('[data-ach-summary]');
    this.achList = q('[data-ach-list]');

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
    this.touchSensInputs = qa<HTMLInputElement>('input[data-touch-sens]');
    this.qualitySelects = qa<HTMLSelectElement>('select[data-quality]');
    this.volInputs = qa<HTMLInputElement>('input[data-vol]');
    this.touchRoot = q('[data-touch]');
    this.stickEl = q('[data-stick]');
    this.stickNub = q('[data-stick-nub]');
    for (const el of qa<HTMLElement>('[data-tbtn]')) {
      const id = el.dataset.tbtn;
      if (id) this.touchButtons.set(id, el);
    }
    for (const input of this.sensInputs) {
      input.addEventListener('input', () =>
        this.onSettings?.({ sensitivity: Number(input.value) }));
    }
    for (const input of this.touchSensInputs) {
      input.addEventListener('input', () =>
        this.onSettings?.({ touchSensitivity: Number(input.value) }));
    }
    for (const select of this.qualitySelects) {
      select.addEventListener('change', () => {
        const value = select.value;
        if (value === 'auto' || value === 'low' || value === 'medium' || value === 'high') {
          this.onSettings?.({ quality: value });
        }
      });
    }
    for (const input of this.volInputs) {
      input.addEventListener('input', () =>
        this.onSettings?.({ volume: Number(input.value) }));
    }
    // Slot chips are also the touch weapon selector.
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      slot.addEventListener('click', () => this.onSlotTap?.(i + 1));
    }

    q('[data-start]').addEventListener('click', () => this.onStart?.());
    q('[data-restart]').addEventListener('click', () => this.onRestart?.());
    q('[data-resume]').addEventListener('click', () => this.onResume?.());
    q('[data-quit]').addEventListener('click', () => this.onQuit?.());
    q('[data-to-menu]').addEventListener('click', () => this.onQuit?.());

    // Seed chip: copy the live run code, with a visible confirmation. The
    // flash targets the VALUE element, which is also what renderSeedLabel
    // rewrites on restore: flashing the tag would never be undone.
    this.seedChip.addEventListener('click', () => {
      void this.copySeed(this.seedN);
    });

    // Seed field: uppercase as the player types, so the code they paste in
    // lowercase still matches the codes the game prints.
    this.menuSeedInput.addEventListener('input', () => {
      const upper = this.menuSeedInput.value.toUpperCase();
      if (upper !== this.menuSeedInput.value) this.menuSeedInput.value = upper;
    });
    // Enter in the field commits, which is what a keyboard player expects.
    this.menuSeedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitSeed();
      }
    });
    q('[data-seed-run]').addEventListener('click', () => this.submitSeed());
    q('[data-daily-run]').addEventListener('click', () => this.onDailyRun?.());
  }

  /** Validate the seed field and start a run, or flash the field red. */
  private submitSeed(): void {
    const code = this.menuSeedInput.value.trim().toUpperCase();
    if (code.length >= 1 && code.length <= 8) {
      this.menuSeedInput.value = code;
      this.onSeedRun?.(code);
      return;
    }
    this.menuSeedInput.classList.add('deny');
    if (this.seedDenyTimer) window.clearTimeout(this.seedDenyTimer);
    this.seedDenyTimer = window.setTimeout(() => {
      this.seedDenyTimer = 0;
      this.menuSeedInput.classList.remove('deny');
    }, SEED_DENY_MS);
  }

  /**
   * Copy the live seed code and flash the outcome on the label that was
   * clicked. Both the top chip and the death card route through here, so the
   * fallback and the "never stuck" guarantee exist in exactly one place.
   */
  private async copySeed(label: HTMLElement): Promise<void> {
    const code = this.seedValue;
    if (!code) {
      this.flashLabel(label, 'COPY FAILED', () => this.renderSeedLabel());
      return;
    }
    const ok = await this.copyText(code);
    this.flashLabel(label, ok ? 'COPIED' : 'COPY FAILED', () => this.renderSeedLabel());
  }
  /**
   * Seed + daily flags for the live run. Called by Game right after a run
   * starts, so the chip is correct before the first HUD frame lands.
   */
  public setSeedCode(code: string, isDaily: boolean): void {
    this.seedValue = code;
    this.seedIsDaily = isDaily;
    this.renderSeedLabel();
  }

  /**
   * Toggle one wager and repaint. The HUD owns the pressed state so the chips
   * are correct before the game acknowledges the change; Game owns the actual
   * selection and re-folds the modifiers.
   */
  private toggleChallenge(id: ChallengeId): void {
    const i = this.challengeIds.indexOf(id);
    if (i >= 0) this.challengeIds.splice(i, 1);
    else this.challengeIds.push(id);
    for (const chip of this.challengeChips) {
      const on = chip.dataset.challenge !== undefined &&
        this.challengeIds.includes(chip.dataset.challenge as ChallengeId);
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.renderChallengePayout();
    this.onChallengeToggle?.(id);
  }

  /** Live payout readout: count plus the total score multiplier. */
  private renderChallengePayout(): void {
    const n = this.challengeIds.length;
    if (n === 0) {
      this.challengePayout.textContent = 'NO WAGER';
      this.challengePayout.classList.remove('hud__challenges-payout--on');
      return;
    }
    const mul = challengeScoreMul(this.challengeIds);
    this.challengePayout.textContent = `${n} WAGER${n > 1 ? 'S' : ''}  x${mul.toFixed(2)} SCORE`;
    this.challengePayout.classList.add('hud__challenges-payout--on');
  }

  /** Restore the menu chips from the game's live selection (e.g. on boot). */
  public setChallengeSelection(ids: readonly ChallengeId[]): void {
    this.challengeIds.length = 0;
    this.challengeIds.push(...ids);
    for (const chip of this.challengeChips) {
      const id = chip.dataset.challenge as ChallengeId | undefined;
      const on = id !== undefined && this.challengeIds.includes(id);
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.renderChallengePayout();
  }

  /**
   * Paint the seed chip text and tooltip from the cached seed state. The chip's
   * VISIBILITY is owned by updateRunChips(), because it also depends on whether
   * a run is live; this only writes the label so the flash restore can call it
   * without resurrecting the chip on the menu.
   *
   * Writes textContent directly rather than through setText: the cached write
   * would see an unchanged seed string and skip the DOM, leaving the label
   * stuck on COPIED forever. This is not a hot path, so the cache buys nothing.
   */
  private renderSeedLabel(): void {
    if (this.seedValue === '') return;
    // A daily run prints DAILY in place of the code and keeps the code in the
    // native tooltip, so the chip states the mode without hiding what the
    // player would actually share.
    this.seedN.textContent = this.seedIsDaily ? 'DAILY' : this.seedValue;
    this.seedChip.title = this.seedIsDaily
      ? `Daily seed ${this.seedValue}. Click to copy.`
      : `Seed ${this.seedValue}. Click to copy.`;
  }

  public update(dt: number, s: HudState): void {
    const hpPct = Math.max(0, s.health / s.maxHealth) * 100;
    this.setStyle('hpw', this.healthFill, 'width', `${hpPct}%`);
    this.healthFill.classList.toggle('low', hpPct <= 30);
    this.healthHead.classList.toggle('low', hpPct <= 30);
    this.setText('hp', this.healthText, String(Math.ceil(s.health)));
    this.vignette.classList.toggle('lowhp', hpPct <= 30 && hpPct > 0);

    this.updateShield(s);
    this.updatePips(s);
    this.updateAbilities(s);
    this.updateRunChips(s);
    this.updateBoss(s);

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
      // innerHTML is a full parse; only pay it when the window actually
      // changed. Before this cache the loop re-parsed three icons 60 times a
      // second for a value that changes on a weapon swap.
      if (this.slotIconCache[i] !== idx) {
        this.slotIconCache[i] = idx;
        slot.innerHTML = icon(this.slotIcons[idx] ?? 'rifle');
      }
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
      // Radar throttle: the sweep and the blips move far slower than 60 Hz,
      // and a canvas redraw is a full rasterisation, so 20 Hz is visually
      // identical and cuts the work to a third.
      this.radarAccum += dt;
      if (this.radarAccum >= RADAR_INTERVAL) {
        this.radarAccum = 0;
        this.drawRadar(s);
      }
      this.radarVisible = true;
    } else if (this.radarVisible) {
      this.radarCtx?.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
      this.radarVisible = false;
      this.radarAccum = 0;
    }

    // Dynamic crosshair spread — the gap is the real cone projected to pixels.
    const gap = s.crosshairGapPx;
    this.setStyle('chgap', this.crosshair, '--ch-gap', `${gap.toFixed(1)}px`);

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.waveBanner.classList.remove('show');
    }
  }

  /**
   * Shield on the health bar, plus the matching numeral beside the health
   * readout. The segment is clamped to the room health leaves, so it is
   * zero-width at full health and the numeral is what keeps the plating
   * legible there; together they answer both "how much" and "where does it
   * sit in the damage pool".
   */
  private updateShield(s: HudState): void {
    const max = Math.max(1, s.maxHealth);
    const shield = Math.max(0, s.shield);
    const healthFrac = clamp01(s.health / max);
    const shieldFrac = Math.min(clamp01(shield / max), 1 - healthFrac);
    this.setStyle('shx', this.shieldFill, 'left', `${healthFrac * 100}%`);
    this.setStyle('shw', this.shieldFill, 'width', `${shieldFrac * 100}%`);
    this.setClass('shv', this.shieldFill, 'on', shieldFrac > 0);
    const show = shield > 0.5;
    this.shieldText.hidden = !show;
    if (show) this.setText('shn', this.shieldText, `+${Math.ceil(shield)}`);
  }

  /** Burn / slow pips. Whole seconds only; a pip at 0 seconds is noise. */
  private updatePips(s: HudState): void {
    const burn = s.burnT > 0;
    const slow = s.slowT > 0;
    this.burnPip.hidden = !burn;
    this.slowPip.hidden = !slow;
    if (burn) this.setText('burnn', this.burnPipN, String(Math.ceil(s.burnT)));
    if (slow) this.setText('slown', this.slowPipN, String(Math.ceil(s.slowT)));
  }

  /**
   * Ability chips. The bar under each chip is the recharge ramp, and it is
   * hidden (width 100 percent, accent) whenever a charge is banked: a full
   * bar that never moves reads as "ready", which is the point.
   *
   * While a grenade is being cooked the chip flips to gold and the bar tracks
   * the cook strength, so the throw window has a visible start and end.
   */
  private updateAbilities(s: HudState): void {
    this.abilitiesEl.hidden = !s.inGame;
    if (!s.inGame) return;

    const dashReady = s.dashCharges > 0;
    this.setText('dashn', this.dashN, `${s.dashCharges}/${s.dashMax}`);
    this.setStyle('dashw', this.dashBar, 'width', `${clamp01(s.dashFraction) * 100}%`);
    this.setClass('dashr', this.dashBar, 'ready', dashReady);
    // An empty chip dims: with zero charges there is nothing to press yet, and
    // the dim state is the tell that does not require reading the n/N.
    this.setClass('dashc', this.dashChip, 'depleted', !dashReady);

    const cook = clamp01(s.grenadeCook);
    const cooking = cook > 0;
    const grenReady = s.grenadeCharges > 0;
    this.setText('grenn', this.grenN, `${s.grenadeCharges}/${s.grenadeMax}`);
    this.setText('grenk', this.grenKindEl, GRENADE_LABEL[s.grenadeKind]);
    // A live cook owns the bar: it shows the cook, not the recharge.
    this.setStyle(
      'grenw',
      this.grenBar,
      'width',
      `${(cooking ? cook : clamp01(s.grenadeFraction)) * 100}%`,
    );
    this.setClass('grenc', this.grenChip, 'cooking', cooking);
    this.setClass('grenr', this.grenBar, 'ready', grenReady && !cooking);
    this.setClass('grenk2', this.grenKindEl, 'cooking', cooking);
  }

  /** Salvage / upgrade / mutation / seed chips. Each hides when it is empty. */
  private updateRunChips(s: HudState): void {
    // Salvage and the mutation only exist inside a run; the menu snapshot keeps
    // whatever the last run left behind, so gate the whole row on inGame.
    const live = s.inGame;
    this.salvageChip.hidden = !live;
    if (live) this.setText('salv', this.salvageN, String(Math.max(0, Math.floor(s.salvage))));

    const hasUpgrades = s.upgrades > 0;
    this.upgradeChip.hidden = !live || !hasUpgrades;
    if (live && hasUpgrades) this.setText('upgn', this.upgradeN, String(s.upgrades));

    const hasMutation = live && s.mutationName !== '';
    this.mutationChip.hidden = !hasMutation;
    if (hasMutation) {
      this.setText('mutn', this.mutationText, s.mutationName);
      // Native tooltip: the description is one line of context, not worth a
      // panel, and the title attribute needs no layout budget.
      if (this.mutationChip.title !== s.mutationDesc) this.mutationChip.title = s.mutationDesc;
    }

    // Active wager: the run's challenges and their total payout. The tooltip
    // lists the picks so the player can re-read what they signed up for
    // without pausing.
    const wagerCount = s.wagerCount ?? 0;
    const hasWager = live && wagerCount > 0;
    this.wagerChip.hidden = !hasWager;
    if (hasWager) {
      this.setText('wagern', this.wagerN, `x${(s.wagerScoreMul ?? 1).toFixed(2)}`);
      const label = s.wagerLabel ?? '';
      if (this.wagerChip.title !== label) this.wagerChip.title = label;
    }

    // The seed chip outlives the run: it is still the code you just played, and
    // it stays visible on the death card's row until the next run replaces it.
    const seed = s.seedCode;
    const daily = s.isDaily;
    if (seed !== this.seedValue || daily !== this.seedIsDaily) {
      this.seedValue = seed;
      this.seedIsDaily = daily;
      this.renderSeedLabel();
    }
    this.seedChip.hidden = !live || seed === '';
  }

  /**
   * Boss bar. Only one boss exists at a time, so the bar is a straight mirror
   * of the live roster entry: name, phase, health fraction. The weak-point
   * state is the whole reason the bar has a second read: while the rear core is
   * intact the fill is plain crimson, and once it is broken the fill takes a
   * gold top edge and the phase text says CORE DOWN, which is the moment the
   * player's flanking actually paid off.
   */
  private updateBoss(s: HudState): void {
    const active = s.bossActive && s.inGame;
    this.bossBar.hidden = !active;
    if (!active) return;
    this.setText('bossn', this.bossNameEl, s.bossName);
    const coreUp = s.bossWeakPoint;
    this.setText('bossp', this.bossPhaseEl, coreUp ? `PHASE ${s.bossPhase}` : 'CORE DOWN');
    const frac = s.bossMax > 0 ? clamp01(s.bossHealth / s.bossMax) : 0;
    this.setStyle('bossw', this.bossFill, 'width', `${frac * 100}%`);
    this.setClass('bossc', this.bossFill, 'core-down', !coreUp);
  }

  /**
   * Achievement toast. Slides in from the top-right, holds, fades out.
   *
   * Timers, not the frame delta: achievements land on the death screen and on
   * quit-to-menu, where `update()` is called with dt 0, so a dt-driven timer
   * would freeze the toast on screen forever.
   */
  public showAchievement(name: string, description: string): void {
    const toast = document.createElement('div');
    toast.className = 'hud__toast';
    toast.dataset.ttl = String(TOAST_HOLD_MS);
    const eyebrow = document.createElement('div');
    eyebrow.className = 'hud__toast-eyebrow';
    eyebrow.textContent = 'ACHIEVEMENT';
    const title = document.createElement('div');
    title.className = 'hud__toast-name';
    title.textContent = name;
    const desc = document.createElement('div');
    desc.className = 'hud__toast-desc';
    desc.textContent = description;
    toast.append(eyebrow, title, desc);
    this.toastHost.appendChild(toast);
    this.toasts.push(toast);

    // Over the cap, the oldest toast is dropped rather than the newest: the
    // player just earned the new one, and a stale popup is the expendable one.
    while (this.toasts.length > TOAST_LIMIT) {
      const oldest = this.toasts.shift();
      if (!oldest) break;
      this.discardToast(oldest);
    }

    // Force a reflow so the entry transition runs on a freshly attached node.
    void toast.offsetWidth;
    toast.classList.add('in');

    const holdId = window.setTimeout(() => {
      toast.classList.add('out');
      const removeId = window.setTimeout(() => this.discardToast(toast), TOAST_FADE_MS);
      this.toastTimers.set(toast, removeId);
    }, TOAST_HOLD_MS);
    this.toastTimers.set(toast, holdId);
  }

  /** Remove one toast and cancel its pending timers. Safe to call twice. */
  private discardToast(toast: HTMLElement): void {
    const id = this.toastTimers.get(toast);
    if (id !== undefined) window.clearTimeout(id);
    this.toastTimers.delete(toast);
    const idx = this.toasts.indexOf(toast);
    if (idx >= 0) this.toasts.splice(idx, 1);
    toast.remove();
  }

  /**
   * Achievement ledger in the menu. Rows are grouped by tier and show the
   * lock state plus progress toward the target; the panel scrolls, so the
   * menu card does not grow with the table.
   *
   * The list is rebuilt only when its inputs change: the signature covers the
   * unlock set and every counter the table reads, and this is called on every
   * return to the menu, which is not a hot path but is not free either.
   */
  public setAchievements(
    unlocked: ReadonlySet<string>,
    counters: Readonly<Record<string, number>>,
  ): void {
    const known = unlocked as ReadonlySet<AchievementId>;
    const metrics = counters as Readonly<Record<AchievementMetric, number>>;
    const summary = this.achTracker.summary(known);
    let signature = `${summary.unlocked}/${summary.total}`;
    for (const def of Object.values(ACHIEVEMENTS)) {
      signature += `|${def.id}:${metrics[def.metric] ?? 0}`;
    }
    // Show the panel on the first call even when the signature matches, so a
    // zero-achievement save still gets its list.
    const first = !this.achievementsSeen;
    this.achievementsSeen = true;
    this.achPanel.hidden = false;
    if (!first && signature === this.achSignature) {
      this.achSummary.textContent = `UNLOCKED ${summary.unlocked}/${summary.total}`;
      return;
    }
    this.achSignature = signature;

    this.achSummary.textContent =
      `UNLOCKED ${summary.unlocked}/${summary.total} · ${summary.percent}%`;

    const tiers = this.achTracker.byTier();
    const rows: string[] = [];
    for (const tier of ACH_TIER_ORDER) {
      rows.push(`<div class="hud__ach-tier">${tier}</div>`);
      for (const def of tiers[tier]) {
        rows.push(this.achievementRow(def, known, metrics));
      }
    }
    this.achList.innerHTML = rows.join('');
  }

  /** One ledger row: name, progress readout, lock state. */
  private achievementRow(
    def: AchievementDef,
    unlocked: ReadonlySet<AchievementId>,
    counters: Readonly<Record<AchievementMetric, number>>,
  ): string {
    const done = unlocked.has(def.id);
    const value = counters[def.metric] ?? 0;
    // The progress bar is not drawn in the list (32 rows of bars is noise), so
    // the percentage is folded into the readout where it is legible, and the
    // state column says lock/unlock in words rather than repeating the number.
    return (
      `<div class="hud__ach-row${done ? ' hud__ach-row--done' : ''}" title="${def.description}">` +
      `<span class="hud__ach-name">${def.name}</span>` +
      `<span class="hud__ach-prog">${formatProgress(value, def.target)}</span>` +
      `<span class="hud__ach-mark">${done ? 'UNLOCKED' : 'LOCKED'}</span>` +
      `<span class="sr-only">${def.description}</span>` +
      `</div>`
    );
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

  /**
   * Death card. Three blocks, each one optional:
   *  1. the run summary (mode, wave, kills, score, best);
   *  2. the extended run stats, when the caller supplies them;
   *  3. the seed plus a copy button, and the upgrade list when non-empty.
   * A legacy caller that passes only the original six fields still renders:
   * every new block is gated on its own data being present, never on a flag.
   */
  public showDeath(visible: boolean, stats?: DeathStats): void {
    this.death.classList.toggle('hidden', !visible);
    if (stats) {
      this.renderDeath(stats);
      this.recordEl.hidden = !stats.isNewRecord;
    }
    this.syncOverlay();
  }

  private renderDeath(stats: DeathStats): void {
    const row = (ic: IconName, label: string, value: number | string): string =>
      `<div title="${label}">${icon(ic)}<span>${value}</span>` +
      `<span class="sr-only">${label}</span></div>`;
    const meta = MODE_META[stats.mode];
    let html =
      `<div class="hud__death-block">` +
      (meta ? row(meta.icon, 'Mode', meta.label) : '') +
      row('flag', 'Wave reached', stats.wave) +
      row('skull', 'Kills', stats.kills) +
      row('score', 'Score', stats.score) +
      row('trophy', 'Best', stats.bestScore) +
      `</div>`;

    // Block 2: extended stats. Every field is optional, so each row is added
    // only when its value arrived; a legacy call renders no second block.
    const extra: string[] = [];
    if (stats.accuracy !== undefined) {
      extra.push(row('target', 'Accuracy', `${(stats.accuracy * 100).toFixed(1)}%`));
    }
    if (stats.headshots !== undefined) extra.push(row('crosshair', 'Headshots', stats.headshots));
    if (stats.timeSurvived !== undefined) {
      extra.push(row('clock', 'Time survived', formatClock(stats.timeSurvived)));
    }
    if (stats.damageDealt !== undefined) extra.push(row('bullet', 'Damage dealt', stats.damageDealt));
    if (stats.damageTaken !== undefined) extra.push(row('shield', 'Damage taken', stats.damageTaken));
    if (stats.longestCombo !== undefined) extra.push(row('score', 'Longest combo', stats.longestCombo));
    if (stats.elitesKilled !== undefined) extra.push(row('skull', 'Elites', stats.elitesKilled));
    if (stats.bossesKilled !== undefined) extra.push(row('trophy', 'Bosses', stats.bossesKilled));
    if (stats.salvageEarned !== undefined) {
      extra.push(row('crate', 'Salvage earned', stats.salvageEarned));
    }
    if (stats.noHitWaves !== undefined) extra.push(row('check', 'No-hit waves', stats.noHitWaves));
    if (extra.length > 0) html += `<div class="hud__death-block">${extra.join('')}</div>`;

    // Block 3: seed + copy. The button carries the same copy path as the chip.
    const seed = stats.seedCode ?? '';
    if (seed !== '') {
      html +=
        `<div class="hud__death-seed">` +
        `<span class="hud__death-seed-tag">SEED</span>` +
        `<b class="hud__death-seed-code">${seed}</b>` +
        (stats.isDaily ? `<span class="hud__death-seed-tag">DAILY</span>` : '') +
        `<button type="button" class="hud__btn hud__btn--tiny" data-death-copy>COPY</button>` +
        `</div>`;
    }

    // Block 4: the cards held this run, as chips.
    const upgrades = stats.upgrades ?? [];
    if (upgrades.length > 0) {
      const chips = upgrades.map((id) => `<span class="hud__death-chip">${upgradeName(id)}</span>`);
      html += `<div class="hud__death-upgrades">${chips.join('')}</div>`;
    }

    // Mutations seen get their own line: they are the reason two runs on the
    // same seed still read differently, so they belong in the summary.
    const mutations = stats.mutationsSeen ?? [];
    if (mutations.length > 0) {
      const chips = mutations.map((m) => `<span class="hud__death-chip">${m}</span>`);
      html +=
        `<div class="hud__death-upgrades">` +
        `<span class="hud__death-seed-tag">MUTATIONS</span>${chips.join('')}` +
        `</div>`;
    }

    this.deathStats.innerHTML = html;

    // The copy button only exists when a seed did, and the seed it copies is
    // the one on this card, not the live run's (the run may already be gone).
    const copyBtn = this.deathStats.querySelector<HTMLButtonElement>('[data-death-copy]');
    if (copyBtn && seed !== '') {
      copyBtn.addEventListener('click', () => {
        const doCopy = async (): Promise<void> => {
          const ok = await this.copyText(seed);
          this.flashLabel(copyBtn, ok ? 'COPIED' : 'COPY FAILED', () => {
            copyBtn.textContent = 'COPY';
          });
        };
        void doCopy();
      });
    }
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

  public syncSettings(
    sensitivity: number,
    volume: number,
    touchSensitivity = 1,
    quality: QualitySetting = 'auto',
  ): void {
    for (const input of this.sensInputs) input.value = String(sensitivity);
    for (const input of this.touchSensInputs) input.value = String(touchSensitivity);
    for (const select of this.qualitySelects) select.value = quality;
    for (const input of this.volInputs) input.value = String(volume);
  }

  /** Show the touch overlay. Called once a real touch is detected. */
  public setTouchMode(on: boolean): void {
    this.touchMode = on;
    this.touchRoot.hidden = !on;
    this.root.classList.toggle('hud--touch', on);
    for (const el of this.touchButtons.values()) el.hidden = !on;
    this.stickEl.hidden = !on;
    this.layoutTouch();
  }

  /**
   * Position the touch overlay from the input layer's own hit-rects, so what
   * the player sees is exactly what the hit-test uses — one source of truth.
   */
  public layoutTouch(): void {
    if (!this.touchMode) return;
    for (const [id, el] of this.touchButtons) {
      const btn = this.touchButtonRects?.find((b) => b.id === id);
      if (!btn) continue;
      el.style.left = `${btn.x - btn.radius}px`;
      el.style.top = `${btn.y - btn.radius}px`;
      el.style.width = `${btn.radius * 2}px`;
      el.style.height = `${btn.radius * 2}px`;
    }
  }

  /** Live stick visual — origin plus current deflection. */
  public updateTouch(
    stick: { active: boolean; originX: number; originY: number; x: number; y: number },
    radius: number,
  ): void {
    if (!this.touchMode) return;
    this.stickEl.hidden = !stick.active;
    if (!stick.active) return;
    this.stickEl.style.left = `${stick.originX - radius}px`;
    this.stickEl.style.top = `${stick.originY - radius}px`;
    this.stickEl.style.width = `${radius * 2}px`;
    this.stickEl.style.height = `${radius * 2}px`;
    const dx = stick.x - stick.originX;
    const dy = stick.y - stick.originY;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, radius) / len;
    this.stickNub.style.transform = `translate(${dx * clamped}px, ${dy * clamped}px)`;
  }

  /** Pressed-state feedback for the touch buttons. */
  public setTouchHeld(id: string, held: boolean): void {
    const el = this.touchButtons.get(id);
    if (el) el.classList.toggle('active', held);
  }

  /** Injected by Game so the HUD can mirror the input hit-rects verbatim. */
  public touchButtonRects: readonly { id: string; x: number; y: number; radius: number }[] | null = null;
}
