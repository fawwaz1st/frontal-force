/**
 * Between-wave supply kiosk.
 *
 * A straight salvage sink: one row per item, priced, bought on the spot. Unlike
 * the draft, nothing here needs a keyboard layer beyond close, and nothing here
 * owns the currency: the caller decides what is affordable and reports back
 * whether the purchase landed. Rows are never rebuilt on a purchase, because a
 * rebuild would destroy the row that is mid-flash.
 */

export interface KioskItem {
  id: string;
  name: string;
  description: string;
  /** Cost in salvage. For a sell row this is the REFUND paid to the player. */
  cost: number;
  /** False when the item cannot be bought right now (maxed, full health...). */
  available: boolean;
  /** Reason shown when unavailable, e.g. 'AT FULL HEALTH'. */
  unavailableReason?: string;
  /** Sell rows pay out instead of charging, and are never blocked by a low
   *  balance. The UI needs the flag to label and price them correctly. */
  sell?: boolean;
}

export interface KioskResult {
  itemId: string;
  cost: number;
}

/** Success flash: readable in peripheral vision without holding the player. */
const OK_MS = 400;
/** Deny flash: the "no" has to register, not linger. */
const DENY_MS = 300;

export class Kiosk {
  public readonly root: HTMLDivElement;
  public onPurchase: ((result: KioskResult) => boolean) | null = null;
  public onClose: (() => void) | null = null;

