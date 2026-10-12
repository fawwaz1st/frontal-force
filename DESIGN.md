---
name: Frontal Force
description: Fire-control instrument HUD for a cold, fast browser FPS.
colors:
  accent: "#7ce7ff"
  accent-soft: "#7ce7ff61"
  accent-wash: "#7ce7ff1a"
  danger: "#ff4d5e"
  success: "#7ddb8a"
  gold: "#ffd76b"
  base: "#0b0e11"
  panel: "#10151af0"
  line: "#96b2c638"
  line-strong: "#96b2c66b"
  text: "#dde7ee"
  text-dim: "#b0c6d69e"
typography:
  display:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 700
    letterSpacing: "0.3em"
  headline:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "42px"
    fontWeight: 700
    letterSpacing: "0.28em"
  data:
    fontFamily: "ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Consolas, monospace"
    fontSize: "32px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.16em"
rounded:
  sm: "0px"
  md: "0px"
  lg: "0px"
  panel: "0px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "#7ce7ff"
    textColor: "#06131a"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "13px 38px"
  button-ghost:
    backgroundColor: "#96b2c60d"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "13px 20px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "5px 11px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "26px 40px"
---

# Design System: Frontal Force

## 1. Overview

**Creative North Star: "Fire Control"**

The HUD is the fire-control panel of a weapon system, not a web page laid over a game. Three things carry that idea:

1. **Corner brackets, not rounded cards.** Every plate has at least one cut corner (a `clip-path` notch) and the arena itself is marked by four L-shaped brackets. Nothing is rounded except things that are physically round: radar, pips, the touch stick, the thumb buttons.
2. **Ruler ticks where a number lives.** Titles, banners and the boss bar carry tick marks with a hairline baseline, so a heading reads like a scale on an instrument instead of a decorative underline.
3. **Monospaced data, condensed labels.** Anything the player compares numerically (ammo, health, score, cost, salvage, coordinates) is monospace with tabular figures; anything that names a thing is condensed uppercase with wide tracking.

The palette is cold gunmetal with a single live hue. Instrument cyan means "interactive or current". Crimson means harm. Lime means recovery. Gold means earned. Nothing else is colored.

This replaces the earlier warm olive "Stencil Crate" system (amber signal, khaki, chamfered corners). The concept changed from "markings sprayed on a supply crate" to "readout on a fire-control panel", which is why the hues went cool, the corners became brackets, and the type gained a monospace data voice.

**Key Characteristics:**
- Cold gunmetal field, instrument cyan as the only interactive hue
- Corner brackets and cut corners; zero border-radius on plates
- Ruler ticks with a hairline baseline under titles and banners
- Monospace tabular data numerals, condensed tracked labels
- Named-area CSS grids for the shell, the menu card, the bottom bar, the draft and the kiosk
- Custom scrollbars styled as instrument sliders (track, thumb, hover, active)
- Compositor-only motion (opacity and transform); no animated box-shadow

## 2. Colors

A cold instrument palette: gunmetal plates, cyan signal, and three rationed status hues.

### Primary
- **Instrument Cyan** (`#7ce7ff`): the only "interactive or current" hue. Active mode chip, active weapon slot, ready ability bar, current weapon, focus rings, crosshair dot, radar sweep, shield segment, sell rows, seed code. Also the primary button fill.
- **Cyan Wash** (`#7ce7ff1a`): the soft fill form, always paired with the solid hue as a border or text color.
- **Cyan Soft** (`#7ce7ff61`): halos, hover borders, the banner title glow.

### Secondary
- **Crimson Alert** (`#ff4d5e`): damage flash, low-health fill, kill hitmarker, K.I.A. title, empty magazine, active wager chips, boss bar top edge. Appears only when the player is losing something or has signed up for risk.

### Tertiary
- **Olive Lime** (`#7ddb8a`): healthy integrity fill (gradient `#4e9c63` to `#7ddb8a`), health pickups, the area-clear check.
- **Record Gold** (`#ffd76b`): NEW RECORD badge, headshot hitmarker, achievement toasts and unlocked ledger rows, salvage and kiosk prices, the boss core-break edge. Earned, never decorative.

### Neutral
- **Gunmetal Black** (`#0b0e11`): page background. The 3D arena keeps its own cold fog, so the HUD and the world share a temperature instead of fighting.
- **Panel** (`#10151af0`): near-opaque plate for chips, cards and slots. No blur behind it.
- **Panel Solid** (`#10151a`): the opaque card body, used where a large surface sits over the scene.
- **Hairline** (`#96b2c638`): every 1px container edge.
- **Hairline Strong** (`#96b2c66b`): the load-bearing edges: chip left rails, ability bottoms, kiosk row left rails, panel outer border.
- **Bone** (`#dde7ee`): primary text and data numerals.
- **Steel Dim** (`#b0c6d69e`): labels, secondary text, inactive slots.

