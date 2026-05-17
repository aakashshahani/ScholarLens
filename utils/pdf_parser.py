"""
PDF text extraction and intelligent chunking.

Uses pdfplumber for extraction, then chunks by token count
with section detection heuristics.
"""

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ExtractedPage:
    page_number: int
    text: str


@dataclass
class ExtractedPaper:
    pages: list[ExtractedPage]
    full_text: str
    page_count: int
    metadata: dict  # pdfplumber metadata if available


@dataclass
class TextChunk:
    text: str
    chunk_index: int
    section: str | None
    page_number: int | None
    token_count: int


# ── Section Detection ────────────────────────────────────────

SECTION_PATTERNS = [
    (r"^\s*(?:\d+\.?\s+)?abstract\b", "abstract"),
    (r"^\s*(?:\d+\.?\s+)?introduction\b", "introduction"),
    (r"^\s*(?:\d+\.?\s+)?(?:related\s+work|background|literature\s+review)\b", "related_work"),
    (r"^\s*(?:\d+\.?\s+)?(?:method(?:s|ology)?|approach|framework)\b", "methods"),
    (r"^\s*(?:\d+\.?\s+)?(?:experiment(?:s|al)?|evaluation|results)\b", "results"),
    (r"^\s*(?:\d+\.?\s+)?discussion\b", "discussion"),
    (r"^\s*(?:\d+\.?\s+)?(?:conclusion(?:s)?|summary)\b", "conclusion"),
    (r"^\s*(?:\d+\.?\s+)?(?:references|bibliography)\b", "references"),
    (r"^\s*(?:\d+\.?\s+)?(?:appendix|supplementary)\b", "appendix"),
]


def detect_section(line: str) -> str | None:
    """Try to match a line to a known paper section."""
    stripped = line.strip().lower()
    for pattern, section_name in SECTION_PATTERNS:
        if re.match(pattern, stripped, re.IGNORECASE):
            return section_name
    return None


# ── PDF Extraction ───────────────────────────────────────────

def extract_pdf(file_path: str | Path) -> ExtractedPaper:
    """Extract text from a PDF using pdfplumber."""
    import pdfplumber

    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"PDF not found: {file_path}")

    pages = []
    with pdfplumber.open(file_path) as pdf:
        metadata = pdf.metadata or {}
        for i, page in enumerate(pdf.pages):
            # Use layout-aware extraction for better spacing
            text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            # Fix hyphenation across lines
            text = re.sub(r"-\n\s*", "", text)
            # Insert space between lowercase and uppercase (catches concatenated words)
            text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
            # Insert space between letter and number boundaries
            text = re.sub(r"([a-zA-Z])(\d)", r"\1 \2", text)
            text = re.sub(r"(\d)([a-zA-Z])", r"\1 \2", text)
            # Fix missing spaces after periods, commas, colons
            text = re.sub(r"([.,;:])([A-Za-z])", r"\1 \2", text)
            # Collapse excessive whitespace but preserve single newlines
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r"\n{3,}", "\n\n", text)
            pages.append(ExtractedPage(page_number=i + 1, text=text.strip()))

    full_text = "\n\n".join(p.text for p in pages if p.text)
    return ExtractedPaper(
        pages=pages,
        full_text=full_text,
        page_count=len(pages),
        metadata=metadata,
    )


# ── Chunking ─────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English."""
    return len(text) // 4


def chunk_text(
    pages: list[ExtractedPage],
    chunk_size: int = 500,
    chunk_overlap: int = 50,
) -> list[TextChunk]:
    """
    Chunk paper text with section awareness and page tracking.

    Strategy:
    1. Walk through pages, detect section boundaries
    2. Accumulate text until chunk_size tokens
    3. On section change, flush current chunk (even if under size)
    4. Overlap by prepending tail of previous chunk
    """
    chunks: list[TextChunk] = []
    current_text = ""
    current_section: str | None = None
    current_page: int | None = None
    chunk_idx = 0
    overlap_text = ""

    for page in pages:
        lines = page.text.split("\n") if page.text else []

        for line in lines:
            detected = detect_section(line)

            # Section change → flush current chunk
            if detected and detected != current_section and current_text.strip():
                chunks.append(TextChunk(
                    text=current_text.strip(),
                    chunk_index=chunk_idx,
                    section=current_section,
                    page_number=current_page,
                    token_count=estimate_tokens(current_text),
                ))
                chunk_idx += 1
                # Keep overlap from end of chunk
                words = current_text.split()
                overlap_words = words[-chunk_overlap:] if len(words) > chunk_overlap else words
                overlap_text = " ".join(overlap_words)
                current_text = overlap_text + " "

            if detected:
                current_section = detected

            if current_page is None:
                current_page = page.page_number

            current_text += line + " "

            # Check if chunk is full
            if estimate_tokens(current_text) >= chunk_size:
                chunks.append(TextChunk(
                    text=current_text.strip(),
                    chunk_index=chunk_idx,
                    section=current_section,
                    page_number=current_page,
                    token_count=estimate_tokens(current_text),
                ))
                chunk_idx += 1
                words = current_text.split()
                overlap_words = words[-chunk_overlap:] if len(words) > chunk_overlap else words
                overlap_text = " ".join(overlap_words)
                current_text = overlap_text + " "
                current_page = page.page_number

    # Flush remaining text
    if current_text.strip():
        chunks.append(TextChunk(
            text=current_text.strip(),
            chunk_index=chunk_idx,
            section=current_section,
            page_number=current_page,
            token_count=estimate_tokens(current_text),
        ))

    return chunks
