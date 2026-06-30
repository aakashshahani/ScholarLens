"""
Search Reranking Eval Harness

Measures whether the Voyage cross-encoder reranker actually improves search
ordering over pure vector (cosine) ranking. Self-contained: it ships its own
graded gold set (gold_search.json) and never touches the production database,
exactly like the contradiction eval.

For each query the gold set lists candidate passages with a graded relevance
label (0 irrelevant -> 3 directly answers). We rank the SAME candidates two
ways and score each ordering:

  - vector  : order by cosine distance of Voyage embeddings (query vs passage)
  - rerank  : order by the Voyage reranker's (query, passage) relevance score

Metrics (higher = better):
  - nDCG@k : rewards putting high-relevance passages near the top, discounted
             by rank. The honest metric for graded relevance.
  - MRR    : 1 / rank of the first "relevant" passage (relevance >= 2).

The point is the DELTA. If reranking doesn't beat vector ranking on this set,
the harness says so plainly rather than implying a win.

Requires VOYAGE_API_KEY (embeddings + reranker are API calls).

Usage:
    python -m eval.rerank_eval
    python -m eval.rerank_eval --gold eval/gold_search.json --k 5
"""

import argparse
import json
import math
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from utils.vector_store import VectorStore  # noqa: E402

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_GOLD = EVAL_DIR / "gold_search.json"
RELEVANT_THRESHOLD = 2  # relevance >= this counts as "relevant" for MRR


# ── Metrics ──────────────────────────────────────────────────

def dcg(relevances: list[int]) -> float:
    """Discounted cumulative gain for a ranked list of relevance grades."""
    return sum(rel / math.log2(i + 2) for i, rel in enumerate(relevances))


def ndcg_at_k(ranked_relevances: list[int], k: int) -> float:
    """nDCG@k: DCG of the produced order vs the ideal order, in [0, 1]."""
    ranked = ranked_relevances[:k]
    ideal = sorted(ranked_relevances, reverse=True)[:k]
    idcg = dcg(ideal)
    return dcg(ranked) / idcg if idcg > 0 else 0.0


def mrr(ranked_relevances: list[int]) -> float:
    """Reciprocal rank of the first relevant (grade >= threshold) passage."""
    for i, rel in enumerate(ranked_relevances):
        if rel >= RELEVANT_THRESHOLD:
            return 1.0 / (i + 1)
    return 0.0


# ── Rankers ──────────────────────────────────────────────────

def vector_order(vs: VectorStore, query: str, passages: list[str]) -> list[int]:
    """Indices of `passages` ordered by ascending cosine distance to query."""
    q = vs.embed_query(query)
    docs = vs.embed_texts(passages)

    def cos_dist(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        return 1.0 - (dot / (na * nb)) if na and nb else 1.0

    dists = [(i, cos_dist(q, d)) for i, d in enumerate(docs)]
    dists.sort(key=lambda t: t[1])
    return [i for i, _ in dists]


def rerank_order(vs: VectorStore, query: str, passages: list[str]) -> list[int]:
    """Indices of `passages` ordered best-first by the Voyage reranker."""
    return [idx for idx, _score in vs.rerank(query, passages)]


# ── Eval loop ────────────────────────────────────────────────

def evaluate(gold: list[dict], k: int) -> dict:
    vs = VectorStore()
    rows = []
    for q in gold:
        query = q["query"]
        passages = [p["text"] for p in q["passages"]]
        rels = [int(p["relevance"]) for p in q["passages"]]

        v_idx = vector_order(vs, query, passages)
        r_idx = rerank_order(vs, query, passages)

        v_rels = [rels[i] for i in v_idx]
        r_rels = [rels[i] for i in r_idx]

        rows.append({
            "id": q["id"],
            "query": query,
            "vector": {"ndcg": ndcg_at_k(v_rels, k), "mrr": mrr(v_rels)},
            "rerank": {"ndcg": ndcg_at_k(r_rels, k), "mrr": mrr(r_rels)},
        })

    def mean(path_a, path_b):
        return sum(r[path_a][path_b] for r in rows) / len(rows) if rows else 0.0

    return {
        "k": k,
        "per_query": rows,
        "vector_ndcg": mean("vector", "ndcg"),
        "rerank_ndcg": mean("rerank", "ndcg"),
        "vector_mrr": mean("vector", "mrr"),
        "rerank_mrr": mean("rerank", "mrr"),
    }


def main():
    parser = argparse.ArgumentParser(description="Search reranking eval harness")
    parser.add_argument("--gold", type=Path, default=DEFAULT_GOLD)
    parser.add_argument("--k", type=int, default=5, help="cutoff for nDCG@k")
    args = parser.parse_args()

    if not args.gold.exists():
        print(f"Gold file not found: {args.gold}")
        sys.exit(1)

    with open(args.gold, encoding="utf-8-sig") as f:
        gold = json.load(f)

    print(f"Loaded {len(gold)} queries from {args.gold}\n")
    res = evaluate(gold, args.k)

    print(f"{'query':>6} | {'vec nDCG':>9} {'rr nDCG':>9} | {'vec MRR':>8} {'rr MRR':>8}")
    print("-" * 52)
    for r in res["per_query"]:
        print(f"{r['id']:>6} | "
              f"{r['vector']['ndcg']:>9.3f} {r['rerank']['ndcg']:>9.3f} | "
              f"{r['vector']['mrr']:>8.3f} {r['rerank']['mrr']:>8.3f}")

    print("\n" + "=" * 52)
    print("SUMMARY")
    print("=" * 52)
    d_ndcg = res["rerank_ndcg"] - res["vector_ndcg"]
    d_mrr = res["rerank_mrr"] - res["vector_mrr"]
    print(f"nDCG@{res['k']}:  vector={res['vector_ndcg']:.3f}  "
          f"rerank={res['rerank_ndcg']:.3f}  delta={d_ndcg:+.3f}")
    print(f"MRR:      vector={res['vector_mrr']:.3f}  "
          f"rerank={res['rerank_mrr']:.3f}  delta={d_mrr:+.3f}")

    if d_ndcg > 0.01:
        print(f"\n-> Reranking improves ordering (nDCG {d_ndcg:+.3f}). "
              f"The rerank stage is justified.")
    elif d_ndcg < -0.01:
        print(f"\n-> Reranking HURTS ordering ({d_ndcg:+.3f}) on this set. "
              f"Reconsider, or the gold set is too easy for vectors.")
    else:
        print(f"\n-> No meaningful difference ({d_ndcg:+.3f}); vector ranking "
              f"already solves this set, so it can't show the rerank's value.")


if __name__ == "__main__":
    main()