### Enemy Kind Hues (scene and radar)
Grunt `#d95cff`, rusher `#ff5c5c`, gunner `#ffb03a`, warden `#35f0c8`. These are scene hues, not HUD signal hues, and the blocked-shot hitmarker borrows the warden teal on purpose.

### Named Rules
**The One Live Hue Rule.** Cyan is the only color allowed to mean "interactive or current". If a new element needs to say "you can press this" or "this is active", it is cyan. Nothing else.

**The Rationing Rule.** Crimson is harm, lime is recovery, gold is earned. A hue that carries no meaning stays bone or steel.

**The Hairline Rule.** Container edges are 1px. Direction is expressed with a 2px *left* rail (chips, ability chips, kiosk rows) or a 2px top edge (boss bar, ability bottom), never with a thick stripe on all sides.

## 3. Typography

**Display Font:** Barlow Condensed (fallback `'Arial Narrow', system-ui, sans-serif`)
**Data Font:** `ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Consolas, monospace`

**Character:** Two voices, one job each. Condensed grotesque carries names, labels and prose; monospace carries every number the player compares. That split is what makes the panel read as an instrument: the eye can find a value without reading the words around it.

### Hierarchy
- **Display** (condensed 700, 44px, +0.3em): overlay titles (FRONTAL FORCE, K.I.A.) with a ruler rule underneath.
- **Headline** (condensed 700, 42px, +0.28em): in-combat banners (WAVE 1, WAVE CLEAR).
- **Data** (mono 700, 32px): ammo readout. Health numeral 26px, salvage 30px, death-card values 16px.
- **Body** (condensed 400, 13-14px, line-height 1.5): descriptions, hints, death stats.
- **Label** (condensed 600, 10-13px, +0.1em to +0.24em, uppercase): chips, buttons, mode chips, kiosk names.

### Named Rules
**The Data Rule.** Any value the player compares numerically uses the monospace face with `font-variant-numeric: tabular-nums`. A number that changes while the player watches must never reflow its neighbours.

**The Stencil Rule.** Condensed uppercase with tracking at or above 0.08em is for short tokens only. Anything longer than a line of instruction stays sentence case.

## 4. Elevation

Flat plates over a darkened scene. Depth comes from the border, the cut corner, the bracket, and the double frame, never from blur.

### Depth Vocabulary
- **Cut corner** (`clip-path` single notch, 6-12px): chips, slots, hints, ability plates.
- **Corner brackets** (four L marks, 16px arms, drawn as eight gradients on one element): the arena frame, and the menu card's four corners.
- **Double frame** (1px panel border plus a 1px outline at 4px offset): overlay cards only.
- **Panel lift** (`box-shadow: 0 24px 70px rgba(0,0,0,0.62)`): overlay cards only.
- **Ruler rule** (repeating 1px ticks over a 1px baseline): titles, banners, draft titles, kiosk titles.

### Named Rules
**The Flat-Not-Float Rule.** No `backdrop-filter`, no glow bloom on plates, no drop shadows on HUD chips. Interactive state changes border and background color; hover may lift 1-2px and never bounces.

**The Compositor Rule.** Motion animates `opacity` and `transform` only. The damage flash and the low-health pulse are static gradient layers whose opacity animates, because animating `box-shadow` repainted the entire viewport every frame.

**The Contain Rule.** Every full-screen overlay and every card carries `contain: layout paint style`, so panel work stays off the rest of the page.

## 5. Layout

The shell is a three-row grid (`header / arena / footer`), and every panel inside it is a grid with **named areas**, so a breakpoint reorders regions by name instead of rewriting their internals.

| Surface | Areas |
| --- | --- |
| HUD shell | `header`, `arena`, `footer` |
| Bottom bar | `integrity`, `abilities`, `weapon` |
| Menu card | `title`, `best`, `records`, `ach`, `modes`, `wagers`, `seed`, `keys`, `settings`, `deploy` |
| Pause card | `title`, `records`, `settings`, `deploy` |
| Death card | `title`, `best`, `records`, `keys`, `settings`, `deploy` |
| Draft panel | `title`, `sub`, `cards`, `actions` |
| Kiosk panel | `title`, `sub`, `salvage`, `list`, `actions` |

