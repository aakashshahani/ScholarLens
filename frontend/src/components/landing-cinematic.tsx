"use client";

/**
 * ScholarLens landing — the "Knowledge Field" WebGL cinematic.
 *
 * This is the ENHANCEMENT layer. It only mounts on capable clients (JS on,
 * prefers-reduced-motion: no-preference, not low-end, fine pointer / large screen) —
 * the gate lives in landing.tsx. No-JS, reduced-motion, and low-end visitors get the
 * static narrative instead and never load three.js (it's a lazy import() chunk here).
 *
 * A single fixed canvas renders ~1500 additive points + line edges; camera, forces,
 * colours and the DOM overlays are all pure functions of one scroll-derived `progress`.
 * The overlays below are aria-hidden decorative chrome — the real, accessible content
 * is the static narrative beneath this layer.
 *
 * Ported from design_handoff_scholarlens/reference/ScholarLens.dc.html (constants intact).
 */

import { useEffect, useRef, type RefObject } from "react";
import { CLAIMS, PALETTE, CHAPTERS } from "@/components/landing-data";

const MONO = "var(--font-mono), monospace";
const SANS = "var(--font-sans), sans-serif";

interface Props {
  /** Opens the React-owned Evidence Chamber dialog (clicked a contradiction marker). */
  onOpenChamber: () => void;
  /** Fires once the first frame is drawn — lets the parent cross-fade the static hero out. */
  onReady?: () => void;
  /** aria-live region the loop writes the active chapter label into. */
  announceRef: RefObject<HTMLElement | null>;
}

