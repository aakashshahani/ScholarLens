"""
Contradiction Engine Eval Harness

Loads hand-labeled claim pairs from gold_claims.json, runs each through
the production judge_pair with use_cache=False, and reports:
  - Confusion matrix (4x4)
  - Per-class precision, recall, F1
  - Overall accuracy and macro-F1
  - Category accuracy
  - Disagreement dump (the rows where the engine got it wrong)

Usage:
    python run_eval.py                  # full eval (calls LLM)
    python run_eval.py --dry-run        # print pairs, no LLM calls
    python run_eval.py --gold other.json  # use a different gold file
"""

import argparse
import json
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ── Resolve imports ──────────────────────────────────────────
# The eval lives in eval/ but needs to import from the project root.
# Adjust this path to match your local layout.

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from agents.contradiction_agent import Claim, ClaimPair, ContradictionAgent


# ── Constants ────────────────────────────────────────────────

RELATIONSHIP_LABELS = ["contradiction", "support", "nuance", "unrelated"]
EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_GOLD = EVAL_DIR / "gold_claims.json"


# ── Load gold data ───────────────────────────────────────────

def load_gold(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)
    # Validate
    for i, entry in enumerate(data):
        assert "claim_a" in entry and "claim_b" in entry, f"Entry {i} missing claim_a or claim_b"
        assert "label" in entry, f"Entry {i} missing label"
        assert entry["label"] in RELATIONSHIP_LABELS, (
            f"Entry {i} has invalid label '{entry['label']}'. "
            f"Must be one of {RELATIONSHIP_LABELS}"
        )
    return data


def entry_to_pair(entry: dict) -> ClaimPair:
    """Convert a gold JSON entry into Claim and ClaimPair objects."""
    ca = entry["claim_a"]
    cb = entry["claim_b"]

    claim_a = Claim(
        id=str(uuid.uuid4()),
        paper_id=f"eval_paper_a_{entry['id']}",
        paper_title=ca["paper_title"],
        text=ca["text"],
        section=ca.get("section", "findings"),
        confidence=ca.get("confidence", "high"),
    )
    claim_b = Claim(
        id=str(uuid.uuid4()),
        paper_id=f"eval_paper_b_{entry['id']}",
        paper_title=cb["paper_title"],
        text=cb["text"],
        section=cb.get("section", "findings"),
        confidence=cb.get("confidence", "high"),
    )

    return ClaimPair(claim_a=claim_a, claim_b=claim_b, similarity=1.0)


# ── Metrics ──────────────────────────────────────────────────

def compute_metrics(
    gold_labels: list[str],
    pred_labels: list[str],
) -> dict:
    """Compute confusion matrix, per-class P/R/F1, accuracy, macro-F1."""

    # Confusion matrix: matrix[gold][pred] = count
    matrix = {g: {p: 0 for p in RELATIONSHIP_LABELS} for g in RELATIONSHIP_LABELS}
    for g, p in zip(gold_labels, pred_labels):
        if g in matrix and p in matrix[g]:
            matrix[g][p] += 1

    # Per-class metrics
    per_class = {}
    for label in RELATIONSHIP_LABELS:
        tp = matrix[label][label]
        fp = sum(matrix[other][label] for other in RELATIONSHIP_LABELS if other != label)
        fn = sum(matrix[label][other] for other in RELATIONSHIP_LABELS if other != label)

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

        per_class[label] = {
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
            "support": tp + fn,  # total gold instances of this class
        }

    # Overall
    correct = sum(1 for g, p in zip(gold_labels, pred_labels) if g == p)
    accuracy = correct / len(gold_labels) if gold_labels else 0.0
    macro_f1 = sum(pc["f1"] for pc in per_class.values()) / len(per_class)

    return {
        "confusion_matrix": matrix,
        "per_class": per_class,
        "accuracy": round(accuracy, 3),
        "macro_f1": round(macro_f1, 3),
        "total": len(gold_labels),
        "correct": correct,
    }


def compute_category_accuracy(
    gold_categories: list[str],
    pred_categories: list[str],
) -> dict:
    """How often the engine gets the category right, broken down by category."""
    counts = defaultdict(lambda: {"correct": 0, "total": 0})
    for g, p in zip(gold_categories, pred_categories):
        counts[g]["total"] += 1
        if g == p:
            counts[g]["correct"] += 1

    result = {}
    for cat, vals in counts.items():
        result[cat] = {
            "accuracy": round(vals["correct"] / vals["total"], 3) if vals["total"] > 0 else 0.0,
            "correct": vals["correct"],
            "total": vals["total"],
        }
    return result


# ── Display ──────────────────────────────────────────────────

def print_confusion_matrix(matrix: dict):
    labels = RELATIONSHIP_LABELS
    # Header
    header = f"{'':>15}" + "".join(f"{l:>15}" for l in labels)
    print(header)
    print("-" * len(header))
    for gold_label in labels:
        row = f"{gold_label:>15}"
        for pred_label in labels:
            count = matrix[gold_label][pred_label]
            marker = f"[{count}]" if gold_label == pred_label else str(count)
            row += f"{marker:>15}"
        print(row)
    print()


