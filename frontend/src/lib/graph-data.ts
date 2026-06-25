// Shared claim-graph data for the landing experience.
//
// Design rule (see the landing concept): meaning lives in the EDGES, not the
// nodes. Claims are rendered neutral; relationships carry all the color.
// Purple (`gen`) is reserved for the system's own voice — verdicts/hypotheses.
//
// The corpus below is a small, real-feeling slice of a negotiation-AI
// literature: every claim is phrased as the verbatim finding it would be
// extracted as, and the relationships form one clear contradiction cluster
// (c1/c2/c3/c4) plus calmer consensus around adaptation (c6/c7/c10/c12).

export type RelType = "support" | "contra" | "nuance";

export const REL_COLOR: Record<RelType, string> = {
  contra: "#FF5C5C",
  support: "#3DD4A0",
  nuance: "#F5A623",
};
export const GEN = "#7C6FFF";
export const NODE_GREY = "#5E6470";
export const NODE_CORE = "#9BA1AD";

export const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export type Claim = {
  id: string;
  text: string;
  paper: string; // short source label
  weight: number; // 1..5 — how many papers assert it (drives node size)
};

export type Relationship = {
  a: string;
  b: string;
  type: RelType;
  // For contradictions: which side the evidence favors ("a" | "b" | "none")
  // and a one-line adjudication in the system's voice.
  verdict?: string;
  favors?: "a" | "b" | "none";
};

export const CLAIMS: Claim[] = [
  { id: "c1", text: "AI counterparty modeling improves negotiation outcomes.", paper: "Park et al. 2024", weight: 4 },
  { id: "c2", text: "Counterparty modeling does not reliably improve outcomes.", paper: "Rao & Mehta 2025", weight: 5 },
  { id: "c3", text: "Agents model a partner's preferences but fail to leverage them.", paper: "Rao & Mehta 2025", weight: 3 },
  { id: "c4", text: "Static coaching outperformed both AI conditions on empowerment.", paper: "Iqbal 2024", weight: 4 },
  { id: "c5", text: "AI prediction leads people to forgo guaranteed rewards.", paper: "Chen 2023", weight: 3 },
  { id: "c6", text: "64% of participants adapted between integrative and distributive play.", paper: "Okonkwo 2025", weight: 4 },
  { id: "c7", text: "Adaptation magnitude depends on prior strategy use.", paper: "Okonkwo 2025", weight: 3 },
  { id: "c8", text: "The better-informed side often makes the weaker concessions.", paper: "Lindqvist 2022", weight: 2 },
  { id: "c9", text: "Feedback-driven coaching raises rapport, not utility.", paper: "Iqbal 2024", weight: 3 },
  { id: "c10", text: "Phase-aligned adaptation predicts outcomes; misaligned does not.", paper: "Vasquez 2025", weight: 3 },
  { id: "c11", text: "Confidentiality concerns are the dominant adoption barrier.", paper: "Sørensen 2024", weight: 2 },
  { id: "c12", text: "Strategic adaptability is constrained by initial posture.", paper: "Vasquez 2025", weight: 3 },
];

export const RELS: Relationship[] = [
  {
    a: "c1", b: "c2", type: "contra", favors: "b",
    verdict:
      "Rao & Mehta's null result uses a larger, pre-registered sample; Park's gain is confined to integrative settings. Weight of evidence favors no reliable, general improvement.",
  },
  {
    a: "c1", b: "c3", type: "contra", favors: "b",
    verdict:
      "Modeling a partner is not the same as exploiting that model — c3 isolates the mechanism c1's outcome claim glosses over.",
  },
  { a: "c2", b: "c3", type: "support" },
  {
    a: "c4", b: "c1", type: "contra", favors: "a",
    verdict:
      "When measured on empowerment rather than payoff, the simplest intervention wins — challenging the premise that more modeling helps.",
  },
  { a: "c4", b: "c9", type: "support" },
  { a: "c5", b: "c1", type: "nuance" },
  { a: "c6", b: "c7", type: "support" },
  { a: "c7", b: "c12", type: "support" },
  { a: "c8", b: "c5", type: "nuance" },
  { a: "c10", b: "c6", type: "nuance" },
  { a: "c10", b: "c7", type: "support" },
  { a: "c2", b: "c9", type: "nuance" },
  { a: "c11", b: "c4", type: "nuance" },
];

// The generated hypothesis that resolves the central contradiction (§ generation).
export const HYPOTHESIS = {
  text:
    "Counterparty modeling improves outcomes only when adaptation is phase-aligned — reconciling why aggregate effects look null while integrative subsets show gains.",
  from: ["c1", "c2", "c10"],
  novelty: "Grounded in 3 sources · bridges 2 unconnected clusters",
};

export const claimById = (id: string) => CLAIMS.find((c) => c.id === id);
