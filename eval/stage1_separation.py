"""
Stage-1 retrieval separation: MiniLM vs BGE on the existing gold set.

WHAT THIS MEASURES (and what it does NOT)
-----------------------------------------
The contradiction eval (run_eval.py) measures STAGE 2 — the judge — in
isolation, by feeding it hand-labeled pairs directly. Swapping the embedding
model CANNOT move that number, because the judge never sees an embedding.

What an embedding swap DOES move is STAGE 1: which pairs from the library clear
the similarity threshold and reach the judge at all. A better retrieval model
should rank genuinely-related pairs (contradiction / support / nuance) ABOVE
unrelated pairs, so a single threshold cleanly separates them.

This script reuses the 30 gold pairs to measure exactly that separation, for
both models, with no new labeling:
  - should-surface  = labels {contradiction, support, nuance}
  - should-reject   = label  {unrelated}

HONESTY GUARD
-------------
The gold set was built to stress the JUDGE (hard-to-classify pairs), not to
stress RETRIEVAL (pairs across the full similarity range). If the unrelated
pairs don't actually sit lower in similarity than the should-surface ones,
this set CANNOT measure retrieval quality — and the script says so, loudly,
instead of printing a confident-looking but meaningless sweep.

USAGE (run locally, where model weights are cached — NOT in the sandbox)
    python -m eval.stage1_separation
    python -m eval.stage1_separation --gold eval/gold_claims.json
"""

import argparse
import json
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_GOLD = EVAL_DIR / "gold_claims.json"

SHOULD_SURFACE = {"contradiction", "support", "nuance"}
THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8]

# The two models under comparison. (query_prefix is applied to BOTH claim
# texts here, matching how find_claim_pairs treats claims as documents — BGE's
# prefix is for queries, and claim-vs-claim similarity uses no query, so we
# embed both claims bare. This mirrors production exactly.)
MODELS = {
    "MiniLM (current)": {"name": "all-MiniLM-L6-v2", "prefix": ""},
    "BGE-base (new)":   {"name": "BAAI/bge-base-en-v1.5", "prefix": ""},
}


def cosine(a, b):
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def load_gold(path):
    with open(path) as f:
        return json.load(f)


def embed_pairs(gold, model_name, prefix):
    """Return list of (similarity, label) for every gold pair under one model."""
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(model_name)

    texts_a = [prefix + g["claim_a"]["text"] for g in gold]
    texts_b = [prefix + g["claim_b"]["text"] for g in gold]
    emb_a = model.encode(texts_a, show_progress_bar=False).tolist()
    emb_b = model.encode(texts_b, show_progress_bar=False).tolist()

    return [
        (cosine(emb_a[i], emb_b[i]), gold[i]["label"])
        for i in range(len(gold))
    ]


def diagnostic(sims_labels, model_label):
    """Print similarity distribution and judge whether the set can discriminate."""
    surface = [s for s, l in sims_labels if l in SHOULD_SURFACE]
    reject = [s for s, l in sims_labels if l not in SHOULD_SURFACE]

    s_min, s_max = min(surface), max(surface)
    s_mean = sum(surface) / len(surface)
    r_min, r_max = min(reject), max(reject)
    r_mean = sum(reject) / len(reject)

    print(f"\n=== {model_label} — similarity distribution ===")
    print(f"  should-surface ({len(surface)}): "
          f"min={s_min:.3f}  mean={s_mean:.3f}  max={s_max:.3f}")
    print(f"  should-reject  ({len(reject)}): "
          f"min={r_min:.3f}  mean={r_mean:.3f}  max={r_max:.3f}")
    gap = s_mean - r_mean
    print(f"  mean separation: {gap:+.3f}  "
          f"(positive = related pairs score higher, as desired)")

    # Can a single threshold separate them at all?
    if r_max >= s_min:
        overlap = sum(1 for s in reject if s >= s_min)
        print(f"  ⚠ OVERLAP: {overlap} unrelated pair(s) score >= the lowest "
              f"related pair. No single threshold perfectly separates this set.")
    if gap < 0.05:
        print("  ⚠ WEAK SEPARATION (<0.05). This gold set may be too judge-focused "
              "to measure retrieval. Consider adding deliberate low-similarity "
              "negatives before trusting the sweep below.")
    return gap


def sweep(sims_labels, model_label):
    """Per-threshold recall on should-surface and rejection on should-reject."""
    surface = [s for s, l in sims_labels if l in SHOULD_SURFACE]
    reject = [s for s, l in sims_labels if l not in SHOULD_SURFACE]
    n_s, n_r = len(surface), len(reject)

    print(f"\n=== {model_label} — threshold sweep ===")
    print(f"{'thresh':>7} | {'surfaced':>8} | {'recall':>7} | "
          f"{'rejected':>8} | {'reject%':>7} | {'F1*':>6}")
    print("-" * 60)
    for t in THRESHOLDS:
        tp = sum(1 for s in surface if s >= t)   # related pairs that surface
        fp = sum(1 for s in reject if s >= t)    # unrelated pairs that leak in
        fn = n_s - tp                            # related pairs missed
        tn = n_r - fp                            # unrelated correctly rejected

        recall = tp / n_s if n_s else 0.0
        reject_rate = tn / n_r if n_r else 0.0
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        f1 = (2 * prec * recall / (prec + recall)) if (prec + recall) else 0.0

        print(f"{t:>7.2f} | {tp:>8} | {recall:>7.2f} | "
              f"{tn:>8} | {reject_rate:>7.2f} | {f1:>6.2f}")
    print("  F1* = retrieval F1 (surface related, reject unrelated). "
          "NOT the judge's F1.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", type=Path, default=DEFAULT_GOLD)
    args = parser.parse_args()

    gold = load_gold(args.gold)
    print(f"Loaded {len(gold)} gold pairs from {args.gold}")
    print(f"  should-surface: {sum(1 for g in gold if g['label'] in SHOULD_SURFACE)}")
    print(f"  should-reject : {sum(1 for g in gold if g['label'] not in SHOULD_SURFACE)}")

    results = {}
    for label, cfg in MODELS.items():
        print(f"\nEmbedding under {label} ({cfg['name']}) ...")
        sims_labels = embed_pairs(gold, cfg["name"], cfg["prefix"])
        gap = diagnostic(sims_labels, label)
        sweep(sims_labels, label)
        results[label] = gap

    print("\n" + "=" * 60)
    print("VERDICT")
    print("=" * 60)
    labels = list(results.keys())
    delta = results[labels[1]] - results[labels[0]]
    print(f"Mean-separation gap:  {labels[0]} = {results[labels[0]]:+.3f},  "
          f"{labels[1]} = {results[labels[1]]:+.3f}")
    if delta > 0.02:
        print(f"→ {labels[1]} separates related from unrelated BETTER "
              f"(by {delta:+.3f}). The swap is justified on retrieval grounds.")
    elif delta < -0.02:
        print(f"→ {labels[1]} separates WORSE (by {delta:+.3f}). "
              f"Reconsider the swap, or the gold set isn't capturing the gain.")
    else:
        print(f"→ No meaningful difference ({delta:+.3f}). Either the models are "
              f"comparable on this set, OR the set can't measure retrieval "
              f"(check the overlap/weak-separation warnings above).")


if __name__ == "__main__":
    main()