def print_per_class(per_class: dict):
    print(f"{'class':>15}  {'prec':>7}  {'recall':>7}  {'f1':>7}  {'support':>7}")
    print("-" * 55)
    for label in RELATIONSHIP_LABELS:
        m = per_class[label]
        print(f"{label:>15}  {m['precision']:>7.3f}  {m['recall']:>7.3f}  {m['f1']:>7.3f}  {m['support']:>7}")
    print()


def print_category_accuracy(cat_acc: dict):
    print("Category accuracy:")
    for cat, vals in sorted(cat_acc.items()):
        print(f"  {cat:>20}: {vals['accuracy']:.1%}  ({vals['correct']}/{vals['total']})")
    print()


# ── Dry run ──────────────────────────────────────────────────

def dry_run(gold: list[dict]):
    print(f"=== DRY RUN: {len(gold)} pairs loaded ===\n")
    label_counts = defaultdict(int)
    for entry in gold:
        label_counts[entry["label"]] += 1
        print(f"[{entry['id']}] label={entry['label']}  category={entry.get('category', '?')}")
        print(f"  A: \"{entry['claim_a']['text'][:90]}...\"")
        print(f"     ({entry['claim_a']['paper_title']})")
        print(f"  B: \"{entry['claim_b']['text'][:90]}...\"")
        print(f"     ({entry['claim_b']['paper_title']})")
        if entry.get("notes"):
            print(f"  notes: {entry['notes']}")
        print()

    print("Label distribution:")
    for label in RELATIONSHIP_LABELS:
        print(f"  {label:>15}: {label_counts.get(label, 0)}")
    print(f"\nTotal: {len(gold)} pairs")


# ── Main eval loop ───────────────────────────────────────────

def run_eval(gold: list[dict]) -> dict:
    """
    Run each gold pair through judge_pair(use_cache=False).
    Returns full results dict with metrics and disagreements.
    """
    # The agent is instantiated but we never call extract_claims or
    # find_claim_pairs — we bypass Stage 1 entirely.
    agent = ContradictionAgent()

    gold_labels = []
    pred_labels = []
    gold_categories = []
    pred_categories = []
    disagreements = []
    all_predictions = []

    print(f"Running eval on {len(gold)} pairs...\n")

    for i, entry in enumerate(gold):
        pair = entry_to_pair(entry)
        gold_label = entry["label"]
        gold_cat = entry.get("category", "unknown")

        print(f"  [{entry['id']}] {gold_label:>15} ... ", end="", flush=True)

        result = agent.judge_pair(pair, use_cache=False)

        pred_label = result.relationship
        pred_cat = result.category

        gold_labels.append(gold_label)
        pred_labels.append(pred_label)
        gold_categories.append(gold_cat)
        pred_categories.append(pred_cat)

        match = "✓" if pred_label == gold_label else "✗"
        print(f"predicted={pred_label:>15}  {match}")

        prediction_record = {
            "id": entry["id"],
            "gold_label": gold_label,
            "pred_label": pred_label,
            "gold_category": gold_cat,
            "pred_category": pred_cat,
            "correct": pred_label == gold_label,
            "explanation": result.explanation,
            "claim_a_text": entry["claim_a"]["text"],
            "claim_b_text": entry["claim_b"]["text"],
            "claim_a_paper": entry["claim_a"]["paper_title"],
            "claim_b_paper": entry["claim_b"]["paper_title"],
        }
        all_predictions.append(prediction_record)

        if pred_label != gold_label:
            disagreement = {
                **prediction_record,
                "gold_notes": entry.get("notes", ""),
                "engine_resolution": result.resolution,
                "engine_stronger_evidence": result.stronger_evidence,
            }
            disagreements.append(disagreement)

    # Compute metrics
    metrics = compute_metrics(gold_labels, pred_labels)
    cat_accuracy = compute_category_accuracy(gold_categories, pred_categories)
    kappa = compute_cohens_kappa(gold_labels, pred_labels)
    binary = compute_binary_tension(gold_labels, pred_labels)

    return {
        "metrics": metrics,
        "category_accuracy": cat_accuracy,
        "cohens_kappa": kappa,
        "binary_tension": binary,
        "disagreements": disagreements,
        "predictions": all_predictions,
        "run_time": datetime.now(timezone.utc).isoformat(),
        "gold_file": str(DEFAULT_GOLD),
        "num_pairs": len(gold),
    }


