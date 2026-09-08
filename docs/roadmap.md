# Roadmap

1. Maintain contracts, SQLite storage and synthetic tests.
2. Define and implement validated user-data import, schema compatibility checks, migrations and backup/restore. Verify failure preserves existing data.
3. Implement explicit strategies, conflict-safe weekday assignments, rest days and versioned recommendations.
4. Add validated Gemini selection and a bilingual web interface.
5. Validate clean installation, recovery, CI and release artifacts.

Users provide their own compatible database with appropriate usage rights. No dataset is distributed. Each milestone requires its own implementation and verification; a successful synthetic test is not real-data validation.
