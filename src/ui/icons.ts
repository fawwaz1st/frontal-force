/**
 * Single stroke-icon family for the whole HUD (24×24 grid, stroke-width 2,
 * round caps — one family only; never mix with filled glyphs).
 * All icons inherit `currentColor` so state changes are pure CSS.
 */
export type IconName =
  | 'score' | 'skull' | 'flag' | 'trophy' | 'shield' | 'bullet'
  | 'reload' | 'clock' | 'check' | 'play' | 'exit' | 'grid'
  | 'target' | 'speaker' | 'mouse' | 'move' | 'jump' | 'sprint'
  | 'crouch' | 'swap' | 'pause' | 'crate' | 'crosshair' | 'infinity' | 'bot'
  | 'rifle' | 'smg' | 'shotgun' | 'railgun';

const ICON_PATHS: Record<IconName, string> = {
  // Score: concentric target
  score: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  skull:
    '<path d="M12 2.5c-5 0-9 3.9-9 8.8 0 2.9 1.4 5.4 3.6 6.9V20a2 2 0 0 0 2 2h6.8a2 2 0 0 0 2-2v-1.8c2.2-1.5 3.6-4 3.6-6.9 0-4.9-4-8.8-9-8.8Z"/><circle cx="9" cy="11.5" r="1.8"/><circle cx="15" cy="11.5" r="1.8"/><path d="M9.5 22v-2.6M12 22v-2.6M14.5 22v-2.6"/>',
  // Wave: triangular pennant — diagonal edge distinguishes it from a "P" glyph
  flag: '<path d="M5.5 21V3.5"/><path d="M6.5 4.5 18 8l-11.5 3.5Z"/>',
  trophy:
    '<path d="M7 4h10v6a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/><path d="M12 15v3M9 21h6M10 18h4l1 3H9l1-3Z"/>',
  // Health: shield with cross
  shield:
    '<path d="M12 2.5 4.5 5.3v5.9c0 4.6 3.2 8.4 7.5 10.3 4.3-1.9 7.5-5.7 7.5-10.3V5.3L12 2.5Z"/><path d="M12 8.5v6M9 11.5h6"/>',
  // Ammo: cartridge
  bullet:
    '<path d="M12 2.5c2.1 2 3.2 4.5 3.2 7v3.7H8.8V9.5c0-2.5 1.1-5 3.2-7Z"/><path d="M8.8 13.2h6.4V19a2 2 0 0 1-2 2h-2.4a2 2 0 0 1-2-2v-5.8Z"/>',
  reload:
    '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
  check: '<path d="M4.5 12.5 10 18 19.5 6.5"/>',
  play: '<path d="M7.5 4.8v14.4L19.5 12 7.5 4.8Z"/>',
  exit:
    '<path d="M13.5 3H19a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5.5"/><path d="m9 8-4 4 4 4M5 12h10"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  target:
    '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>',
  speaker:
    '<path d="M11 5 6.5 9H3.5v6h3L11 19V5Z"/><path d="M14.8 9.2a4 4 0 0 1 0 5.6M17.5 6.5a8 8 0 0 1 0 11"/>',
  mouse:
    '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 3v5.5"/><circle cx="10.6" cy="6.6" r="1.1" fill="currentColor" stroke="none"/>',
  move: '<path d="M12 3.5v17M3.5 12h17"/><path d="m9 6.5 3-3 3 3M9 17.5l3 3 3-3M6.5 9l-3 3 3 3M17.5 9l3 3-3 3"/>',
  jump: '<path d="M12 19V5.5"/><path d="m6.5 11 5.5-5.5L17.5 11"/><path d="M5 21.5h14"/>',
  sprint:
    '<path d="m3.5 7 5.5 5-5.5 5M11.5 7l5.5 5-5.5 5M18.5 7l2.5 5-2.5 5"/>',
  crouch:
    '<path d="M12 4.5v9.5"/><path d="m8 10.5 4 4 4-4"/><path d="M5 20.5h14"/>',
  swap: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
  pause: '<path d="M8.5 4.5v15M15.5 4.5v15"/>',
  crate:
    '<rect x="3.5" y="6.5" width="17" height="13" rx="1"/><path d="M3.5 11h17M3.5 15h17M12 6.5v13"/><path d="M3.5 6.5 6 3.5h12l2.5 3"/>',
  crosshair:
    '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  // Endless mode: joined loops
  infinity: '<circle cx="8.6" cy="12" r="3.4"/><circle cx="15.4" cy="12" r="3.4"/>',
  // Humanoid escort bot
  bot:
    '<rect x="9" y="3" width="6" height="5" rx="1.5"/><path d="M10.6 5.5h.01M13.4 5.5h.01"/><rect x="7" y="9.5" width="10" height="7" rx="2"/><path d="M12 16.5v2.5M9.5 21.5l2.5-2.5 2.5 2.5M4.5 11.5v3M19.5 11.5v3"/>',
  // Weapon silhouettes (side profile, muzzle points right)
  rifle:
    '<path d="M2.5 9.5h9.5v4H7.5l-.8 3h-2.6l.6-3H2.5v-4Z"/><path d="M12 10.7h4.5M16.5 10.7h5"/><path d="M7.6 13.5v4.5M6 18.5h3.6"/>',
  smg:
    '<path d="M4 8.5h8.5v4H8l-.7 2.5H5.2l.6-2.5H4v-4Z"/><path d="M12.5 9.7h3.5M16.5 9.7h4.5"/><path d="M8.6 12.5v6M7 18.8h3.5"/><path d="M4.6 8.5 4 6.2h3l.6 2.3"/>',
  shotgun:
    '<path d="M2.5 9.5h10v3.5H6l-.7 3H2.9l.6-3H2.5v-3.5Z"/><path d="M12.5 10.2h9M12.5 12.3h9"/><path d="M13.5 13.5h3.5v2h-3.5z"/>',
  railgun:
    '<path d="M2.5 10h8v3.5H6l-.6 3H3l.5-3H2.5V10Z"/><path d="M10.5 11h11"/><path d="M12.5 11V8.2h4.5V11"/><circle cx="14.8" cy="7.4" r="0.4"/>',
};

/** Inline SVG markup helper. Size/color come from CSS classes. */
export function icon(name: IconName, cls = ''): string {
  return (
    `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`
  );
}
