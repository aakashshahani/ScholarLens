"""
PDF Analysis Agent — the core intelligence layer of ScholarLens.

This agent handles:
1. Extract and parse uploaded PDFs
2. Generate structured analysis (summary, methods, findings, limitations,
   key_claims, research_gaps) — now parallelized across 6 threads
3. Store chunks with embeddings for semantic search
4. Answer questions about papers using retrieved context

Analysis pipeline change:
  The original sequential agentic loop (Claude decides what to call next,
  turn by turn) was replaced with a parallel pipeline. Each of the 6 analysis
  types is a targeted single-turn LLM call; all 6 fire concurrently via
  ThreadPoolExecutor. Same cost, ~5x faster wall-clock time.

  Why: the agentic loop pattern is valuable when the task is genuinely
  open-ended and the model needs to discover what to do next. Structured
  extraction of known analysis types is not that — you know exactly what
  6 things you want. Sequential tool-call turns added ~25s of latency with
  no quality improvement over targeted parallel prompts.

  The contradiction agent retains a genuine two-stage reasoning loop where
  the LLM's judgment in stage 2 depends on vector similarity results from
  stage 1 — that's where the agentic pattern actually earns its keep.

The ask() method retains its agentic RAG loop unchanged — that one is
open-ended by nature (the model doesn't know in advance what to search for).
"""

import json
import concurrent.futures
from pathlib import Path

from anthropic import Anthropic

from config import settings
from db import Database, Paper, Chunk, AnalysisResult
from utils import extract_pdf, chunk_text, VectorStore


# ── Analysis type definitions ────────────────────────────────
# Each entry defines one targeted analysis call.
# prompt_instruction tells Claude exactly what to produce.
# max_tokens is sized per type — gaps/claims need more room than summary.

ANALYSIS_TYPES = [
    {
        "type": "summary",
        "max_tokens": 1024,
        "prompt_instruction": (
            "Write a structured summary of this paper in 2-3 paragraphs. "
            "Cover: (1) the research objective and motivation, "
            "(2) the approach and methods used, "
            "(3) the key results and what they mean. "
            "Be specific — cite numbers, datasets, and comparisons where available. "
            "Do not pad. If something is unclear in the text, say so."
        ),
    },
    {
        "type": "methods",
        "max_tokens": 1024,
        "prompt_instruction": (
            "Extract the methodology in detail. Cover: study design, "
            "data sources and size, techniques or models used, evaluation metrics, "
            "and any baselines compared against. "
            "Use a structured format with clear labels. "
            "Quote specific numbers (sample sizes, train/test splits, hyperparameters) "
            "where present. Flag anything that is underspecified."
        ),
    },
    {
        "type": "findings",
        "max_tokens": 1024,
        "prompt_instruction": (
            "List the key findings as a structured set of bullet points. "
            "Each finding should be a specific, falsifiable claim with supporting "
            "evidence from the paper (numbers, effect sizes, significance levels). "
            "Distinguish between primary findings and secondary/incidental observations. "
            "Do not restate the abstract — go deeper into the results section."
        ),
    },
    {
        "type": "limitations",
        "max_tokens": 768,
        "prompt_instruction": (
            "Identify the limitations of this paper honestly. Include: "
            "methodological limitations, scope constraints (what population/domain "
            "the findings do and don't generalize to), threats to validity, "
            "and anything the authors themselves flag as future work. "
            "Be critical where warranted — a limitation section that says "
            "'no limitations' is a red flag, not a pass."
        ),
    },
    {
        "type": "key_claims",
        "max_tokens": 1024,
        "prompt_instruction": (
            "Extract the paper's central claims — the specific assertions it "
            "is asking you to believe after reading it. "
            "For each claim: state it precisely in one sentence, rate confidence "
            "(high/medium/low) based on the quality of evidence provided, and note "
            "what evidence supports it. "
            "Focus on claims that could be cited, replicated, or contradicted by "
            "another paper. Avoid vague generalities."
        ),
    },
    {
        "type": "research_gaps",
        "max_tokens": 1024,
        "prompt_instruction": (
            "Identify what questions this paper leaves open or explicitly defers "
            "to future work. Also note gaps the paper does NOT acknowledge but "
            "that are apparent from the methodology or findings — e.g. untested "
            "populations, uncontrolled variables, missing ablations. "
            "Frame each gap as a specific researchable question. "
            "These gaps are the raw material for hypothesis generation."
        ),
    },
]