### Breakpoints
- `max-height: 700px`: card padding and gaps tighten, ledger shortens.
- `max-height: 560px`: radar to 104px, footer insets tighten, keys go three columns.
- `max-width: 820px`: the menu card collapses to one column.
- `max-width: 640px`: the bottom bar becomes two rows (`abilities` above `integrity | weapon`), the seed row stacks, the draft goes one card per row.
- `pointer: coarse`: larger tap targets and hover styles neutralised.
- `max-height: 430px` landscape: keys and ledger drop, settings flow horizontally.

### Named Rules
**The Named-Area Rule.** A responsive change reorders named areas. It never rewrites the internal layout of a region, because that is what produces inconsistent panels across breakpoints.

## 6. Components

### Buttons
- **Primary:** cyan fill with dark diagonal hazard stripes, ink `#06131a`, 700/16px, +0.22em tracking, padding 13px 38px. Hover brightens 8% and lifts 1px with a soft cyan halo; active presses back down.
- **Ghost:** hairline border, faint fill, dim text. Hover lifts the text to bone with a faint fill and no glow.
- **Tiny:** 11px, used for the death card's COPY button.
- **Focus:** `2px solid` cyan outline at 3px offset on every interactive element. Where `clip-path` would eat the outline, an inset ring is used instead.

### Chips (header rail)
Crate plate with a cut top-right corner, a 2px left rail and a 1px hairline border. The rail carries the state color: neutral steel for score and kills, cyan for the wave and combo, gold for salvage, amber for mutations, crimson for wagers.

### Readouts (footer rail)
- **Integrity:** 12px track with quarter ticks, lime gradient fill, crimson under 30%. The shield rides on the bar as a second cyan segment so health and plating read as one pool.
- **Abilities:** two compact plates with a 3px recharge bar. A banked charge makes the bar cyan; a depleted chip dims; a cooking grenade turns the plate gold and the bar tracks the cook.
- **Weapon:** name plus `n/4` index and ALL FOUR equipped slots (the current slot is the cyan variant). A three-slot window was a workaround for ten weapons; with a four-slot loadout the whole kit fits, so nothing is one scroll away. A charge ring sits on the plate's top-right corner for the weapons that charge, and turns gold at full.

### Draft cards
Grid rows: rarity / name / description / owned. The rarity is a 3px top edge in the tier hue (steel, cyan, gold) plus a monospace rarity label. Legendary trades the solid edge for hazard hatch. Hover lifts the card 2px and tints the border with its tier hue.

### Kiosk rows
A two-column grid per row (text block, price) so prices align in a column. Purchase rows carry a steel left rail that turns cyan on hover; sell rows are cyan by default because they pay out instead of charging. Refused and successful states color the rail lime or crimson.

### Signature: Crosshair
Four corner brackets around a 4px cyan dot. The brackets translate outward with `--ch-gap`, which is the real weapon cone projected to pixels, so the reticle is the spread readout. It dims to 28% when pointer lock is lost.

### Signature: World markers
A world-space indicator over every enemy and ally, projected by `Game` and placed by the HUD. Structure: a dot whose inner bar height is `--hp` (health without a second element), a glyph, and a range number.

- **Colour is the KIND**, set inline from the same cached hue the radar uses, so a new enemy kind is legible the day it ships with no CSS change.
- **Shape and size are the ROLE** (`--enemy` / `--elite` / `--boss` / `--ally`), so a threat is never just another dot.
- **Glyphs** mark the kinds that change how you fight: `X` sniper, `+` healer, `S` summoner, `!` exploder, `E` elite, `B` boss, `A` ally.
- **Off-screen markers clamp to the edge** and hollow out (transparent fill, 1.5px border, 60% opacity), so a flanking enemy cannot arrive unannounced and a marker never points the wrong way.

### Signature: Named damage
Two layers, because they answer different questions. The arc around the crosshair says **where** the hit came from; the label under it says **what** did it.

The label is monospace, 11px, crimson, on a cut-corner plate with a `▲` prefix. It fades over 2.4 s from full to 25% opacity so it never competes with the next hit. Every source that can damage the player passes a label: enemy kinds use their own name, hazards use `TESLA COIL` / `STEAM VENT` / `BARREL BLAST`, damage over time uses `AFFIX BURN`, and self-inflicted blast uses `YOUR OWN BLAST`.

### Signature: Scope
Only rendered for the magnified optics, and it fades in with the aim so the transition is never a hard cut. A radial mask punches the sight picture out of a near-black field; two hairline cyan crossbars with a centre gap keep the target uncovered; a repeating-gradient tick ladder runs down the vertical.

