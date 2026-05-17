"""
PDF Analysis Agent — the core intelligence layer of ScholarLens.

This agent uses Claude with tool use to:
1. Extract and parse uploaded PDFs
2. Generate structured analysis (summary, methods, findings, limitations)
3. Store chunks with embeddings for semantic search
4. Answer questions about papers using retrieved context

The agent pattern: Claude decides WHAT to analyze, tools do the work,
Claude interprets the results. This is the loop that makes it agentic
rather than just a pipeline.
"""

import json
from pathlib import Path

from anthropic import Anthropic

from config import settings
from db import Database, Paper, Chunk, AnalysisResult
from utils import extract_pdf, chunk_text, VectorStore


# ── Tool Definitions ─────────────────────────────────────────
# These are the tools Claude can call. Each maps to a real function.

TOOLS = [
    {
        "name": "extract_pdf_text",
        "description": (
            "Extract all text from a PDF file, organized by page. "
            "Returns the full text, page count, and any available metadata. "
            "Use this as the first step when analyzing a new paper."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the PDF file on disk",
                }
            },
            "required": ["file_path"],
        },
    },
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
    {
        "name": "store_analysis",
        "description": (
            "Store a structured analysis result for a paper. "
            "Use this after generating a summary, methods extraction, "
            "findings list, or limitations assessment. "
            "analysis_type must be one of: summary, methods, findings, "
            "limitations, key_claims, research_gaps."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "paper_id": {
                    "type": "string",
                    "description": "ID of the paper being analyzed",
                },
                "analysis_type": {
                    "type": "string",
                    "enum": [
                        "summary", "methods", "findings",
                        "limitations", "key_claims", "research_gaps",
                    ],
                    "description": "Type of analysis to store",
                },
                "content": {
                    "type": "string",
                    "description": "The analysis content as structured text or JSON",
                },
            },
            "required": ["paper_id", "analysis_type", "content"],
        },
    },
    {
        "name": "get_paper_metadata",
        "description": (
            "Retrieve stored metadata and prior analyses for a paper. "
            "Use this to check what's already been analyzed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "paper_id": {
                    "type": "string",
                    "description": "The paper ID to look up",
                }
            },
            "required": ["paper_id"],
        },
    },
    {
        "name": "list_library",
        "description": (
            "List all papers currently in the library with their titles, "
            "authors, and analysis status."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Max papers to return (default 20)",
                    "default": 20,
                },
            },
        },
    },
]


# ── Tool Execution ───────────────────────────────────────────

class PDFAnalysisAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()

    def _execute_tool(self, tool_name: str, tool_input: dict) -> str:
        """Route a tool call to the right function and return a string result."""
        try:
            if tool_name == "extract_pdf_text":
                return self._tool_extract_pdf(tool_input["file_path"])
            elif tool_name == "search_paper_chunks":
                return self._tool_search_chunks(
                    tool_input["query"],
                    tool_input.get("paper_id"),
                    tool_input.get("n_results", 5),
                )
            elif tool_name == "store_analysis":
                return self._tool_store_analysis(
                    tool_input["paper_id"],
                    tool_input["analysis_type"],
                    tool_input["content"],
                )
            elif tool_name == "get_paper_metadata":
                return self._tool_get_metadata(tool_input["paper_id"])
            elif tool_name == "list_library":
                return self._tool_list_library(tool_input.get("limit", 20))
            else:
                return json.dumps({"error": f"Unknown tool: {tool_name}"})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _tool_extract_pdf(self, file_path: str) -> str:
        """Extract PDF and return text + metadata for Claude to analyze."""
        from config import UPLOAD_DIR

        # If Claude passes a paper ID instead of a file path, look up the stored text
        paper = self.db.get_paper(file_path)
        if paper and paper.full_text:
            truncated_text = paper.full_text[:32000]
            if len(paper.full_text) > 32000:
                truncated_text += "\n\n[... text truncated. Full text searchable via chunks.]"
            return json.dumps({
                "page_count": paper.page_count,
                "metadata": {"title": paper.title},
                "text_preview": truncated_text,
                "total_chars": len(paper.full_text),
            })

        # Try as a filename in uploads dir
        path = Path(file_path)
        if not path.exists():
            path = UPLOAD_DIR / Path(file_path).name
        if not path.exists():
            return json.dumps({"error": f"File not found: {file_path}. Use get_paper_metadata to check stored paper data, or search_paper_chunks to find content."})

        extracted = extract_pdf(path)

        # Truncate full text for Claude's context (keep first ~8000 tokens)
        truncated_text = extracted.full_text[:32000]
        if len(extracted.full_text) > 32000:
            truncated_text += "\n\n[... text truncated for analysis. Full text stored and searchable via chunks.]"

        return json.dumps({
            "page_count": extracted.page_count,
            "metadata": extracted.metadata,
            "text_preview": truncated_text,
            "total_chars": len(extracted.full_text),
        })

    def _tool_search_chunks(
        self, query: str, paper_id: str | None, n_results: int
    ) -> str:
        results = self.vector_store.search(
            query=query, n_results=n_results, paper_id=paper_id,
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

    def _tool_store_analysis(
        self, paper_id: str, analysis_type: str, content: str,
    ) -> str:
        result = AnalysisResult(
            id=AnalysisResult.new_id(),
            paper_id=paper_id,
            analysis_type=analysis_type,
            content=content,
        )
        self.db.insert_analysis(result)
        return json.dumps({
            "status": "stored",
            "analysis_id": result.id,
            "type": analysis_type,
        })

    def _tool_get_metadata(self, paper_id: str) -> str:
        paper = self.db.get_paper(paper_id)
        if not paper:
            return json.dumps({"error": "Paper not found"})
        analyses = self.db.get_analyses_for_paper(paper_id)
        chunk_count = len(self.db.get_chunks_for_paper(paper_id))
        return json.dumps({
            "title": paper.title,
            "authors": paper.authors,
            "year": paper.year,
            "abstract": paper.abstract[:500],
            "source": paper.source,
            "chunk_count": chunk_count,
            "existing_analyses": [
                {"type": a.analysis_type, "created_at": a.created_at}
                for a in analyses
            ],
        })

    def _tool_list_library(self, limit: int) -> str:
        papers = self.db.list_papers(limit=limit)
        return json.dumps([
            {
                "id": p.id,
                "title": p.title,
                "authors": p.authors[:3],  # first 3
                "year": p.year,
                "source": p.source,
            }
            for p in papers
        ])

    # ── Metadata Extraction ────────────────────────────────────

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
            # Strip markdown fences if present
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()
            meta = json.loads(raw)
            # Ensure correct types
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

        # Extract metadata (title, authors, year, abstract) using Claude
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

        # Chunk and embed
        text_chunks = chunk_text(
            extracted.pages,
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
        )

        if text_chunks:
            db_chunks = []
            chunk_ids = []
            texts = []
            paper_ids = []
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
                paper_ids.append(paper.id)
                sections.append(tc.section)

            # Store embeddings
            self.vector_store.add_chunks(chunk_ids, texts, paper_ids, sections)

            # Update chunks with embedding IDs
            for chunk, cid in zip(db_chunks, chunk_ids):
                chunk.embedding_id = cid
            self.db.insert_chunks(db_chunks)

        return paper

    # ── Agentic Analysis Loop ────────────────────────────────

    def analyze_paper(self, paper_id: str) -> list[dict]:
        """
        Run Claude's agentic analysis on a paper.

        Claude decides what to analyze, calls tools to extract and store
        results, and continues until it's satisfied the analysis is complete.
        This is the core agent loop — Claude is in the driver's seat.
        """
        system_prompt = """You are ScholarLens, an expert research paper analyst.

You have access to tools for extracting, searching, and storing paper analyses.
When analyzing a paper, you should:

1. First check what's already been analyzed (get_paper_metadata)
2. Get the paper text using extract_pdf_text — pass the PAPER ID (not a file path).
   The text has already been extracted and stored during ingestion.
3. Generate and store EXACTLY ONE of each analysis type using store_analysis:
   - "summary": A structured summary (2-3 paragraphs covering objective, approach, key results)
   - "methods": Detailed methodology extraction (study design, data, techniques, metrics)
   - "findings": Key findings as a structured list with supporting evidence
   - "limitations": Honest limitations and potential issues
   - "key_claims": The paper's central claims, each with confidence level and evidence quality
   - "research_gaps": What questions remain open or what follow-up work is needed

IMPORTANT: Call store_analysis exactly ONCE per analysis type. Do NOT store duplicates.
Be thorough but precise. Cite specific sections and data points from the paper.
If data or methods are unclear, say so explicitly rather than guessing.

After storing all 6 analyses, provide a brief final summary to the user."""

        messages = [
            {
                "role": "user",
                "content": (
                    f"Please perform a complete analysis of paper {paper_id}. "
                    f"Check its metadata first, then extract the text and generate "
                    f"all analysis types (summary, methods, findings, limitations, "
                    f"key_claims, research_gaps)."
                ),
            }
        ]

        # Agent loop: keep going until Claude stops calling tools
        all_results = []
        max_turns = 15  # safety limit

        for turn in range(max_turns):
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=4096,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )

            # Process response blocks
            assistant_content = response.content
            tool_results = {}  # keyed by tool_use_id to avoid double execution

            for block in assistant_content:
                if block.type == "tool_use":
                    result = self._execute_tool(block.name, block.input)
                    tool_results[block.id] = result
                    all_results.append({
                        "tool": block.name,
                        "input": block.input,
                        "output": json.loads(result) if result.startswith("{") or result.startswith("[") else result,
                    })

            # Add assistant message to conversation
            messages.append({"role": "assistant", "content": assistant_content})

            # If there were tool calls, add cached results and continue
            if tool_results:
                tool_result_content = [
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": tool_results[block.id],
                    }
                    for block in assistant_content
                    if block.type == "tool_use"
                ]
                messages.append({"role": "user", "content": tool_result_content})
            else:
                # Claude is done — no more tool calls
                break

            if response.stop_reason == "end_turn":
                break

        return all_results

    # ── Question Answering ───────────────────────────────────

    def ask(self, question: str, paper_id: str | None = None) -> str:
        """
        Answer a question using retrieved context from the paper library.

        This is RAG: retrieve relevant chunks, pass to Claude with the question.
        """
        system_prompt = """You are ScholarLens, a research assistant with access to
a library of analyzed papers. Answer questions using the search tool to find
relevant passages. Always cite which paper and section your answer comes from.
If the evidence is insufficient, say so clearly."""

        messages = [{"role": "user", "content": question}]

        # Let Claude use search tools to find relevant context
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
                        "content": self._execute_tool(block.name, block.input),
                    }
                    for block in assistant_content
                    if block.type == "tool_use"
                ]
                messages.append({"role": "user", "content": tool_result_content})
            else:
                break

        # Extract final text response
        final_text = ""
        for block in response.content:
            if block.type == "text":
                final_text += block.text

        return final_text
