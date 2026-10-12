/**
 * Between-wave upgrade draft.
 *
 * A modal decision plate: one card per offer, plus a reroll and a skip. The
 * overlay owns its own keyboard layer, and only while it is up. A hidden draft
 * that keeps listening would eat the player's number keys mid-wave, so show()
 * detaches before it attaches: a reroll re-enters through the same door and
 * must never stack a second listener.
 */
import type { DraftOffer } from '../game/Run';
import { rarityLabel } from '../game/Upgrades';
import { icon } from './icons';

export interface DraftResult {
  /** Chosen card id, or null when the player skipped. */
  chosen: string | null;
  /** Salvage spent on rerolls during this draft. */
  rerollCost: number;
}

/** Price of a reroll once the free ones are spent. */
const PAID_REROLL_COST = 75;
/** Deny flash length: long enough to read, short enough not to nag. */
const DENY_MS = 300;
/** Digit key codes. The index maps to the card at the same index. */
const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

export class Draft {
  public readonly root: HTMLDivElement;
  /** Fired once per resolved draft. */
  public onResolve: ((result: DraftResult) => void) | null = null;
  /** Fired when a reroll is requested; the caller re-rolls and calls show() again. */
  public onReroll: ((cost: number) => boolean) | null = null;

  private readonly panel: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly cardsEl: HTMLDivElement;
  private readonly rerollBtn: HTMLButtonElement;
  private readonly cards: HTMLButtonElement[] = [];
  private salvage = 0;
  private rerolls = 0;
  /** Salvage burned on paid rerolls in the current draft. */
  private spent = 0;
  private denyTimer = 0;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Modifier chords belong to the browser, and auto-repeat would spend a
    // reroll per frame while R is held down.
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

