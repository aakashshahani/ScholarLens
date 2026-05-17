"""
ScholarLens — Streamlit Frontend (Phase 1)
Redesigned with a high-tech research intelligence aesthetic.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import streamlit as st
import json
from datetime import datetime

from config import settings, UPLOAD_DIR
from db import Database
from agents import PDFAnalysisAgent, ContradictionAgent, HypothesisAgent, PaperImporter


# ── Page Config ──────────────────────────────────────────────

st.set_page_config(
    page_title="ScholarLens",
    page_icon="🔬",
    layout="wide",
    initial_sidebar_state="expanded",
)


# ── Inject Custom Theme ─────────────────────────────────────

st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');

:root {
    --bg-primary: #0a0e17;
    --bg-secondary: #111827;
    --bg-card: #151d2e;
    --bg-card-hover: #1a2540;
    --bg-input: #0d1321;
    --border-dim: #1e293b;
    --accent-blue: #3b82f6;
    --accent-cyan: #06b6d4;
    --accent-emerald: #10b981;
    --accent-amber: #f59e0b;
    --accent-rose: #f43f5e;
    --accent-violet: #8b5cf6;
    --text-primary: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-dim: #64748b;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'DM Sans', sans-serif;
}

.stApp {
    background-color: var(--bg-primary) !important;
    font-family: var(--font-sans) !important;
    color: var(--text-primary) !important;
}
.stApp > header { background: transparent !important; }

/* Sidebar */
section[data-testid="stSidebar"] {
    background: var(--bg-secondary) !important;
    border-right: 1px solid var(--border-dim) !important;
}
section[data-testid="stSidebar"] .stMarkdown,
section[data-testid="stSidebar"] .stRadio label,
section[data-testid="stSidebar"] p,
section[data-testid="stSidebar"] span {
    color: var(--text-secondary) !important;
    font-family: var(--font-sans) !important;
}
section[data-testid="stSidebar"] .stRadio > div { gap: 2px !important; }
section[data-testid="stSidebar"] .stRadio label {
    padding: 8px 12px !important;
    border-radius: 6px !important;
    transition: all 0.2s ease !important;
    font-size: 0.9rem !important;
}
section[data-testid="stSidebar"] .stRadio label:hover {
    background: var(--bg-card) !important;
}

/* Metrics */
div[data-testid="stMetric"] {
    background: var(--bg-card) !important;
    border: 1px solid var(--border-dim) !important;
    border-radius: 8px !important;
    padding: 12px 16px !important;
}
div[data-testid="stMetric"] label {
    color: var(--text-dim) !important;
    font-family: var(--font-mono) !important;
    font-size: 0.7rem !important;
    text-transform: uppercase !important;
    letter-spacing: 1.5px !important;
}
div[data-testid="stMetric"] div[data-testid="stMetricValue"] {
    color: var(--accent-cyan) !important;
    font-family: var(--font-mono) !important;
    font-weight: 600 !important;
}

/* File uploader */
section[data-testid="stFileUploader"] {
    border: 1px dashed var(--border-dim) !important;
    border-radius: 12px !important;
    background: var(--bg-card) !important;
}
section[data-testid="stFileUploader"]:hover {
    border-color: var(--accent-blue) !important;
}

/* Buttons */
.stButton > button {
    font-family: var(--font-sans) !important;
    font-weight: 600 !important;
    border-radius: 8px !important;
    border: 1px solid var(--border-dim) !important;
    transition: all 0.3s ease !important;
}
.stButton > button[kind="primary"],
.stButton > button[data-testid="stBaseButton-primary"] {
    background: linear-gradient(135deg, #3b82f6, #06b6d4) !important;
    border: none !important;
    color: white !important;
    box-shadow: 0 4px 24px rgba(59, 130, 246, 0.25) !important;
}
.stButton > button[kind="primary"]:hover,
.stButton > button[data-testid="stBaseButton-primary"]:hover {
    box-shadow: 0 8px 32px rgba(59, 130, 246, 0.4) !important;
    transform: translateY(-1px) !important;
}
.stButton > button:not([kind="primary"]) {
    background: var(--bg-card) !important;
    color: var(--text-secondary) !important;
}
.stButton > button:not([kind="primary"]):hover {
    border-color: var(--accent-blue) !important;
    color: var(--text-primary) !important;
}

/* Inputs */
.stTextInput > div > div > input {
    background: var(--bg-input) !important;
    border: 1px solid var(--border-dim) !important;
    border-radius: 8px !important;
    color: var(--text-primary) !important;
    font-family: var(--font-sans) !important;
    padding: 10px 14px !important;
}
.stTextInput > div > div > input:focus {
    border-color: var(--accent-blue) !important;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15) !important;
}
.stTextInput label, .stSelectbox label, .stSlider label {
    color: var(--text-secondary) !important;
    font-family: var(--font-sans) !important;
}

/* Expanders */
.streamlit-expanderHeader {
    background: var(--bg-card) !important;
    border: 1px solid var(--border-dim) !important;
    border-radius: 8px !important;
    color: var(--text-primary) !important;
    font-family: var(--font-mono) !important;
    font-weight: 500 !important;
    font-size: 0.85rem !important;
    letter-spacing: 0.5px !important;
}
.streamlit-expanderHeader:hover {
    border-color: var(--accent-blue) !important;
}
.streamlit-expanderContent {
    background: var(--bg-card) !important;
    border: 1px solid var(--border-dim) !important;
    border-top: none !important;
    border-radius: 0 0 8px 8px !important;
    color: var(--text-secondary) !important;
    font-family: var(--font-sans) !important;
    line-height: 1.7 !important;
}

/* Tabs */
.stTabs [data-baseweb="tab-list"] {
    gap: 4px !important;
    background: var(--bg-secondary) !important;
    padding: 4px !important;
    border-radius: 10px !important;
    border: 1px solid var(--border-dim) !important;
}
.stTabs [data-baseweb="tab"] {
    border-radius: 6px !important;
    color: var(--text-dim) !important;
    font-family: var(--font-mono) !important;
    font-weight: 500 !important;
    font-size: 0.78rem !important;
    letter-spacing: 0.3px !important;
}
.stTabs [data-baseweb="tab"][aria-selected="true"] {
    background: var(--bg-card) !important;
    color: var(--accent-cyan) !important;
    border: 1px solid var(--border-dim) !important;
}
.stTabs [data-baseweb="tab-panel"] {
    color: var(--text-secondary) !important;
    padding-top: 1.5rem !important;
    font-family: var(--font-sans) !important;
    line-height: 1.7 !important;
}
.stTabs [data-baseweb="tab-highlight"] { display: none !important; }

hr { border-color: var(--border-dim) !important; opacity: 0.5 !important; }

.stSelectbox > div > div {
    background: var(--bg-input) !important;
    border: 1px solid var(--border-dim) !important;
    border-radius: 8px !important;
    color: var(--text-primary) !important;
}

div[data-testid="stStatusWidget"] {
    background: var(--bg-card) !important;
    border: 1px solid var(--border-dim) !important;
    border-radius: 10px !important;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg-primary); }
::-webkit-scrollbar-thumb { background: var(--border-dim); border-radius: 3px; }

/* ── Custom Components ──────────────────────────── */

.sl-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.75rem;
    font-weight: 700;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
}
.sl-subtitle {
    font-family: 'DM Sans', sans-serif;
    font-size: 0.9rem;
    color: #64748b;
    margin-bottom: 1.5rem;
}
.sl-logo {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    font-size: 1.2rem;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 2px;
}
.sl-logo-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    color: #64748b;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 1.5rem;
}

.sl-paper-card {
    background: linear-gradient(145deg, #151d2e, #111827);
    border: 1px solid #1e293b;
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 12px;
    transition: all 0.3s ease;
}
.sl-paper-card:hover {
    border-color: #2563eb44;
    box-shadow: 0 4px 24px rgba(59, 130, 246, 0.08);
}
.sl-paper-title {
    font-family: 'DM Sans', sans-serif;
    font-size: 1.05rem;
    font-weight: 600;
    color: #f1f5f9;
    margin-bottom: 6px;
    line-height: 1.4;
}
.sl-paper-authors {
    font-family: 'DM Sans', sans-serif;
    font-size: 0.82rem;
    color: #94a3b8;
    margin-bottom: 10px;
}
.sl-paper-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    color: #64748b;
    margin-bottom: 10px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}

.sl-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 100px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.3px;
    margin-right: 5px;
    margin-bottom: 5px;
}
.sl-badge-summary { background: #10b98118; color: #10b981; border: 1px solid #10b98130; }
.sl-badge-methods { background: #3b82f618; color: #3b82f6; border: 1px solid #3b82f630; }
.sl-badge-findings { background: #f59e0b18; color: #f59e0b; border: 1px solid #f59e0b30; }
.sl-badge-limitations { background: #f43f5e18; color: #f43f5e; border: 1px solid #f43f5e30; }
.sl-badge-claims { background: #8b5cf618; color: #8b5cf6; border: 1px solid #8b5cf630; }
.sl-badge-gaps { background: #06b6d418; color: #06b6d4; border: 1px solid #06b6d430; }

.sl-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin: 1rem 0 1.5rem 0;
}
.sl-stat-card {
    background: linear-gradient(145deg, #151d2e, #111827);
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 16px;
    text-align: center;
}
.sl-stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.75rem;
    font-weight: 700;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}
.sl-stat-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-top: 4px;
}

.sl-search-result {
    background: linear-gradient(145deg, #151d2e, #111827);
    border: 1px solid #1e293b;
    border-left: 3px solid #3b82f6;
    border-radius: 0 8px 8px 0;
    padding: 1rem 1.25rem;
    margin-bottom: 10px;
}
.sl-search-result:hover { border-left-color: #06b6d4; }
.sl-search-score {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: #06b6d4;
}
.sl-search-section {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1px;
}
.sl-search-text {
    font-family: 'DM Sans', sans-serif;
    font-size: 0.88rem;
    color: #94a3b8;
    line-height: 1.6;
    margin-top: 8px;
}

.sl-empty-state { text-align: center; padding: 3rem 2rem; }
.sl-empty-icon { font-size: 3rem; opacity: 0.15; color: #3b82f6; }
.sl-empty-text { font-family: 'DM Sans', sans-serif; font-size: 1rem; color: #64748b; }
.sl-empty-hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: #475569;
    margin-top: 8px;
}
</style>
""", unsafe_allow_html=True)


