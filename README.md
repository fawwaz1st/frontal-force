# Frontal Force

A fast browser FPS. You hold a neon arena against endless waves of grunts, snipers, flyers, exploders, healers, summoners, shield wardens, and a three-phase boss. Between waves you draft upgrades, buy gear with salvage, and the arena itself mutates around you.

Built with Three.js, TypeScript, and Vite. Every visual is procedural and every sound is synthesized with WebAudio, so the whole game is source code and no external assets.

**Play it:** https://fawwaz1st.github.io/frontal-force/

![Combat on Frost Line](docs/screenshots/map-frost.png)

---

## Four arenas, chosen by your seed

The map is part of the seed code, so a shared seed reproduces both the layout and the place. Each theme changes the palette, sky, fog, light colour, and cover density. Consecutive seeds are spread by an avalanche hash, so the rotation never looks like "next".

| Dawn Range | Night Yard | Rust Works | Frost Line |
| --- | --- | --- | --- |
| ![Dawn Range](docs/screenshots/map-dawn.png) | ![Night Yard](docs/screenshots/map-night.png) | ![Rust Works](docs/screenshots/map-rust.png) | ![Frost Line](docs/screenshots/map-frost.png) |
| Cold light, long shadows, normal cover. | Dark and tight, lit by work lamps. Denser cover. | Hot haze over dead machinery. Densest cover. | White ground, blue air, sparse cover and long sight lines. |

## Scope, charge, and ricochet

Every weapon has a real aimed FOV, and two carry a magnified optic with a scope overlay. The rail also charges for a bigger hit and ricochets twice off cover.

![Scoped on the Lance Rail](docs/screenshots/scope.png)

## A three-slot loadout, chosen once

Ten weapons exist; you carry three. The loadout screen is where the arsenal lives, so mid-fight you are deciding when to swap, not scrolling a list. Three is the largest number that stays a decision: you can cover a close, a mid and a long role and still remember which key holds which, and every pick costs you something.

![The loadout screen](docs/screenshots/loadout.png)

## Drops

Every enemy the player kills rolls for loot, and what it leaves behind is worth walking over to:

| Drop | Effect | Odds per kill |
| --- | --- | --- |
| **Salvage** | +12 currency toward the kiosk | 22% |
| **Ammo** | Refills the reserve of every equipped weapon | 14% |
| **Health** | +35 HP | 9% |

Elites add 35 percentage points to the salvage and ammo rolls and half that to health, and the boss always drops salvage and health — a fight that long must never end dry. The rolls are **independent**, not a schedule, and they use the run's seeded RNG, so a seed replays its loot exactly. Only player kills drop: an ally cannot farm the arena on your behalf.

A drop scatters where the body fell, blinks out over its last three seconds, and expires after 22 s. That is what separates it from the arena's fixed **stations**, which are destinations that never expire and respawn 14 s after being taken. A drop is a reward that pulls you forward; a station is a place you decide to go.

A drop you cannot use right now stays on the ground. Walking over a health drop at full HP does not consume it, because destroying a reward that grants nothing is a punishment for winning the fight that produced it, and it is invisible. Loot also shows on the radar as a **diamond** (the dots are threats), so you can see what is worth detouring for.

## The arena

The play space is 74 x 74 m, sized to the engagement ranges: every enemy engages inside 44 m and the longest useful sight line is about 40 m, so the old 94 m box was mostly dead ground that only ever produced long walks.

Four fixed structures, and every one of them does a job:

| Structure | What it does |
| --- | --- |
| **Central bunker** | A hard two-sided anchor at the far end. Both faces register cover, so it is a landmark rather than a one-way trap. |
| **Watchtowers** (2, mirrored) | Tall enough to break a long sight line, thin enough to fight around. Each carries a work lamp. |
| **Sandbag nests** (4, on the diagonals) | Low enough to shoot over crouched and worth crouching behind. This is what makes the crouch key matter outside the slide. |
| **Overhead tarps** (2) | The only cover that works from above as well as the side. |

Everything removed was scenery that changed no fight: six berms, four target frames, seven painted stripes, and three lamp poles standing in empty space. The rule is **if a thing cannot be used, it is not built**, and every structure registers its own cover spots so the AI can claim it. Those spots live in a separate list, because the run's generated layout clears its own spots on every rebuild.