# Keep TOOLS for the ask() RAG loop — that one is still agentic
TOOLS = [
    {
        "name": "search_paper_chunks",
        "description": (
            "Semantic search across stored paper chunks. Use this to find "
            "relevant passages when answering questions about papers. "
            "Returns the most similar chunks with their section labels."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language search query",
                },
                "paper_id": {
                    "type": "string",
                    "description": "Optional: filter to a specific paper ID",
                },
                "n_results": {
                    "type": "integer",
                    "description": "Number of results (default 5)",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
    },
]


class PDFAnalysisAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()

    # ── Metadata Extraction ──────────────────────────────────

    def _extract_metadata(self, first_pages_text: str) -> dict:
        """Use Claude to extract title, authors, year, abstract from paper text."""
        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "Extract metadata from this academic paper text. "
                        "Return ONLY valid JSON with these fields:\n"
                        '{"title": "...", "authors": ["First Last", ...], '
                        '"year": 2024, "abstract": "..."}\n\n'
                        "If you can't find a field, use null for year and "
                        "empty string/array for others. Do NOT include any "
                        "text outside the JSON object.\n\n"
                        f"Paper text:\n{first_pages_text}"
                    ),
                }],
            )
            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()
            meta = json.loads(raw)
            if not isinstance(meta.get("authors"), list):
                meta["authors"] = []
            if isinstance(meta.get("year"), str):
                try:
                    meta["year"] = int(meta["year"])
                except ValueError:
                    meta["year"] = None
            return meta
        except Exception as e:
            print(f"Metadata extraction failed: {e}")
            return {"title": "", "authors": [], "year": None, "abstract": ""}

    # ── Core Ingest Pipeline ─────────────────────────────────

    def ingest_pdf(self, file_path: str | Path, filename: str | None = None) -> Paper:
        """
        Full ingestion pipeline:
        1. Extract text from PDF
        2. Chunk text with section awareness
        3. Embed and store chunks in ChromaDB
        4. Create paper record in SQLite
        Returns the Paper object with its ID.
        """
        file_path = Path(file_path)
        extracted = extract_pdf(file_path)

        meta = self._extract_metadata(extracted.full_text[:6000])

        paper = Paper(
            id=Paper.new_id(),
            title=meta.get("title", filename or file_path.stem),
            authors=meta.get("authors", []),
            abstract=meta.get("abstract", ""),
            year=meta.get("year"),
            source="upload",
            filename=filename or file_path.name,
            full_text=extracted.full_text,
            page_count=extracted.page_count,
        )
        self.db.insert_paper(paper)

        text_chunks = chunk_text(
            extracted.pages,
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
        )

        if text_chunks:
            db_chunks = []
            chunk_ids = []
            texts = []
            paper_ids_list = []
            sections = []

            for tc in text_chunks:
                chunk = Chunk(
                    id=Chunk.new_id(),
                    paper_id=paper.id,
                    text=tc.text,
                    chunk_index=tc.chunk_index,
                    section=tc.section,
                    page_number=tc.page_number,
                )
                db_chunks.append(chunk)
                chunk_ids.append(chunk.id)
                texts.append(tc.text)
                paper_ids_list.append(paper.id)
                sections.append(tc.section)

            self.vector_store.add_chunks(chunk_ids, texts, paper_ids_list, sections)

            for chunk, cid in zip(db_chunks, chunk_ids):
                chunk.embedding_id = cid
            self.db.insert_chunks(db_chunks)

        return paper

    # ── Parallel Analysis Pipeline ───────────────────────────

    def _run_single_analysis(
        self,
        paper_id: str,
        paper_title: str,
        text: str,
        analysis_type: str,
        prompt_instruction: str,
        max_tokens: int,
    ) -> dict:
        """
        Run one targeted analysis call and persist the result.

        Called concurrently by analyze_paper — each invocation gets its own
        Anthropic client call. Thread-safe: db.insert_analysis uses a new
        SQLite connection per call (WAL mode handles concurrent writes).

        Returns a status dict for logging.
        """
        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=max_tokens,
                messages=[{
                    "role": "user",
                    "content": (
                        f"Paper: {paper_title}\n\n"
                        f"Full text (may be truncated):\n{text}\n\n"
                        "---\n\n"
                        f"{prompt_instruction}"
                    ),
                }],
            )
            content = response.content[0].text.strip()
            self.db.insert_analysis(AnalysisResult(
                id=AnalysisResult.new_id(),
                paper_id=paper_id,
                analysis_type=analysis_type,
                content=content,
            ))
            return {"type": analysis_type, "status": "ok", "chars": len(content)}
        except Exception as e:
            print(f"Analysis failed [{analysis_type}] for {paper_id}: {e}")
            return {"type": analysis_type, "status": "error", "error": str(e)}

    def analyze_paper(self, paper_id: str) -> list[dict]:
        """
        Run all 6 analysis types concurrently for a paper.

        Each analysis is a targeted single-turn LLM call with a specific
        prompt — no tool use, no multi-turn loop. All 6 fire in parallel
        via ThreadPoolExecutor and results are persisted as they complete.

        Skip types that are already stored (idempotent — safe to call on a
        paper that was partially analyzed).

        Returns a list of status dicts, one per analysis type.
        """
        paper = self.db.get_paper(paper_id)
        if not paper:
            print(f"analyze_paper: paper {paper_id} not found")
            return []

        if not paper.full_text:
            print(f"analyze_paper: paper {paper_id} has no stored text")
            return []

        # Skip types already stored — makes re-runs idempotent
        existing = {a.analysis_type for a in self.db.get_analyses_for_paper(paper_id)}
        pending = [a for a in ANALYSIS_TYPES if a["type"] not in existing]

        if not pending:
            return [{"type": a["type"], "status": "already_stored"} for a in ANALYSIS_TYPES]

        # Truncate text once, shared across all threads (read-only)
        text = paper.full_text[:32000]
        if len(paper.full_text) > 32000:
            text += "\n\n[text truncated — full content searchable via semantic search]"

        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(pending)) as executor:
            futures = {
                executor.submit(
                    self._run_single_analysis,
                    paper_id,
                    paper.title,
                    text,
                    a["type"],
                    a["prompt_instruction"],
                    a["max_tokens"],
                ): a["type"]
                for a in pending
            }
            for future in concurrent.futures.as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as e:
                    atype = futures[future]
                    print(f"analyze_paper thread error [{atype}]: {e}")
                    results.append({"type": atype, "status": "error", "error": str(e)})

        return results

    # ── Question Answering (agentic RAG — unchanged) ─────────

    def ask(self, question: str, paper_id: str | None = None) -> str:
        """
        Answer a question using retrieved context from the paper library.

        Retains the agentic loop: the model doesn't know in advance what
        to search for, so it issues search calls, reads results, and decides
        whether to search again or answer. This is genuinely open-ended
        in a way that paper analysis is not.
        """
        system_prompt = """You are ScholarLens, a research assistant with access to
a library of analyzed papers. Answer questions using the search tool to find
relevant passages. Always cite which paper and section your answer comes from.
If the evidence is insufficient, say so clearly."""

        messages = [{"role": "user", "content": question}]

        max_turns = 5

        for turn in range(max_turns):
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=2048,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )

            assistant_content = response.content
            has_tool_use = any(b.type == "tool_use" for b in assistant_content)

            messages.append({"role": "assistant", "content": assistant_content})

            if has_tool_use:
                tool_result_content = [
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": self._execute_search_tool(block.input),
                    }
                    for block in assistant_content
                    if block.type == "tool_use"
                ]
                messages.append({"role": "user", "content": tool_result_content})
            else:
                break

        final_text = ""
        for block in response.content:
            if block.type == "text":
                final_text += block.text

        return final_text

    def _execute_search_tool(self, tool_input: dict) -> str:
        """Execute the search_paper_chunks tool for the ask() loop."""
        try:
            results = self.vector_store.search(
                query=tool_input["query"],
                n_results=tool_input.get("n_results", 5),
                paper_id=tool_input.get("paper_id"),
            )
            return json.dumps([
                {
                    "paper_id": r.paper_id,
                    "section": r.section,
                    "text": r.text[:500],
                    "similarity_score": round(r.score, 4),
                }
                for r in results
            ])
        except Exception as e:
            return json.dumps({"error": str(e)})