# ── Initialize Services ──────────────────────────────────────

@st.cache_resource
def get_db():
    return Database()

@st.cache_resource
def get_agent():
    return PDFAnalysisAgent()

@st.cache_resource
def get_contradiction_agent():
    return ContradictionAgent()

@st.cache_resource
def get_hypothesis_agent():
    return HypothesisAgent()

@st.cache_resource
def get_importer():
    return PaperImporter()

db = get_db()
agent = get_agent()
contradiction_agent = get_contradiction_agent()
hypothesis_agent = get_hypothesis_agent()
importer = get_importer()


# ── Sidebar ──────────────────────────────────────────────────

with st.sidebar:
    st.markdown(
        '<div class="sl-logo">◆ ScholarLens</div>'
        '<div class="sl-logo-sub">Research Intelligence</div>',
        unsafe_allow_html=True,
    )

    # Use session state for navigation so buttons can switch pages
    if "nav_page" not in st.session_state:
        st.session_state["nav_page"] = "◈ Upload"

    nav_options = ["◈ Upload", "🔎 Import", "◇ Library", "◆ Search", "◇ Detail", "⚡ Contradictions", "💡 Hypotheses"]

    # If a button changed the page, use that. Otherwise use the radio.
    def _on_nav_change():
        st.session_state["nav_page"] = st.session_state["_nav_radio"]

    current_index = 0
    if st.session_state["nav_page"] in nav_options:
        current_index = nav_options.index(st.session_state["nav_page"])

    page = st.radio(
        "Navigate",
        nav_options,
        index=current_index,
        key="_nav_radio",
        on_change=_on_nav_change,
        label_visibility="collapsed",
    )
    # Sync: if button set nav_page, use that; otherwise use radio selection
    page = st.session_state["nav_page"]

    st.divider()

    papers = db.list_papers(limit=1000)

    st.metric("PAPERS", len(papers))

    errors = settings.validate()
    if errors:
        st.error("⚠ " + " · ".join(errors))


