# Handoff: ScholarLens — Knowledge Field

A build-ready spec for the ScholarLens landing experience: a scroll-driven WebGL
cinematic that becomes an explorable instrument, built **idiomatically into the existing
ScholarLens Next.js (App Router) app** with **React Three Fiber**.

This is the spec. The two files in `reference/` are the **look & motion source of truth**
(open `ScholarLens.standalone.html` in a browser to feel it; read `ScholarLens.dc.html`
for the exact algorithms). They are vanilla-Three prototypes — **do not** ship them. Every
behavioral decision below supersedes them, because the prototypes ignore SSR, accessibility,
reduced-motion, mobile, and conversion — all of which this landing must get right.

---

## 0. The one rule that governs this build

**This page must not regress what the current landing already earned.** ScholarLens'
live landing (`frontend/src/components/landing.tsx`) ships with real headline text in the
server HTML, Lighthouse Perf 91 / A11y 100 / SEO 100 / Best-Practices 96, a full
`prefers-reduced-motion` path, and a keyboard-usable surface. A WebGL cinematic that throws
that away is a downgrade no matter how good it looks.

So the architecture is **static-first, enhancement-second**:

1. The server renders a **real, complete, semantic landing page** — `<h1>`, the seven
   chapters as actual `<section>`s with real copy, the Evidence Chamber as real markup, a
   persistent header with the primary CTA. This is what crawlers, no-JS visitors, screen
   readers, and the reduced-motion path get. It is a good page on its own.
2. On capable clients (JS on, `prefers-reduced-motion: no-preference`, pointer or large
   viewport), a **client-only canvas layer mounts on top** and *becomes* the experience —
   the WebGL field, scroll-driven camera, hover markers, the cinematic. The static sections
   visually recede behind it (or are visually hidden once the canvas owns the story), but
   they remain in the DOM and the a11y tree.

If you ever have to choose: the static page wins. The canvas is the enhancement.

---

## 1. Overview

ScholarLens turns scientific literature into a living knowledge graph — **claims, not papers,
as the unit of analysis**: contradiction detection, evidence synthesis, hypothesis generation,
gap discovery.

The landing tells that thesis as one continuous argument in motion. A single WebGL "knowledge
field" of ~1500 nodes animates through 7 chapters; camera, forces, colors, and DOM annotations
are all pure functions of one scalar `progress ∈ [0,1]` derived from scroll. After the field
organizes, the user can hover claims for metadata and click a contradiction to open the
**Evidence Chamber** — the centerpiece that shows *why* two findings disagree without declaring
a winner.

**Design fidelity:** colors, type, motion, and copy below are final — match them exactly.
**Production fidelity:** the SSR/a11y/reduced-motion/mobile layers in §3, §10, §11 are
non-negotiable and are *not* in the prototype.

---

## 2. The shared design law (must stay consistent with the rest of the product)

ScholarLens' whole visual identity rests on one law, and this page must obey it:

> **Meaning lives in the EDGES, not the nodes.**

- **Claims (nodes) are neutral** — cool white / slate. Size encodes evidential weight; ring
  brightness encodes how contested a claim is. Nodes are *not* colored decoratively.
- **The relationship palette is the only semantic color:** amber = support, red =
  contradiction, teal = hypothesis. Edge *geometry* also encodes type so it reads in greyscale
  (contradiction edges are taut + flare under tension; support edges are calm).
