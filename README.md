# ScholarLens

**Research intelligence platform that actually reads your papers.**

Researchers juggle Google Scholar, Zotero, NotebookLM, and spreadsheets just to stay on top of a single literature review. ScholarLens replaces that workflow. Upload a paper, and an AI agent extracts the methodology, findings, limitations, and open questions automatically. Search across your entire library by meaning, not keywords. Ask questions and get answers grounded in your papers.

Not a wrapper around an LLM. The agent decides what to analyze, calls its own tools, and builds persistent knowledge that grows with your library.

![Python](https://img.shields.io/badge/Python-3.12-blue) ![License](https://img.shields.io/badge/License-MIT-green)

## How it works

The core is an agent loop with tool use. Instead of a fixed pipeline (extract > summarize > done), the agent gets a set of tools and a goal. It decides which tools to call, in what order, and when it's done.

For each paper, the agent produces six structured reports:
- **Summary** with objective, approach, and key results
- **Methods** breakdown (study design, sample, techniques, metrics)
- **Findings** with supporting evidence
- **Limitations** the authors admit, plus ones they missed
- **Key claims** with confidence levels and evidence quality
- **Research gaps** and follow-up questions

## Architecture

    Streamlit Frontend
      Upload / Library / Search / Detail
              |
      PDF Analysis Agent
      LLM + Tool Use (agentic loop)
        - Extract PDF text
        - Search stored passages
        - Store analysis results
              |
      Data Layer
        SQLite  (papers, metadata, analyses)
        ChromaDB (embeddings, similarity search)

## Quick start

```bash
git clone https://github.com/aakashshahani/ScholarLens.git
cd ScholarLens

python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-xxxxx
streamlit run app.py
```



## Project structure

    scholarlens/
      app.py               Streamlit frontend
      requirements.txt
      .env.example
      config/
        settings.py         Configuration and env vars
      agents/
        pdf_analyst.py      Core agent with tool use
      db/
        database.py         SQLite schema and data models
      utils/
        pdf_parser.py       PDF extraction and chunking
        vector_store.py     ChromaDB wrapper
      data/                 Created at runtime

## Tech stack

| Component | Choice | Why |
|-----------|--------|-----|
| LLM | Claude (Anthropic API) | Tool use support, strong at structured extraction |
| Embeddings | sentence-transformers (MiniLM) | Runs locally, no API cost |
| Vector DB | ChromaDB | Zero setup, persistent, migrates to pgvector |
| Database | SQLite | Single file, WAL mode, PostgreSQL-compatible schema |
| Frontend | Streamlit | Fast prototyping (React migration planned) |
| PDF parsing | pdfplumber | Best open-source option for academic papers |

## Roadmap

**Done:**
- PDF upload and structured analysis (6 report types)
- Section-aware chunking with overlap
- Semantic search across library
- Per-paper Q&A
- Contradiction detection across papers
- Hypothesis generation from cross-paper patterns

**Next:**
- Multi-paper synthesis
- arXiv/PubMed auto-import
- React + FastAPI frontend

First iteration:
<img width="1341" height="698" alt="image" src="https://github.com/user-attachments/assets/c2b39019-3b02-4ed5-9b6e-0425e31667ba" />
<img width="1431" height="740" alt="image" src="https://github.com/user-attachments/assets/21581233-2e03-494f-89ae-c269d4760f3b" />
<img width="1443" height="761" alt="image" src="https://github.com/user-attachments/assets/2303cd6d-8125-4d35-b88b-4334c16e1d18" />
<img width="1436" height="606" alt="image" src="https://github.com/user-attachments/assets/5ab67abf-2791-4c3a-aa2e-2b6f3af71ef5" />
<img width="1515" height="785" alt="image" src="https://github.com/user-attachments/assets/77571015-1795-4566-a564-e3770eb3d4fa" />
<img width="1543" height="434" alt="image" src="https://github.com/user-attachments/assets/01f2e632-5ab5-44f7-b7c9-3bbf1b396796" />
<img width="1502" height="672" alt="image" src="https://github.com/user-attachments/assets/d6604206-f185-436d-beb6-1c8f85a03e1d" />



## About

Built by Aakash Shahani, CS graduate from the University of South Florida (Dec 2025). Research assistant at the USF CSSAI lab studying whether LLMs can improve negotiation skills in humans. Started this project after spending weeks manually reading and comparing dozens of papers for that research. Figured the process of analyzing, searching, and cross-referencing papers should be automated.
