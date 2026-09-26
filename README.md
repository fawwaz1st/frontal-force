# Frontal Force

Fast single-file-arena FPS in the browser — survive waves of grunts, rushers, gunners, and shield-bearing wardens in a neon sci-fi arena, across five game modes, with ten weapons, two autonomous escort bots, and a full touch scheme. Built with Three.js + TypeScript + Vite, zero external assets (all visuals procedural, all audio synthesized via WebAudio).

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
| 1–9 / wheel | Switch weapon (10 slots) |
| Esc / P | Pause |
| Headshots | 2× damage |
| Touch | Drag the right side to look (×0.45 while aiming), left 45 % is a floating stick, 7 on-screen buttons |

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

## AI

- **Threat table** — enemies are no longer player-fixated. The player and both escorts implement `CombatTarget` (`src/combat/Combatant.ts`); enemies score every visible candidate with a weighted utility function — proximity 0.30, role 0.20, aggression/grudge 0.20, fragility 0.15, aimPressure 0.15 — and commit to the best one.
- **Stickiness** — 0.25 s staggered re-score, 1.25× switch hysteresis, 1.5 s minimum commitment. Two perception radii (sight vs keep-sight) stop boundary flicker; alerted memory runs 6 s; a squad alert propagates on damage in O(n).
- **Projectile ownership** — a bolt carries the id of the friendly it was aimed at, so a stray round never hits a bystander.
- **Escorts are autonomous, not leashed** — anchor + leash + role slot: the owner position is quantized to a 3 m grid and used only as an idle anchor. Soft leash 18 m, hard leash 26 m. A squad role auction every 2 s gives the nearer bot the flank and the other overwatch, with opposite orbit signs; per-role engagement bands are flanker ≤12 m and overwatch 10–20 m. Self-preservation: retreat under 30 % HP, re-engage at 55 %, hard 8 s ceiling.

## Arsenal

Ten weapons (`WEAPON_ORDER` in `src/combat/weapons.ts`), each with a full stat block — damage, pellets, fire rate, mag, reserve, reload, spread (hip/moving), recoil, range, tracer, sound.

| Weapon | Role |
| --- | --- |
| Vanguard AR | Baseline auto rifle. |
| Hornet SMG | Fast, close, wide spread. |
| Breaker SG | 9-pellet burst, 40 m ceiling. |
| Lance Rail | 130-damage precision single shot. |
| Harrier DMR | Three-taps a warden while still one-shotting a grunt. |
| Bastion LMG | 100-round lane holder, 3.3× the AR's base spread. |
| Sidewinder | 105-round pool and the fastest reload — the never-caught-empty backup. |
| Siegebreaker | Real splash: 4 m linear falloff to a 35 % floor, plus a separate 3.2 m self-damage radius capped at 35 damage. |
| Helios Beam | 0.012 moving spread — the only weapon that does not degrade while strafing. |
| Trident Burst | 3 sequential rounds (~288 rpm); ten trigger pulls per 1.8 s reload. |

The HUD names the equipped weapon and shows a three-slot window (previous / current / next) plus an `n/10` index.

## Architecture

```
src/
  core/     loop.ts (fixed timestep + spiral guard), math.ts, storage.ts (settings/records), quality.ts (device tier + frame-time governor)
  input/    Input.ts (keyboard/mouse/pointer-lock + touch fallback) · TouchControls.ts (pointerId map, stick, buttons)
  player/   Player.ts (capsule movement, look, camera)
  combat/   weapons.ts (10 defs) · WeaponController.ts (firing/reload/switching/hitscan) · Combatant.ts (CombatTarget + threat scoring)
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
- **Pause** triggers on Esc/P, and on any pointer-lock loss (incl. tab switch); on touch there is no lock to acquire, so a run pauses when the page loses focus.
- **Loop** runs a fixed 60 Hz simulation with a catch-up guard (max 5 steps/frame).
- **Adaptive quality** — a boot heuristic (`userAgentData.mobile`/UA + `deviceMemory` + cores) picks low/medium/high; a frame-time governor on a 30 fps budget (40 ms high / 26 ms low / 33 ms reset) steps the pixel ratio down, and recovery is gated behind a 5 s sustained-fast window. Presets: low 0.75 ratio, no AA, no shadows / medium 1.0, no AA, 1024 shadows / high 1.5, AA, 2048 shadows — always capped by `devicePixelRatio`.
- **Mobile** — full touch scheme (`src/input/TouchControls.ts`): PointerEvent with a `pointerId` map, free-drag look on the right (0.25°/CSS-px, ×0.45 while aiming), a floating-origin stick on the left (0.18 dead zone, 62 px radius), and 7 on-screen buttons mirrored from the input layer's own hit-rects. Pointer lock is no longer a gate: if it has not landed within 320 ms the game switches to the touch scheme. Chrome Android 144 shipped Pointer Lock; iOS Safari still has none.
- **Responsive layout** — `viewport-fit=cover` + safe-area insets, `100dvh`, `touch-action: none`, breakpoints at 700/640/560/430 px plus `pointer: coarse`, and quality + touch-sensitivity settings.
