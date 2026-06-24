"""
PDF text extraction and intelligent chunking.

Uses PyMuPDF (fitz) for extraction — faster than pdfplumber, gives raw text
block positions so two-column layouts are handled by geometry rather than
heuristics, and handles more PDF variants without crashing.

Column detection works by collecting all text block x-origins on a page,
finding whether they cluster into one band (single column) or two bands
(two-column). If two bands are found, blocks are sorted left-column-first,
top-to-bottom within each column, then joined. Single-column pages are sorted
top-to-bottom by y-position as usual.
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
    metadata: dict


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

def _clean(text: str) -> str:
    """Post-process extracted text to fix common academic PDF artifacts."""
    text = re.sub(r"-\n\s*", "", text)                    # hyphenation repair
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)      # camelCase split
    text = re.sub(r"([a-zA-Z])(\d)", r"\1 \2", text)      # letter-digit boundary
    text = re.sub(r"(\d)([a-zA-Z])", r"\1 \2", text)      # digit-letter boundary
    text = re.sub(r"([.,;:])([A-Za-z])", r"\1 \2", text)  # punctuation spacing
    text = re.sub(r"[ \t]+", " ", text)                    # collapse spaces/tabs
    text = re.sub(r"\n{3,}", "\n\n", text)                 # collapse blank lines
    return text.strip()


def _find_column_split(x_origins: list[float], page_width: float) -> float | None:
    """
    Given the x-origin of every text block on a page, decide whether the page
    has two columns and if so return the x-coordinate of the gap between them.

    Strategy: bucket x-origins into left-half vs right-half of the page.
    If both halves are meaningfully populated and the gap region is sparse,
    return the midpoint as the split. Otherwise return None (single column).

    This is intentionally simple — academic two-column layouts have a clear
    gutter, so a coarse bucket check is sufficient without k-means or gap
    analysis.
    """
    if not x_origins:
        return None

    mid = page_width / 2
    margin = page_width * 0.05   # ignore blocks within 5% of centre (headers etc)

    left  = [x for x in x_origins if x < mid - margin]
    right = [x for x in x_origins if x > mid + margin]
    gap   = [x for x in x_origins if mid - margin <= x <= mid + margin]

    total = len(x_origins)
    if total == 0:
        return None

    left_frac  = len(left)  / total
    right_frac = len(right) / total
    gap_frac   = len(gap)   / total

    # Two-column: both sides populated, gap sparse
    if left_frac > 0.20 and right_frac > 0.20 and gap_frac < 0.10:
        return mid

    return None


def extract_pdf(file_path: str | Path) -> ExtractedPaper:
    """
    Extract text from a PDF using PyMuPDF (fitz).

    For each page:
    - Collect text blocks with their bounding boxes (x0, y0, x1, y1, text).
    - Detect whether the page is single- or two-column using x-origin clustering.
    - Sort blocks into reading order: left column top-to-bottom, then right
      column top-to-bottom for two-column pages; top-to-bottom for single.
    - Join block text and apply post-processing fixes.

    PyMuPDF gives bounding boxes directly so column detection is geometric,
    not a heuristic on word counts — it works correctly on narrow margins,
    wide figures, and mixed-layout pages.
    """
    import fitz  # PyMuPDF

    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"PDF not found: {file_path}")

    doc = fitz.open(str(file_path))
    metadata = {
        "title":   doc.metadata.get("title", ""),
        "author":  doc.metadata.get("author", ""),
        "subject": doc.metadata.get("subject", ""),
    }

    pages = []
    for page_num, page in enumerate(doc):
        page_width = page.rect.width

        # get_text("blocks") returns (x0, y0, x1, y1, text, block_no, block_type)
        # block_type 0 = text, 1 = image — skip images
        raw_blocks = page.get_text("blocks")
        text_blocks = [b for b in raw_blocks if b[6] == 0 and b[4].strip()]

        if not text_blocks:
            pages.append(ExtractedPage(page_number=page_num + 1, text=""))
            continue

        x_origins   = [b[0] for b in text_blocks]
        split_x     = _find_column_split(x_origins, page_width)

        if split_x is not None:
            # Two-column: sort left blocks by y, then right blocks by y
            left_blocks  = sorted([b for b in text_blocks if b[0] < split_x],  key=lambda b: b[1])
            right_blocks = sorted([b for b in text_blocks if b[0] >= split_x], key=lambda b: b[1])
            ordered = left_blocks + right_blocks
        else:
            # Single column: sort by y-origin (top to bottom)
            ordered = sorted(text_blocks, key=lambda b: b[1])

        page_text = "\n".join(b[4].strip() for b in ordered)
        pages.append(ExtractedPage(page_number=page_num + 1, text=_clean(page_text)))

    doc.close()

    full_text = "\n\n".join(p.text for p in pages if p.text)

    # OCR fallback: if the PDF produced near-empty text (scanned/image-based),
    # try pytesseract. This requires pdf2image and pytesseract to be installed
    # (pip install pdf2image pytesseract). Silently skips if unavailable.
    meaningful_chars = sum(len(p.text) for p in pages if p.text)
    total_pages = len(pages)
    if total_pages > 0 and meaningful_chars < total_pages * 80:
        pages = _ocr_fallback(file_path, pages, metadata)
        full_text = "\n\n".join(p.text for p in pages if p.text)

    return ExtractedPaper(
        pages=pages,
        full_text=full_text,
        page_count=len(pages),
        metadata=metadata,
    )


def _ocr_fallback(
    file_path: Path,
    original_pages: list[ExtractedPage],
    metadata: dict,
) -> list[ExtractedPage]:
    """Run OCR on pages that produced little or no text via PyMuPDF.
    Returns a new pages list with OCR text substituted where applicable."""
    try:
        from pdf2image import convert_from_path
        import pytesseract
    except ImportError:
        return original_pages  # OCR deps not installed — return as-is

    try:
        images = convert_from_path(str(file_path), dpi=200)
    except Exception as e:
        print(f"[ocr] pdf2image failed: {e}")
        return original_pages

    new_pages = list(original_pages)
    for i, img in enumerate(images):
        orig = original_pages[i] if i < len(original_pages) else None
        # Only OCR pages with sparse text
        if orig and len(orig.text) >= 80:
            continue
        try:
            ocr_text = pytesseract.image_to_string(img, lang="eng")
            cleaned = _clean(ocr_text)
            page_num = orig.page_number if orig else i + 1
            new_pages[i] = ExtractedPage(page_number=page_num, text=cleaned)
        except Exception as e:
            print(f"[ocr] page {i+1} failed: {e}")

    return new_pages


# ── Chunking ─────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English."""
    return len(text) // 4