Cover density varies by theme: RUST WORKS is crowded, FROST LINE is sparse with long sight lines.

## Game feel

- **Hitstop.** A kill freezes the simulation for 60-160 ms (bigger kill, longer freeze), and a headshot for 35 ms. It is a time scale on the sim only, at 0.12 rather than 0, so the renderer keeps running and nothing deadlocks: the freeze reads as a punch, not a stutter.
- **Flinch.** A hit rocks the body away from the shooter and springs back, scaled by the fraction of the target's max health the hit took. The white flash says "I hit it"; the flinch says "it felt that".
- **Death in three beats.** Impact (squash), topple (ease-out fall with a little spin), settle (lies still while the glow drains). The squash is applied to the body, not the group, or it would scale the topple rotation with it.

## Run locally

```bash
npm install
npm run dev         # dev server on http://localhost:5173/
npm run build       # typecheck + production build (GitHub Pages base path)
npm run preview     # serve the production build at /frontal-force/
npm run check       # typecheck only
npm run check:self  # 157 logic regression tests, no browser needed
```

`npm run preview` serves the same URLs GitHub Pages serves, so a base-path mistake fails locally instead of in production.

## Deploy

Pushing to `main` deploys automatically through `.github/workflows/deploy.yml`:

1. `npm ci`
2. `npm run build` (a type error fails the deploy)
3. `npm run check:self`
4. `actions/configure-pages` with `enablement: true`, so the first deploy turns Pages on by itself
5. upload `dist/` and deploy to the `github-pages` environment

The base path is read from `GITHUB_REPOSITORY`, so renaming the repository does not require editing the config.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim |
| LMB | Fire |
| RMB | Aim down sights (scopes the magnified optics) |
| Space | Jump |
| Shift | Sprint |
| C / Ctrl | Crouch. Press while sprinting to **slide** |
| R | Reload |
| 1-3 / wheel | Switch weapon (your three slots) |
| Shift+W / double-tap W | Dash (2 charges, 0.12 s invulnerability) |
| G (hold to cook, release to throw) | Grenade: frag, smoke, or EMP |
| F | Cycle grenade kind |
| V | Melee: 42 damage, executes below 15 % health for an 18 HP heal |
| Esc / P | Pause |

**Touch:** the left 45 % of the screen is a floating stick, dragging the right side looks around (slowed to 45 % while aiming), and on-screen buttons cover fire, jump, reload, crouch, dash, grenade, and melee. The layout respects safe-area insets on notched phones and the HUD switches to a touch layout on first contact.

## Reading the screen

![HUD](docs/screenshots/combat.png)

