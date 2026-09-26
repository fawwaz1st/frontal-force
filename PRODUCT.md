# Product

## Register

product

## Users

Players running a fast browser FPS in short, intense sessions (5–20 minutes) — desktop keyboard + mouse first, with full touch support on phones and tablets. They are under constant pressure: reading health, ammo, radar, and wave state while aiming and moving. Secondary audience: developers evaluating a zero-asset Three.js + TypeScript game architecture.

## Product Purpose

A single-arena wave-survival FPS that runs instantly in the browser with zero external assets — every visual is procedural geometry/textures, every sound is synthesized via WebAudio. Success looks like: tight game feel, an HUD that stays readable at speed, and a codebase small enough to reason about in one sitting. Five modes re-tune pacing and scoring, a kill-combo multiplier rewards momentum, and a lifetime record ledger gives short sessions a long arc. Ten weapons span close-range auto through explosive splash, two escort bots fight autonomously beside the player, and adaptive quality keeps the frame budget on weaker hardware.

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
- **Threat table** — enemies are not player-fixated. Every friendly (player + both escorts) registers a `CombatTarget`; enemies score them all with a weighted utility function (proximity 0.30, role 0.20, aggression/grudge 0.20, fragility 0.15, aimPressure 0.15), then commit: 0.25 s staggered re-score, 1.25× switch hysteresis, 1.5 s minimum commitment. Bolts carry the intended victim's id — a stray round never clips a bystander — while a bolt whose path crosses an escort's body is intercepted and eats the damage.

## Arsenal

Ten weapons, each with a full stat block (`src/combat/weapons.ts`). The lineup spans auto rifles and SMGs through DMR/LMG/burst precision to the Siegebreaker launcher, whose 4 m splash falls off linearly to a 35 % floor and whose 3.2 m self-damage radius is hard-capped at 35 damage. The Trident Burst fires 3 sequential rounds (~288 rpm). The HUD shows a previous/current/next window, the weapon's name, and an `n/10` index instead of an icon wall.

## Squad

Two escort bots deploy with the player and fight autonomously — anchor + leash + role slot. The player's position is quantized to a 3 m grid and used only as an idle anchor; the leash is soft at 18 m, hard at 26 m. A role auction every 2 s sends the nearer bot to flank (≤12 m) and the other to overwatch (10–20 m), with opposite orbit signs. Bots retreat below 30 % HP, re-engage at 55 %, and never stay retreated longer than 8 s.

## Platforms & Performance

One build serves desktop and mobile. Touch is a first-class scheme: free-drag look, floating stick, 7 on-screen buttons; pointer lock is optional (iOS Safari has none, Chrome Android 144 shipped it), and the game falls through to touch if the lock has not landed within 320 ms. Adaptive quality picks low/medium/high at boot and a frame-time governor holds a 30 fps budget, always capped by `devicePixelRatio`. The layout honors safe-area insets and `100dvh` with breakpoints at 700/640/560/430 px plus `pointer: coarse`; quality and touch sensitivity are player settings.

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
- **Respect the operator** — keyboard-navigable menus, visible focus, reduced-motion support, and honest input requirements (pointer lock is treated as optional, never as a gate).

## Accessibility & Inclusion

- WCAG AA contrast for all HUD and menu text (4.5:1 body, 3:1 large).
- `prefers-reduced-motion: reduce` honored: pulse/blink/flashing animations collapse to static states.
- Menus fully keyboard-operable with `:focus-visible` indicators; hidden overlays removed from tab order and the accessibility tree.
- Coarse-pointer (touch) devices get a first-class control scheme (floating stick, free-drag look, on-screen buttons), not a notice; pointer lock is never required.