# Sections that should never be indexed. Bibliography entries and appendix
# material match on keywords but contain no substantive claims. Excluding
# them at ingestion time means they never appear in search results or
# contradiction detection, even without a post-query filter.
SKIP_SECTIONS = {"references", "appendix"}


def chunk_text(
    pages: list[ExtractedPage],
    chunk_size: int = 500,
    chunk_overlap: int = 100,
) -> list[TextChunk]:
    """
    Chunk paper text with section awareness and page tracking.

    Strategy:
    1. Walk through pages line by line, detect section boundaries via regex.
    2. Accumulate text until chunk_size tokens.
    3. On section change, flush current chunk immediately (even if under size)
       so chunks never span major structural divides.
    4. Overlap: carry the last chunk_overlap words into the next chunk so
       claims that straddle a boundary appear in full in at least one chunk.

    chunk_overlap default raised from 50 to 100 words — academic claims
    frequently run 2-3 sentences, and 50 words was too narrow to prevent
    claim splits at chunk boundaries.
    """
    chunks: list[TextChunk] = []
    current_text = ""
    current_section: str | None = None
    current_page: int | None = None
    chunk_idx = 0
    overlap_text = ""

    def _flush(text: str, section: str | None, page: int | None) -> str:
        """Append a chunk and return the overlap tail for the next chunk.
        Chunks whose section is in SKIP_SECTIONS are silently dropped —
        they are never added to the index."""
        nonlocal chunk_idx
        if not text.strip():
            return ""
        # Drop references/appendix chunks entirely — don't index them.
        if section in SKIP_SECTIONS:
            return ""  # no overlap carried forward from skipped sections
        chunks.append(TextChunk(
            text=text.strip(),
            chunk_index=chunk_idx,
            section=section,
            page_number=page,
            token_count=estimate_tokens(text),
        ))
        chunk_idx += 1
        words = text.split()
        tail = words[-chunk_overlap:] if len(words) > chunk_overlap else words
        return " ".join(tail)

    for page in pages:
        lines = page.text.split("\n") if page.text else []

        for line in lines:
            detected = detect_section(line)

            # Section boundary → flush before switching
            if detected and detected != current_section and current_text.strip():
                overlap_text = _flush(current_text, current_section, current_page)
                current_text = overlap_text + " " if overlap_text else ""

            if detected:
                current_section = detected

            if current_page is None:
                current_page = page.page_number

            current_text += line + " "

            # Size limit → flush mid-section
            if estimate_tokens(current_text) >= chunk_size:
                overlap_text = _flush(current_text, current_section, current_page)
                current_text = overlap_text + " " if overlap_text else ""
                current_page = page.page_number

    # Flush remaining text
    if current_text.strip():
        _flush(current_text, current_section, current_page)

    return chunks