- **World markers.** Every enemy and ally carries a marker: a dot filled to its health, coloured by enemy kind (the same hues the radar uses), with a glyph for the ones that change how you fight (`X` sniper, `+` healer, `S` summoner, `!` exploder, `E` elite, `B` boss, `A` ally). Off-screen markers clamp to the edge and hollow out.
- **Named damage.** Every source that can hurt you names itself: the arc shows *where* the hit came from, the label under the crosshair shows *what* did it (`▲ EXPLODER`, `▲ TESLA COIL`, `▲ BARREL BLAST`, `▲ AFFIX BURN`, `▲ YOUR OWN BLAST`, or the shooter's kind for a bolt).
- **Radar** for the wider picture, at 20 Hz so it costs a third of a 60 Hz redraw.

## Sound

Everything is synthesized with WebAudio, and the kit is built from five primitives layered into every sound: a transient click, a filtered noise body, a pitched thump, a tonal tail, and a room send. A gunshot that is only one of those reads as a blip; a gunshot built from all five reads as a gun.

- **A real room.** A procedurally generated impulse response (decaying noise with an early-reflection cluster) runs on a convolver, and every voice decides how much of itself to send there. The room send is what makes firing feel like it happens in the arena rather than in a vacuum.
- **Distance.** A shot 40 m away is quieter AND loses its room tail, because the tail is the distance cue: a far shot that keeps its reverb sounds close but quiet, which is worse than either. A shared low-pass on the master stands in for air absorption.
- **A listener frame.** Pan is resolved against the player's position and yaw, so a sound stays on the same side of your head as you turn. Every call site that used to compute its own pan got it wrong the same way (it panned along the world X axis, which is only your right if you happen to be facing -Z).
- **Near misses.** A bolt that passes within 1.4-3.4 m of you whizzes past, panned to its side. This is how you learn you are being shot at from a direction you are not facing.
- **Material impacts.** A round striking the world ticks off concrete, rings off metal, thuds into fabric, or splinters glass.
- **A room tone.** A quiet filtered noise bed plus a detuned sub, faded in with the run. Without it, silence between waves reads as "the game stopped".
- **A saturated master.** A soft-clip WaveShaper sits between the bus and the compressor, so 24 enemies firing at once compress into each other instead of clipping into a mess.
- **No clicks.** Every voice has a 2-8 ms attack. A waveform that jumps to full amplitude instantly produces a broadband transient, which the ear hears as a tick rather than as a hit.
- **No frozen samples.** Every noise voice reads from a random offset in the buffer, or repeated shots phase-lock and sound like one sample played forever.

## The run loop

1. **Fight a wave.** Enemies spawn from points that respect line of sight to your position.
2. **Clear it.** A clean, fast clear pays a medal (GOLD / SILVER / BRONZE) and bonus score.
3. **Draft a card.** Three offers from 40 upgrades, with rarity weights that shift toward rare and legendary as the run goes on. Rerolls cost salvage.
4. **Spend salvage.** Every third wave the kiosk opens first: field repair, a full armory refill, an extra draft reroll, reactive plating, and sell-back for any upgrade you regret (40% of its value, paid back as salvage).
5. **Repeat**, with the arena mutating every few waves.

Death shows the full run summary: accuracy, headshots, damage dealt and taken, longest combo, elites and bosses killed, salvage earned, no-hit waves, the seed, and the mutations you saw. The seed is copyable and re-deployable, so a run can be raced or shared.

## Modes

| Mode | Behavior |
| --- | --- |
| STANDARD | Classic wave pacing, 6 s breaks. |
| BLITZ | 3.5 s breaks, denser spawns, x1.35 score. |
| ONSLAUGHT | Heavy waves from wave 2, x1.75 score. |
| ROTATION | Weapon swaps on every kill, x1.5 score. |
| OVERRUN | Endless: 24-alive cap, HP x1.12^(wave-1) capped at x40, speed capped x1.30, spawn cadence x0.94^(wave-1) with a 0.25 s floor. Player damage scales on the same curve so the mode cannot wall out. Own best-wave record. |

**Daily run:** a date-derived seed, so every player on the same UTC day gets the same arena, spawn order, and card offers.

## Challenge wagers

Optional difficulty modifiers picked in the menu before deploying. Each one is a bet: the run gets harder in a specific, readable way and pays a score multiplier. Payouts compound, so stacking three is a real gamble (Horde x1.45 plus Glass Cannon x1.30 is x1.885, not x1.75).

| Wager | Effect | Payout |
| --- | --- | --- |
| Glass Cannon | You take double damage. | +30% score |
| Ironclad | Enemies have 40% more health. | +30% score |
| Famine | You start with half the reserve ammo. | +20% score |
| Relentless | Enemies move 20% faster. | +25% score |
| Scatter | Your weapon cone is 60% wider. | +25% score |
| Horde | Waves spawn 50% more enemies and elites gain an extra affix. | +45% score |

The selection persists between sessions, shows a live payout readout in the menu, and stays visible mid-run as a HUD chip so you can always see what you signed up for.

## Enemies

| Enemy | Behavior |
| --- | --- |
| Grunt | Baseline rifleman. Matte scavenged plates. |
| Rusher | Fast melee flanker that commits to a charge, and slides the last few metres. Bare frame, almost no plate. |
| Gunner | Slow, long-range cannon with heavy bolts. Wide, thick industrial plating. |
| Warden | 180 HP mid-range shooter behind a riot shield. Frontal shots inside a +/-60 deg cone land at 50 % and charge a 6-block guard meter that breaks for 1.2 s; flank shots deal x1.5. The shield also drops during its 0.45 s wind-up, so trading the telegraph is the counter-play. Polished ceramic plate. |
| Sniper | Long-range one-shot threat: a laser telegraph, then a fast hard-hitting bolt. Narrow, small-headed, almost matte black. |
| Flyer | Drone that ignores cover and orbits at head height. Thin glossy composites. |
| Exploder | Charges and detonates; killing it early is the counter-play. The glowing charge tank is the threat, readable from the silhouette. |
| Healer | Fragile support healing 3 %/s to every enemy within 9 m, which changes target priority. The only bright white body on the field. |
| Summoner | Spawns a grunt every 6 s and ignores the player to keep the pipeline running. Deep violet lacquer, tall and thin. |
| Warden Prime | Boss on every fifth wave. 2200 HP, three phases, a glowing rear core that takes x2.5 damage. Enough rear-core damage (18% of max health, post-multiplier) destroys the core permanently, so flanking it is a real objective rather than a temporary bonus. Gold-plated and self-lit. |

Every kind carries its own **armour look**: plate tint, roughness, metalness, body glow, and plate glow (`ARMOR_LOOK`), plus its own **proportions** (`PROPORTION`: shoulder width, pad size, head scale). Ten archetypes sharing one gunmetal frame with a coloured strip was why the roster read as the same model ten times.

### Affixes

From wave 4, elites spawn with 1 to 3 affixes rolled from 14: Blazing, Overloading, Glacial, Mending, Juggernaut, Hasted, Gilded, Splitting, Vampiric, Volatile, Regenerating, Armored, Shrouded, Charged. Each one changes how a fight has to be fought: Splitting copies split on death, Volatile explodes, Glacial slows, Blazing burns, and Armored trades flat reduction for a slower, tankier target.

## AI

- **Threat table.** The player and both escorts implement `CombatTarget` (`src/combat/Combatant.ts`). Enemies score every visible candidate with a weighted utility function (proximity 0.30, role 0.20, aggression/grudge 0.20, fragility 0.15, aimPressure 0.15) and commit to the best one.
- **Squad tactics.** Three cheap mechanisms turn a roster of individuals into a squad. **Fire teams** of three share ONE victim, so a group concentrates instead of spreading; focus fire is a 1.6x score bonus rather than a hard override, because forcing the team target made squads walk past targets in front of them. **Bounding overwatch** advances one member at a time: the others hold a firing position, and holding gives up only the approach (a holding agent still shoots, strafes and dodges). **Suppression** keeps an agent firing on a shorter cadence once it has held a position, so breaking line of sight is a contested move rather than an off switch. Melee and support archetypes are excluded from holding: a rusher that stops to cover is just a slow rusher.
- **Agility.** Three short committed bursts punctuate the walk cycle instead of replacing it: a **dodge** (0.32 s, x2.35 speed) fired reactively the moment an agent takes fire, aimed to whichever side of the shot line it already occupies so it never runs into the stream; a **juke** (0.26 s, x2.1) that breaks a straight approach on a staggered 1.4-3.6 s cadence; and a **slide** (0.55 s, x2.9) used only by rushers and exploders, only inside a 9 m commit window.
- **Obstacle handling.** An agent whose step produces almost no displacement commits to a lateral detour for 0.6 s, so it walks around a crate instead of grinding against it. The side is picked once, because alternating every frame vibrates in place instead of committing.
- **Stickiness.** 0.25 s staggered re-score, 1.25x switch hysteresis, 1.5 s minimum commitment, two perception radii to stop boundary flicker, 6 s alerted memory, and a squad alert that propagates on damage in O(n).
- **Projectile ownership.** A bolt carries the id of the friendly it was aimed at, so a stray round never hits a bystander.
- **Escorts are INDEPENDENT.** There is no leash. Each bot owns a half of the arena, split on whichever axis the enemy cloud is more spread along, and its objective is the enemy cluster inside its own sector. An empty sector falls back to reinforcing the other one, then to a patrol of its own centroid. A respawn walks in from its own sector edge, never from the player. The bot's `update` signature still accepts the player position and explicitly discards it (`void ownerPos`), so any future edit that reaches for the player has to change the signature to do it.
- **Obstacle handling (escorts).** `moveToward` probes the direct line and two 55-degree detours, so a bot that meets a crate walks around it. The old version stopped dead on any hit within 1.4 m, which is what "the bot is stuck on a box" looked like from the player's side.

## Arena hazards

Explosive barrels (7 per arena, 60 HP, 4.5 m blast for 120 damage), tesla coils, and flame vents. Barrels can be shot to clear a crowd, and barrel kills count toward the run summary and a dedicated achievement.

## Grenades

Three kinds, cycled with `F` and thrown with `G` (hold to cook, release to commit).

| Grenade | Effect |
| --- | --- |
| Frag | 130 damage at the centre, linear falloff to a 30% floor over 4.6 m. |
| Smoke | A live cloud that blocks enemy line of sight, so it breaks pursuit and firing lanes. |
| EMP | 25 damage and disables warden plates and the boss shield for the duration. |

Enemies also carry affix riders that fire when they hit you: Blazing sets you burning for 4 damage per second, Glacial slows your movement, and Charged arcs a visible burst.

## Arsenal

Ten weapons (`src/combat/weapons.ts`), three equipped at a time. Each one has a full stat block plus an aimed FOV, a scope flag, a movement weight, and a role line that the loadout screen shows.

| Weapon | Role |
| --- | --- |
| Vanguard AR | Baseline auto rifle. |
| Hornet SMG | Fast, close, wide spread, and the lightest feet (+8% move). |
| Breaker SG | 9-pellet burst, 40 m ceiling. |
| Lance Rail | 130-damage precision single shot. **Scoped** (18 deg), **charges** 0.6 s for x1.35, **ricochets twice** off cover. |
| Harrier DMR | Three-taps a warden while still one-shotting a grunt. **Scoped** (26 deg). |
| Bastion LMG | 100-round lane holder, 3.3x the AR's base spread, heaviest gun (-18% move). |
| Sidewinder | 105-round pool, fastest reload, lightest of all (+12% move). |
| Siegebreaker | 4 m splash with linear falloff to a 35 % floor, plus a separate 3.2 m self-damage radius capped at 35. **Charges** 0.4 s for x1.2. |
| Helios Beam | 0.012 moving spread: the only weapon that does not degrade while strafing. |
| Trident Burst | Three sequential rounds (~288 rpm); ten trigger pulls per 1.8 s reload. |

The HUD shows all three equipped slots at once, plus the `n/3` index, and a charge ring for the weapons that charge.

### Loadout rules

- Three slots (`LOADOUT_SLOTS`), persisted in the save.
- Choosing a weapon already in another slot **swaps** the two positions rather than duplicating it.
- `sanitizeLoadout` drops unknown and duplicate ids and pads from the default kit, so a save from an older build can never leave you unarmed.
- Movement weight applies to every ground speed including the slide, so the loadout has a real cost and the choice cannot collapse to "most damage".

## Precision model

Accuracy is treated as a system, not a stat:

- **The first shot of a burst is perfectly accurate** while stationary and grounded. Sustained fire blooms the cone; the bloom resets with the group and on reload.
- **Movement penalty scales with actual velocity**, so counter-strafing works the way players expect.
- **The ray leaves the eye, not the muzzle.** The crosshair is the aim point at every range; the muzzle is used only for tracers, muzzle flash, and brass.
- **The crosshair gap is derived from the projection**, so the reticle shows the real cone instead of a fixed size.
- **The aim is sampled before this shot's recoil is applied.** Recoil rotates the same pitch/yaw the shot reads, so applying it first would deflect the round by its own kick. A regression test locks this ordering in.
- **Hitboxes are a capsule plus a head sphere** at 88 % body height with a 1.15x radius, so a headshot is a real geometry test rather than a Y-threshold.
- **Damage reported is post-mitigation.** A shield that eats half a round, flat armor, or an overkill execute cannot inflate damage-dealt or lifesteal.

## Progression

- **40 upgrade cards** across three rarities (common, rare, legendary) with stacking caps, including on-kill, on-crit, lifesteal, blast, ricochet, and movement modifiers.
- **35 achievements** with lifetime counters persisted across sessions: headshot counts, accuracy bests, kill streaks, no-hit waves, barrel kills, melee kills, dash kills, daily runs, and style ranks.
- **Style rank D to SSS**, ULTRAKILL-style: kill rate and headshot accuracy raise it, taking damage demotes it.
- **Kill combo** with an x8 cap, refreshed per kill and decaying after a 3 s window.

## Architecture

```
src/
  core/     loop.ts (fixed timestep + spiral guard) · math.ts · storage.ts (save schema v1) · quality.ts (tier detect + frame governor) · rng.ts (seeded, deterministic)
  input/    Input.ts (keyboard/mouse/pointer-lock + touch fallback) · TouchControls.ts (pointerId map, stick, buttons)
  player/   Player.ts (capsule movement, look, recoil, crouch/slide, dash, shield)
  combat/   weapons.ts (10 defs + 3-slot loadout rules) · WeaponController.ts (fire/reload/switch/charge/ricochet/hitscan/spread) · Combatant.ts (CombatTarget + threat scoring) · Grenades.ts (frag/smoke/EMP)
  ai/       Enemies.ts (AI, fire teams, agility, affix hooks, projectiles, boss phases, radar feed) · Affixes.ts (14 elite modifiers) · Ally.ts (independent escorts) · Tactics.ts (cover claims)
  game/     Game.ts (orchestrator) · Run.ts (seeded run state + stats) · Waves.ts (modes, mutations, boss cadence) · Challenges.ts (6 difficulty wagers) · Upgrades.ts (40 cards) · Achievements.ts · AchievementCounters.ts
  ui/       Hud.ts (HUD, menu, death card, ledger) · Draft.ts (card picker) · Kiosk.ts (salvage shop) · icons.ts (inline SVG set)
  world/    World.ts (arena, octree, cover) · Maps.ts (4 arena themes) · Hazards.ts (barrels/tesla/vents) · Pickups.ts
  render/   Effects.ts (pooled particles, tracers, decals) · Viewmodel.ts (first-person weapon)
  audio/    Audio.ts (synthesized WebAudio: weapons, impacts, music)
```

Data flows one way: `Input -> Game -> simulation modules -> HudState -> Hud (DOM)`. Modules never reach into the HUD; the HUD never touches simulation state.

### Design rules the code follows

- **Fixed timestep simulation, interpolated rendering.** The sim runs at a fixed rate with a spiral guard; the camera interpolates between ticks, so aim stays smooth on high-refresh displays and shots resolve against the tick that fired them.
- **Everything random is seeded.** The arena layout, the arena THEME, spawn order, card offers, affix rolls, and **loot drops** all come from the run seed, which is why a seed code reproduces a run.
- **A theme may change looks, never the rules.** `applyTheme` only writes material and light properties. Geometry, the collision octree, and cover claims are identical across themes, so a new map can never invalidate what a player learned about cover.
- **A theme must be legible.** Two tests bracket every theme: a luminance floor, because a night that hides the enemies is a bug wearing atmosphere as a disguise, and an energy ceiling, because a near-white floor under a bright key light washes the frame out and a silhouette stops reading against it.
- **If a thing cannot be used, it is not built.** Every fixed structure registers cover the AI can claim. A structure the AI cannot use is scenery, and scenery is what "less is more" deletes.
- **An independent agent never reads the player.** The escort's `update` accepts the player position and discards it, so independence is enforced by the signature rather than by a comment.
- **Every health point is attributable.** Anything that can damage the player passes a source label, and the HUD prints it. "I lost health and I do not know why" is a bug, not a difficulty.
- **Zero external assets.** Geometry, materials, icons, and audio are generated in code.
- **Measured, not guessed.** `scripts/self-check.ts` locks formulas (endless curves, combo tiers, warden cone math, challenge fold math, save schema, fire ordering, **delivered fire rate and charge cycle against the stat block**, slide gating, stand-up probe ordering, theme index range, theme luminance floor and ceiling, loadout sanitising, charge gating, ricochet bounds, drop rolls and expiry, audio ADSR stages, audio layering, listener-frame panning, squad focus fire, bounding holds, ally independence, hitstop scale) and runs in CI before every deploy.

## Performance

- Adaptive quality tiers (low / medium / high) with a frame-time governor that steps down when frames run long, and a manual override in the settings panel.
- The sun's shadow map is baked once for the static arena and re-armed only when quality changes.
- Direct meshes are merged, effects are pooled, and hot-path HUD writes are cached so unchanged values never touch the DOM.
- On Windows, Chrome may log a `powerPreference` warning from the WebGPU adapter request. It is a browser notice, not a game error.

## License

No license file is included; treat the source as all rights reserved unless the repository owner states otherwise.
