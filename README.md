# MultilayerMT

Codebase of the MSc thesis by Yunus Melih Gözütok, *"Multi-Layer Mutation Testing for E2E Web Applications Testing"* (TUM, 2025).

> **Note:** the core of this code was reconstructed from the thesis text; the original
> implementation was not available. Where the thesis does not specify a detail, the
> decision taken is documented in [`docs/RECONSTRUCTION.md`](docs/RECONSTRUCTION.md),
> together with the corrections made to the thesis operators while replicating the
> study. On top of the thesis's 51 operators the tool ships a library of 251 operators
> collected from the web mutation testing literature
> ([`docs/OPERATORS.md`](docs/OPERATORS.md)).

MultilayerMT assesses the adequacy of Playwright end-to-end test suites with
**runtime mutation testing on three layers**:

| Layer | Thesis | Library | How mutations are injected |
|---|---|---|---|
| DOM | 32 | 153 | `context.addInitScript()`: applied to elements as the page is parsed and re-applied on DOM changes via `MutationObserver`; browser-API patches installed at document start; runner-side hooks (viewport, CDP throttling); rewriting of served scripts through request routing |
| Network | 11 | 65 | request interception (`context.route()`, `route.fetch()` / `fulfill()` / `abort()` / `continue()`), on responses and on requests |
| Test script | 8 | 33 | AST rewriting (TypeScript compiler API) into a temporary copy of the test files |

The application source code and the original test files are never modified.
DOM mutants target **Prioritized Web Elements (PWE)**: elements ranked by
`0.4·Interaction + 0.3·Visibility + 0.3·Semantic`, computed from a traced
baseline run of the suite.

## Architecture (thesis Fig. 4.1)

```
config + Playwright suite + running app
            │
     runMutationAnalysis() ────── src/api.ts
     MutationEngine ───────────── src/engine/engine.ts (typed events)
      │        │
      │   trace run (fixture → instrumentation)   src/runtime/{fixture,instrument}.ts, src/browser/recorder.ts
      │        │
  PWE selector (scoring, top-N per page)          src/pwe/pwe.ts
      │
  mutant generator + operator registry/plugins    src/engine/generator.ts, src/operators/registry.ts
      │      thesis DOM ops      src/browser/domMutator.ts
      │      thesis network ops  src/operators/network/{payload,runtime}.ts
      │      thesis test ops     src/operators/test/{astMutator,astUtil}.ts
      │      literature library  src/operators/lit/{domElement,domA11y,domPage,jsSource,network,testScript}.ts
      │
  test executor (sandbox + `playwright test`)     src/engine/{sandbox,executor}.ts
      │
  result classifier (KILLED/SURVIVED/SKIPPED/…)   src/engine/classifier.ts
      │
  reporters (json/html/markdown/console/custom)   src/report/{report,reporters}.ts
      │
  CLI                                             src/cli.ts
```

## Installation

Requirements: Node.js ≥ 18 and a project that uses `@playwright/test` (≥ 1.40).

```bash
# as a dependency of another project (built on install)
npm install --save-dev github:ast-fortiss-tum/multilayer-mt

# or for development of MultilayerMT itself
npm ci && npm run build
npm test            # unit + integration tests (incl. all DOM operators in Chromium)
npm run test:e2e    # full pipeline on the demo app through the programmatic API
```

## Quick start (CLI)

```bash
npx mlmt init                     # writes mlmt.config.json (detects playwright config + test dir)
# start the application under test, then:
npx mlmt run                      # trace -> PWE -> generate -> execute -> report
npx mlmt run --max-pwe 16 --reuse-trace --layers dom,network
npx mlmt run --operator-set thesis                # only the 51 thesis operators (default: thesis + library)
npx mlmt run --threshold 60 --json > result.json   # CI gate: exit code 3 below 60%
```

| Command | Purpose |
|---|---|
| `mlmt init` | scaffold a config |
| `mlmt run` | full pipeline |
| `mlmt trace` / `pwe` / `generate` | individual stages |
| `mlmt operators [--set thesis\|literature] [--layer L] [--plugin m.js]` | list operators (built-in + library + plugins) |
| `mlmt sites <test>` / `mlmt mutate <test> --operator X --site n` | test-script mutations on single files |
| `mlmt report <report.json>` | re-render the HTML report |
| `mlmt aggregate <r1.json> …` | Markdown tables of thesis Ch. 5 across runs |

## Operator library

