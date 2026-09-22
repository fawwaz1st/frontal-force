# AGENTS.md — project learnings

## Tooling quirks (Codebuff)
- `write_file` with long content can silently corrupt output (dropped tokens mid-file, e.g. `PROJECTILE_POOL` → `PROJECTILE pool`, `this.rafId` → `thisrafId`, duplicated CSS selectors). Always re-read a freshly written file before typechecking; prefer `str_replace` for surgical edits.
- Playtest automation: the preview tab's rAF fully suspends when the panel is not visible — HUD state freezes and `preview_evaluate` returns stale values. Validate "frozen game" observations only while the panel actually renders.
- Pointer lock is denied in automation and Esc is swallowed by the browser: drive pause with `KeyP` (alias wired in Input.ts), dispatch synthetic `KeyboardEvent`/`MouseEvent` on `document`, and spoof `document.pointerLockElement` via `Object.defineProperty` to exercise firing paths.
- A SYNC terminal dev server dies when the user interrupts the turn. Start long-lived servers with `nohup ... & sleep` and verify with `curl http://127.0.0.1:5199/` (plain `localhost` was intermittently unreachable from the browser; `127.0.0.1` works).

## Build / config
- `npm run check` = `tsc --noEmit`; `npm run build` = check + vite build. tsconfig is strict-plus: `noUncheckedIndexedAccess` (indexing returns `T | undefined`), `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (type-only imports must use `import type`).
- Vite serves on 0.0.0.0:5199 during sessions; legacy `dist/` was committed in the baseline but is now gitignored.

## Architecture decisions
- Data flow is one-way: `Input → Game (orchestrator) → sim modules → HudState → Hud (DOM)`. Sim modules never touch the HUD; the HUD never mutates sim state. Weapon ownership (ammo/reload/switch/hitscan) lives in `combat/WeaponController`, not Game.
- HUD full-screen overlays (`[data-menu]`, `[data-pause]`, `[data-death]`) are `inset:0; pointer-events:auto` — they MUST be created with the `hidden` class or the last one in the DOM swallows every click on the page (this bit us once).
- Pause triggers on pointer-lock loss as well as Esc/P; pointer lock can also drop on tab switch. `resume()` re-pauses after 300 ms if the lock does not return (browsers rate-limit re-lock after Esc).
- Enemy kills leave fading corpses (~3.5 s, scale-y collapse) before disposal — `aliveCount` only counts non-dead; radar uses `forEachLive`.
- Radar/damage-arc rotation: player-local forward = `-(dx·sin yaw + dz·cos yaw)`, right = `dx·cos yaw − dz·sin yaw`. Damage-arc angle = `atan2(dx, −dz) + yaw` (arc wedge points screen-up at angle 0). Verify sign conventions with the yaw=0 basis vectors before "fixing" mirrored blips.
- Enemy hits carry the attacker position through `EnemyManager.onPlayerHit(damage, from)` so the HUD can show directional damage arcs; `player.onDamaged(from)` forwards it.

## Game tuning / behavior
- Fixed-timestep loop (60 Hz) has a catch-up guard: max 5 sim steps per frame, backlog dropped beyond that — long stalls degrade to slow motion instead of freeze-spiral.
- Headshots (hit point in top ~22% of enemy capsule) deal 2× damage; wave-clear bonus is wave×250; best score/wave persist in `localStorage` key `frontal-force.v1`.
