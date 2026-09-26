---
name: Frontal Force
description: Stencil-crate HUD system for a gritty, dark, military browser FPS.
colors:
  accent: "#ff9f1c"
  accent-soft: "#ff9f1c66"
  danger: "#ff5040"
  success: "#b6e04a"
  amber: "#ffd98a"
  gold: "#ffd76b"
  base: "#0a0b08"
  panel: "#10110cf0"
  line: "#ded2aa47"
  text: "#ece7d8"
  text-dim: "#ded2aa99"
typography:
  display:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "46px"
    fontWeight: 700
    letterSpacing: "0.3em"
  headline:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "42px"
    fontWeight: 700
    letterSpacing: "0.28em"
  data:
    fontFamily: "Barlow Condensed, 'Arial Narrow', system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.1
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
  xl: "42px"
components:
  button-primary:
    backgroundColor: "#ff9f1c"
    textColor: "#17120a"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "13px 44px"
  button-ghost:
    backgroundColor: "#ece7d80d"
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "13px 24px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 16px"
  menu-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "42px 56px"
---

# Design System: Frontal Force

## 1. Overview

**Creative North Star: "The Stencil Crate"**

This system behaves like markings sprayed onto a military supply crate: condensed stencil type, bone-white ink on olive-black, chamfered plate corners instead of soft rounds, and hazard hatching reserved for the one action that commits you (DEPLOY). Warm amber signal sits over the cold blue arena — deliberate complementary contrast, so the HUD always separates from the world instead of dissolving into it.

Everything is flat. No backdrop blur, no glassmorphism, no glow bloom: depth comes from a solid panel over a darkened scene, a khaki hairline, a chamfered `clip-path` corner, and a double-frame outline on the menu card. Color stays rationed — amber is the only "this is live" color, crimson is only loss, lime is only recovery, gold is only achievement.

This system explicitly rejects the AI-template look listed in PRODUCT.md (default palettes, glassmorphism, gradient text, hero-metric cards, eyebrows) AND the retired navy-neon "gamer HUD": no blue-on-blue glow, no rounded glass cards, no scanlines, no bounce.

**Key Characteristics:**
- Condensed stencil type, wide-tracked uppercase labels, oversized data numerals
- Chamfered corners (`clip-path`) everywhere instead of border-radius; flat panels, zero blur
- Hazard hatch stripes mark the primary/commit action and the active mode
- Signal color rationing: accent, danger, success, gold each own one meaning
- Motion as feedback only (hit, damage direction, reload, low health, screen shake, landing impact) with reduced-motion parity
- One HUD for both input schemes: the same panels reposition under `--safe-*` insets and `100dvh`, and the touch overlay borrows the accent signal rather than inventing a second palette

## 2. Colors

A warm signal palette on an olive-black field: amber for interaction, crimson for harm, lime for recovery, gold for achievement — nothing colored that doesn't mean something. The arena behind stays cold blue; the HUD never competes with it hue-for-hue.

