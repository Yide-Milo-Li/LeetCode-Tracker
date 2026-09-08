# Changelog

## Unreleased

- Streamlined storage engine and contracts to focus purely on user-provided data ingestion.
- Implemented high-performance JSON Lines (`.jsonl`) BYOD ingestion pipeline with lenient tag and URL derivation.
- Added atomic SQLite UPSERT storage for problem catalog with audit history logging.
- Documented LLM prompt templates for ChatGPT, Gemini, and Claude to format custom problem lists.
- Verified bulk ingestion throughput of 1,000 problems under 20ms and 4,000+ problems under 100ms.
- Preserved user problem catalog locally into private backup.