    const index = DIGIT_CODES.indexOf(event.code);
    if (index >= 0) {
      const id = this.cards[index]?.dataset.cardId;
      if (id) {
        event.preventDefault();
        this.finish(id);
      }
      return;
    }
    if (event.code === 'KeyR') {
      event.preventDefault();
      this.requestReroll();
      return;
    }
    if (event.code === 'KeyS' || event.code === 'Escape') {
      event.preventDefault();
      this.finish(null);
    }
  };

  public constructor() {
    this.root = document.createElement('div');
    // The `hidden` class is mandatory on construction: an unhidden full-screen
    // overlay swallows every click on the page, a bug this project has already
    // paid for once.
    this.root.className = 'hud__draft hidden';
    this.root.dataset.draft = '';
    this.root.inert = true;

    this.panel = document.createElement('div');
    this.panel.className = 'hud__draft-panel';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'hud__draft-title';

    const sub = document.createElement('div');
    sub.className = 'hud__draft-sub';
    sub.textContent = 'SELECT ONE UPGRADE';

    this.cardsEl = document.createElement('div');
    this.cardsEl.className = 'hud__draft-cards';

    this.rerollBtn = document.createElement('button');
    this.rerollBtn.type = 'button';
    this.rerollBtn.className = 'hud__btn hud__btn--ghost';
    this.rerollBtn.addEventListener('click', () => this.requestReroll());

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'hud__btn hud__btn--ghost';
    skipBtn.textContent = 'SKIP';
    skipBtn.addEventListener('click', () => this.finish(null));

    const actions = document.createElement('div');
    actions.className = 'hud__draft-actions';
    actions.append(this.rerollBtn, skipBtn);

    this.panel.append(this.titleEl, sub, this.cardsEl, actions);
    this.root.append(this.panel);
  }

  public get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /**
   * Show the draft. `wave` titles the panel, `offers` are the cards,
   * `salvage` is the player's current currency, `rerolls` the remaining
   * free rerolls. Renders one card per offer plus a SKIP button.
   */
  public show(wave: number, offers: readonly DraftOffer[], salvage: number, rerolls: number): void {
    // A reroll re-shows the same draft, so the previous keyboard layer goes
    // first. removeEventListener on a listener that was never added is a no-op,
    // which keeps this path idempotent.
    document.removeEventListener('keydown', this.onKeyDown);
    this.clearDeny();

    this.salvage = salvage;
    this.rerolls = Math.max(0, rerolls);
    this.titleEl.textContent = `WAVE ${wave} CLEARED`;

    this.cards.length = 0;
    this.cardsEl.replaceChildren();
    for (const offer of offers) {
      const card = this.buildCard(offer);
      this.cards.push(card);
      this.cardsEl.append(card);
    }
    this.renderReroll();

    this.root.classList.remove('hidden');
    this.root.inert = false;
    document.addEventListener('keydown', this.onKeyDown);
  }

  public hide(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.clearDeny();
    this.root.classList.add('hidden');
    this.root.inert = true;
    // The draft is over either way, so the per-draft reroll ledger closes here.
    // finish() snapshots it into the result before calling this.
    this.spent = 0;
  }

  private buildCard(offer: DraftOffer): HTMLButtonElement {
    const card = offer.card;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hud__draft-card';
    btn.dataset.rarity = card.rarity;
    btn.dataset.cardId = card.id;

    // Header row: rarity medal + label on the left, stack pips on the right.
    // The medal makes the tier readable by shape and hue before any text.
    const head = document.createElement('span');
    head.className = 'hud__draft-head';

    const rarity = document.createElement('span');
    rarity.className = 'hud__draft-rarity';
    rarity.innerHTML = `${icon('medal')}<span>${rarityLabel(card.rarity)}</span>`;

    head.append(rarity);

    // Stack pips: one filled diamond per copy already owned, capped at the
    // card's own stack cap so the row length means something.
    const cap = card.maxStacks ?? 5;
    if (offer.owned > 0) {
      const pips = document.createElement('span');
      pips.className = 'hud__draft-pips';
      pips.title = `Owned ${offer.owned} of ${cap}`;
      for (let i = 0; i < cap; i++) {
        const pip = document.createElement('i');
        if (i < offer.owned) pip.className = 'on';
        pips.append(pip);
      }
      head.append(pips);
    }

    const name = document.createElement('span');
    name.className = 'hud__draft-name';
    name.textContent = card.name;

    const desc = document.createElement('span');
    desc.className = 'hud__draft-desc';
    desc.textContent = card.description;

    btn.append(head, name, desc);

    btn.addEventListener('click', () => this.finish(card.id));
    return btn;
  }

  private renderReroll(): void {
    const paid = this.rerolls <= 0;
    const cost = paid ? PAID_REROLL_COST : 0;
    const affordable = !paid || this.salvage >= cost;
    this.rerollBtn.textContent = paid ? `REROLL (${cost} SALVAGE)` : `REROLL (${this.rerolls})`;
    // The button stays clickable while unaffordable: the caller owns the
    // refusal, and the red deny flash is the feedback. The dimmed label only
    // warns before the click.
    this.rerollBtn.dataset.afford = affordable ? '1' : '0';
    this.rerollBtn.title = affordable ? '' : 'NOT ENOUGH SALVAGE';
  }

  private requestReroll(): void {
    const cost = this.rerolls > 0 ? 0 : PAID_REROLL_COST;
    const accepted = this.onReroll?.(cost) ?? false;
    if (!accepted) {
      // A refused free reroll is the caller's own veto. Only a refused paid
      // reroll means "no funds", which is the state worth alarming about.
      if (cost > 0) this.flashDeny();
      return;
    }
    if (cost > 0) this.spent += cost;
    this.rerolls = Math.max(0, this.rerolls - 1);
    this.renderReroll();
  }

  private finish(chosen: string | null): void {
    const result: DraftResult = { chosen, rerollCost: this.spent };
    this.hide();
    this.onResolve?.(result);
  }

  private flashDeny(): void {
    this.panel.classList.add('hud__draft-deny');
    this.panel.setAttribute('data-deny', '1');
    window.clearTimeout(this.denyTimer);
    this.denyTimer = window.setTimeout(() => this.clearDeny(), DENY_MS);
  }

  private clearDeny(): void {
    window.clearTimeout(this.denyTimer);
    this.denyTimer = 0;
    this.panel.classList.remove('hud__draft-deny');
    this.panel.removeAttribute('data-deny');
  }
}
