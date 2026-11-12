# MultilayerMT

Codebase of the MSc thesis by Yunus Melih Gözütok, *"Multi-Layer Mutation Testing for E2E Web Applications Testing"* (TUM, 2025).

> **Note:** this code was reconstructed from the thesis text. The original
> implementation was not available. Where the thesis does not specify a detail,
> the decision taken is documented in [`docs/RECONSTRUCTION.md`](docs/RECONSTRUCTION.md).

MultilayerMT assesses the adequacy of Playwright end-to-end test suites with
**runtime mutation testing on three layers**:

| Layer | Operators | How mutations are injected |
|---|---|---|
| DOM | 32 | `context.addInitScript()`, re-applied on DOM changes via `MutationObserver` |
| Network | 11 | request interception (`context.route()`, `route.fetch()` / `fulfill()` / `abort()`) |
| Test script | 8 | AST rewriting (TypeScript compiler API) into a temporary copy of the test files |

The application source code and the original test files are never modified.
DOM mutants target **Prioritized Web Elements (PWE)**: elements ranked by
`0.4·Interaction + 0.3·Visibility + 0.3·Semantic`, computed from a traced
baseline run of the suite.

## Architecture (thesis Fig. 4.1)

```
config + Playwright suite + running app
            │
     MutationEngine ───────────── src/engine/engine.ts
      │        │
      │   trace run (runtime fixture, recorder)   src/runtime/fixture.ts, src/browser/recorder.ts
      │        │
  PWE selector (scoring, top-N per page)          src/pwe/pwe.ts
      │
  mutant generator                                src/engine/generator.ts
      │      DOM ops      src/browser/domMutator.ts
      │      network ops  src/operators/network/{payload,runtime}.ts
      │      test ops     src/operators/test/astMutator.ts
      │
  test executor (sandbox + `playwright test`)     src/engine/{sandbox,executor}.ts
      │
  result classifier (KILLED/SURVIVED/SKIPPED/…)   src/engine/classifier.ts
      │
  reporter (JSON + HTML, aggregate tables)        src/report/report.ts
```

## Installation

Requirements: Node.js ≥ 18 and a project that uses `@playwright/test` (≥ 1.40).

```bash
npm ci
npm run build
npm test            # unit tests + all 32 DOM operators exercised in Chromium
```

## Usage

1. Make sure the application under test is running and the Playwright suite passes.
2. Create a config (see [`examples/todo-app/mlmt.config.json`](examples/todo-app/mlmt.config.json)
   and [`src/config.ts`](src/config.ts) for all options):

   ```json
   {
     "app": "my-app",
     "projectRoot": ".",
     "playwrightConfig": "playwright.config.ts",
     "testDir": "tests",
     "maxPwe": 8,
     "workers": 4
   }
   ```

3. Run the pipeline:

   ```bash
   npx mlmt run -c mlmt.config.json            # trace → PWE → generate → execute → report
   npx mlmt run -c mlmt.config.json --max-pwe 16 --reuse-trace
   ```

Other commands:

| Command | Purpose |
|---|---|
| `mlmt operators` | list the 51 operators |
| `mlmt trace` | baseline run + trace run → `.mlmt/trace.json` |
| `mlmt pwe` | print the PWE ranking per page |
| `mlmt generate` | write mutant descriptors without executing them |
| `mlmt report <report.json>` | re-render the HTML report |
| `mlmt aggregate <r1.json> <r2.json> …` | Markdown tables of thesis Ch. 5 across runs |

Useful options: `--layers dom,network`, `--operators SVM,NSO.status.override`,
`--max-mutants 200` (seeded sample), `--all-tests` (run the full suite per
mutant), `--keep-sandboxes`.

Outputs (in `.mlmt/` by default): `trace.json`, `pwe-<N>.json`,
`mutants-pwe<N>.json`, `report-pwe<N>.json`, `report-pwe<N>.html`, and
per-mutant folders under `runs/` (mutant descriptor, mutated test file, result).

## How a mutant is executed

1. The test directory is copied to `.mutants/<id>/`; imports of `@playwright/test`
   are redirected to the MultilayerMT runtime fixture, and a wrapper Playwright
   config points at the copy (`webServer` is dropped, retries set to 0).
2. DOM and network mutants run against one shared instrumented copy; the fixture
   reads the mutant descriptor and registers the mutation on every new browser
   context. Test-script mutants get their own copy with one AST-mutated file.
3. Only test files that reached the mutated page/endpoint during tracing are run
   (`testSelection: "covering"`; use `"all"` for the full suite).
4. Classification (Fig. 4.4): not applied at runtime / no AST site → **SKIPPED**;
   crash or no report → **ERROR**; run timeout → **TIMEOUT**; at least one test
   that passed in the baseline fails → **KILLED**; otherwise **SURVIVED**.
5. Mutation score = killed / (killed + survived);
   applicability = (killed + survived) / generated.

## Demo

[`examples/todo-app`](examples/todo-app) is a small dependency-free web app (server-rendered
login + client-side todo list on a JSON API) with an 8-test Playwright suite:

```bash
npm run build
cd examples/todo-app && node ../../dist/src/cli.js run -c mlmt.config.json
```

## Empirical study

See [`experiments/`](experiments/) for the driver script that runs every subject
with PWE-4/8/16 and aggregates the results into the tables of Chapter 5.
The BEWT subjects themselves are not included.

## License

MIT
