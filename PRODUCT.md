# Product

## Register

product

## Users

Desktop players running a fast browser FPS in short, intense sessions (5–20 minutes), keyboard + mouse, pointer lock engaged. They are under constant pressure: reading health, ammo, radar, and wave state while aiming and moving. Secondary audience: developers evaluating a zero-asset Three.js + TypeScript game architecture.

## Product Purpose

A single-arena wave-survival FPS that runs instantly in the browser with zero external assets — every visual is procedural geometry/textures, every sound is synthesized via WebAudio. Success looks like: tight game feel, an HUD that stays readable at speed, and a codebase small enough to reason about in one sitting.

## Brand Personality

Gritty, dark, military. The interface reads like a combat visor's readout: functional, terse, no warmth wasted on decoration.

## Anti-references

- Generic AI-generated UI: default palettes, decorative glassmorphism, gradient text, hero-metric cards, section eyebrows.
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
