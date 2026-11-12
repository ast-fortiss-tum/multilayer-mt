# Empirical study (thesis Chapter 5)

The study ran MultilayerMT on seven BEWT subjects (Bludit, Claroline, Joomla,
Kanboard, MantisBT, MediaWiki, PrestaShop) with three PWE limits (4, 8, 16),
i.e. 21 runs, with 4 parallel workers.

The subjects and their Playwright suites are **not** part of this repository.
To reproduce:

1. Deploy each subject in Docker with seed data and make sure its Playwright
   suite passes (baseline). MultilayerMT drops the `webServer` entry of the
   Playwright config, so the application must already be running (or use the
   `server` option of the MultilayerMT config).
2. Copy `subjects/TEMPLATE.mlmt.json` to `subjects/<name>.mlmt.json` per subject
   and fill in the paths. Use `pageKeyQuery` to choose which query parameters
   identify a page (e.g. `["title", "action"]` for MediaWiki's `index.php`).
3. Build MultilayerMT (`npm ci && npm run build` in the repository root) and run

   ```bash
   experiments/run-study.sh experiments/subjects/*.mlmt.json
   ```

   This produces one JSON+HTML report per run and `results/aggregate.md` with
   the tables of Sec. 5.5 (overall results, per application, per layer, test-gap
   categories, performance/speedup).