export default function LandingCinematic({ onOpenChamber, onReady, announceRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onOpenRef = useRef(onOpenChamber);
  onOpenRef.current = onOpenChamber;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    let raf = 0;
    let renderer: { dispose: () => void; setSize: (w: number, h: number, u?: boolean) => void; render: (s: unknown, c: unknown) => void } | null = null;
    let disposed = false;
    const cleanups: (() => void)[] = [];

    // ── lazy-load three only for capable clients ────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    import("three").then((T: any) => {
      if (disposed || !canvas) return;

      const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const win = (p: number, s: number, pk: number, e: number) => (p < s || p > e ? 0 : p < pk ? smooth(s, pk, p) : 1 - smooth(pk, e, p));
      const camZ = (p: number) => {
        const keys = [[0, 126], [0.1, 70], [0.18, 66], [0.3, 60], [0.44, 56], [0.6, 150], [0.74, 208], [0.86, 240], [1, 210]];
        for (let i = 0; i < keys.length - 1; i++) { const [p0, z0] = keys[i], [p1, z1] = keys[i + 1]; if (p <= p1) return lerp(z0, z1, smooth(p0, p1, p)); }
        return keys[keys.length - 1][1];
      };

      const rdr = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
      // Additive glow point cloud is fill-rate bound; cap DPR (1.25) + drop MSAA — big perf win on retina / iGPU.
      rdr.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      rdr.setClearColor(0x04050a, 1);
      renderer = rdr;
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(55, 1, 0.1, 3000);
      camera.position.set(0, 0, 126);
      const group = new T.Group(); scene.add(group);
      const tmpV = new T.Vector3();

      const N = 1300, CLUSTERS = 6;
      const palette = PALETTE.clusters;
      const CONTRA = [1.0, 0.3, 0.3];
      const HYP = [0.21, 0.82, 0.76];

      const centers: number[][] = [];
      for (let c = 0; c < CLUSTERS; c++) {
        const phi = Math.acos(1 - 2 * (c + 0.5) / CLUSTERS), theta = Math.PI * (1 + Math.sqrt(5)) * c, r = 72;
        centers.push([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.7, r * Math.sin(phi) * Math.sin(theta)]);
      }

      const scattered = new Float32Array(N * 3), clustered = new Float32Array(N * 3), colors = new Float32Array(N * 3);
      const sizes = new Float32Array(N), birth = new Float32Array(N), cidx = new Int16Array(N), contra = new Uint8Array(N), seed = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const u = Math.random(), v = Math.random(), th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1), rad = 90 + Math.random() * 80;
        scattered[i * 3] = rad * Math.sin(ph) * Math.cos(th); scattered[i * 3 + 1] = rad * Math.sin(ph) * Math.sin(th) * 0.8; scattered[i * 3 + 2] = rad * Math.cos(ph);
        const c = Math.floor(Math.random() * CLUSTERS); cidx[i] = c; const cc = centers[c]; const spread = 11 + Math.random() * 13;
        clustered[i * 3] = cc[0] + (Math.random() - 0.5) * spread * 2; clustered[i * 3 + 1] = cc[1] + (Math.random() - 0.5) * spread * 2; clustered[i * 3 + 2] = cc[2] + (Math.random() - 0.5) * spread * 2;
        const isC = Math.random() < 0.12; contra[i] = isC ? 1 : 0; const col = isC ? CONTRA : palette[c];
        colors[i * 3] = col[0]; colors[i * 3 + 1] = col[1]; colors[i * 3 + 2] = col[2];
        const hub = Math.random() < 0.08; sizes[i] = hub ? 3.2 + Math.random() * 2.4 : 1.0 + Math.random() * 1.1;
        birth[i] = Math.random() * 0.78; seed[i] = Math.random() * 6.28;
      }
      // node 0 = origin paper, node 1 = hypothesis node
      scattered[0] = 0; scattered[1] = 0; scattered[2] = 0; clustered[0] = 0; clustered[1] = 0; clustered[2] = 0;
      sizes[0] = 7.5; birth[0] = 0; contra[0] = 0; cidx[0] = 1; colors[0] = 0.85; colors[1] = 0.9; colors[2] = 1.0;
      const g0 = centers[2], g1 = centers[4];
      clustered[3] = (g0[0] + g1[0]) / 2 + 14; clustered[4] = (g0[1] + g1[1]) / 2 + 10; clustered[5] = (g0[2] + g1[2]) / 2;
      scattered[3] = clustered[3]; scattered[4] = clustered[4]; scattered[5] = clustered[5];
      sizes[1] = 6.5; birth[1] = 0.99; contra[1] = 0; cidx[1] = 2; colors[3] = HYP[0]; colors[4] = HYP[1]; colors[5] = HYP[2];

      const pos = new Float32Array(N * 3); pos.set(scattered); const alpha = new Float32Array(N);
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("aColor", new T.BufferAttribute(colors, 3));
      geo.setAttribute("aSize", new T.BufferAttribute(sizes, 1));
      geo.setAttribute("aAlpha", new T.BufferAttribute(alpha, 1));
      const mat = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        vertexShader: "attribute float aSize; attribute vec3 aColor; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; void main(){ vColor=aColor; vAlpha=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*(320.0/-mv.z); gl_Position=projectionMatrix*mv; }",
        fragmentShader: "varying vec3 vColor; varying float vAlpha; void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d); float core=smoothstep(0.5,0.0,r); float glow=smoothstep(0.5,0.12,r)*0.6; float a=(core+glow)*vAlpha; if(a<=0.001) discard; gl_FragColor=vec4(vColor*(0.6+core*0.95), a); }",
      });
      group.add(new T.Points(geo, mat));
      const posAttr = geo.attributes.position, alphaAttr = geo.attributes.aAlpha;

      // ── edges ──
      const pairs: number[] = [], types: number[] = []; const byC: number[][] = Array.from({ length: CLUSTERS }, () => []);
      for (let i = 2; i < N; i++) byC[cidx[i]].push(i);
      for (let i = 2; i < N; i++) { const peers = byC[cidx[i]]; for (let k = 0; k < 2; k++) { const j = peers[Math.floor(Math.random() * peers.length)]; if (j !== i) { pairs.push(i, j); types.push(0); } } }
      const cNodes: number[] = []; for (let i = 2; i < N; i++) if (contra[i]) cNodes.push(i);
      for (let k = 0; k < 110 && cNodes.length > 1; k++) { const a = cNodes[Math.floor(Math.random() * cNodes.length)], b = cNodes[Math.floor(Math.random() * cNodes.length)]; if (a !== b && cidx[a] !== cidx[b]) { pairs.push(a, b); types.push(1); } }
      const E = pairs.length / 2; const epos = new Float32Array(E * 6), ecol = new Float32Array(E * 6), ealpha = new Float32Array(E * 2);
      // Edge colour is constant per type (red contradiction / amber support) — set once, never re-upload.
      for (let e = 0; e < E; e++) { const isC = types[e] === 1; const r = isC ? 1.0 : 0.82, g = isC ? 0.27 : 0.64, b = isC ? 0.27 : 0.36; ecol[e * 6] = r; ecol[e * 6 + 1] = g; ecol[e * 6 + 2] = b; ecol[e * 6 + 3] = r; ecol[e * 6 + 4] = g; ecol[e * 6 + 5] = b; }
      const egeo = new T.BufferGeometry();
      egeo.setAttribute("position", new T.BufferAttribute(epos, 3));
      egeo.setAttribute("aColor", new T.BufferAttribute(ecol, 3));
      egeo.setAttribute("aAlpha", new T.BufferAttribute(ealpha, 1));
      const emat = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        vertexShader: "attribute vec3 aColor; attribute float aAlpha; varying vec3 vColor; varying float vAlpha; void main(){ vColor=aColor; vAlpha=aAlpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader: "varying vec3 vColor; varying float vAlpha; void main(){ gl_FragColor=vec4(vColor,vAlpha); }",
      });
      group.add(new T.LineSegments(egeo, emat));

      // ── starfield ──
      const SN = 1600, sp = new Float32Array(SN * 3);
      for (let i = 0; i < SN; i++) { const u = Math.random(), v = Math.random(), th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1), r = 420 + Math.random() * 560; sp[i * 3] = r * Math.sin(ph) * Math.cos(th); sp[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th); sp[i * 3 + 2] = r * Math.cos(ph); }
      const sgeo = new T.BufferGeometry(); sgeo.setAttribute("position", new T.BufferAttribute(sp, 3));
      scene.add(new T.Points(sgeo, new T.PointsMaterial({ color: 0x5a6a8a, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.5, depthWrite: false, blending: T.AdditiveBlending })));

      // ── interactive feature markers ──
      const F = CLAIMS.map((c, i) => {
        const cc = centers[c.cluster]; const a = i * 1.7, r = 18 + (i % 3) * 5;
        return { ...c, x: cc[0] + Math.cos(a) * r, y: cc[1] + Math.sin(a * 1.3) * r * 0.7, z: cc[2] + Math.sin(a) * r };
      });
      const layer = root.querySelector('[data-markers="layer"]') as HTMLElement;
      const tip = root.querySelector('[data-tip="box"]') as HTMLElement;
      const tipKind = root.querySelector('[data-tip="kind"]') as HTMLElement;
      const tipText = root.querySelector('[data-tip="text"]') as HTMLElement;
      const tipMeta = root.querySelector('[data-tip="meta"]') as HTMLElement;
      let hovered: number | null = null;
      const showTip = (f: typeof F[number]) => {
        tipKind.textContent = f.kind;
        tipKind.style.color = f.kind === "CONTRADICTION" ? "rgba(255,150,150,0.9)" : f.kind === "HYPOTHESIS" ? "rgba(110,222,205,0.9)" : "rgba(200,216,242,0.85)";
        tipText.textContent = f.text;
        tipMeta.innerHTML = f.meta.map((m) => `<span style="font-family:${MONO};font-size:9px;color:rgba(200,216,242,0.78);border:1px solid rgba(160,180,215,0.22);border-radius:5px;padding:3px 6px;">${m}</span>`).join("") + (f.chamber ? `<span style="font-family:${MONO};font-size:9px;color:#ff9a9a;border:1px solid rgba(255,120,120,0.35);border-radius:5px;padding:3px 6px;">CLICK TO INVESTIGATE →</span>` : "");
      };
      const markers = F.map((f, i) => {
        // Mouse-only enhancement: not keyboard-focusable (the whole cinematic is
        // aria-hidden decoration — keyboard/SR users use the static narrative + the
        // accessible chamber modal). tabIndex -1 avoids focusable-under-aria-hidden.
        const el = document.createElement("button");
        el.type = "button";
        el.tabIndex = -1;
        el.style.cssText = "position:absolute;left:0;top:0;transform:translate(-9999px,-9999px);pointer-events:none;will-change:transform;background:none;border:0;padding:0;width:44px;height:44px;margin:-22px 0 0 -22px;cursor:pointer;";
        const isHot = f.kind !== "CLAIM";
        // Clickable markers (contradiction/hypothesis) get a faint outer "target" ring so
        // they read as actionable; hover-only claims get a single ring. All pulse + glow so
        // the 8 interactive markers stand out from the ~1300 field nodes.
        if (isHot) {
          const outer = document.createElement("div");
          outer.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;border:1px solid ${f.col}55;`;
          el.appendChild(outer);
        }
        const ring = document.createElement("div");
        ring.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;border:1.5px solid ${f.col};box-shadow:0 0 14px ${f.col}99, inset 0 0 6px ${f.col}55;transition:width .16s ease,height .16s ease;animation:kf-ring ${isHot ? "2.4s" : "3.6s"} ease-in-out infinite;`;
        const core = document.createElement("div");
        core.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:4px;height:4px;border-radius:50%;background:${f.col};`;
        el.appendChild(ring); el.appendChild(core);
        const enter = () => { hovered = i; showTip(f); };
        const leave = () => { if (hovered === i) { hovered = null; tip.style.opacity = "0"; } };
        el.addEventListener("mouseenter", enter);
        el.addEventListener("mouseleave", leave);
        if (f.chamber) el.addEventListener("click", () => onOpenRef.current());
        layer.appendChild(el);
        return { el, ring, isHot };
      });

      // ── overlay DOM refs ──
      const q = (s: string) => root.querySelector(s) as HTMLElement;
      const qa = (s: string) => Array.from(root.querySelectorAll(s)) as HTMLElement[];
      const annos = qa('[data-phase="anno"]');
      const hint = q('[data-phase="hint"]'), exploreHint = q('[data-explore="hint"]');
      const anno2 = q('[data-phase="anno2"]'), product = q('[data-phase="product"]');
      const deco = q('[data-deco="wrap"]'), decoPaper = q('[data-deco="paper"]');
      const decoClaims = qa('[data-deco="claim"]'), decoLines = qa('[data-deco="lines"] line') as unknown as HTMLElement[], decoCap = q('[data-deco="cap"]');
      const statsPanel = q('[data-stats="panel"]'), statClaims = q('[data-stat="claims"]'), statPapers = q('[data-stat="papers"]'), statContra = q('[data-stat="contra"]');
      const hyp = q('[data-hyp="wrap"]');
      const railFill = q('[data-rail="fill"]'), railPct = q('[data-rail="pct"]'), railScene = q('[data-rail="scene"]');
      const coords = q('[data-readout="coords"]');

      // ── input + clock ──
      let progress = 0, target = 0, time = 0, lastT = 0, frame = 0;
      let mx = window.innerWidth / 2, my = window.innerHeight / 2, pmx = 0, pmy = 0;
      let w = window.innerWidth, h = window.innerHeight;
      let lastScene = -1, shown = false;

      const resize = () => { w = window.innerWidth; h = window.innerHeight; rdr.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
      const onScroll = () => { const hh = document.documentElement.scrollHeight - window.innerHeight; target = hh > 0 ? Math.min(1, Math.max(0, window.scrollY / hh)) : 0; };
      const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", resize);
      window.addEventListener("pointermove", onMove);
      cleanups.push(() => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", resize); window.removeEventListener("pointermove", onMove); });
      onScroll(); resize();

      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        frame++;
        // Real elapsed time so the smoothing + ambient drift are frame-rate independent.
        // Old `*0.1`/frame lagged badly on sub-60fps machines (the field trailed the scroll);
        // the exp form closes the same fraction per second regardless of fps. dt clamped so a
        // backgrounded tab doesn't snap on return.
        const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
        lastT = now;
        const aw = window.innerWidth, ah = window.innerHeight;
        if (aw && ah && (aw !== w || ah !== h)) resize();
        time += dt;
        progress += (target - progress) * (1 - Math.exp(-dt * 8));
        const p = progress, t = time, W = window.innerWidth, H = window.innerHeight;

        pmx += ((mx / W * 2 - 1) - pmx) * 0.04; pmy += ((my / H * 2 - 1) - pmy) * 0.04;
        camera.position.x = Math.sin(p * 1.6) * 14 + pmx * 7;
        camera.position.y = Math.cos(p * 1.3) * 9 + 4 - pmy * 6;
        camera.position.z = camZ(p);
        camera.lookAt(0, 0, 0);
        group.rotation.y = p * 0.8 + t * 0.012;
        group.rotation.x = Math.sin(p * 2.2) * 0.12;

        const clusterMix = smooth(0.2, 0.58, p), appear = Math.min(1, p / 0.3), tension = Math.exp(-Math.pow((p - 0.44) / 0.085, 2));
        for (let i = 0; i < N; i++) {
          let x = lerp(scattered[i * 3], clustered[i * 3], clusterMix);
          let y = lerp(scattered[i * 3 + 1], clustered[i * 3 + 1], clusterMix);
          let zz = lerp(scattered[i * 3 + 2], clustered[i * 3 + 2], clusterMix);
          const s = seed[i]; x += Math.sin(t * 0.6 + s) * 0.8; y += Math.cos(t * 0.5 + s * 1.3) * 0.8; zz += Math.sin(t * 0.4 + s * 0.7) * 0.8;
          if (contra[i] && tension > 0.01) { const cc = centers[cidx[i]]; const dx = x - cc[0], dy = y - cc[1], dz = zz - cc[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001, push = tension * 16; x += (dx / d) * push + Math.sin(t * 7 + s) * tension * 4; y += (dy / d) * push + Math.cos(t * 8 + s) * tension * 4; zz += (dz / d) * push + Math.sin(t * 6 + s * 2) * tension * 4; }
          pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = zz;
          let a = smooth(birth[i], birth[i] + 0.12, appear); if (contra[i]) a *= 0.7 + tension * 0.6; alpha[i] = Math.min(1, a) * 0.95;
        }
        alpha[0] = (1 - smooth(0.06, 0.18, p)) * 0.95;
        alpha[1] = smooth(0.7, 0.78, p) * (0.75 + 0.25 * Math.sin(t * 3));
        posAttr.needsUpdate = true; alphaAttr.needsUpdate = true;

        const edgeBase = smooth(0.18, 0.32, p);
        // ~2700 edges × 6 floats re-uploaded every frame is the heaviest CPU cost here.
        // Edges connect slow-moving nodes, so updating them at half-rate is imperceptible
        // and frees real headroom on weaker GPUs.
        if ((frame & 1) === 0) {
          for (let e = 0; e < E; e++) {
            const a = pairs[e * 2], b = pairs[e * 2 + 1];
            epos[e * 6] = pos[a * 3]; epos[e * 6 + 1] = pos[a * 3 + 1]; epos[e * 6 + 2] = pos[a * 3 + 2];
            epos[e * 6 + 3] = pos[b * 3]; epos[e * 6 + 4] = pos[b * 3 + 1]; epos[e * 6 + 5] = pos[b * 3 + 2];
            const ea = types[e] === 1 ? edgeBase * (0.12 + tension * 0.85) : edgeBase * 0.14 * Math.min(alpha[a], alpha[b]);
            ealpha[e * 2] = ea; ealpha[e * 2 + 1] = ea;
          }
          egeo.attributes.position.needsUpdate = true; egeo.attributes.aAlpha.needsUpdate = true;
        }

        // markers
        group.updateMatrixWorld();
        const markerVis = smooth(0.42, 0.55, p) * (1 - smooth(0.83, 0.9, p));
        let tipShown = false;
        for (let i = 0; i < F.length; i++) {
          const f = F[i], m = markers[i];
          let vis = markerVis;
          if (f.hypothesis) vis *= smooth(0.7, 0.78, p);
          const bx = f.x + Math.sin(t * 0.5 + i) * 0.6, by = f.y + Math.cos(t * 0.4 + i) * 0.6, bz = f.z + Math.sin(t * 0.3 + i) * 0.6;
          tmpV.set(bx, by, bz).applyMatrix4(group.matrixWorld).project(camera);
          const onScreen = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
          if (vis < 0.05 || !onScreen) { m.el.style.opacity = "0"; m.el.style.pointerEvents = "none"; m.el.style.transform = "translate(-9999px,-9999px)"; continue; }
          const sx = (tmpV.x * 0.5 + 0.5) * W, sy = (-tmpV.y * 0.5 + 0.5) * H;
          m.el.style.transform = `translate(${sx}px,${sy}px)`;
          m.el.style.opacity = String(vis);
          m.el.style.pointerEvents = markerVis > 0.4 ? "auto" : "none";
          if (hovered === i) { m.ring.style.width = "24px"; m.ring.style.height = "24px"; tip.style.transform = `translate(${Math.min(sx + 18, W - 256)}px,${Math.max(sy - 20, 12)}px)`; tipShown = true; }
          else { m.ring.style.width = "16px"; m.ring.style.height = "16px"; }
        }
        tip.style.opacity = tipShown ? "1" : "0";

        // overlays
        hint.style.opacity = String(win(p, 0, 0.012, 0.045));
        const wrapO = win(p, 0.04, 0.11, 0.2); deco.style.opacity = String(wrapO);
        const paperO = 1 - smooth(0.1, 0.15, p); decoPaper.style.opacity = String(0.4 + 0.6 * paperO);
        const claimO = smooth(0.1, 0.155, p); decoClaims.forEach((c) => { c.style.opacity = String(claimO); c.style.transform = `translate(-50%,-50%) translateY(${(1 - claimO) * 10}px)`; });
        decoLines.forEach((l) => (l.style.opacity = String(claimO))); decoCap.style.opacity = String(claimO);
        annos.forEach((el) => { const o = win(p, +el.dataset.start!, +el.dataset.peak!, +el.dataset.end!); el.style.opacity = String(o); el.style.transform = `translate(-50%,-50%) translateY(${(1 - o) * 16}px)`; });
        const statsO = win(p, 0.55, 0.64, 0.72); statsPanel.style.opacity = String(statsO); const cu = smooth(0.55, 0.66, p); statClaims.textContent = String(Math.round(512 * cu)); statPapers.textContent = String(Math.round(147 * cu)); statContra.textContent = String(Math.round(37 * cu));
        const hypO = win(p, 0.71, 0.79, 0.85); hyp.style.opacity = String(hypO); hyp.style.transform = `translate(-50%,-50%) translateY(${(1 - hypO) * 16}px)`;
        exploreHint.style.opacity = String(smooth(0.46, 0.55, p) * (1 - smooth(0.86, 0.93, p)));
        anno2.style.opacity = String(win(p, 0.84, 0.9, 0.97));
        const prodO = win(p, 0.86, 0.95, 1.5); product.style.opacity = String(prodO); product.style.pointerEvents = prodO > 0.6 ? "auto" : "none"; product.style.transform = `scale(${0.965 + 0.035 * Math.min(1, prodO)})`;
        railFill.style.height = (p * 100).toFixed(1) + "%";
        railPct.textContent = String(Math.round(p * 100)).padStart(2, "0");
        const sc = p < 0.05 ? 1 : p < 0.2 ? 2 : p < 0.36 ? 3 : p < 0.54 ? 4 : p < 0.7 ? 5 : p < 0.85 ? 6 : 7;
        railScene.textContent = String(sc).padStart(2, "0");
        if (sc !== lastScene) { lastScene = sc; if (announceRef.current) announceRef.current.textContent = CHAPTERS[sc - 1].eyebrow; }
        const scaleName = CHAPTERS[sc - 1].scene; const links = Math.round(E * edgeBase); const claims = Math.round((N - 2) * Math.min(1, appear));
        coords.textContent = `SCALE ${scaleName} · CLAIMS ${claims} · LINKS ${links}`;

        rdr.render(scene, camera);
        // Cross-fade the cinematic in over the static hero once the first frame is drawn
        // (no hard "initializing" veil pop). onReady lets the parent fade the hero out in sync.
        if (!shown) { shown = true; root.style.opacity = "1"; onReadyRef.current?.(); }
      };
      loop(performance.now());
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanups.forEach((c) => c());
      if (renderer) renderer.dispose();
    };
  }, [announceRef]);

  // Decorative enhancement chrome — hidden from the a11y tree (the static narrative
  // beneath this layer is the canonical, accessible content).
  return (
    <div ref={rootRef} aria-hidden className="fixed inset-0 z-10" style={{ fontFamily: SANS, opacity: 0, transition: "opacity .9s ease" }}>
      <canvas ref={canvasRef} className="fixed inset-0 w-screen h-screen block" style={{ zIndex: 0 }} />
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 1, background: "radial-gradient(120% 90% at 50% 50%, rgba(4,5,10,0) 36%, rgba(4,5,10,0.6) 100%)" }} />

      {/* brand + readout */}
      <div className="fixed left-[30px] top-[78px] z-[6] pointer-events-none flex items-center gap-[9px]" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: "rgba(170,190,220,0.6)" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#9fb4d8", boxShadow: "0 0 8px #9fb4d8", animation: "kf-pulse 2.4s ease-in-out infinite" }} />
        KNOWLEDGE FIELD <span style={{ color: "rgba(140,160,195,0.4)" }}>/ LIVE</span>
      </div>
      <div data-readout="coords" className="fixed left-[30px] bottom-[24px] z-[6] pointer-events-none" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, color: "rgba(150,170,205,0.55)" }}>SCALE — · CLAIMS — · LINKS —</div>

      {/* progress rail */}
      <div className="fixed right-[26px] top-1/2 -translate-y-1/2 z-[6] flex flex-col items-center gap-[10px] pointer-events-none">
        <div data-rail="scene" style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 2, color: "rgba(160,180,210,0.55)" }}>01</div>
        <div style={{ position: "relative", width: 2, height: 190, background: "rgba(140,160,200,0.16)", borderRadius: 2, overflow: "hidden" }}>
          <div data-rail="fill" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "0%", background: "linear-gradient(180deg,#9fb4d8,#caa45a)", borderRadius: 2 }} />
        </div>
        <div data-rail="pct" style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, color: "rgba(160,180,210,0.5)" }}>00</div>
      </div>

      {/* scroll hint */}
      <div data-phase="hint" className="fixed left-1/2 bottom-[42px] -translate-x-1/2 z-[5] pointer-events-none text-center" style={{ opacity: 0 }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 4, color: "rgba(180,200,230,0.7)" }}>SCROLL TO ENTER THE FIELD</div>
        <div style={{ margin: "10px auto 0", width: 1, height: 34, background: "linear-gradient(180deg,rgba(180,200,230,0.7),rgba(180,200,230,0))" }} />
      </div>

      {/* explore hint */}
      <div data-explore="hint" className="fixed left-1/2 bottom-[42px] -translate-x-1/2 z-[6] pointer-events-none flex items-center gap-[10px]" style={{ opacity: 0, fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: "rgba(180,200,230,0.7)" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#35d0c0", boxShadow: "0 0 8px #35d0c0" }} />
        EXPLORE · HOVER CLAIMS · <span style={{ color: "#ff8a8a" }}>CLICK CONTRADICTIONS</span>
      </div>

      {/* decomposition: paper → 3 claims */}
      <div data-deco="wrap" className="fixed left-1/2 top-1/2 z-[5] pointer-events-none" style={{ transform: "translate(-50%,-50%)", width: 760, height: 480, opacity: 0 }}>
        <svg data-deco="lines" width="760" height="480" viewBox="0 0 760 480" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <line x1="380" y1="118" x2="150" y2="330" stroke="rgba(200,164,90,0.55)" strokeWidth="1" strokeDasharray="3 4" />
          <line x1="380" y1="118" x2="380" y2="392" stroke="rgba(200,164,90,0.55)" strokeWidth="1" strokeDasharray="3 4" />
          <line x1="380" y1="118" x2="610" y2="330" stroke="rgba(200,164,90,0.55)" strokeWidth="1" strokeDasharray="3 4" />
        </svg>
        <div data-deco="paper" style={{ position: "absolute", left: 380, top: 118, transform: "translate(-50%,-50%)", width: 230, padding: "13px 15px", border: "1px solid rgba(180,196,216,0.4)", borderRadius: 9, background: "linear-gradient(180deg,rgba(16,22,40,0.85),rgba(9,12,24,0.9))", boxShadow: "0 14px 40px rgba(0,0,0,0.5)" }}>
          <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: 2, color: "rgba(180,196,216,0.75)" }}>PAPER · TMLR 2022</div>
          <div style={{ marginTop: 6, fontSize: 13, fontWeight: 500, lineHeight: 1.3, color: "#eef2fa" }}>Emergent Abilities of Large Language Models</div>
        </div>
        {[
          { l: 150, t: 330, b: "rgba(220,228,245,0.4)", bg: "linear-gradient(180deg,rgba(16,20,30,0.9),rgba(9,12,20,0.92))", tag: "CLAIM · SCALE", tc: "rgba(220,228,245,0.85)", text: "Some abilities are absent in small models.", col: "#eef2fa" },
          { l: 380, t: 392, b: "rgba(200,164,90,0.45)", bg: "linear-gradient(180deg,rgba(28,23,12,0.9),rgba(16,13,8,0.92))", tag: "CLAIM · SCALE", tc: "rgba(220,180,110,0.95)", text: "They appear abruptly with model scale.", col: "#f4eede" },
          { l: 610, t: 330, b: "rgba(53,208,192,0.45)", bg: "linear-gradient(180deg,rgba(12,26,28,0.9),rgba(8,16,18,0.92))", tag: "CLAIM · EVALUATION", tc: "rgba(53,208,192,0.95)", text: "Emergence is hard to predict in advance.", col: "#e6f2f0" },
        ].map((c, i) => (
          <div key={i} data-deco="claim" style={{ position: "absolute", left: c.l, top: c.t, transform: "translate(-50%,-50%)", width: 215, padding: "11px 13px", border: `1px solid ${c.b}`, borderRadius: 8, background: c.bg, boxShadow: "0 10px 30px rgba(0,0,0,0.45)", opacity: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 2, color: c.tc }}>{c.tag}</div>
            <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.35, color: c.col }}>{c.text}</div>
          </div>
        ))}
        <div data-deco="cap" style={{ position: "absolute", left: 380, top: 455, transform: "translateX(-50%)", whiteSpace: "nowrap", fontFamily: MONO, fontSize: 10, letterSpacing: 4, color: "rgba(180,200,230,0.6)", opacity: 0 }}>PAPERS BECOME CLAIMS</div>
      </div>

      {/* editorial annotations */}
      {[
        { s: 0.2, pk: 0.27, e: 0.34, label: "03 / RELATIONSHIPS", line: "Claims agree more than papers do.", color: "rgba(200,164,90,0.9)" },
        { s: 0.37, pk: 0.44, e: 0.51, label: "04 / CONTRADICTIONS", line: "And then they collide.", color: "rgba(255,120,120,0.92)" },
        { s: 0.55, pk: 0.62, e: 0.69, label: "05 / KNOWLEDGE GRAPH", line: "One field, one view.", color: "rgba(159,180,216,0.9)" },
      ].map((a, i) => (
        <div key={i} data-phase="anno" data-start={a.s} data-peak={a.pk} data-end={a.e} className="fixed left-1/2 top-1/2 z-[5] pointer-events-none text-center" style={{ transform: "translate(-50%,-50%)", opacity: 0, width: "min(86vw,760px)", padding: "48px 40px", background: "radial-gradient(ellipse 76% 64% at 50% 50%, rgba(4,5,10,0.78) 0%, rgba(4,5,10,0.45) 48%, rgba(4,5,10,0) 80%)" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 5, marginBottom: 18, color: a.color }}>{a.label}</div>
          <div className="text-balance" style={{ fontWeight: 300, fontSize: "clamp(28px,4.6vw,58px)", lineHeight: 1.08, letterSpacing: "-0.015em", color: "#eef2fa" }}>{a.line}</div>
        </div>
      ))}

      {/* stats panel */}
      <div data-stats="panel" className="fixed left-1/2 z-[5] pointer-events-none flex items-end gap-[34px]" style={{ bottom: "15vh", transform: "translateX(-50%)", opacity: 0 }}>
        <div><div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 3, color: "rgba(150,170,205,0.6)" }}>CLAIMS</div><div data-stat="claims" style={{ marginTop: 3, fontSize: 28, fontWeight: 300, color: "#eaf0fb", fontVariantNumeric: "tabular-nums" }}>0</div></div>
        <div><div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 3, color: "rgba(150,170,205,0.6)" }}>PAPERS</div><div data-stat="papers" style={{ marginTop: 3, fontSize: 28, fontWeight: 300, color: "#eaf0fb", fontVariantNumeric: "tabular-nums" }}>0</div></div>
        <div><div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 3, color: "rgba(255,120,120,0.7)" }}>CONTRADICTIONS</div><div data-stat="contra" style={{ marginTop: 3, fontSize: 28, fontWeight: 300, color: "#ff8a8a", fontVariantNumeric: "tabular-nums" }}>0</div></div>
      </div>

      {/* hypothesis callout */}
      <div data-hyp="wrap" className="fixed left-1/2 top-1/2 z-[5] pointer-events-none" style={{ transform: "translate(-50%,-50%)", opacity: 0, padding: "44px 40px", background: "radial-gradient(ellipse 72% 70% at 50% 42%, rgba(4,5,10,0.76) 0%, rgba(4,5,10,0) 78%)" }}>
        <div style={{ position: "relative", width: "min(86vw,640px)", textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 5, color: "rgba(53,208,192,0.95)", marginBottom: 16 }}>06 / HYPOTHESES</div>
          <div style={{ fontWeight: 300, fontSize: "clamp(28px,4.6vw,58px)", lineHeight: 1.08, letterSpacing: "-0.015em", color: "#eef2fa" }}>The gap is the interesting part.</div>
          <div style={{ margin: "26px auto 0", width: "min(82vw,460px)", padding: "14px 16px", border: "1px solid rgba(53,208,192,0.5)", borderRadius: 10, background: "linear-gradient(180deg,rgba(10,30,30,0.78),rgba(6,18,18,0.85))", boxShadow: "0 0 40px rgba(53,208,192,0.18), 0 14px 40px rgba(0,0,0,0.5)", textAlign: "left" }}>
            <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: 2, color: "rgba(53,208,192,0.95)" }}>GENERATED HYPOTHESIS</div>
            <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.4, color: "#def4f0" }}>Which capabilities, if any, show true discontinuities under continuous, well-calibrated metrics?</div>
          </div>
        </div>
      </div>

      {/* feature markers + tooltip */}
      <div data-markers="layer" className="fixed inset-0 z-[7]" style={{ pointerEvents: "none" }} />
      <div data-tip="box" className="fixed left-0 top-0 z-[9] pointer-events-none" style={{ opacity: 0, transform: "translate(-9999px,-9999px)", width: 240, padding: "12px 13px", border: "1px solid rgba(140,165,210,0.3)", borderRadius: 10, background: "linear-gradient(180deg,rgba(12,16,28,0.94),rgba(8,11,20,0.96))", backdropFilter: "blur(8px)", boxShadow: "0 16px 44px rgba(0,0,0,0.55)" }}>
        <div data-tip="kind" style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 2, color: "rgba(180,200,235,0.8)" }}>CLAIM</div>
        <div data-tip="text" style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.4, color: "#eef2fa" }} />
        <div data-tip="meta" style={{ marginTop: 9, display: "flex", flexWrap: "wrap", gap: 5 }} />
      </div>

      {/* chapter 7 intro line */}
      <div data-phase="anno2" className="fixed left-1/2 z-[8] pointer-events-none text-center" style={{ top: "11vh", transform: "translate(-50%,0)", opacity: 0, width: "min(90vw,820px)" }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 5, color: "rgba(159,180,216,0.8)", marginBottom: 12 }}>07 / THE WORKSPACE</div>
        <div style={{ fontWeight: 300, fontSize: "clamp(20px,2.8vw,34px)", lineHeight: 1.2, color: "#eef2fa" }}>Run all of this on your own library.<br />From a folder of PDFs to a map of your field.</div>
      </div>

      {/* product / control center */}
      <div data-phase="product" className="fixed inset-0 z-[8] flex items-center justify-center" style={{ opacity: 0, pointerEvents: "none", padding: "4vh 3vw" }}>
        <div style={{ width: "min(96vw,1180px)", height: "min(88vh,720px)", border: "1px solid rgba(159,180,216,0.22)", borderRadius: 14, overflow: "hidden", background: "linear-gradient(180deg,rgba(9,12,22,0.86),rgba(6,8,16,0.92))", backdropFilter: "blur(14px)", boxShadow: "0 40px 120px rgba(0,0,0,0.65)", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderBottom: "1px solid rgba(159,180,216,0.16)" }}>
            <div style={{ display: "flex", gap: 7 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f57" }} /><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#febc2e" }} /><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#28c840" }} /></div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 3, color: "rgba(160,185,225,0.7)" }}>SCHOLARLENS · CONTROL CENTER</div>
            <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: "rgba(120,200,140,0.85)" }}>● LIVE</div>
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div style={{ width: 212, borderRight: "1px solid rgba(159,180,216,0.14)", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
              {[
                { ic: "◇", t: "Knowledge Graph", active: true },
                { ic: "▤", t: "Library" }, { ic: "◈", t: "Paper Details" }, { ic: "⌕", t: "Semantic Search" }, { ic: "◆", t: "Claim Explorer" },
                { ic: "⚡", t: "Contradictions", badge: "37", bc: "#ff9a9a", bbg: "rgba(255,90,90,0.18)", tcol: "rgba(255,150,150,0.85)" },
                { ic: "✦", t: "Hypothesis Gen", badge: "12", bc: "#7fe6d8", bbg: "rgba(53,208,192,0.16)", tcol: "rgba(110,222,205,0.9)" },
                { ic: "◉", t: "Research Monitor" },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 8, fontSize: 13, fontWeight: r.active ? 500 : 400, background: r.active ? "rgba(159,180,216,0.14)" : "transparent", color: r.active ? "#dce8fb" : r.tcol || "rgba(190,205,230,0.7)" }}>
                  <span style={{ opacity: 0.7 }}>{r.ic}</span> {r.t}
                  {r.badge && <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, background: r.bbg, color: r.bc, padding: "2px 6px", borderRadius: 6 }}>{r.badge}</span>}
                </div>
              ))}
              <div style={{ marginTop: "auto", padding: 11, border: "1px solid rgba(159,180,216,0.25)", borderRadius: 9, background: "rgba(159,180,216,0.06)" }}>
                <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: 2, color: "rgba(170,190,225,0.7)" }}>LIBRARY</div>
                <div style={{ marginTop: 3, fontSize: 13, color: "#e7eefb" }}>Your papers</div>
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
              <div style={{ flex: 1.5, position: "relative", minWidth: 0, borderRight: "1px solid rgba(159,180,216,0.14)", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 16, top: 14, zIndex: 2, fontFamily: MONO, fontSize: 9, letterSpacing: 3, color: "rgba(150,170,205,0.6)" }}>KNOWLEDGE GRAPH · 512 CLAIMS</div>
                <svg viewBox="0 0 520 420" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
                  <g stroke="rgba(200,164,90,0.34)" strokeWidth="1">
                    <line x1="160" y1="150" x2="250" y2="210" /><line x1="250" y1="210" x2="350" y2="160" /><line x1="250" y1="210" x2="230" y2="320" /><line x1="350" y1="160" x2="400" y2="250" /><line x1="230" y1="320" x2="330" y2="330" /><line x1="160" y1="150" x2="120" y2="250" /><line x1="120" y1="250" x2="230" y2="320" />
                  </g>
                  <line x1="350" y1="160" x2="230" y2="320" stroke="#ff4d4d" strokeWidth="1.5" strokeDasharray="5 4" />
                  <g>
                    <circle cx="160" cy="150" r="10" fill="#9fb4d8" /><circle cx="250" cy="210" r="14" fill="#e6ecf8" /><circle cx="350" cy="160" r="9" fill="#ff5b5b" /><circle cx="230" cy="320" r="11" fill="#ff5b5b" /><circle cx="400" cy="250" r="8" fill="#caa45a" /><circle cx="120" cy="250" r="7" fill="#9fb4d8" /><circle cx="330" cy="330" r="8" fill="#e6ecf8" />
                    <circle cx="295" cy="245" r="9" fill="none" stroke="#35d0c0" strokeWidth="1.5" strokeDasharray="3 3" />
                  </g>
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", gap: 11, overflow: "hidden" }}>
                <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 3, color: "rgba(255,140,140,0.8)" }}>CONTRADICTION EXPLORER</div>
                <div style={{ padding: "11px 12px", border: "1px solid rgba(255,90,90,0.28)", borderRadius: 9, background: "rgba(255,70,70,0.05)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1, color: "#ff9a9a", border: "1px solid rgba(255,90,90,0.4)", borderRadius: 5, padding: "2px 6px" }}>CONTRADICTS</span><span style={{ fontFamily: MONO, fontSize: 9, color: "rgba(170,190,220,0.5)" }}>open</span></div>
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: "#e9eefa" }}>&ldquo;Abilities emerge abruptly at scale.&rdquo;</div>
                  <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.4, color: "rgba(220,200,205,0.7)" }}>vs &ldquo;emergence is a metric artifact.&rdquo;</div>
                </div>
                <div style={{ padding: "11px 12px", border: "1px solid rgba(200,164,90,0.3)", borderRadius: 9, background: "rgba(200,164,90,0.04)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1, color: "#e6c690", border: "1px solid rgba(200,164,90,0.4)", borderRadius: 5, padding: "2px 6px" }}>SUPPORTS</span><span style={{ fontFamily: MONO, fontSize: 9, color: "rgba(170,190,220,0.5)" }}>multiple papers</span></div>
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: "#e9eefa" }}>Scaling laws stay smooth and predictable.</div>
                </div>
                <div style={{ marginTop: "auto", padding: 12, border: "1px solid rgba(124,111,255,0.4)", borderRadius: 10, background: "rgba(124,111,255,0.08)" }}>
                  <div style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: 2, color: "rgba(168,158,255,0.95)" }}>✦ SUGGESTED HYPOTHESIS</div>
                  <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.4, color: "#e4e0ff" }}>Test for true discontinuities under continuous metrics.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