Besides the 51 operators of the thesis, MultilayerMT ships **251 operators from the web
mutation testing literature** (MAEWU, webMuJava, Mutandis, AjaxMutator, Ma11y,
HTTPMutator, RESTest, Gremlin, Stryker, …): DOM and CSS mutations, browser-API
and timer faults, accessibility and presentation faults, 65 network/HTTP/API faults
(response and request side), 43 rewrites of the application's served JavaScript, and
33 test-script mutations. Every operator cites its sources and the identifiers it has
in them; the full catalogue, the source operators that cannot be injected into a
running app, and the references are in **[docs/OPERATORS.md](docs/OPERATORS.md)**.

```bash
npx mlmt operators --set literature --layer network       # list
npx mlmt run --operator-set thesis                        # the 51 thesis operators only
npx mlmt run --operator-set literature --layers network   # library only, one layer
npx mlmt run --operators A11,HTM,JSM.eq                   # families or ids (any set)
```

`operatorSet` defaults to `all`. The library is large — on MediaWiki at PWE-8 the thesis
set generates about 4,200 mutants and the whole library about 30,000, most of them
JavaScript rewrites (one per script, page and variant) — so select operators or
sample with `--max-mutants`. Study configs that must stay comparable with the thesis
set `"operatorSet": "thesis"`.

Every command supports `--json`. Exit codes: 0 ok, 1 error, 2 usage/config, 3 below threshold, 130 interrupted.

## Library use

```ts
import { runMutationAnalysis, evaluateTestSuite, applyDomMutation, attachRecorder } from 'multilayer-mt';

// whole pipeline
const report = await runMutationAnalysis({ config: 'mlmt.config.json', onResult: (r) => console.log(r.mutant.id, r.status) });

// score generated tests without writing them into the project
const r2 = await evaluateTestSuite({ 'gen/a.spec.ts': source }, { config: 'mlmt.config.json', onlyInline: true });

// building blocks for crawlers / agents / custom harnesses
const rec = await attachRecorder(context);                                   // traces -> PWE model
await applyDomMutation(page, { operator: 'SVM.display.none', selector: '#save' });
```

The library also offers custom operators through plugins on all three layers,
pluggable reporters, a typed event-emitting `MutationEngine`, AbortSignal
support, and config files in JSON/JS/MJS with a JSON Schema. See
**[docs/API.md](docs/API.md)**.

Configuration highlights (full list in [`docs/config.schema.json`](docs/config.schema.json)):
`layers`, `maxPwe`, `workers`, `testSelection`, `operatorSet`, `operators.include/exclude`,
`operatorParams`, `pageKeyQuery` (which query parameters identify a page) and
`pageKeyNormalize` (regex rewrites that make page keys and endpoints stable when URLs embed
run-specific ids, e.g. test-generated page titles).

Outputs (in `.mlmt/` by default): `trace.json`, `pwe-<N>.json`,
`mutants-pwe<N>.json`, `report-pwe<N>.{json,html}`, and per-mutant folders under
`runs/` (mutant descriptor, mutated test file, result).

## How a mutant is executed

1. The test directory is copied to `.mutants/<id>/`; imports of `@playwright/test`
   are redirected to the MultilayerMT runtime fixture, and a wrapper Playwright
   config points at the copy (`webServer` is dropped, retries set to 0).
2. DOM and network mutants run against one shared instrumented copy; the fixture
   reads the mutant descriptor and registers the mutation on every new browser
   context (DOM mutations in the page, runner-side effects such as viewport or script
   rewriting through request routing). Test-script mutants get their own copy with one
   AST-mutated file.
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
cd examples/todo-app && node ../../dist/src/cli.js run
```

## Empirical study (thesis Chapter 5)

[`experiments/`](experiments/) holds the driver script that runs every subject with
PWE-4/8/16 and aggregates the results into the tables of Chapter 5.

The subjects are the [BEWT](https://github.com/OlianasD/BenchmarkE2EWebTesting) web
applications. BEWT ships Java/Selenium suites and the thesis's Playwright versions were
never published, so the suites are being ported to Playwright one application at a time
under `experiments/subjects/<app>/` (deployment scripts, specs, list of deviations from
BEWT). Status:

| Subject | Status |
|---|---|
| MediaWiki 1.40.0 | ported: 27 tests, all passing; first pilot results in `experiments/results/mediawiki/` |
| Bludit, Claroline, Joomla, Kanboard, MantisBT, PrestaShop | not yet ported |

The study configs pin `"operatorSet": "thesis"` so that results stay comparable with the
thesis. See [`experiments/README.md`](experiments/README.md) and
[`experiments/subjects/mediawiki/README.md`](experiments/subjects/mediawiki/README.md).

## License

MIT