# ── Page: Upload ─────────────────────────────────────────────

if page == "◈ Upload":
    st.markdown(
        '<div class="sl-title">Upload & Analyze</div>'
        '<div class="sl-subtitle">Drop a research paper and ScholarLens will automatically analyze it.</div>',
        unsafe_allow_html=True,
    )

    uploaded_file = st.file_uploader(
        "Choose a PDF",
        type=["pdf"],
        label_visibility="collapsed",
    )

    if uploaded_file:
        st.markdown(
            f'<div class="sl-paper-card">'
            f'<div class="sl-paper-title">📄 {uploaded_file.name}</div>'
            f'<div class="sl-paper-meta">'
            f'<span>SIZE: {uploaded_file.size / 1024:.0f} KB</span>'
            f'<span>TYPE: PDF</span>'
            f'</div></div>',
            unsafe_allow_html=True,
        )

        if st.button("▶ ANALYZE PAPER", type="primary", use_container_width=True):
            save_path = UPLOAD_DIR / uploaded_file.name
            with open(save_path, "wb") as f:
                f.write(uploaded_file.getbuffer())

            with st.status("◆ Analyzing paper...", expanded=True) as status:
                st.write("⟐ Reading PDF...")
                paper = agent.ingest_pdf(save_path, filename=uploaded_file.name)
                chunks = db.get_chunks_for_paper(paper.id)
                st.write(f"✓ Processed **{paper.page_count}** pages")

                st.write("⟐ Running deep analysis...")
                try:
                    results = agent.analyze_paper(paper.id)
                    analyses = db.get_analyses_for_paper(paper.id)
                    st.write(f"✓ Generated **{len(analyses)}** analysis reports")
                    status.update(label="✓ Analysis complete", state="complete")
                except Exception as e:
                    st.error(f"Analysis error: {e}")
                    status.update(label="⚠ Partial completion", state="error")

            st.session_state["selected_paper_id"] = paper.id

            analyses = db.get_analyses_for_paper(paper.id)
            if analyses:
                st.markdown(
                    '<div class="sl-title" style="font-size:1.2rem; margin-top:1.5rem;">Analysis Results</div>',
                    unsafe_allow_html=True,
                )
                for analysis in analyses:
                    label = analysis.analysis_type.replace("_", " ").upper()
                    with st.expander(f"◇ {label}"):
                        st.markdown(analysis.content)
    else:
        st.markdown(
            '<div class="sl-empty-state">'
            '<div class="sl-empty-icon">◇</div>'
            '<div class="sl-empty-text">Drop a research paper here to begin</div>'
            '<div class="sl-empty-hint">PDF format · any field · any length</div>'
            '</div>',
            unsafe_allow_html=True,
        )


