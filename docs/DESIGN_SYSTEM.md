# Design system

Defined in `apps/web/src/app/globals.css` (Tailwind v4 `@theme` tokens) and `apps/web/src/lib/core-visuals.ts` (core state visuals). Principle: depth from layered surfaces, hairline borders, geometry and motion — not from glow.

## Colour
| Token | Value | Use |
|---|---|---|
| `void` / `abyss` / `midnight` | `#010309` / `#030812` / `#06101f` | Page backgrounds, layered depth |
| `surface` / `surface-2` / `surface-3` | `#0a1628` / `#0e1d34` / `#142743` | Panels, controls |
| `cyan` | `#2ee6ff` | The single electric accent: focus, primary actions, idle core |
| `ice` | `#c4f1ff` | Technical data, code, highlights |
| `violet` | `#8b7bff` | Restrained secondary light (thinking, memory kinds) |
| `amber` / `danger` / `success` | `#ffb547` / `#ff4d6d` / `#3dffa8` | Approval / error / completion — semantic only |
| `ink` → `ink-4` | `#e6f4ff` → `#44576d` | Text hierarchy |
| `line` → `line-3` | cyan at 12% → 40% | Hairline borders |

## Typography
Space Grotesk (display, headings, state labels) · Inter (UI text) · JetBrains Mono (data labels, IDs, metrics). Panel titles: 0.7rem, 600, 0.22em tracking, uppercase. Data labels: mono 0.66rem uppercase.

## Surfaces
`.holo-panel` — translucent layered gradient, 1px hairline, top inner highlight, corner brackets, 14px radius, backdrop blur. Controls: `.btn` (default/primary/danger/ghost), `.field`, `.chip`. Primitives in `components/ui.tsx`: Panel, Chip, StatusDot, Button, Toggle, Stat, EmptyState, Skeleton, ErrorNote, JsonBlock, PageHeader.

## Motion
Durations 120 / 200 / 360 / 640 ms; easing `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out). Workspace transitions: fade + 8px rise + blur. Navigation indicator: shared-layout spring. Core state transitions are damped over ~0.6 s. `prefers-reduced-motion` (or the Settings toggle) collapses CSS animation and slows the core.

## Core states
| State | Colour | Behaviour |
|---|---|---|
| Idle | cyan | Slow rotation, calm particles |
| Listening | aqua | Mic-amplitude waveform ring, nucleus swell |
| Thinking | violet | Orbitals accelerate, neural pulses fire |
| Speaking | ice-cyan | Playback-amplitude ripple rings |
| Executing | blue | Data pathways, sequential segment lighting |
| Awaiting approval | amber | Locking gate ring, slow breathing |
| Complete | green | One controlled shockwave, then settle |
| Error | red | Subtle glitch, reduced spin |
| Offline | grey | Desaturated, nearly still |

## Accessibility
Visible focus rings, skip link, `aria-live` status for core state and chat, keyboard command bar, keyboard orbit/zoom on the core with DOM alternatives for 3D nodes, labelled controls, high-contrast text tokens.