### Primary
- **Signal Amber** (#ff9f1c): primary accent — hazard buttons, active weapon slot, wave chip, reload fill, focus-visible outlines, ally drone, radar sweep, crosshair dot. The only color allowed to say "this is interactive or current."
- **Amber Halo** (#ff9f1c66): the soft form — hover halos, small text-shadow bloom. Always paired with the solid accent.

### Secondary
- **Crimson Alert** (#ff5040): damage vignette, low-health fill, kill hitmarker, K.I.A. title, empty-mag ammo. Appears only when the player is losing something.

### Tertiary
- **Olive Lime** (#b6e04a): healthy integrity fill (gradient `#7fb238 → #b6e04a`) and health pickups.
- **Caution Amber** (#ffd98a): reserved secondary warm tone — touch notice, quiet caution text.
- **Record Gold** (#ffd76b): NEW RECORD badge and headshot hitmarker — rare by design; earned, never decorative.

### Neutral
- **Olive Black** (#0a0b08): page background and vignette floor (the 3D scene keeps its own cold `#060a14` fog — contrast is intentional).
- **Crate Panel** (#10110cf0): near-opaque flat surface for chips, cards, slots — no blur behind it.
- **Khaki Hairline** (#ded2aa47): every 1px border — chips, bars, cards, slots.
- **Bone** (#ece7d8): primary text and data numerals.
- **Khaki Dim** (#ded2aa99): labels, secondary text, inactive slots.

### Enemy Kind Hues (scene)

The four enemy kinds own one hue each, shared by the model and its radar blip so the threat reads at a glance: grunt `#d95cff`, rusher `#ff5c5c`, gunner `#ffb03a`, warden `#35f0c8` (teal). These are scene/radar hues — not part of the HUD signal vocabulary.

### Named Rules
**The Signal-Only Rule.** A hue may only appear when it carries gameplay or interaction meaning: amber = interactive/current, crimson = harm, lime = recovery, gold = achievement. If a new element doesn't have a meaning, it stays khaki/bone.

**The Hairline Rule.** Every container edge is a 1px `{colors.line}` border — never a thick colored stripe, never `border-left` used as an accent.

**The Chamfer Rule.** Plates never round: corners are cut with `clip-path` (8–18px). Border-radius above 0 is reserved for genuinely round things (blips, dots, the touch stick and its thumb buttons).

## 3. Typography

**Display Font:** Barlow Condensed (fallback: 'Arial Narrow', system-ui, sans-serif)
**Body Font:** Barlow Condensed (fallback: 'Arial Narrow', system-ui, sans-serif)

**Character:** One family, three weights (400/600/700). Condensed grotesque skeleton = military signage and crate stenciling; wide letter-spacing on short uppercase tokens turns labels into sprayed equipment markings. No display/body pairing — product register, one voice.

### Hierarchy
- **Display** (700, 46px, +0.3em): menu titles (FRONTAL FORCE, PAUSED, K.I.A.) with a hazard-dash rule underneath.
- **Headline** (700, 42px, +0.28em): in-game wave banners (WAVE 1, WAVE CLEAR).
- **Data** (700, 34px, line-height 1.1): ammo readout; health numeral at 28px. Data beats prose mid-combat.
- **Body** (400, 14–15px, line-height 1.5): death stats, hint text.
- **Label** (600, 11–13px, +0.08em…+0.22em, uppercase): chips, mode chips, button text.

### Named Rules
**The Stencil Rule.** Uppercase + tracking ≥0.08em is reserved for labels, chips, and buttons — short tokens only. Anything longer than a line of instruction stays sentence case (hints, key list values).

## 4. Elevation

This system is flat-not-float: surfaces are opaque plates over a darkened scene. Elevation is expressed by border, chamfer, and hatch — never by blur and rarely by glow. Backdrop blur is gone entirely (retired with the navy-glass look); the menu overlay dims the scene with a flat tint instead.

### Depth Vocabulary
- **Chamfer** (`clip-path` cut corners, 7–18px): chips, slots, hints, cards — the plate silhouette.
- **Double frame** (1px card border + offset 1px outline at 5px): menu/pause/death card only.
- **Hazard hatch** (`repeating-linear-gradient(-45deg, …)`): primary button fill, active mode chip, title rule. Marks commitment and current selection.
- **Panel lift** (`box-shadow: 0 24px 80px rgba(0,0,0,0.6)`): menu card only.
- **State halo** (`box-shadow: 0 0 18px #ff9f1c66`): primary button hover, crosshair dot — small, rare.

### Named Rules
**The Flat-Not-Float Rule.** No `backdrop-filter`, no panel glow bloom, no drop shadows on HUD chips. Interactive states change border/background color (amber fill or amber outline); they may nudge ≤1px but never bounce.

**The Safe-Area Rule.** The HUD is laid out inside `env(safe-area-inset-*)`, exposed as `--safe-t/r/b/l` custom properties — one source of truth shared by CSS and `TouchControls.layout()`. The stage is `100dvh` (`vh` as the fallback), and `touch-action: none` sits on every element that receives pointer events, because the browser otherwise steals pan/pinch mid-drag.

## 5. Components

Supply-crate stenciling: khaki hairlines, chamfered plates, hazard hatch on commit actions, oversized numerals.

### Buttons
- **Shape:** radius 0, square plate.
- **Primary:** solid `#ff9f1c` fill with dark diagonal hazard stripes over it, ink `#17120a`, 700/17px, +0.22em tracking, padding 13px 40px, `1px solid #ff9f1c`.
- **Hover / Focus:** hover = brightness 1.1 + translateY(-1px) + soft `0 0 18px #ff9f1c66`; active = brightness 0.94; `:focus-visible` = `2px solid #ff9f1c` outline, offset 3.
- **Ghost:** hairline khaki border, `#ece7d80d` fill, dim text — ABANDON RUN / MAIN MENU. Hover lifts text to bone with a faint fill, no glow.

### Chips
- **Style:** crate-panel background, khaki hairline, radius 0, chamfered 9px corners, label type 15px/600, padding 6px 14px. **No blur.**
- **State:** the WAVE chip is the accent variant (amber text, amber border, `rgba(255,159,28,0.1)` fill); score/kills stay neutral. The **kill-combo chip** reuses that amber variant for the `×N` multiplier in the HUD top row — hidden at ×1, so it only shows once a streak is worth reading.

### Cards / Containers
- **Corner Style:** radius 0, chamfered 18px (`clip-path`).
- **Background:** near-opaque `{colors.panel}` — no backdrop blur anywhere.
- **Frame:** 1px `{colors.line}` border + offset double outline (5px) for the menu card.
- **Shadow Strategy:** panel lift (see Elevation) for the menu card only.
- **Internal Padding:** 42px 56px.

### Records Ledger (menu)
- **Rows:** lifetime stat rows under the menu best line — dim uppercase label, 1px dotted khaki leader, bone tabular-nums value; 13px/600, +0.14em tracking, 6px row gap.
- **Behavior:** the ledger stays hidden until the first recorded run; per-mode kill rows appear only for modes with kills.

### Inputs / Fields
- **Style:** native range inputs, `accent-color: #ff9f1c`, width 200px, no custom chrome; icon-led labels (crosshair/speaker).
- **Focus:** `:focus-visible` outline 2px accent, offset 3 (shared with buttons).
- **Fields:** sensitivity, touch look, volume, and a graphics-quality select (AUTO / LOW / MEDIUM / HIGH) — the quality field is the only native `<select>`, kept unstyled for reliable mobile pickers. Touch look and quality are separate settings because a phone's feel and a phone's frame budget are different problems.

### Touch Overlay
- **Stick:** floating-origin movement stick drawn at the touch point — 2px `{colors.accent-soft}` ring, `rgba(255,159,28,0.06)` fill, round (a stick is a round thing; the Chamfer Rule allows it), 62px radius, 0.18 radial dead zone.
- **Buttons:** seven round hit-rects (FIRE / AIM / JUMP / SPRINT / CROUCH / RELOAD / CYCLE) — 2px khaki hairline, `rgba(16,17,12,0.42)` fill, dim icon; held state flips to accent border + accent icon + `rgba(255,159,28,0.18)` fill, the same "this is live" signal as the rest of the HUD.
- **Placement:** `Hud.layoutTouch()` writes each element's position from the input layer's own hit-rects, so what is drawn is exactly what is tappable; the cluster is inset by `--safe-*` so FIRE never sits under the home indicator.
- **Touch mode also gives the thumbs their corners:** the bottom bar lifts by 22px and the radar moves in, while the slot chips and index hide (the CYCLE button replaces them).
- **Rationale:** buttons are circles because a thumb has no corners; everything else in the system stays a chamfered plate.

### HUD Readouts (in-game)
- **Integrity bar:** 10px track (olive-black + khaki hairline), fill gradient lime `#7fb238 → #b6e04a`, crimson below 30% (`#ff5040 → #ff8a5e`), width transition 0.15s ease-out; numeral 28px/700; shield icon tints with state.
- **Ally bar:** drone icon + 120×5 amber micro-bar under the health bar; hidden when the drone is down.
- **Ammo block:** right-aligned 34px/700 numeral; reserve after in dim 17px; empty mag = crimson + blink; reloading swaps digits for a spinning amber reload glyph (no layout shift, no innerHTML).
- **Weapon selector:** ten weapons will not fit as an icon wall, so the block names the equipped weapon (12px/600, +0.16em, bone) beside an `n/10` index (dim, tabular-nums) and shows a three-slot window — previous / current / next. The current slot is the accent variant (amber border, amber icon, `rgba(255,159,28,0.1)` fill); the prev/next slots sit back at 0.55 opacity with a smaller icon so the active one reads first. Same 34×26 chamfered plate, 1px khaki hairline, no blur.

### Signature: Crosshair
- Four bone-white 2px ticks + 3px **amber center dot**, `0 0 4px` amber micro-glow, gap driven by `--ch-gap` (4px idle → 18px moving/firing), transition 0.08s ease-out; dims to 25% opacity when pointer lock is lost. Damage arcs are radial-gradient wedges that rotate to the attacker and fade over 0.8s.

## 6. Do's and Don'ts

### Do:
- **Do** keep the Signal-Only Rule: color only where gameplay meaning exists; everything else khaki/bone.
- **Do** chamfer plate corners with `clip-path`; keep border-radius at 0 on containers.
- **Do** use 1px `#ded2aa47` hairlines for every container edge.
- **Do** use hazard hatch ONLY for the primary commit button, the active mode chip, and title rules — scarcity keeps it loud.
- **Do** uppercase + ≥0.08em tracking for labels/buttons/chips; sentence case for anything longer.
- **Do** keep `:focus-visible` outlines (`2px solid #ff9f1c`, offset 3) on every interactive element — clip-path elements must not rely on clipped outlines.
- **Do** honor `prefers-reduced-motion: reduce`: feedback keyframes collapse to opacity-only, screen shake is silenced in code, infinite pulses become static.
- **Do** hide gameplay HUD (chips, radar, bars) under full-screen overlays via `hud--overlay`.
- **Do** inset every anchored HUD cluster by `--safe-*`, and keep touch targets ≥30px radius-scaled circles.

### Don't:
- **Don't** ship AI-template UI per PRODUCT.md: default palettes, hero-metric cards, section eyebrows, numbered `01/02` scaffolding.
- **Don't** resurrect the retired navy-neon look: no `#5f8cff`-family blues on HUD, no blue-on-blue glow, no backdrop-filter blur, no rounded glass cards.
- **Don't** use gradient text (`background-clip: text`) or side-stripe borders (`border-left >1px` as accent).
- **Don't** look playful or casual-arcade: no bounce/elastic easing, no cartoon colors, no exclamation-marked copy.
- **Don't** add over-decorated "gamer" chrome: no scanline overlays, no glow on non-interactive elements.
- **Don't** put display tracking (+0.28em…) on prose or body copy.
- **Don't** animate `<img>`/scene elements decoratively; motion must report state.
