# Frontal Force

Fast single-file-arena FPS in the browser — survive endless waves of grunts, rushers, and gunners in a neon sci-fi arena. Built with Three.js + TypeScript + Vite, zero external assets (all visuals procedural, all audio synthesized via WebAudio).

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

## Architecture

```
src/
  core/     loop.ts (fixed timestep + spiral guard), math.ts, storage.ts (settings/records)
  input/    Input.ts (keyboard/mouse/pointer-lock)
  player/   Player.ts (capsule movement, look, camera)
  combat/   weapons.ts (defs) · WeaponController.ts (firing/reload/switching/hitscan)
  enemies/  Enemies.ts (AI, projectiles, corpses, radar feed)
  items/    Pickups.ts
  world/    World.ts (arena geometry, lights, collision octree)
  audio/    Audio.ts (procedural WebAudio SFX, heartbeat)
  ui/       Hud.ts (DOM HUD, radar canvas, menus)
  game/     Game.ts (thin orchestrator: phases, wiring, scoring) · Waves.ts
```

Data flows one way: `Input → Game → simulation modules → HudState → Hud (DOM)`.
Modules never reach into the HUD; the HUD never touches simulation state.

- **Settings & records** persist via `localStorage` (`src/core/storage.ts`).
- **Pause** triggers on Esc/P, and on any pointer-lock loss (incl. tab switch).
- **Loop** runs a fixed 60 Hz simulation with a catch-up guard (max 5 steps/frame).