### Signature: Menu tabs
Four tabs (`PLAY`, `LOADOUT`, `RECORDS`, `SETTINGS`) with exactly one panel visible. The menu card's named-area grid is replaced by a single column so no block rule has to change. `DEPLOY` stays outside the panel and is visible on every tab, because the primary action must not require a tab switch. The panel is the only scroll region, so a long ledger scrolls inside a fixed frame instead of pushing DEPLOY off screen.

The menu opens on `PLAY` every time: the panel you came back for is the one that starts a run, not whatever you were last fiddling with.

### Signature: Scrollbars
Track is a recessed dark rail with a 1px steel divider; the thumb is a slim steel bar inset 3px inside the track via `background-clip: content-box`. Hover turns the thumb cyan-soft, active turns it full cyan. Firefox gets the equivalent through `scrollbar-width: thin` and `scrollbar-color`.

## 7. Visual Readouts

The system is visual-first: a number earns its place by carrying a visual
carrier, and the number is the precision layer under it, never the whole read.

| Carrier | Used for | Rule |
| --- | --- | --- |
| **Headline tile** | Death-card mode, kills, score, best | One oversized tabular numeral, one icon, one label. Never more than four per row. |
| **Meter** | Accuracy, headshot rate, survival, damage trade, best combo | A bar needs a stated scale (10 minutes, 20:1 trade, x16 combo). A bar against an invented percentage is a lie. |
| **Pip row** | Dash and grenade charges, draft stack counts | One cell per unit, filled while held. The numeric count stays as a small secondary. |
| **Emblem** | Elites, bosses, salvage, no-hit waves | Only rendered when the value is above zero; each carries a hue and an icon, never text alone. |
| **Medal** | Achievement rows and tiers, draft rarity | Tier hue: bronze `#c98a5a`, silver `#b9c6d0`, gold `#ffd76b`. Locked medals stay at 50% opacity. |
| **Progress ring** | Achievement completion | SVG stroke driven by a `--p` percentage. The count sits beside it. |
| **Chip meter** | Salvage toward the kiosk's top price | Scaled to a real threshold in the game (120 salvage), so "can I afford it" is a glance. |
| **Icon plate** | Kiosk rows | A 34px glyph per row, chosen from the item id, so a list is scannable by shape. |
| **World marker** | Every enemy and ally | Kind hue for colour, role class for shape, `--hp` fill for health, a glyph only for the kinds that change how you fight, and a range number. |
| **Named-damage label** | Every hit the player takes | Names the source. A damage-over-time or a hazard with no visible attacker is the most confusing way to lose health, so it must name itself. |
| **Charge ring** | Charge-up weapons | An SVG stroke driven by real charge progress. Turns gold and pulses at full: the "release now" tell. |

### Named Rules
**The Carrier Rule.** A readout that only shows a number is unfinished. Give it a meter, a pip row, a ring or a medal; keep the number as the precision under it.

**The Stated Scale Rule.** Every meter names what full means (a 10-minute survival bar, a 20:1 damage trade, a x16 combo). A bar without a stated scale is decoration.

**The Zero Hides Rule.** Emblems and secondary readouts do not render at zero. A trophy strip shows what the run earned, not what it lacked.

**The Name-It Rule.** Anything that can take a point of health off the player must say what it was. An unattributed hit is a bug regardless of how it was tuned.

**The One-Panel Rule.** A menu shows one thing at a time. If two panels are both visible, one of them is a distraction and the other is buried.

**The Legibility-Over-Mood Rule.** A theme may be as dark as it likes, but only down to the point where a silhouette still reads against the floor. A night that hides the enemies is a bug wearing atmosphere as a disguise. The same rule applies in the other direction: a near-white floor under a bright key light washes the frame out and the silhouette stops reading too.

**The Use-It-Or-Delete-It Rule.** Environment is either a mechanic or it is gone. Every fixed structure registers cover the AI can claim; anything that cannot be used is scenery, and scenery is what gets deleted.

### Touch Overlay
- **Stick:** floating-origin, 2px cyan-soft ring with a cyan wash fill. Round, because a stick is round.
- **Buttons:** seven round hit-rects with a steel border that flips to cyan on hold.
- **Placement:** `Hud.layoutTouch()` writes positions from the input layer's own hit-rects, so what is drawn is exactly what is tappable, inset by the safe-area variables.

## 8. Sound

Sound is a readout. The system treats it that way: every cue answers a question the player is already asking.

### The five primitives

Every sound is layered from some of these, never just one:

| Primitive | What it is | What it tells the player |
| --- | --- | --- |
| **Transient** | A 2 ms high crack | "That happened, now." |
| **Body** | Filtered noise that sweeps dark | The size of the thing. |
| **Thump** | A pitched sine dropping fast | How heavy it was. |
| **Tail** | A low noise wash | How big the space is. |
| **Room send** | A convolver send | Where it happened. |

