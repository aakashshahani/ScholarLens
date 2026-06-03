"""
BM25 index for keyword-based claim retrieval.

Used as the second pass in the contradiction pipeline's Stage 1.
Dense (vector) retrieval catches semantically similar claims but misses
pairs that use different vocabulary for the same concept. BM25 catches
those by matching on shared rare terms — method names, dataset names,
metric names, acronyms — that appear verbatim in both claims.

Example of what BM25 catches that dense retrieval misses:
  Claim A: "BERT fails on documents exceeding 512 tokens"
  Claim B: "transformer attention degrades on long-context inputs"
  → Low cosine similarity (different vocabulary), but both are about the
    same limitation. BM25 scores them high on "tokens"/"context" overlap.

Design decisions:
  - rank_bm25 (BM25Okapi variant): standard, no external dependencies,
    well-behaved on short texts like claims.
  - Tokenizer: lowercase + split on non-alphanumeric. No stemming, no
    stopwords — for academic claims, method/dataset names must survive
    intact ("GPT-4", "BLEU", "F1"). Stopwords add noise here, not signal.
  - The index is built per-scan from the active claim list. Claims are
    short (1-3 sentences) and scans are infrequent, so rebuilding is cheap.
  - Scores are normalised to [0, 1] against the max score in the result
    set so they can be compared to cosine similarity values carried on
    ClaimPair.similarity.
"""

import re
from dataclasses import dataclass


def _tokenize(text: str) -> list[str]:
    """
    Lowercase and split on non-alphanumeric characters.

    Keeps numbers intact (important for claims with effect sizes, sample
    sizes, p-values). Splits on hyphens so 'state-of-the-art' becomes
    ['state', 'of', 'the', 'art'] and 'GPT-4' becomes ['GPT', '4'].
    """
    return [tok for tok in re.split(r"[^a-z0-9]+", text.lower()) if tok]


@dataclass
class BM25Match:
    doc_index: int    # index into the corpus list passed to BM25Index()
    score: float      # normalised BM25 score in [0, 1]


class BM25Index:
    """
    Thin wrapper around rank_bm25.BM25Okapi.

    Usage:
        index = BM25Index(texts)           # build once per scan
        matches = index.query(text, n=10)  # top-n matches with scores
    """

    def __init__(self, texts: list[str]):
        from rank_bm25 import BM25Okapi
        self._texts = texts
        tokenized = [_tokenize(t) for t in texts]
        self._bm25 = BM25Okapi(tokenized)

    def query(self, text: str, n: int = 10) -> list[BM25Match]:
        """
        Return up to n documents most similar to text by BM25 score.

        Scores are normalised against the max score in the full result set
        so a returned score of 1.0 means "best BM25 match in the corpus"
        and 0.0 means no shared tokens. Entries with a raw score of 0 are
        excluded — they have literally no token overlap with the query.

        Returns an empty list if the index has fewer than 2 documents or
        the query tokenises to nothing (e.g. a query of punctuation only).
        """
        tokens = _tokenize(text)
        if not tokens or len(self._texts) < 2:
            return []

        raw_scores = self._bm25.get_scores(tokens)  # numpy array, length = len(texts)
        max_score = float(raw_scores.max())

        if max_score == 0.0:
            return []

        # Pair (index, normalised_score), filter zeros, sort descending
        scored = [
            BM25Match(doc_index=i, score=float(raw_scores[i]) / max_score)
            for i in range(len(self._texts))
            if raw_scores[i] > 0.0
        ]
        scored.sort(key=lambda m: m.score, reverse=True)
        return scored[:n]

    def __len__(self) -> int:
        return len(self._texts)