# ── Page: Import ─────────────────────────────────────────────

elif page == "🔎 Import":
    st.markdown(
        '<div class="sl-title">Import Papers</div>'
        '<div class="sl-subtitle">Search arXiv and Semantic Scholar, or paste a DOI or arXiv ID.</div>',
        unsafe_allow_html=True,
    )

    # Quick lookup
    lookup_id = st.text_input(
        "Quick lookup",
        placeholder="Paste an arXiv ID (2301.12345), DOI (10.1145/...), or arXiv URL",
        key="import_lookup",
    )

    if lookup_id:
        with st.spinner("Looking up paper..."):
            result = importer.lookup(lookup_id)
        if result:
            st.session_state["import_results"] = [result]
        else:
            st.error("Paper not found. Check the ID and try again.")

    st.divider()

    # Search
    search_query = st.text_input(
        "Search",
        placeholder="e.g., LLM negotiation coaching feedback",
        key="import_search",
    )

    col1, col2 = st.columns([1, 1])
    with col1:
        sources = st.multiselect(
            "Sources",
            ["arxiv", "semantic_scholar"],
            default=["arxiv", "semantic_scholar"],
            key="import_sources",
        )
    with col2:
        max_results = st.slider("Results per source", 3, 10, 5, key="import_max")

    if search_query and st.button("🔎 SEARCH", type="primary", use_container_width=True):
        with st.spinner("Searching databases..."):
            results = importer.search(search_query, sources=sources, max_per_source=max_results)
        if results:
            st.session_state["import_results"] = results
        else:
            st.warning("No results found. Try different keywords.")

    # Display results
    if "import_results" in st.session_state:
        results = st.session_state["import_results"]
        st.markdown(
            f'<div class="sl-subtitle">{len(results)} papers found</div>',
            unsafe_allow_html=True,
        )

        for i, r in enumerate(results):
            authors_str = ", ".join(r.authors[:3])
            if len(r.authors) > 3:
                authors_str += f" +{len(r.authors) - 3}"

            citations = f" · {r.citation_count} citations" if r.citation_count else ""
            pdf_status = "PDF available" if r.pdf_url else "No PDF"

            col1, col2 = st.columns([5, 1])
            with col1:
                st.markdown(
                    f'<div class="sl-paper-card">'
                    f'<div class="sl-paper-title">{r.title}</div>'
                    f'<div class="sl-paper-authors">{authors_str}</div>'
                    f'<div class="sl-paper-meta">'
                    f'<span>◇ {r.source.upper().replace("_", " ")}</span>'
                    f'<span>◆ {r.year or "?"}</span>'
                    f'<span>◇ {pdf_status}</span>'
                    f'{f"<span>◆ {r.citation_count} cited</span>" if r.citation_count else ""}'
                    f'</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.82rem; '
                    f'color:#64748b; line-height:1.5; margin-top:6px;">'
                    f'{r.abstract[:250]}{"..." if len(r.abstract) > 250 else ""}</div>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
            with col2:
                st.write("")
                st.write("")
                if r.pdf_url:
                    if st.button("ADD →", key=f"import_{i}"):
                        with st.spinner(f"Importing {r.title[:40]}..."):
                            # Download PDF
                            pdf_path = importer.download_pdf(r)
                            if pdf_path:
                                # Ingest into library
                                paper = agent.ingest_pdf(pdf_path, filename=pdf_path.name)

                                # Update with proper metadata from the source
                                import sqlite3 as _sql
                                import json as _json
                                conn = _sql.connect(str(db.db_path))
                                conn.execute(
                                    "UPDATE papers SET title=?, authors=?, abstract=?, year=?, source=?, doi=?, arxiv_id=? WHERE id=?",
                                    (r.title, _json.dumps(r.authors), r.abstract, r.year,
                                     r.source, r.doi, r.source_id if r.source == "arxiv" else None,
                                     paper.id),
                                )
                                conn.commit()
                                conn.close()

                                # Run analysis
                                try:
                                    agent.analyze_paper(paper.id)
                                    st.success(f"Added and analyzed: {r.title[:60]}")
                                except Exception as e:
                                    st.warning(f"Added but analysis failed: {e}")
                            else:
                                st.error("PDF download failed.")
                else:
                    st.markdown(
                        '<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; '
                        'color:#64748b; padding-top:20px;">No PDF</div>',
                        unsafe_allow_html=True,
                    )


# ── Page: Library ────────────────────────────────────────────

elif page == "◇ Library":
    st.markdown(
        '<div class="sl-title">Paper Library</div>'
        '<div class="sl-subtitle">All papers and their analysis status.</div>',
        unsafe_allow_html=True,
    )

    papers = db.list_papers(limit=50)

    if not papers:
        st.markdown(
            '<div class="sl-empty-state">'
            '<div class="sl-empty-icon">◇</div>'
            '<div class="sl-empty-text">Library is empty</div>'
            '<div class="sl-empty-hint">Upload a paper to get started</div>'
            '</div>',
            unsafe_allow_html=True,
        )
    else:
        for paper in papers:
            analyses = db.get_analyses_for_paper(paper.id)
            analysis_types = {a.analysis_type for a in analyses}
            chunks = db.get_chunks_for_paper(paper.id)

            badge_map = {
                "summary": "sl-badge-summary",
                "methods": "sl-badge-methods",
                "findings": "sl-badge-findings",
                "limitations": "sl-badge-limitations",
                "key_claims": "sl-badge-claims",
                "research_gaps": "sl-badge-gaps",
            }
            badges_html = ""
            for atype, css in badge_map.items():
                if atype in analysis_types:
                    label = atype.replace("_", " ")
                    badges_html += f'<span class="sl-badge {css}">✓ {label}</span>'

            authors_str = ", ".join(paper.authors[:4]) if paper.authors else "—"
            if paper.authors and len(paper.authors) > 4:
                authors_str += f" +{len(paper.authors) - 4}"

            col1, col2 = st.columns([5, 1])
            with col1:
                st.markdown(
                    f'<div class="sl-paper-card">'
                    f'<div class="sl-paper-title">{paper.title}</div>'
                    f'<div class="sl-paper-authors">{authors_str}</div>'
                    f'<div class="sl-paper-meta">'
                    f'<span>◇ {paper.source.upper()}</span>'
                    f'<span>◆ {paper.page_count or "?"} pages</span>'
                    f'{"<span>◇ " + str(paper.year) + "</span>" if paper.year else ""}'
                    f'</div>'
                    f'<div>{badges_html}</div>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
            with col2:
                st.write("")
                st.write("")
                if st.button("VIEW →", key=f"view_{paper.id}"):
                    st.session_state["selected_paper_id"] = paper.id
                    st.session_state["nav_page"] = "◇ Detail"
                    st.rerun()


# ── Page: Search ─────────────────────────────────────────────

elif page == "◆ Search":
    st.markdown(
        '<div class="sl-title">Search</div>'
        '<div class="sl-subtitle">Query your entire library using natural language.</div>',
        unsafe_allow_html=True,
    )

    query = st.text_input(
        "Search",
        placeholder="e.g., methods for detecting amyloid plaques in brain tissue",
        label_visibility="collapsed",
    )

    col1, col2 = st.columns([1, 1])
    with col1:
        n_results = st.slider("Results", 3, 20, 8, label_visibility="collapsed")
    with col2:
        search_mode = st.selectbox("Mode", ["Search Library", "Ask a Question"], label_visibility="collapsed")

    if query:
        if search_mode == "Search Library":
            results = agent.vector_store.search(query=query, n_results=n_results)
            if results:
                st.markdown(
                    f'<div class="sl-subtitle" style="margin-top:0.5rem;">'
                    f'{len(results)} results · sorted by relevance</div>',
                    unsafe_allow_html=True,
                )
                for r in results:
                    paper = db.get_paper(r.paper_id)
                    title = paper.title if paper else "Unknown"
                    relevance = max(0, min(100, int((1 - r.score) * 100)))
                    st.markdown(
                        f'<div class="sl-search-result">'
                        f'<div style="display:flex; justify-content:space-between; margin-bottom:4px;">'
                        f'<span class="sl-search-section">◇ {r.section or "general"}</span>'
                        f'<span class="sl-search-score">relevance: {relevance}%</span>'
                        f'</div>'
                        f'<div class="sl-paper-title" style="font-size:0.9rem;">{title}</div>'
                        f'<div class="sl-search-text">{r.text[:400]}{"..." if len(r.text) > 400 else ""}</div>'
                        f'</div>',
                        unsafe_allow_html=True,
                    )
            else:
                st.markdown(
                    '<div class="sl-empty-state">'
                    '<div class="sl-empty-text">No results. Try a broader query.</div>'
                    '</div>',
                    unsafe_allow_html=True,
                )
        else:
            with st.spinner("◆ Thinking..."):
                answer = agent.ask(query)
            st.markdown(
                '<div class="sl-title" style="font-size:1.1rem; margin-top:1rem;">Answer</div>',
                unsafe_allow_html=True,
            )
            st.markdown(answer)


# ── Page: Detail ─────────────────────────────────────────────

elif page == "◇ Detail":
    paper_id = st.session_state.get("selected_paper_id")

    if not paper_id:
        papers = db.list_papers(limit=10)
        if papers:
            st.markdown(
                '<div class="sl-title">Paper Detail</div>'
                '<div class="sl-subtitle">Select a paper to view its full analysis.</div>',
                unsafe_allow_html=True,
            )
            selected = st.selectbox(
                "Choose a paper",
                papers,
                format_func=lambda p: p.title,
                label_visibility="collapsed",
            )
            if selected:
                paper_id = selected.id
                st.session_state["selected_paper_id"] = paper_id
        else:
            st.markdown(
                '<div class="sl-empty-state">'
                '<div class="sl-empty-icon">◇</div>'
                '<div class="sl-empty-text">No papers yet</div>'
                '<div class="sl-empty-hint">Upload a paper first</div>'
                '</div>',
                unsafe_allow_html=True,
            )

    if paper_id:
        paper = db.get_paper(paper_id)
        if not paper:
            st.error("Paper not found.")
        else:
            authors_str = ", ".join(paper.authors[:5]) if paper.authors else "—"
            st.markdown(
                f'<div class="sl-title">{paper.title}</div>'
                f'<div class="sl-subtitle">{authors_str}</div>',
                unsafe_allow_html=True,
            )

            analyses = db.get_analyses_for_paper(paper_id)
            chunks = db.get_chunks_for_paper(paper_id)

            st.markdown(
                f'<div class="sl-stat-grid">'
                f'<div class="sl-stat-card"><div class="sl-stat-value">{paper.page_count or "?"}</div><div class="sl-stat-label">Pages</div></div>'
                f'<div class="sl-stat-card"><div class="sl-stat-value">{len(analyses)}</div><div class="sl-stat-label">Analyses</div></div>'
                f'<div class="sl-stat-card"><div class="sl-stat-value">{paper.year or "?"}</div><div class="sl-stat-label">Year</div></div>'
                f'<div class="sl-stat-card"><div class="sl-stat-value">{paper.source.title()}</div><div class="sl-stat-label">Source</div></div>'
                f'</div>',
                unsafe_allow_html=True,
            )

            if analyses:
                tab_names = [a.analysis_type.replace("_", " ").upper() for a in analyses]
                tabs = st.tabs(tab_names)
                for tab, analysis in zip(tabs, analyses):
                    with tab:
                        st.markdown(analysis.content)
            else:
                st.info("No analyses yet. Upload and analyze from the Upload page.")

            st.divider()

            st.markdown(
                '<div class="sl-title" style="font-size:1.1rem;">Ask about this paper</div>',
                unsafe_allow_html=True,
            )
            question = st.text_input(
                "Question",
                placeholder="e.g., What sample size was used?",
                key="paper_question",
                label_visibility="collapsed",
            )
            if question:
                with st.spinner("◆ Searching..."):
                    answer = agent.ask(
                        f"Regarding the paper '{paper.title}': {question}",
                        paper_id=paper_id,
                    )
                st.markdown(answer)


# ── Page: Contradictions ─────────────────────────────────────

elif page == "⚡ Contradictions":
    st.markdown(
        '<div class="sl-title">Cross-Paper Analysis</div>'
        '<div class="sl-subtitle">Find contradictions, agreements, and nuances across your library.</div>',
        unsafe_allow_html=True,
    )

    papers = db.list_papers(limit=50)

    if len(papers) < 2:
        st.markdown(
            '<div class="sl-empty-state">'
            '<div class="sl-empty-icon">⚡</div>'
            '<div class="sl-empty-text">Need at least 2 papers to compare</div>'
            '<div class="sl-empty-hint">Upload more papers from the Upload page</div>'
            '</div>',
            unsafe_allow_html=True,
        )
    else:
        # Let user pick which papers to compare
        selected_papers = st.multiselect(
            "Select papers to compare (leave empty for all)",
            papers,
            format_func=lambda p: p.title,
        )

        col1, col2 = st.columns([1, 1])
        with col1:
            threshold = st.slider(
                "Similarity threshold",
                0.3, 0.9, 0.5,
                help="Lower = more comparisons (broader). Higher = only very similar claims.",
            )
        with col2:
            max_pairs = st.slider(
                "Max comparisons",
                5, 30, 15,
                help="Limits API calls. Each comparison costs a small amount.",
            )

        if st.button("⚡ RUN ANALYSIS", type="primary", use_container_width=True):
            paper_ids = [p.id for p in selected_papers] if selected_papers else None

            with st.status("⚡ Scanning for contradictions...", expanded=True) as status:
                st.write("⟐ Extracting claims from papers...")

                # Extract claims
                all_claims = []
                scan_papers = selected_papers if selected_papers else papers
                for paper in scan_papers:
                    claims = contradiction_agent.extract_claims(paper.id)
                    all_claims.extend(claims)
                    st.write(f"  ✓ {paper.title[:60]}... ({len(claims)} claims)")

                if len(all_claims) < 2:
                    st.error("Not enough claims extracted. Try different papers.")
                    status.update(label="⚠ Not enough data", state="error")
                else:
                    st.write(f"⟐ Comparing {len(all_claims)} claims across papers...")
                    pairs = contradiction_agent.find_claim_pairs(all_claims, threshold)
                    pairs = pairs[:max_pairs]
                    st.write(f"  ✓ Found {len(pairs)} similar claim pairs")

                    if not pairs:
                        st.warning("No similar claims found. Try lowering the similarity threshold.")
                        status.update(label="⚠ No matches found", state="complete")
                    else:
                        st.write(f"⟐ Judging {len(pairs)} pairs...")
                        results = []
                        for i, pair in enumerate(pairs):
                            result = contradiction_agent.judge_pair(pair)
                            results.append(result)

                        # Sort: contradictions first
                        priority = {"contradiction": 0, "nuance": 1, "support": 2, "unrelated": 3, "error": 4}
                        results.sort(key=lambda r: priority.get(r.relationship, 5))

                        st.session_state["contradiction_results"] = results
                        status.update(label=f"✓ Found {len(results)} relationships", state="complete")

        # Display results
        if "contradiction_results" in st.session_state:
            results = st.session_state["contradiction_results"]

            # Summary counts
            counts = {}
            for r in results:
                counts[r.relationship] = counts.get(r.relationship, 0) + 1

            color_map = {
                "contradiction": "#f43f5e",
                "nuance": "#f59e0b",
                "support": "#10b981",
                "unrelated": "#64748b",
            }
            label_map = {
                "contradiction": "Contradictions",
                "nuance": "Nuanced differences",
                "support": "Agreements",
                "unrelated": "Unrelated",
            }

            # Summary badges
            summary_html = '<div style="display:flex; gap:12px; margin:1rem 0 1.5rem 0; flex-wrap:wrap;">'
            for rel_type in ["contradiction", "nuance", "support", "unrelated"]:
                count = counts.get(rel_type, 0)
                if count > 0:
                    color = color_map.get(rel_type, "#64748b")
                    label = label_map.get(rel_type, rel_type)
                    summary_html += (
                        f'<div style="background:{color}18; border:1px solid {color}30; '
                        f'border-radius:8px; padding:8px 16px; text-align:center;">'
                        f'<div style="font-family:JetBrains Mono,monospace; font-size:1.5rem; '
                        f'font-weight:700; color:{color};">{count}</div>'
                        f'<div style="font-family:JetBrains Mono,monospace; font-size:0.65rem; '
                        f'color:{color}; text-transform:uppercase; letter-spacing:1px;">{label}</div>'
                        f'</div>'
                    )
            summary_html += '</div>'
            st.markdown(summary_html, unsafe_allow_html=True)

            # Filter tabs
            filter_type = st.selectbox(
                "Filter by",
                ["All", "Contradictions", "Nuanced differences", "Agreements"],
                label_visibility="collapsed",
            )

            filter_map = {
                "All": None,
                "Contradictions": "contradiction",
                "Nuanced differences": "nuance",
                "Agreements": "support",
            }
            active_filter = filter_map[filter_type]

            for r in results:
                if active_filter and r.relationship != active_filter:
                    continue

                color = color_map.get(r.relationship, "#64748b")
                rel_label = r.relationship.upper()
                cat_label = r.category

                st.markdown(
                    f'<div style="background:linear-gradient(145deg, #151d2e, #111827); '
                    f'border:1px solid {color}30; border-left:3px solid {color}; '
                    f'border-radius:0 10px 10px 0; padding:1.25rem 1.5rem; margin-bottom:12px;">'
                    f'<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">'
                    f'<span style="font-family:JetBrains Mono,monospace; font-size:0.7rem; '
                    f'font-weight:600; color:{color}; letter-spacing:1px;">{rel_label}</span>'
                    f'<span style="font-family:JetBrains Mono,monospace; font-size:0.65rem; '
                    f'color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">{cat_label}</span>'
                    f'</div>'
                    f'<div style="background:#0d132180; border-radius:6px; padding:10px 14px; margin-bottom:8px;">'
                    f'<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; color:#64748b; margin-bottom:4px;">Paper A</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.82rem; color:#94a3b8; margin-bottom:2px;">'
                    f'<strong style="color:#f1f5f9;">{r.claim_a.paper_title[:70]}</strong></div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.85rem; color:#cbd5e1;">{r.claim_a.text}</div>'
                    f'</div>'
                    f'<div style="background:#0d132180; border-radius:6px; padding:10px 14px; margin-bottom:12px;">'
                    f'<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; color:#64748b; margin-bottom:4px;">Paper B</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.82rem; color:#94a3b8; margin-bottom:2px;">'
                    f'<strong style="color:#f1f5f9;">{r.claim_b.paper_title[:70]}</strong></div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.85rem; color:#cbd5e1;">{r.claim_b.text}</div>'
                    f'</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.88rem; color:#94a3b8; line-height:1.6;">'
                    f'{r.explanation}</div>'
                    f'{"<div style=" + chr(34) + "font-family:DM Sans,sans-serif; font-size:0.82rem; color:#64748b; margin-top:8px; font-style:italic;" + chr(34) + ">Resolution: " + r.resolution + "</div>" if r.resolution else ""}'
                    f'</div>',
                    unsafe_allow_html=True,
                )


# ── Page: Hypotheses ─────────────────────────────────────────

elif page == "💡 Hypotheses":
    st.markdown(
        '<div class="sl-title">Hypothesis Generator</div>'
        '<div class="sl-subtitle">Generate testable research hypotheses from patterns across your library.</div>',
        unsafe_allow_html=True,
    )

    papers = db.list_papers(limit=50)

    if len(papers) < 1:
        st.markdown(
            '<div class="sl-empty-state">'
            '<div class="sl-empty-icon">💡</div>'
            '<div class="sl-empty-text">Upload papers first</div>'
            '</div>',
            unsafe_allow_html=True,
        )
    else:
        research_q = st.text_input(
            "Research question (optional)",
            placeholder="e.g., How can AI improve negotiation training outcomes?",
            help="Leave empty to generate hypotheses from library-wide patterns",
        )

        selected_papers = st.multiselect(
            "Focus on specific papers (leave empty for all)",
            papers,
            format_func=lambda p: p.title,
            key="hyp_papers",
        )

        num_hypotheses = st.slider("Number of hypotheses", 3, 8, 5, key="hyp_count")

        if st.button("💡 GENERATE HYPOTHESES", type="primary", use_container_width=True):
            paper_ids = [p.id for p in selected_papers] if selected_papers else None

            with st.spinner("💡 Analyzing patterns across papers..."):
                hypotheses = hypothesis_agent.generate(
                    research_question=research_q or None,
                    paper_ids=paper_ids,
                    num_hypotheses=num_hypotheses,
                )

            if not hypotheses:
                st.error("Generation failed. Try again or check your API key.")
            else:
                st.session_state["hypotheses"] = hypotheses

        if "hypotheses" in st.session_state:
            hypotheses = st.session_state["hypotheses"]

            for i, h in enumerate(hypotheses):
                novelty_colors = {"high": "#10b981", "medium": "#f59e0b", "low": "#64748b"}
                impact_colors = {"high": "#3b82f6", "medium": "#f59e0b", "low": "#64748b"}
                n_color = novelty_colors.get(h.novelty, "#64748b")
                i_color = impact_colors.get(h.impact, "#64748b")

                papers_html = ""
                for sp in h.supporting_papers:
                    papers_html += (
                        f'<div style="background:#0d132180; border-radius:6px; padding:8px 12px; margin-bottom:6px;">'
                        f'<div style="font-family:DM Sans,sans-serif; font-size:0.82rem; color:#f1f5f9; font-weight:600;">{sp["title"][:70]}</div>'
                        f'<div style="font-family:DM Sans,sans-serif; font-size:0.8rem; color:#94a3b8; margin-top:2px;">{sp["relevant_finding"]}</div>'
                        f'</div>'
                    )

                challenges_html = ""
                for ch in h.challenges:
                    challenges_html += (
                        f'<span style="display:inline-block; background:#f43f5e18; border:1px solid #f43f5e30; '
                        f'border-radius:100px; padding:2px 10px; font-family:JetBrains Mono,monospace; '
                        f'font-size:0.68rem; color:#f43f5e; margin-right:6px; margin-bottom:4px;">{ch}</span>'
                    )

                st.markdown(
                    f'<div style="background:linear-gradient(145deg, #151d2e, #111827); '
                    f'border:1px solid #1e293b; border-radius:12px; padding:1.5rem; margin-bottom:16px;">'
                    f'<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">'
                    f'<span style="font-family:JetBrains Mono,monospace; font-size:0.75rem; color:#64748b;">H{i+1}</span>'
                    f'<div style="display:flex; gap:8px;">'
                    f'<span style="font-family:JetBrains Mono,monospace; font-size:0.65rem; '
                    f'color:{n_color}; background:{n_color}18; border:1px solid {n_color}30; '
                    f'border-radius:100px; padding:2px 10px;">novelty: {h.novelty}</span>'
                    f'<span style="font-family:JetBrains Mono,monospace; font-size:0.65rem; '
                    f'color:{i_color}; background:{i_color}18; border:1px solid {i_color}30; '
                    f'border-radius:100px; padding:2px 10px;">impact: {h.impact}</span>'
                    f'</div></div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:1.05rem; '
                    f'color:#f1f5f9; font-weight:600; line-height:1.5; margin-bottom:10px;">{h.statement}</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.88rem; '
                    f'color:#94a3b8; line-height:1.6; margin-bottom:14px;">{h.rationale}</div>'
                    f'<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; '
                    f'color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Grounded in</div>'
                    f'{papers_html}'
                    f'<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; '
                    f'color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-top:12px; margin-bottom:4px;">How to test</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.85rem; '
                    f'color:#94a3b8; line-height:1.6; margin-bottom:10px;">{h.methodology}</div>'
                    f'<div style="font-family:JetBrains Mono,monospace; font-size:0.68rem; '
                    f'color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Challenges</div>'
                    f'<div>{challenges_html}</div>'
                    f'<div style="font-family:DM Sans,sans-serif; font-size:0.8rem; '
                    f'color:#64748b; margin-top:10px; font-style:italic;">{h.novelty_explanation}</div>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