def compute_cohens_kappa(gold_labels: list[str], pred_labels: list[str]) -> float:
    """
    Cohen's kappa: agreement above chance. Robust to class imbalance in a way
    raw accuracy is not. Ranges -1 to 1; >0.6 substantial, >0.8 near-perfect.
    """
    from collections import Counter
    n = len(gold_labels)
    if n == 0:
        return 0.0
    observed = sum(1 for g, p in zip(gold_labels, pred_labels) if g == p) / n
    gold_counts = Counter(gold_labels)
    pred_counts = Counter(pred_labels)
    all_labels = set(gold_labels) | set(pred_labels)
    expected = sum(
        (gold_counts.get(lbl, 0) / n) * (pred_counts.get(lbl, 0) / n)
        for lbl in all_labels
    )
    if expected == 1.0:
        return 1.0
    return round((observed - expected) / (1 - expected), 3)


def compute_binary_tension(gold_labels: list[str], pred_labels: list[str]) -> dict:
    """
    Collapse the 4-way problem into the binary the product cares about:
    is there TENSION between the claims or not?
      Tension    = {contradiction, nuance}
      No tension = {support, unrelated}
    Far more stable than 4-way macro-F1 because the hardest boundary
    (contradiction vs nuance) is collapsed into one bucket.
    """
    def to_binary(lbl: str) -> str:
        return "tension" if lbl in ("contradiction", "nuance") else "no_tension"
    gb = [to_binary(g) for g in gold_labels]
    pb = [to_binary(p) for p in pred_labels]
    tp = sum(1 for g, p in zip(gb, pb) if g == "tension" and p == "tension")
    fp = sum(1 for g, p in zip(gb, pb) if g == "no_tension" and p == "tension")
    fn = sum(1 for g, p in zip(gb, pb) if g == "tension" and p == "no_tension")
    tn = sum(1 for g, p in zip(gb, pb) if g == "no_tension" and p == "no_tension")
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    accuracy = (tp + tn) / len(gb) if gb else 0.0
    return {
        "tension_precision": round(precision, 3),
        "tension_recall": round(recall, 3),
        "tension_f1": round(f1, 3),
        "binary_accuracy": round(accuracy, 3),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


# ── Entry point ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Contradiction engine eval harness")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print loaded pairs without calling the LLM",
    )
    parser.add_argument(
        "--gold",
        type=str,
        default=str(DEFAULT_GOLD),
        help="Path to gold claims JSON file",
    )
    args = parser.parse_args()

    gold_path = Path(args.gold)
    if not gold_path.exists():
        print(f"Gold file not found: {gold_path}")
        sys.exit(1)

    gold = load_gold(gold_path)

    if args.dry_run:
        dry_run(gold)
        return

    # Full eval
    results = run_eval(gold)

    # Print results
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60 + "\n")

    print(f"Accuracy: {results['metrics']['accuracy']:.1%}  "
          f"({results['metrics']['correct']}/{results['metrics']['total']})")
    print(f"Macro F1: {results['metrics']['macro_f1']:.3f}")
    print(f"Cohen's kappa: {results['cohens_kappa']:.3f}  "
          f"(agreement above chance; >0.6 substantial)\n")

    bt = results["binary_tension"]
    print("Binary tension mode (contradiction+nuance vs support+unrelated):")
    print(f"  tension F1: {bt['tension_f1']:.3f}   "
          f"precision: {bt['tension_precision']:.3f}   "
          f"recall: {bt['tension_recall']:.3f}")
    print(f"  binary accuracy: {bt['binary_accuracy']:.1%}\n")

    print("Confusion matrix (rows=gold, cols=predicted):")
    print_confusion_matrix(results["metrics"]["confusion_matrix"])

    print_per_class(results["metrics"]["per_class"])
    print_category_accuracy(results["category_accuracy"])

    # Disagreements
    n_disagree = len(results["disagreements"])
    if n_disagree > 0:
        print(f"Disagreements: {n_disagree} pairs\n")
        for d in results["disagreements"]:
            print(f"  [{d['id']}] gold={d['gold_label']}  pred={d['pred_label']}")
            print(f"    A: \"{d['claim_a_text'][:80]}...\"")
            print(f"    B: \"{d['claim_b_text'][:80]}...\"")
            print(f"    Engine says: {d['explanation'][:120]}")
            if d["gold_notes"]:
                print(f"    Your note:   {d['gold_notes'][:120]}")
            print()
    else:
        print("No disagreements — perfect run.\n")

    # Save to files
    disagree_path = EVAL_DIR / "disagreements.json"
    with open(disagree_path, "w", encoding="utf-8") as f:
        json.dump(results["disagreements"], f, indent=2, ensure_ascii=False)
    print(f"Disagreements saved to: {disagree_path}")

    results_path = EVAL_DIR / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({
            "metrics": results["metrics"],
            "category_accuracy": results["category_accuracy"],
            "cohens_kappa": results["cohens_kappa"],
            "binary_tension": results["binary_tension"],
            "run_time": results["run_time"],
            "num_pairs": results["num_pairs"],
            "num_disagreements": len(results["disagreements"]),
        }, f, indent=2, ensure_ascii=False)
    print(f"Metrics saved to:       {results_path}")


if __name__ == "__main__":
    main()
