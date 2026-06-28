/**
 * ScholarLens landing — shared narrative data for the "Knowledge Field" experience.
 *
 * One honest source feeds BOTH the WebGL cinematic (landing-cinematic.tsx) and the
 * static, SSR'd narrative (landing.tsx). The negotiation-AI claims below are a curated
 * DEMO narrative — not live results. Nothing here is presented to the user as a real
 * finding; it's a worked example of how ScholarLens reasons over a literature.
 *
 * Design law (shared with the rest of the product): meaning lives in the EDGES.
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

/** The 8 curated claims projected as interactive markers in the cinematic. */
export const CLAIMS: FeatureClaim[] = [
  { kind: "CLAIM",         col: "#e6ecf8", text: "LLM coaching improved negotiation performance.", meta: ["RCT", "n=240", "conf 0.88", "d=0.62"], cluster: 0 },
  { kind: "CLAIM",         col: "#caa45a", text: "Improvement was strongest for novices.",          meta: ["subgroup", "n=240", "conf 0.79"], cluster: 3 },
  { kind: "CONTRADICTION", col: "#ff5b5b", text: "Coaching gains persist after four weeks.",        meta: ["longitudinal", "n=180", "conf 0.74"], cluster: 2, chamber: true },
  { kind: "CONTRADICTION", col: "#ff5b5b", text: "Coaching gains decay within two weeks.",          meta: ["replication", "n=210", "conf 0.81"], cluster: 4, chamber: true },
  { kind: "CLAIM",         col: "#9fb4d8", text: "Coaching reduced anchoring bias in offers.",       meta: ["lab", "n=96", "conf 0.66"], cluster: 1 },
  { kind: "CLAIM",         col: "#e6ecf8", text: "Experts showed no measurable change.",             meta: ["field", "n=140", "conf 0.71"], cluster: 5 },
  { kind: "CLAIM",         col: "#9fb4d8", text: "Effect mediated by preparation time.",             meta: ["mediation", "n=320", "conf 0.69"], cluster: 1 },
  { kind: "HYPOTHESIS",    col: "#35d0c0", text: "Durability under adversarial counterparts — untested.", meta: ["generated", "H-0427"], cluster: 2, hypothesis: true },
];

/** Semantic palette (hex + normalized RGB for the GPU shaders). */
export const PALETTE = {
  bg: "#04050a",
  support: "#caa45a",
  contradiction: "#ff5b5b",
  hypothesis: "#35d0c0",
  // cluster node base colours (normalized RGB), from the prototype
  clusters: [
    [0.86, 0.9, 0.98], [0.4, 0.58, 0.86], [0.3, 0.78, 0.74],
    [0.82, 0.66, 0.4], [0.62, 0.7, 0.86], [0.52, 0.56, 0.84],
  ] as [number, number, number][],
};

/** The seven chapters — drives the rail, the aria-live region, and the static narrative. */
export interface Chapter {
  n: string;        // "01"
  scene: string;    // short rail/scale tag, e.g. "VOID"
  eyebrow: string;  // editorial label, e.g. "01 / The Void"
  title: string;    // headline line shown in the cinematic + static section
  body: string;     // prose for the static (no-JS / reduced-motion) narrative
  accent: "neutral" | "support" | "contra" | "hypothesis" | "system";
}

export const CHAPTERS: Chapter[] = [
  {
    n: "01", scene: "VOID", eyebrow: "01 / The Void",
    title: "It begins with a single paper.",
    body: "One document, glowing alone in the dark. Everything a field knows starts like this — locked inside papers that never talk to each other.",
    accent: "neutral",
  },
  {
    n: "02", scene: "CLAIM", eyebrow: "02 / Claim Extraction",
    title: "Every paper is really a bundle of claims.",
    body: "ScholarLens reads the full text and pulls each finding as the exact sentence it appears in — verbatim, traced to its source. A paper stops being a sealed box and becomes the claims inside it.",
    accent: "neutral",
  },
  {
    n: "03", scene: "NETWORK", eyebrow: "03 / Relationships",
    title: "Claims connect into evidence.",
    body: "Claims that reinforce one another draw together along amber support edges. Thousands of atomic findings begin to organize into a single connected field.",
    accent: "support",
  },
  {
    n: "04", scene: "TENSION", eyebrow: "04 / Contradictions",
    title: "ScholarLens finds where evidence disagrees.",
    body: "Red contradiction edges stretch taut across the field. Where two findings collide, the graph holds them apart under tension — these are the open questions worth investigating.",
    accent: "contra",
  },
  {
    n: "05", scene: "FIELD", eyebrow: "05 / Knowledge Graph",
    title: "Claims organize into research fields.",
    body: "Pull back, and the clusters resolve into research communities. Hundreds of claims, the papers behind them, and every contradiction between them — one navigable graph.",
    accent: "neutral",
  },
  {
    n: "06", scene: "GAP", eyebrow: "06 / Hypothesis",
    title: "A research gap becomes a hypothesis.",
    body: "In the space between clusters, ScholarLens proposes what no paper has tested yet — a hypothesis generated from the exact contradictions that motivated it.",
    accent: "hypothesis",
  },
  {
    n: "07", scene: "UNIVERSE", eyebrow: "07 / The Interface",
    title: "This universe is built from real literature.",
    body: "Everything you just saw is how ScholarLens works on your own papers — extract claims, map agreement and conflict, surface the gaps, and generate grounded hypotheses. This is how you navigate it.",
    accent: "system",
  },
];

/** Evidence Chamber — the investigative panel that opens from a contradiction marker. */
export const CHAMBER = {
  a: {
    text: "Coaching gains persist after four weeks.",
    paper: "Durable Effects of AI Negotiation Coaching",
    tags: ["LONGITUDINAL RCT", "n = 180", "conf 0.74"],
  },
  b: {
    text: "Coaching gains decay within two weeks.",
    paper: "Short-Horizon Replication of Coaching Effects",
    tags: ["REPLICATION", "n = 210", "conf 0.81"],
  },
  shared: ["skill retention", "novice cohort", "coaching dosage"],
  methodological:
    "Follow-up window of 4 weeks vs 2 weeks; spaced reminder prompts present in A, absent in B.",
  explanations:
    "Spaced reinforcement in A may sustain gains · cohort experience differs · measurement timing relative to the last session is not aligned across studies.",
  gap: "Durability under realistic adversarial counterparts is untested. ScholarLens proposes this as the next experiment.",
  footer: "ScholarLens investigates why research disagrees — it does not declare a winner.",
};
