/**
 * ScholarLens landing — shared narrative data for the "Knowledge Field" experience.
 *
 * One source feeds BOTH the WebGL cinematic (landing-cinematic.tsx) and the static,
 * SSR'd narrative (landing.tsx).
 *
 * The worked example is REAL and verifiable, not fabricated: the well-known "emergent
 * abilities" debate in ML — Wei et al. (2022, "Emergent Abilities of Large Language
 * Models", TMLR) argued some capabilities appear abruptly at a critical scale; Schaeffer,
 * Miranda & Koyejo (2023, NeurIPS Outstanding Paper, "Are Emergent Abilities of LLMs a
 * Mirage?") showed those abrupt jumps are largely an artifact of discontinuous metrics.
 * Papers, venues, and findings are accurate. This is honest precision for a skeptical ML
 * audience, and it demonstrates the core value prop: ScholarLens shows WHY findings
 * disagree without declaring a winner.
 *
 * Design law (shared with the product): meaning lives in the EDGES.
 * amber = support · red = contradiction · teal = hypothesis · purple --gen = system voice.
 */

export type ClaimKind = "CLAIM" | "CONTRADICTION" | "HYPOTHESIS";

export interface FeatureClaim {
  kind: ClaimKind;
  col: string;
  text: string;
  meta: string[];
  cluster: number;
  chamber?: boolean;
  hypothesis?: boolean;
}

/** The 8 markers projected into the cinematic — real claims from the LLM-scaling literature. */
export const CLAIMS: FeatureClaim[] = [
  { kind: "CLAIM",         col: "#e6ecf8", text: "Larger language models follow smooth, predictable scaling laws.", meta: ["scaling laws"], cluster: 0 },
  { kind: "CLAIM",         col: "#caa45a", text: "Some capabilities appear only once models pass a certain size.",  meta: ["emergence"], cluster: 3 },
  { kind: "CONTRADICTION", col: "#ff5b5b", text: "Emergent abilities appear abruptly at a critical scale.",         meta: ["TMLR 2022"], cluster: 2, chamber: true },
  { kind: "CONTRADICTION", col: "#ff5b5b", text: "Those abilities are a mirage — an artifact of the metric.",       meta: ["NeurIPS 2023"], cluster: 4, chamber: true },
  { kind: "CLAIM",         col: "#9fb4d8", text: "Under continuous metrics, capability gains look smooth.",          meta: ["metrics"], cluster: 1 },
  { kind: "CLAIM",         col: "#e6ecf8", text: "Chain-of-thought prompting unlocks multi-step reasoning at scale.", meta: ["prompting"], cluster: 5 },
  { kind: "CLAIM",         col: "#9fb4d8", text: "Some benchmark jumps reflect test-set contamination.",            meta: ["evaluation"], cluster: 1 },
  { kind: "HYPOTHESIS",    col: "#35d0c0", text: "Which abilities show true discontinuities under calibrated metrics? — untested.", meta: ["generated"], cluster: 2, hypothesis: true },
];

/** Semantic palette (hex + normalized RGB for the GPU shaders). */
export const PALETTE = {
  bg: "#04050a",
  support: "#caa45a",
  contradiction: "#ff5b5b",
  hypothesis: "#35d0c0",
  clusters: [
    [0.86, 0.9, 0.98], [0.4, 0.58, 0.86], [0.3, 0.78, 0.74],
    [0.82, 0.66, 0.4], [0.62, 0.7, 0.86], [0.52, 0.56, 0.84],
  ] as [number, number, number][],
};

/** The seven chapters — drives the rail, the aria-live region, and the static narrative. */
export interface Chapter {
  n: string;
  scene: string;
  eyebrow: string;
  title: string;
  body: string;
  accent: "neutral" | "support" | "contra" | "hypothesis" | "system";
}

export const CHAPTERS: Chapter[] = [
  {
    n: "01", scene: "VOID", eyebrow: "01 / Your papers",
    title: "Start with the pile you can't get through.",
    body: "Drop in a literature — ten papers or ten thousand. ScholarLens reads each one in full, the way you would if you had the time.",
    accent: "neutral",
  },
  {
    n: "02", scene: "CLAIM", eyebrow: "02 / Claim extraction",
    title: "Every paper is a bundle of claims.",
    body: "ScholarLens pulls each finding out as a discrete claim, quoted and traced to the sentence it came from. The 2022 “emergent abilities” paper, for instance, becomes three: some abilities are absent in small models, they appear abruptly with scale, and they're hard to predict in advance.",
    accent: "neutral",
  },
  {
    n: "03", scene: "NETWORK", eyebrow: "03 / Relationships",
    title: "Claims agree more than papers do.",
    body: "Across your library, claims that point the same way link together — the consensus you'd never catch scanning titles and abstracts.",
    accent: "support",
  },
  {
    n: "04", scene: "TENSION", eyebrow: "04 / Contradictions",
    title: "And then they collide.",
    body: "ScholarLens surfaces claims that directly contradict each other — like the 2022 claim that LLM abilities emerge abruptly at scale, and the 2023 reanalysis arguing that “emergence” is an artifact of the metric.",
    accent: "contra",
  },
  {
    n: "05", scene: "FIELD", eyebrow: "05 / Knowledge graph",
    title: "One field, one view.",
    body: "Claims cluster into the questions a field is actually arguing about. You navigate the whole literature as a graph instead of a reading list.",
    accent: "neutral",
  },
  {
    n: "06", scene: "GAP", eyebrow: "06 / Hypotheses",
    title: "The gap is the interesting part.",
    body: "Where the evidence conflicts or runs out, ScholarLens proposes the experiment that would settle it — grounded in the exact claims that motivated it.",
    accent: "hypothesis",
  },
  {
    n: "07", scene: "WORKSPACE", eyebrow: "07 / The workspace",
    title: "All of it, on your own library.",
    body: "Extract claims, map agreement and conflict, open any contradiction, and generate grounded hypotheses — from your papers, not a demo.",
    accent: "system",
  },
];

/** Evidence Chamber — the real "emergent abilities" contradiction, as ScholarLens sees it. */
export const CHAMBER = {
  a: {
    text: "Large language models show emergent abilities that appear abruptly at a critical scale.",
    paper: "Wei et al. — Emergent Abilities of Large Language Models, TMLR (2022)",
    tags: ["EMERGENCE", "TMLR 2022"],
  },
  b: {
    text: "Those abilities are a mirage — an artifact of discontinuous metrics, not a real change at scale.",
    paper: "Schaeffer, Miranda & Koyejo — NeurIPS (2023)",
    tags: ["REANALYSIS", "NeurIPS 2023"],
  },
  shared: ["model scale", "capability evaluation", "benchmark metrics"],
  methodological:
    "Schaeffer et al. re-scored the same models with continuous metrics (e.g. token edit distance) instead of exact-match accuracy — and the abrupt jumps largely disappeared.",
  explanations:
    "The sharp jumps may be a measurement artifact; or genuine discontinuities exist on specific tasks; or the threshold reflects the metric's nonlinearity, not a change in the model.",
  gap: "Which capabilities — if any — show true discontinuities under continuous, well-calibrated metrics? ScholarLens proposes this as the open question.",
  footer: "ScholarLens investigates why research disagrees — it does not declare a winner.",
};
