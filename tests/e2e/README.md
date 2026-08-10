# Generated E2E tests

E2E specs are generated from the current scenario into `tests/e2e/generated/`.
That directory is intentionally ignored by Git because generated specs may contain
the URL and test credentials supplied for a particular website.

Generate a suite from the CLI before running Playwright. Each generation replaces
the previous generated suite so tests from different websites are not mixed.
