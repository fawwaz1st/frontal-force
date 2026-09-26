# Product

## Register

product

## Users

Desktop players running a fast browser FPS in short, intense sessions (5–20 minutes), keyboard + mouse, pointer lock engaged. They are under constant pressure: reading health, ammo, radar, and wave state while aiming and moving. Secondary audience: developers evaluating a zero-asset Three.js + TypeScript game architecture.

## Product Purpose

A single-arena wave-survival FPS that runs instantly in the browser with zero external assets — every visual is procedural geometry/textures, every sound is synthesized via WebAudio. Success looks like: tight game feel, an HUD that stays readable at speed, and a codebase small enough to reason about in one sitting. Five modes re-tune pacing and scoring, a kill-combo multiplier rewards momentum, and a lifetime record ledger gives short sessions a long arc.

## Game Modes

- **STANDARD** — classic wave pacing.
- **BLITZ** — shorter breaks, denser spawns, ×1.35 score.
- **ONSLAUGHT** — heavy waves from wave 2, ×1.75 score.
- **ROTATION** — weapon swaps on every kill, ×1.5 score.
- **OVERRUN** — the endless mode: 24 alive at once, HP ×1.12^(wave−1) (capped ×40), speed capped ×1.30, spawn cadence ×0.94^(wave−1) (floor 0.25 s), ×1.5 score. No "cleared" plate; it keeps its own `bestWaveOverrun` record. Player and escort damage scale on the same HP curve, so a fixed ammo pool never walls the run out.

## Enemies

- **Grunt** — baseline rifleman.
- **Rusher** — fast melee flanker.
- **Gunner** — slow long-range cannon.
- **Warden** — teal (0x35f0c8) 180 HP mid-range shooter at 22 m, riot shield on the left arm. Frontal shots inside a ±60° cone land at 50 % and charge a 6-block guard meter that breaks for 1.2 s; shots outside the cone deal ×1.5. The shield drops during its 0.45 s attack wind-up — trading the telegraph is the intended counter-play.

## Brand Personality

Gritty, dark, military. The interface reads like a combat visor's readout: functional, terse, no warmth wasted on decoration.

## Anti-references

- Generic AI-generated UI: default palettes, decorative glassmorphism, gradient text, hero-metric cards, section eyebrows.
- The retired navy-neon "gamer HUD" (2026-09): blue-on-blue glowing glass chips, backdrop blur, rounded cards, cobalt-on-navy everything. Replaced by the stencil-crate system (amber signal / khaki / bone / chamfers).
- Playful/casual arcade aesthetics (bouncy easing, cartoon colors, cheerfully exclamation-marked copy).
- Over-decorated "gamer" chrome (angular everything, gratuitous scanlines and glow on every element).

## Design Principles

- **Diegetic** — the HUD should feel like it belongs to the operator's visor, not like a web page overlaid on a game.
- **Readability under fire** — when two elements compete, the one needed mid-combat wins. Hierarchy serves the 200 ms decision.
- **Feedback over flourish** — every animation communicates state (hit, damage direction, reload progress, low health). Nothing animates to look busy.
- **Zero-asset honesty** — procedural visuals and synthesized audio are the identity; consistency of that synthesized look beats imported polish.
- **Respect the operator** — keyboard-navigable menus, visible focus, reduced-motion support, and honest input requirements (say so when a touch device can't play).

## Accessibility & Inclusion

- WCAG AA contrast for all HUD and menu text (4.5:1 body, 3:1 large).
- `prefers-reduced-motion: reduce` honored: pulse/blink/flashing animations collapse to static states.
- Menus fully keyboard-operable with `:focus-visible` indicators; hidden overlays removed from tab order and the accessibility tree.
- Coarse-pointer (touch) devices get an upfront notice that mouse + keyboard are required, instead of a broken pointer-lock flow.
