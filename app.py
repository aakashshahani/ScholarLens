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
from agents import PDFAnalysisAgent


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

db = get_db()
agent = get_agent()


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

    page = st.radio(
        "Navigate",
        ["◈ Upload", "◇ Library", "◆ Search", "◇ Detail"],
        index=["◈ Upload", "◇ Library", "◆ Search", "◇ Detail"].index(
            st.session_state.get("nav_page", "◈ Upload")
        ),
        key="nav_radio",
        label_visibility="collapsed",
    )
    st.session_state["nav_page"] = page

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
