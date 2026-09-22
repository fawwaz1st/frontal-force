---
name: Frontal Force
description: Combat-visor HUD system for a gritty, dark, military browser FPS.
colors:
  accent: "#5f8cff"
  accent-soft: "#5f8cff59"
  danger: "#ff4d5e"
  success: "#2aff8a"
  amber: "#ffd98a"
  gold: "#ffd76b"
  base: "#060a14"
  panel: "#080c169e"
  line: "#8caaff38"
  text: "#e8eeff"
  text-dim: "#c8d6ff9e"
typography:
  display:
    fontFamily: "Chakra Petch, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 700
    letterSpacing: "0.3em"
  headline:
    fontFamily: "Chakra Petch, system-ui, sans-serif"
    fontSize: "42px"
    fontWeight: 700
    letterSpacing: "0.28em"
  data:
    fontFamily: "Chakra Petch, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.1
  body:
    fontFamily: "Chakra Petch, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Chakra Petch, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.24em"
rounded:
  sm: "3px"
  md: "6px"
  lg: "8px"
  panel: "14px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "24px"
  xl: "42px"
components:
  button-primary:
    backgroundColor: "#5f8cff40"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "13px 44px"
  button-ghost:
    backgroundColor: "#8caaff14"
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

**Creative North Star: "The Combat Visor"**

This system behaves like the readout etched into an operator's helmet: terse, high-contrast, monospaced in spirit even though it isn't monospaced in fact. Wide letter-spacing on every label reads as stenciled equipment marking; numbers are large because numbers are what you check mid-firefight. The register is the product register — design serves gameplay, and every pixel either reports state or gets out of the way.

Depth comes from light, not from lift: panels are translucent near-black glass (`#080c169e`) over the arena, edges are hairline periwinkle (`#8caaff38`), and anything active earns a glow rather than a drop shadow. Color is rationed. The accent cobalt (`#5f8cff`) marks interactivity and wave state; red (`#ff4d5e`) is reserved for damage and death; green and amber only appear when they carry gameplay meaning.

This system explicitly rejects the AI-template look listed in PRODUCT.md: default palettes, decorative glassmorphism, gradient text, hero-metric cards, and section eyebrows. It also rejects playful arcade warmth and over-decorated "gamer" chrome — no scanline overlays, no glow on everything, no bounce.

**Key Characteristics:**
- Stenciled, wide-tracked labels; oversized data numerals
- Translucent panel surfaces with hairline borders — glow as the only elevation language
- Signal color rationing: accent, danger, success, amber each own one meaning
- Motion as feedback only (hit, damage direction, reload, low health) with reduced-motion parity

## 2. Colors

A four-signal palette on a near-black field: cobalt for interaction, crimson for harm, green for recovery, amber for caution — nothing colored that doesn't mean something.