A gunshot built from only one of these reads as a blip. All ten weapons use all five and differ only in the numbers, which is what keeps them one family while each stays identifiable.

### Named Rules

**The No-Click Rule.** Every voice has a 2-8 ms attack. A waveform that jumps to full amplitude instantly produces a broadband transient, and the ear hears that as a tick rather than as a hit.

**The No-Frozen-Sample Rule.** Every noise voice reads from a random offset in the buffer, and every shot jitters its pitch by ±6%. Without both, repeated fire phase-locks and sounds like one sample played forever, which is the strongest "cheap audio" tell there is.

**The Room Rule.** There is always a room. A sound with no reverb sounds like it is in the player's head, not in an arena.

**The Distance-Carries-The-Tail Rule.** A far sound is quieter AND loses its room tail. A distant shot that keeps its reverb sounds close but quiet, which is worse than either.

**The Listener-Frame Rule.** Pan is resolved against the player's position and yaw, in one place. Every call site that computed its own pan got it wrong in the same way: it panned along the world X axis, which is only the player's right if they happen to be facing -Z. Turn around and a sound on your right arrives on your left.

**The Near-Miss Rule.** A round passing close must whizz. It is how a player learns they are being shot at from a direction they are not looking, and it is the single highest-value cue in a shooter.

### Signal path

```
voice -> [panner] -> dryBus ------------------+
                 \-> roomSend -> convolver --+--> air low-pass --> saturation --> master --> compressor --> out
```

The saturation stage is a soft knee, so 24 enemies firing at once compress into each other instead of summing into a square wave.

## 9. Squad tactics

Three mechanisms, all cheap, all properties of the roster rather than per-agent pathfinding:

- **Fire teams.** Three agents share ONE victim. The bonus is a 1.6x score multiplier, not a hard override, because forcing the team target makes a squad walk past a target standing in front of it.
- **Bounding overwatch.** One member advances at a time; the rest hold a firing position and cover it. A hold gives up ONLY the approach: a holding agent still shoots, still strafes, still dodges. That distinction is the whole design, and it is regression-tested.
- **Suppression.** Once an agent has held a position, it keeps firing on a shorter cadence even without a clean line, so breaking sight is a contested move rather than an off switch.

Melee and support archetypes never hold: a rusher that stops to cover is just a slow rusher.

## 10. Performance Rules

- **Compositor-only animation.** Damage flash, low-health pulse, hitmarkers, pops and toasts animate opacity or transform.
- **Cached DOM writes.** `setText`, `setStyle` and `setClass` compare against a cache and skip the write when nothing changed.
- **Cached markup.** The three-slot weapon window rebuilds its `innerHTML` only when the window index changes, not 60 times a second.
- **Throttled canvas.** The radar redraws at 20 Hz; the sweep and blips read as continuous motion at that rate and the rasterisation cost drops to a third.
- **No filters on the canvas.** The radar's ring is CSS, because a filtered canvas is re-rasterised every frame it changes.
- **Named-area grids with `contain`.** Panel layout and paint work stay local to the panel.

## 11. Do's and Don'ts

### Do:
- **Do** keep cyan as the only interactive/current hue.
- **Do** cut a corner or draw a bracket on every plate; keep border-radius at 0.
- **Do** use the monospace face with tabular figures for every comparable number.
- **Do** use ruler ticks where a heading or a scale needs a rule.
- **Do** express direction with a 2px left rail or a 2px top edge, not a full thick border.
- **Do** keep focus rings visible on every interactive element, using an inset ring where `clip-path` clips an outline.
- **Do** honor `prefers-reduced-motion: reduce`: keyframes collapse to opacity-only, and transform-based hovers are removed.
- **Do** inset every anchored cluster by the safe-area variables, and keep touch targets at least 60px across.
- **Do** give every number a visual carrier (meter, pips, ring, medal) and state the meter's scale.

### Don't:
- **Don't** reintroduce the retired warm stencil look (amber signal, khaki hairlines, chamfered corners) or the earlier navy-glass look (backdrop blur, rounded glass cards, blue-on-blue glow).
- **Don't** animate `box-shadow`, `filter` or `width` on a full-screen layer.
- **Don't** put display tracking on prose, or monospace on prose.
- **Don't** use gradient text or side-stripe borders thicker than 2px.
- **Don't** ship playful or casual-arcade styling: no bounce easing, no cartoon hues, no exclamation-marked copy.
- **Don't** add decorative chrome: no scanline overlays, no glow on non-interactive elements, no animated background textures.