  private readonly listEl: HTMLDivElement;
  private readonly salvageEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly costEls = new Map<string, HTMLElement>();
  private readonly flashTimers = new Map<string, number>();
  private items: readonly KioskItem[] = [];
  private salvage = 0;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === 'Escape' || event.code === 'KeyK') {
      event.preventDefault();
      this.close();
    }
  };

  public constructor() {
    this.root = document.createElement('div');
    // Mandatory: an unhidden full-screen overlay eats every click on the page.
    this.root.className = 'hud__kiosk hidden';
    this.root.dataset.kiosk = '';
    this.root.inert = true;

    const panel = document.createElement('div');
    panel.className = 'hud__kiosk-panel';

    const title = document.createElement('div');
    title.className = 'hud__kiosk-title';
    title.textContent = 'SUPPLY KIOSK';

    const sub = document.createElement('div');
    sub.className = 'hud__kiosk-sub';
    sub.textContent = 'INTERMISSION ONLY';

    const salvageRow = document.createElement('div');
    salvageRow.className = 'hud__kiosk-salvage';
    this.salvageEl = document.createElement('b');
    this.salvageEl.textContent = '0';
    const salvageUnit = document.createElement('span');
    salvageUnit.textContent = 'SALVAGE';
    salvageRow.append(this.salvageEl, salvageUnit);

    this.listEl = document.createElement('div');
    this.listEl.className = 'hud__kiosk-list';

    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'hud__btn hud__btn--ghost';
    this.closeBtn.textContent = 'CLOSE';
    this.closeBtn.addEventListener('click', () => this.close());

    const actions = document.createElement('div');
    actions.className = 'hud__kiosk-actions';
    actions.append(this.closeBtn);

    panel.append(title, sub, salvageRow, this.listEl, actions);
    this.root.append(panel);
  }

  public get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  public show(items: readonly KioskItem[], salvage: number): void {
    // Re-showing replaces the previous keyboard layer instead of adding to it.
    document.removeEventListener('keydown', this.onKeyDown);
    this.cancelFlashes();

    this.items = items;
    this.salvage = salvage;
    this.salvageEl.textContent = String(salvage);

    this.rows.clear();
    this.costEls.clear();
    this.listEl.replaceChildren();
    for (const item of items) this.listEl.append(this.buildRow(item));

    this.root.classList.remove('hidden');
    this.root.inert = false;
    document.addEventListener('keydown', this.onKeyDown);
    // Purchase rows are the only interactive content; park focus there so the
    // kiosk is usable without touching the mouse.
    this.firstEnabledRow()?.focus();
  }

  public hide(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.cancelFlashes();
    this.root.classList.add('hidden');
    this.root.inert = true;
  }

  /** Update the salvage readout without re-rendering the whole list. */
  public setSalvage(salvage: number): void {
    this.salvage = salvage;
    this.salvageEl.textContent = String(salvage);
    this.refreshPrices();
  }

  private buildRow(item: KioskItem): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hud__kiosk-row';
    row.dataset.itemId = item.id;
    // `owned` marks a purchase that already landed, so a row cannot be bought
    // twice before the caller re-renders the list. It starts at 0 because the
    // first click must be allowed through (a pre-set '1' would dead-lock it).
    row.dataset.owned = '0';

    const text = document.createElement('span');
    text.className = 'hud__kiosk-text';

    const name = document.createElement('span');
    name.className = 'hud__kiosk-name';
    name.textContent = item.name;

    const desc = document.createElement('span');
    desc.className = 'hud__kiosk-desc';
    desc.textContent = item.description;

    text.append(name, desc);

    const cost = document.createElement('span');
    cost.className = 'hud__kiosk-cost';

    row.append(text, cost);

    row.addEventListener('click', () => {
      // Only ids the kiosk is CURRENTLY offering may be bought. Checking the
      // live item list (rather than a post-purchase marker) keeps a stale row
      // from spending salvage while still allowing the FIRST click to land.
      if (!this.items.some((entry) => entry.id === item.id)) return;
      if (row.disabled) return;
      const ok = this.onPurchase?.({ itemId: item.id, cost: item.cost }) ?? false;
      this.flash(row, ok ? 'ok' : 'deny');
    });

    this.rows.set(item.id, row);
    this.costEls.set(item.id, cost);
    this.paintRow(item, row, cost);
    return row;
  }

  /** Write one row's price or its refusal reason. */
  private paintRow(item: KioskItem, row: HTMLButtonElement, cost: HTMLElement): void {
    const bought = row.dataset.owned === '1';
    // A sell row is affordable by definition: it PAYS the balance.
    const affordable = item.sell === true || item.cost <= this.salvage;
    // `bought` marks the purchase as accepted even when the item leaves the
    // list right after, so a sold-out row does not re-offer itself.
    const buyable = item.available && affordable && !bought;

    row.disabled = !buyable;
    row.setAttribute('aria-disabled', buyable ? 'false' : 'true');
    row.title = buyable ? '' : this.refusalFor(item, affordable);
    row.classList.toggle('hud__kiosk-row--sell', item.sell === true);

    if (!item.available && !bought) {
      // The reason is more useful than a price the player cannot pay anyway.
      cost.textContent = item.unavailableReason ?? 'UNAVAILABLE';
      cost.classList.add('hud__kiosk-cost--blocked');
      cost.classList.remove('hud__kiosk-cost--short');
      return;
    }
    // Sell rows print +N so the payout direction is unmissable.
    cost.textContent = item.sell ? `+${item.cost}` : String(item.cost);
    cost.classList.toggle('hud__kiosk-cost--short', !affordable);
    cost.classList.remove('hud__kiosk-cost--blocked');
  }

  private refusalFor(item: KioskItem, affordable: boolean): string {
    if (!item.available) return item.unavailableReason ?? 'UNAVAILABLE';
    if (!affordable) return 'NOT ENOUGH SALVAGE';
    return '';
  }

  /** Re-price every row against the current balance. */
  private refreshPrices(): void {
    for (const item of this.items) {
      const row = this.rows.get(item.id);
      const cost = this.costEls.get(item.id);
      if (!row || !cost) continue;
      this.paintRow(item, row, cost);
    }
  }

  private flash(row: HTMLButtonElement, state: 'ok' | 'deny'): void {
    const id = row.dataset.itemId;
    if (!id) return;
    if (state === 'ok') row.dataset.owned = '1';
    row.dataset.state = state;
    window.clearTimeout(this.flashTimers.get(id));
    this.flashTimers.set(
      id,
      window.setTimeout(() => {
        this.flashTimers.delete(id);
        delete row.dataset.state;
        if (state === 'ok') {
          // The purchase landed, so re-price against the new balance without
          // rebuilding the row.
          const item = this.items.find((entry) => entry.id === id);
          const cost = this.costEls.get(id);
          if (item && cost) this.paintRow(item, row, cost);
        }
      }, state === 'ok' ? OK_MS : DENY_MS),
    );
  }

  private cancelFlashes(): void {
    for (const timer of this.flashTimers.values()) window.clearTimeout(timer);
    this.flashTimers.clear();
    for (const row of this.rows.values()) delete row.dataset.state;
  }

  private firstEnabledRow(): HTMLButtonElement | null {
    for (const row of this.rows.values()) {
      if (!row.disabled) return row;
    }
    return null;
  }

  private close(): void {
    if (!this.visible) return;
    this.hide();
    this.onClose?.();
  }
}
