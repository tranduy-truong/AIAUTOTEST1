# Generated E2E tests

E2E specs are generated from the current scenario directly into `tests/e2e/`.
Generated `*.spec.ts` and `*.spec.js` files in this directory are intentionally
ignored by Git because they may contain the URL and test credentials supplied for
a particular website.

Generate a suite from the CLI before running Playwright. Each generation replaces
the previous generated suite so tests from different websites are not mixed.