- **Purple `--gen #7C6FFF` is reserved exclusively for the system's own voice** — generated
  hypotheses and verdicts. Never spend it decoratively. (The prototype uses teal for the
  hypothesis accent; keep teal for the hypothesis *node/edge* semantic, but any "ScholarLens
  generated this" chrome — badges, the Evidence Chamber's verdict framing — uses `--gen`.)

If you break this law the concept collapses into generic sci-fi. Hold it.

---

## 3. Architecture (target — inside the existing app)

This is **not** a separate site. It mounts where the current landing mounts:
`app-shell.tsx` renders the landing at `/` for logged-out users, SSR'd. Keep that path.

```
frontend/src/
  components/
    landing/
      Landing.tsx              # server component shell: header + CTA + all 7 static <section>s
                               #   + Evidence Chamber markup + footer. Renders WITHOUT JS.
      KnowledgeFieldClient.tsx # 'use client'; dynamic(ssr:false); the enhancement layer.
                               #   Decides (reduced-motion / capability) whether to mount the canvas.
      field/
        KnowledgeField.tsx     # <Canvas>; owns camera rig + GPU objects
        Nodes.tsx              # Points cloud (1500) — positions/colors/alpha from sim
        Edges.tsx              # LineSegments (support + contradiction)
        Starfield.tsx          # static far Points
        CameraRig.tsx          # per-frame camera from progress + pointer parallax (useFrame)
        FeatureMarkers.tsx     # 8 interactive claims projected 3D→screen
      overlays/
        Annotations.tsx        # editorial lines per chapter
        Decomposition.tsx      # paper→claims fan-out (chapter 2)
        StatsPanel.tsx         # field stats count-up
        HypothesisCallout.tsx  # chapter 6
        EvidenceChamber.tsx    # contradiction dialog (role=dialog, focus-trapped)
        ProductReveal.tsx      # control-center UI (chapter 7)
        Cursor.tsx             # custom cursor — fine-pointer + motion-allowed ONLY
        ProgressRail.tsx       # right-edge scene/percent rail (aria-hidden)
  lib/
    landing/
      sim.ts                   # pure sim math (positions, forces, palette, camera keyframes)
      useProgress.ts           # zustand store: progress, hoveredClaim, chamberOpen
      claims.ts                # the 8 feature claims + Evidence Chamber data (§8)
      easing.ts                # smoothstep, lerp, win() helpers
```

> ⚠️ The frontend ships a modified Next.js — **read the relevant guide in
> `frontend/node_modules/next/dist/docs/` before writing App-Router code** (per
> `frontend/AGENTS.md`). Don't assume stock Next behavior.

### State (tiny — one zustand store)

```ts
type SimState = {
  progress: number;          // 0..1, written by the scroll handler, read in useFrame
  hoveredClaim: number|null; // feature-node index under cursor
  chamberOpen: boolean;      // Evidence Chamber visibility
  reduced: boolean;          // prefers-reduced-motion — if true the canvas never mounts
  set: (p: Partial<SimState>) => void;
};
```

`progress` updates every frame — **never** `setState` per frame on the React tree. The Canvas
reads it inside `useFrame` imperatively. Only discrete events (hover, chamber open/close) flip
booleans that re-render DOM overlays. Mutate `geometry` attributes / `instanceMatrix` in place
and set `needsUpdate = true`, exactly like the prototype loop.

### The capability gate (decides static vs. cinematic)

`KnowledgeFieldClient` mounts the canvas **only when all hold**:
- JS is running (it's `ssr:false` + `next/dynamic`, so the static page is the first paint),
- `matchMedia('(prefers-reduced-motion: no-preference)')` matches,
- not a low-end device (`navigator.hardwareConcurrency > 4`) — else mount the reduced field (§11),
- a quick WebGL probe succeeds.

When the canvas mounts, it `aria-hidden`s itself and hides the static sections **visually**
(keep them in the DOM/a11y tree). When it doesn't, the static page *is* the page.

---

## 4. The master clock: scroll → progress → everything

- The cinematic is one tall scroll container (prototype uses an `880vh` spacer). **Cap real
  scroll length lower on the production build** — `880vh` is ~9 screens before the CTA, which
  hurts conversion. Target `≈600vh` desktop / `≈400vh` mobile and re-fit the chapter windows
  proportionally (the windows below are normalized `0..1`, so only the spacer height changes).
- `progress = clamp(scrollY / (scrollHeight - innerHeight), 0, 1)`.
- Smooth it: `progress += (target - progress) * 0.07` per frame. Lenis is **optional** here —
  if you use it, gate it behind the same reduced-motion check, and never fully hijack scroll
  (keyboard PageDown / Space / arrow keys and the native scrollbar must still work).
- Everything downstream is a pure function of `progress` (`p`) and free-running `time`
  (`t += 0.016/frame`).

Helpers (`lib/landing/easing.ts`):

```ts
export const lerp = (a:number,b:number,t:number)=>a+(b-a)*t;
export const smooth = (a:number,b:number,x:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
// triangular visibility window for an overlay: 0 at start, 1 at peak, 0 at end
export const win = (p:number,s:number,pk:number,e:number)=> p<s||p>e ? 0 : p<pk ? smooth(s,pk,p) : 1-smooth(pk,e,p);
```

### Chapter → progress map (drives rail label, aria-live region, and which overlay is up)

| Chapter | p range | What happens |
|---|---|---|
| 01 The Void | 0.00–0.05 | one origin "paper" node glowing at center; "scroll to enter" hint |
| 02 Claim Extraction | 0.05–0.20 | paper fades, fans into 3 readable claim cards (Decomposition overlay) |
| 03 Relationships | 0.20–0.36 | nodes appear (staggered), amber support edges fade in, clustering begins |
| 04 Contradictions | 0.36–0.54 | red contradiction edges + repulsion tension peaks at p≈0.44 |
| 05 Knowledge Graph | 0.54–0.70 | camera pulls back; clusters = fields; stats count up (512/147/37) |
| 06 Hypothesis | 0.70–0.85 | teal hypothesis node emerges in a gap; callout card |
| 07 The Interface | 0.85–1.00 | product control-center UI scales in over the field |

Exact overlay windows (`win(p, start, peak, end)`), from the prototype — keep verbatim:

- Decomposition wrap: `win(p,0.04,0.11,0.20)`; paper fades `1-smooth(0.10,0.15,p)`; claims in `smooth(0.10,0.155,p)`
- Anno "Relationships": `win(p,0.20,0.27,0.34)` · "Contradictions": `win(p,0.37,0.44,0.51)` · "Knowledge Graph": `win(p,0.55,0.62,0.69)`
- Stats panel: `win(p,0.55,0.64,0.72)`, numbers = `round(target * smooth(0.55,0.66,p))`
- Hypothesis callout: `win(p,0.71,0.79,0.85)`
- Explore hint: `smooth(0.5,0.58,p) * (1 - smooth(0.7,0.78,p))`
- Product reveal: `win(p,0.86,0.95,1.5)`; panel scales `0.965 → 1.0`
- Feature markers visible: `smooth(0.42,0.55,p) * (1 - smooth(0.83,0.9,p))`; interactive when that value > 0.4

**Accessibility hook:** as the active chapter changes, write its label ("03 / Relationships")
into a visually-hidden `aria-live="polite"` region so screen-reader users who *do* drive the
canvas hear where they are. The reduced-motion path doesn't need this — its chapters are real
headings.

---

## 5. Camera (CameraRig.tsx, in useFrame)

Perspective camera, `fov 55`, `near 0.1`, `far 3000`. Position scripted from `p` plus a subtle
pointer parallax. Always `lookAt(0,0,0)`.

```ts
// z distance keyframed over progress (the dolly). Piecewise smoothstep between stops:
const Z = [[0,126],[0.10,70],[0.18,66],[0.30,60],[0.44,56],[0.60,150],[0.74,208],[0.86,240],[1,210]];

camera.position.x = Math.sin(p*1.6)*14 + parallaxX*7;   // parallaxX,Y eased from pointer NDC (*0.04)
camera.position.y = Math.cos(p*1.3)*9 + 4 - parallaxY*6;
camera.position.z = camZ(p);
camera.lookAt(0,0,0);

group.rotation.y = p*0.8 + t*0.012;   // the whole field slowly rotates
group.rotation.x = Math.sin(p*2.2)*0.12;
```

The dolly is the spine: tight on the origin paper (z≈66) through claims, mid for contradictions
(z≈56), then the dramatic pull-back to z≈208 that reveals the whole field. Parallax reads from
pointer on desktop; on touch, drive it from a *tiny* device-orientation tilt or disable it.

---

## 6. The field — nodes, edges, forces (lib/landing/sim.ts + Nodes/Edges)

**Counts:** `N = 1500` nodes, `CLUSTERS = 6`, plus `~2600` static starfield points. Two reserved
indices: `node 0` = origin paper (pinned center, fades by p≈0.18); `node 1` = hypothesis node
(in a gap between clusters, appears at p>0.70, pulses).

**Cluster centers** — Fibonacci sphere, radius 72:
```ts
for (c in 0..5) { phi=acos(1-2*(c+0.5)/6); theta=PI*(1+sqrt(5))*c; r=72;
  center = [r*sin(phi)*cos(theta), r*cos(phi)*0.7, r*sin(phi)*sin(theta)]; }
```

**Each node** stores two positions and animates between them:
- `scattered`: random shell, radius 90–170 (the "void / unorganized" state)
- `clustered`: cluster center + random spread (±11–24)
- `clusterMix = smooth(0.20, 0.58, p)` → `pos = lerp(scattered, clustered, clusterMix)`
- breathing: add `sin(t*0.6+seed)*0.8` per axis so the field never freezes
- emergence: per-node `birth ∈ [0,0.78]`; `alpha = smooth(birth, birth+0.12, min(1,p/0.30))`
- `~12%` of nodes flagged contradiction (red); `~8%` are larger "hub" claims

**Contradiction tension** (chapter 4) — Gaussian burst centered at p=0.44:
```ts
tension = exp(-((p-0.44)/0.085)**2);              // 0..1, peaks ~p0.44
dir = normalize(pos - clusterCenter);
pos += dir * tension*16 + noise(t,seed) * tension*4;   // contradictions destabilize, then settle
```

**Edges** (`Edges.tsx`, one `LineSegments`, additive blend):
- support: each node linked to 2 random same-cluster peers. **Amber** `(0.82,0.64,0.36)`,
  alpha `edgeBase*0.14*min(alphaA,alphaB)`, `edgeBase = smooth(0.18,0.32,p)`.
- contradiction: ~110 cross-cluster links between red nodes. **Red** `(1.0,0.27,0.27)`,
  alpha `edgeBase*(0.12 + tension*0.85)` — they flare during the tension beat.
- Update both endpoints from the node buffer every frame; set `needsUpdate`.

**Rendering nodes:** a `THREE.Points` cloud with the additive shader (`gl_PointSize =
aSize*320/-mvZ`; soft radial core + glow → reads as bloom without a post pass). Prefer Points +
additive glow — it's cheap and gives the "telescope" look — unless you add a real bloom pass (§9).

(Exact shaders, the edge-build loop, and the per-frame math are transcribed verbatim in
`reference/ScholarLens.dc.html` lines ~383–554. Match the constants.)

---

## 7. Design tokens

**Palette (restrained / editorial — semantic, not decorative):**
| Token | Hex / RGB | Meaning |
|---|---|---|
| bg | `#04050a` | deep space background |
| neutral knowledge | `#e6ecf8` / `#9fb4d8` | default claims, white-blue |
| support | `#caa45a` (edges `0.82,0.64,0.36`) | **amber** supporting relationships |
| contradiction | `#ff5b5b` (`1.0,0.27,0.27`) | **red** contradictions |
| hypothesis | `#35d0c0` (`0.21,0.82,0.76`) | **teal** generated hypotheses (node/edge) |
| system voice | `#7C6FFF` (`--gen`) | **purple** — ScholarLens' own verdicts/badges only |

Cluster node base colors (normalized RGB), from the prototype:
`[0.86,0.90,0.98] [0.40,0.58,0.86] [0.30,0.78,0.74] [0.82,0.66,0.40] [0.62,0.70,0.86] [0.52,0.56,0.84]`

**Type:** display/UI = **Space Grotesk** (300/400/500/600); metadata/labels = **IBM Plex Mono**
(400/500), uppercase, `letter-spacing` 2–5px. Editorial headlines: weight 300,
`clamp(28px,4.6vw,58px)`, `line-height 1.08`, `letter-spacing -0.015em`, `text-wrap:balance`.

> The live app already loads **Fraunces / Geist / Geist Mono** (three epistemic roles: voice /
> guide / evidence). Decide deliberately: either (a) keep the cinematic on Space Grotesk + IBM
> Plex Mono as a distinct "instrument" typeface set, or (b) port the motion onto the app's
> existing trio for one brand voice. Don't load all five families — pick a lane and preload it.

**Misc:** card radius 9–16px; borders `1px rgba(150,180,215,0.2–0.5)`; panel bg
`linear-gradient(180deg, rgba(10,14,26,.8), rgba(7,9,18,.9))` + `backdrop-filter:blur(10–14px)`;
shadows `0 30–50px 90–130px rgba(0,0,0,.6)`.

---

## 8. Interactive feature claims + Evidence Chamber (lib/landing/claims.ts)

8 curated claims are projected 3D→screen each frame and get an HTML marker (ring + dot). Hover
shows a metadata tooltip; the two `CONTRADICTION` markers open the Evidence Chamber.

```ts
export const CLAIMS = [
  { kind:'CLAIM',         col:'#e6ecf8', text:'LLM coaching improved negotiation performance.', meta:['RCT','n=240','conf 0.88','d=0.62'], cluster:0 },
  { kind:'CLAIM',         col:'#caa45a', text:'Improvement was strongest for novices.',          meta:['subgroup','n=240','conf 0.79'], cluster:3 },
  { kind:'CONTRADICTION', col:'#ff5b5b', text:'Coaching gains persist after four weeks.',        meta:['longitudinal','n=180','conf 0.74'], cluster:2, chamber:true },
  { kind:'CONTRADICTION', col:'#ff5b5b', text:'Coaching gains decay within two weeks.',          meta:['replication','n=210','conf 0.81'], cluster:4, chamber:true },
  { kind:'CLAIM',         col:'#9fb4d8', text:'Coaching reduced anchoring bias in offers.',       meta:['lab','n=96','conf 0.66'], cluster:1 },
  { kind:'CLAIM',         col:'#e6ecf8', text:'Experts showed no measurable change.',             meta:['field','n=140','conf 0.71'], cluster:5 },
  { kind:'CLAIM',         col:'#9fb4d8', text:'Effect mediated by preparation time.',             meta:['mediation','n=320','conf 0.69'], cluster:1 },
  { kind:'HYPOTHESIS',    col:'#35d0c0', text:'Durability under adversarial counterparts — untested.', meta:['generated','H-0427'], cluster:2, hypothesis:true },
];
```

> **Data honesty.** These negotiation-AI claims (and `arXiv:2403.118`) are a *curated demo
> narrative*, not live data — fine for a hero, but **label nothing as a real result**, and keep
> the wording identical to the prototype so the Evidence Chamber stays internally consistent.
> Phase 2 (§12): swap this set for the real honest dataset already in
> `frontend/src/lib/graph-data.ts` so the landing shows the product's actual claims.

**Evidence Chamber** — opens on clicking either contradiction marker. It compares the conflicting
pair and ends on the gap→hypothesis. Exact content (match verbatim):

- **Claim A** — "Coaching gains persist after four weeks." · *Durable Effects of AI Negotiation Coaching* · `LONGITUDINAL RCT · n=180 · conf 0.74`
- **Claim B** — "Coaching gains decay within two weeks." · *Short-Horizon Replication of Coaching Effects* · `REPLICATION · n=210 · conf 0.81`
- **Shared concepts:** skill retention · novice cohort · coaching dosage
- **Methodological difference:** follow-up window 4wk vs 2wk; spaced reminder prompts present in A, absent in B
- **Possible explanations:** spaced reinforcement in A may sustain gains; cohort experience differs; measurement timing not aligned
- **Research gap → hypothesis:** durability under realistic **adversarial counterparts** is untested → ScholarLens proposes it as the next experiment
- Footer line: *"ScholarLens investigates **why** research disagrees — it does not declare a winner."*

**The Chamber must be a real, accessible dialog** (the prototype is just an opacity toggle —
upgrade it):
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby` on the "Evidence Chamber" title.
- **Focus trap**: move focus to the close button on open; cycle Tab within; restore focus to the
  triggering marker on close.
- Close via ✕, backdrop click, **and `Esc`**.
- Lock body scroll on open (`overflow:hidden`), restore on close.
- Backdrop blur + fade `.35s`, card scales `0.95→1`.
- The marker that opens it must be a real focusable control (a `<button>`), keyboard-activatable,
  not a bare `<div>` with a mouse listener.

---

## 9. Performance & the optional post-FX

The prototype hits 60fps via: one `Points` cloud + one `LineSegments` for the whole graph;
typed-array buffers mutated in place, `needsUpdate=true` once/frame;
`setPixelRatio(min(devicePixelRatio, 2))`; a self-healing resize check each frame.

Optional second pass (lazy-loaded, off on low-end and reduced-motion):
- `@react-three/postprocessing`: subtle `<Bloom>` (low intensity, high threshold — only node
  cores bloom), a *barely-there* `<ChromaticAberration>`, gentle `<DepthOfField>` during the
  Evidence-Chamber dive. The look is "precision instrument," not neon. Keep it minimal.
- Lazy-load the Canvas (`next/dynamic`, `ssr:false`) so first paint is the static page (§3).

---

## 10. Accessibility & reduced-motion (REQUIRED — the prototype does none of this)

This is the section the original handoff was missing. Treat it as acceptance criteria.

**Reduced-motion / no-canvas path (the static page from §3):**
- No scroll-jacking, no Lenis, no continuous rotation, no parallax. The seven chapters are
  ordinary stacked `<section>`s with real `<h2>`s, the editorial lines as real text, and a
  static SVG diagram per chapter (the prototype's `__bundler_thumbnail` SVG and the
  control-center SVG are good starting art). Standard scroll-reveal at most, gated behind
  `prefers-reduced-motion`.
- The Evidence Chamber still works (it's a dialog, not motion).
- This path must look *intentional*, not like a broken fallback. It's the page most search
  engines and many users will actually see.

**Cursor:** the prototype sets `cursor:none` globally — **don't.** Only hide the native cursor on
the canvas hero, and only when `(pointer: fine)` *and* motion is allowed. Everywhere else, and on
all real controls, the OS cursor stays. The custom cursor is decorative enhancement, never the
only affordance.

**Keyboard:** persistent header links, the CTA, every feature marker, and the Chamber are all
real focusable controls with visible focus rings. PageDown/Space/Home/End must scroll the
cinematic (don't trap them). A "Skip the intro →" link jumps straight to the product/CTA.

**Screen readers:** the static sections are the canonical content. The canvas is `aria-hidden`.
Chapter changes announce via the `aria-live` region (§4).

**Color/contrast:** verify the mono metadata labels and footer copy hit AA (≥4.5:1) on the
`#04050a` background — several prototype greys (`rgba(150,170,205,0.45)` etc.) likely fail.
Bump them like the live app did (it added `--text-muted #868D9B` for exactly this).

---

## 11. Mobile & touch (REQUIRED)

- **Capability degrade:** on `hardwareConcurrency <= 4` or a failed fps probe, mount the
  *reduced field* — `N≈700`, `pixelRatio 1`, no bloom, no starfield, parallax off.
- **Touch markers:** there's no hover on touch. Make markers **tap-to-reveal** the tooltip;
  a second tap on a contradiction opens the Chamber. Markers must be ≥44px touch targets even
  if the visual ring is 14px (use a transparent hit area).
- **Scroll length:** shorter spacer on mobile (`≈400vh`), so the CTA isn't a marathon away.
- **No `cursor:none`** on touch (it's already moot, but don't apply the desktop cursor CSS).

---

## 12. Conversion (don't bury the CTA)

The prototype's only "Enter ScholarLens" button lives at p≈0.86 — nine screens down. Fix it:

- A **persistent header** (real `<header>`, always visible, in the SSR HTML): logo + a primary
  **"Enter ScholarLens"** / **"Sign in"** CTA. This is the conversion path and it's always one
  click away, on every chapter, on mobile, and on the reduced-motion page.
- Keep the in-cinematic CTA at chapter 7 as the *climax*, but it's no longer the only one.
- A "Skip the intro" affordance (also the keyboard skip link) for repeat / impatient visitors.
- The header CTA routes into the existing auth flow (`app-shell.tsx` gate), same as today's
  landing — don't invent a parallel flow.

---

## 13. Build order

Get chapters 1–7 reading correctly before any polish. One beat at a time, verified against
`reference/ScholarLens.standalone.html`.

1. **Static page first** (§3, §10, §12): the SSR shell — header + CTA + 7 `<section>`s + Evidence
   Chamber dialog + footer. Ship-able and accessible with JS off. This is the floor.
2. **Capability gate + canvas mount** (§3): `KnowledgeFieldClient`, `dynamic(ssr:false)`, the
   reduced-motion / low-end branches.
3. **Scroll→progress + CameraRig dolly** (§4, §5).
4. **Nodes + Edges + force/cluster/tension math** (§6) — match the constants.
5. **DOM overlays + chapter timing + aria-live** (§4).
6. **8 feature markers + Evidence Chamber dialog** (§8) — real buttons, focus trap, Esc.
7. **Mobile/touch pass** (§11).
8. **Post-FX bloom/DoF**, lazy-loaded, last (§9).
9. **Re-run the landing Lighthouse + a11y checks** and confirm no regression vs the live
   numbers (Perf ~90, A11y 100, SEO 100). The static page is what's audited.

---

## 14. Kickoff prompt for Claude Code

> Read `design_handoff_scholarlens/README.md` and open
> `design_handoff_scholarlens/reference/ScholarLens.standalone.html` in a browser to see the
> target. Build the ScholarLens landing **into the existing Next.js app** (it mounts at `/` via
> `app-shell.tsx`, SSR'd) following §3. **Static page first**: a server-rendered, accessible,
> no-JS-capable landing — header + persistent CTA + the 7 chapters as real `<section>`s + the
> Evidence Chamber as a real `role="dialog"` + footer. Then layer the WebGL cinematic on top as a
> `dynamic(ssr:false)` client enhancement that only mounts when JS is on, `prefers-reduced-motion`
> is `no-preference`, and the device isn't low-end. Use one zustand store for `progress` /
> `hoveredClaim` / `chamberOpen`; drive all Three.js objects imperatively in `useFrame` — never
> re-render React per frame. Implement in the order in §13. Match every constant, color, and copy
> string in §4–§8 exactly (they're transcribed from `reference/ScholarLens.dc.html`). Obey the
> §2 design law (meaning in the edges; `--gen` purple for system voice only) and the §10
> accessibility / §11 mobile / §12 conversion requirements — the prototype ignores all three and
> must not be copied on those. Ask me before changing any timing or palette value. End with a
> Lighthouse pass confirming no regression vs the current landing.

---

## 15. What changed from the first draft of this handoff

The original README specced a faithful R3F port of the prototype and nothing else. This revision
keeps every motion/force/color/copy constant **and adds the production layers the prototype
omits**, because a pixel-perfect port would have regressed the live landing's SSR/SEO/a11y wins:

- **§0 / §3** — static-first, enhancement-second architecture; mount inside the existing app, not
  a standalone site; keep the SSR path.
- **§2** — pinned the page to the product's existing "meaning lives in the edges" design law and
  reserved `--gen` purple for system voice.
- **§4 / §12** — shorter scroll, a persistent always-visible CTA + skip link (was buried at p≈0.86).
- **§10** — full reduced-motion / no-JS path, real cursor, keyboard, screen-reader, contrast.
- **§11** — mobile/touch: tap-to-reveal markers, capability degrade, touch target sizes.
- **§8** — Evidence Chamber upgraded to a real focus-trapped dialog; data-honesty + real-data note.

The `reference/` prototypes are unchanged — they remain the **look & motion source of truth**.
Where this README and a prototype disagree (cursor, scroll-jacking, accessibility, the CTA), the
README wins.

---

## 16. Files in this bundle
- `README.md` — this spec.
- `reference/ScholarLens.standalone.html` — self-contained running prototype (open in browser; bundled artifact, not editable by hand).
- `reference/ScholarLens.dc.html` — annotated prototype source (exact constants & loop logic, lines ~283–599).