### Primary
- **Cobalt Signal** (#5f8cff): primary accent — focused buttons, active weapon slot, wave chip, reload fill, focus-visible outlines, banner glow. The only color allowed to say "this is interactive or current."
- **Cobalt Halo** (#5f8cff59): the glow form of the accent — button gradients, hover halos, text-shadow bloom. Always paired with the solid accent, never alone as fill text.

### Secondary
- **Crimson Alert** (#ff4d5e): damage vignette, low-health fill, kill hitmarker, K.I.A. title, empty-mag ammo. Appears only when the player is losing something.

### Tertiary
- **Recovery Green** (#2aff8a): health pickups and healthy integrity fill (gradient `#38e08c → #7dffb8`).
- **Caution Amber** (#ffd98a): contextual hint bar (reload, low ammo, low integrity).
- **Record Gold** (#ffd76b): NEW RECORD badge and headshot hitmarker — rare by design; earned, never decorative.

### Neutral
- **Arena Black** (#060a14): page and scene background, fog, vignette floor.
- **Visor Panel** (#080c169e): translucent surface for chips, cards, slots (62% over the arena).
- **Hairline** (#8caaff38): every1px border — chips, bars, cards, slots.
- **Stencil White** (#e8eeff): primary text and data numerals.
- **Stencil Dim** (#c8d6ff9e): labels, secondary text, inactive slots.

### Named Rules
**The Signal-Only Rule.** A hue may only appear when it carries gameplay or interaction meaning: cobalt = interactive/current, crimson = harm, green = recovery, amber = caution, gold = achievement. If a new element doesn't have a meaning, it stays neutral.

**The Hairline Rule.** Every container edge is a1px `{colors.line}` border — never a thick colored stripe, never `border-left` used as an accent.

## 3. Typography

**Display Font:** Chakra Petch (fallback: system-ui, sans-serif)
**Body Font:** Chakra Petch (fallback: system-ui, sans-serif)

**Character:** One family, three weights (400/600/700). Its squarish techno skeleton carries the military tone; wide letter-spacing turns labels into stenciled equipment markings. No display/body pairing — product register, one voice.

### Hierarchy
- **Display** (700, 44px, +0.3em): menu titles (FRONTAL FORCE, PAUSED, K.I.A.), text-shadow cobalt bloom.
- **Headline** (700, 42px, +0.28em): in-game wave banners (WAVE 1, WAVE CLEAR).
- **Data** (700, 34px, line-height1.1): ammo readout; health numeral at 26px. Data beats prose mid-combat.
- **Body** (400, 13–15px, line-height1.5): menu key list, death stats, hint text.
- **Label** (400, 11–13px, +0.14em…+0.24em, uppercase): chips, INTEGRITY, settings labels, button text (buttons step to 700 at 13–16px).

### Named Rules
**The Stencil Rule.** Uppercase + tracking ≥0.14em is reserved for labels, chips, and buttons — short tokens only. Anything longer than a line of instruction stays sentence case (hints, key list values).

## 4. Elevation

This system is glow-not-lift: surfaces sit flat against the arena and depth is expressed through light. A heavy ambient drop shadow exists only under the menu card to detach it from the blurred scene; everything else communicates elevation by emitting light — hover halos, active-slot bloom, radar drop-shadow. Backdrop blur on panels is functional (readability over live gameplay), not decorative glassmorphism.

### Shadow Vocabulary
- **Panel lift** (`box-shadow: 0 24px 80px rgba(0,0,0,0.5)`): menu/pause/death card only.
- **Accent halo** (`box-shadow: 0 0 24px #5f8cff59`): primary button hover.
- **State bloom** (`box-shadow: 0 0 10px–14px #5f8cff59`): active weapon slot, ghost button hover.
- **Radar cast** (`filter: drop-shadow(0 0 10px rgba(95,140,255,0.25))`): radar canvas only.
- **Scene blur** (`backdrop-filter: blur(4px–6px)`): full-screen overlays and chips — legibility over moving gameplay.

### Named Rules
**The Glow-Not-Lift Rule.** Hover and active states emit accent light; they never translate, scale, or bounce (≤1px nudge on buttons is the ceiling).

## 5. Components

Military readouts: hairline-bordered translucent panels, stenciled labels, oversized numerals.

### Buttons
- **Shape:** radius 8px (`rounded.lg`).
- **Primary:** border `1px solid #5f8cff`, background gradient `#5f8cff59 → #5f8cff1f`, white700/16px text, +0.24em tracking, padding 13px44px.
- **Hover / Focus:** hover = halo `0 0 24px #5f8cff59` + translateY(-1px); active = translateY(0); `:focus-visible` = `2px solid #5f8cff` outline, offset 3px.
- **Ghost:** border hairline `#8caaff38`, background `#8caaff14`, dim text — for ABANDON RUN / MAIN MENU. Hover lifts text to `{colors.text}` with a soft halo.

### Chips
- **Style:** panel background, hairline border, radius 6px, label type 13px/+0.14em, padding 6px16px, blur(6px).
- **State:** the WAVE chip is the accent variant (cobalt text + `#5f8cff59` border); score/best/kills stay neutral.

### Cards / Containers
- **Corner Style:** radius 14px (`rounded.panel`).
- **Background:** `{colors.panel}` over `blur(4px)` scene backdrop.
- **Shadow Strategy:** panel lift (see Elevation).
- **Border:**1px `{colors.line}`.
- **Internal Padding:**42px56px.

### Inputs / Fields
- **Style:** native range inputs, `accent-color: #5f8cff`, width170px, no custom chrome.
- **Focus:** `:focus-visible` outline2px accent, offset3px (shared with buttons).
- **Label:** grid110px +1fr, label type, +0.18em tracking.

### HUD Readouts (in-game)
- **Integrity bar:**10px track (near-black + hairline), fill gradient green → crimson below30% (`#ff4d5e → #ff8a5e`), width transition 0.15s ease-out; numeral26px/700 below.
- **Ammo block:** right-aligned34px/700 numeral; reserve after in dim17px; empty mag = crimson +0.6s step blink; reloading swaps digits for RELOADING via `::after` (no layout shift, no innerHTML).

### Signature: Crosshair
- Four1px-white ticks +2px dot, cobalt `0 0 6px` glow, gap driven by `--ch-gap` (4px idle → 18px moving/firing), transition 0.08s ease-out; dims to25% opacity when pointer lock is lost. Damage arcs are radial-gradient wedges that rotate to the attacker and fade over0.8s.

## 6. Do's and Don'ts

### Do:
- **Do** keep the Signal-Only Rule: color only where gameplay meaning exists; everything else neutral.
- **Do** use1px `#8caaff38` hairlines for every container edge.
- **Do** uppercase + ≥0.14em tracking for labels/buttons/chips; sentence case for anything longer.
- **Do** express hover/active as accent glow (`0 0 10–24px #5f8cff59`), ≤1px translation.
- **Do** keep `:focus-visible` outlines (`2px solid #5f8cff`, offset3px) on every interactive element.
- **Do** honor `prefers-reduced-motion: reduce`: feedback keyframes collapse to opacity-only, infinite pulses become static glows.
- **Do** hide gameplay HUD (chips, radar, bars) under full-screen overlays via `hud--overlay`.

### Don't:
- **Don't** ship AI-template UI per PRODUCT.md: default palettes, hero-metric cards, section eyebrows, numbered `01/02` scaffolding.
- **Don't** use decorative glassmorphism — backdrop blur is permitted only on panels over live gameplay for legibility.
- **Don't** use gradient text (`background-clip: text`) or side-stripe borders (`border-left >1px` as accent).
- **Don't** look playful or casual-arcade: no bounce/elastic easing, no cartoon colors, no exclamation-marked copy.
- **Don't** add over-decorated "gamer" chrome: no scanline overlays, no glow on non-interactive elements, no angular-everything.
- **Don't** put display tracking (+0.28em…) on prose or body copy.
- **Don't** animate `<img>`/scene elements decoratively; motion must report state.
