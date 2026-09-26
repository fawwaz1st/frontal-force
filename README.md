# Frontal Force

Fast single-file-arena FPS in the browser — survive waves of grunts, rushers, gunners, and shield-bearing wardens in a neon sci-fi arena, across five game modes. Built with Three.js + TypeScript + Vite, zero external assets (all visuals procedural, all audio synthesized via WebAudio).

## Run

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production build
npm run preview  # serve the production build
```

## Controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim, LMB fire |
| Space | Jump |
| Shift | Sprint |
| C / Ctrl | Crouch — while sprinting: slide |
| R | Reload |
| 1–4 / wheel | Switch weapon |
| Esc / P | Pause |
| Headshots | 2× damage |

## Modes

| Mode | Behavior |
| --- | --- |
| STANDARD | Classic wave pacing. |
| BLITZ | Shorter breaks, denser spawns; ×1.35 score. |
| ONSLAUGHT | Heavy waves from wave 2; ×1.75 score. |
| ROTATION | Weapon swaps on every kill; ×1.5 score. |
| OVERRUN | Endless horde: 24-alive cap, HP ×1.12^(wave−1) (cap ×40), speed cap ×1.30, spawn cadence ×0.94^(wave−1) (floor 0.25 s), ×1.5 score, no wave-clear plate, own best-wave record. Player damage scales on the same curve. |

## Enemies

- **Grunt** — baseline rifleman.
- **Rusher** — fast melee flanker.
- **Gunner** — slow long-range cannon.
- **Warden** — 180 HP mid-range shooter (22 m) behind a left-arm riot shield (teal `0x35f0c8`). Frontal shots inside a ±60° cone land at 50 % and charge a 6-block guard meter that breaks for 1.2 s; shots outside the cone deal ×1.5. The shield also drops during its 0.45 s attack wind-up — trading the telegraph is the intended counter-play.

## Architecture

```
src/
  core/     loop.ts (fixed timestep + spiral guard), math.ts, storage.ts (settings/records)
  input/    Input.ts (keyboard/mouse/pointer-lock)
  player/   Player.ts (capsule movement, look, camera)
  combat/   weapons.ts (defs) · WeaponController.ts (firing/reload/switching/hitscan)
  enemies/  Enemies.ts (AI, projectiles, corpses, radar feed)
  allies/   Ally.ts (escort bots)
  items/    Pickups.ts
  world/    World.ts (arena geometry, lights, collision octree)
  audio/    Audio.ts (procedural WebAudio SFX, heartbeat)
  ui/       Hud.ts (DOM HUD, radar canvas, menus)
  game/     Game.ts (thin orchestrator: phases, wiring, scoring) · Waves.ts · Tactics.ts (cover-claim allocator)
```

Data flows one way: `Input → Game → simulation modules → HudState → Hud (DOM)`.
Modules never reach into the HUD; the HUD never touches simulation state.

- **Settings & records** persist via `localStorage` (`src/core/storage.ts`); save schema `version: 1` hydrates additively — legacy saves keep working, unknown keys are dropped, every number is `finite()` + clamped.
- **Kill combo** — 3 s window per kill, multiplier `min(1 + floor(streak/2), 8)`; one tier decays per 0.5 s after the window lapses and player damage resets it. Shown as the amber `×N` chip in the HUD top row.
- **Lifetime records** — `totalKills`, `totalRuns`, `totalWavesCleared`, per-mode `killsPerMode`, plus a separate OVERRUN wave record, rendered as stencil leader-dot rows under the menu best line.
- **Landing impact** — touchdown above 6 m/s vertical speed adds a white shock ring + smoke puff.
- **Pause** triggers on Esc/P, and on any pointer-lock loss (incl. tab switch).
- **Loop** runs a fixed 60 Hz simulation with a catch-up guard (max 5 steps/frame).
