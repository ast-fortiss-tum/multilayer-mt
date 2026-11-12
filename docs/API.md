# MultilayerMT API and integration guide

MultilayerMT can be used at four levels. Use the highest one that fits your needs.

| Level | Use it for | Entry points |
|---|---|---|
| 1. One call | CI, scripts, evaluating a suite | `runMutationAnalysis`, `evaluateTestSuite`, CLI `mlmt run` |
| 2. Engine | progress UIs, custom pipelines, reusing traces | `createEngine`, `MutationEngine` (typed events) |
| 3. Building blocks | crawlers, agents, test generators, custom harnesses | `attachRecorder`, `applyDomMutation`, `applyNetworkMutation`, `applyMutant`, `mutateTestSource`, `listTestMutationSites`, `buildPweModel`, `generateMutants` |
| 4. Extension | new fault models, new outputs | plugins (`definePlugin`, `define*Operator`), reporters |

Install (Node.js ≥ 18; `@playwright/test` ≥ 1.40 is a peer dependency):

```bash
npm install --save-dev github:ast-fortiss-tum/multilayer-mt   # builds on install (prepare)
```

Everything is exported from `multilayer-mt`, with type declarations. There are two subpath exports:

- `multilayer-mt/fixture`: a drop-in replacement for `@playwright/test`, aware of MultilayerMT.
- `multilayer-mt/browser`: the self-contained in-page scripts (recorder, DOM mutator).

---

## 1. One call

```ts
import { runMutationAnalysis } from 'multilayer-mt';

const report = await runMutationAnalysis({
  // a config file path, a config object, or omit it to discover mlmt.config.* in cwd
  config: { projectRoot: '/path/to/project', testDir: 'e2e', maxPwe: 8 },
  overrides: { layers: ['dom', 'network'], workers: 4 },
  onResult: (r, { done, total }) => console.log(`${done}/${total} ${r.mutant.id} ${r.status}`),
  reporters: ['json', 'html'],      // the API disables reporters unless you list them
});

report.totals.mutationScore;        // killed / (killed + survived)
report.perLayer.network;            // Counts per layer
report.results.filter((r) => r.status === 'SURVIVED');   // test gaps, with r.gapCategory
```

`RunReport` (see `src/types.ts`) contains the totals, per-layer and per-operator
counts, gap categories, the PWE model, and every `MutantResult`. Each result
holds the mutant descriptor, its status, its duration, the per-test outcomes and
the error messages.

### Evaluating generated tests (test generation, LLM agents)

`evaluateTestSuite` adds in-memory test files to a sandbox copy of the suite,
so nothing is written into the project. With `onlyInline: true` only those
files are traced, mutated and executed:

```ts
import { evaluateTestSuite } from 'multilayer-mt';

const report = await evaluateTestSuite(
  { 'generated/login.spec.ts': generatedSource },          // path relative to testDir
  { config: 'mlmt.config.json', onlyInline: true, overrides: { maxPwe: 4 } },
);
const fitness = report.totals.mutationScore ?? 0;            // e.g. a search fitness function
```

Paths of generated files are relative to the project's `testDir`, so relative
imports of helpers (`../helpers`) resolve as they would for a real file.

---

## 2. Engine

```ts
import { createEngine } from 'multilayer-mt';

const engine = await createEngine({ config: 'mlmt.config.json', logger: console as any });
engine.on('phase', (p) => console.log('phase', p));        // server|baseline|trace|pwe|generate|execute|report|done
engine.on('generated', (mutants) => console.log(mutants.length, 'mutants'));
engine.on('mutant:result', (r, p) => bar.update(p.done / p.total));

// either the whole pipeline ...
const report = await engine.run({ reuseTrace: true, signal: abortController.signal });

// ... or step by step
const trace = await engine.trace();                 // baseline + trace runs
const pwe = engine.pwe(trace);                      // PWE ranking per page
let mutants = engine.generate(trace, pwe);          // descriptors (D/N/T0001...)
mutants = mutants.filter((m) => m.layer !== 'test');
const results = await engine.execute(mutants, trace.baseline);
engine.cleanup();
```

Notes:
- `run()` takes `{ trace, mutants, reporters, reuseTrace, signal }`. Aborting
  kills the running Playwright processes and rejects with `AbortError`.
- Each engine works in its own sandbox namespace (`runId`), so several engines
  can run in parallel on one project. Give each one its own `outputDir`.
- The library is silent by default. Pass a `Logger` (`consoleLogger()` or your
  own `{info, warn, error, debug}`) to see output.

---

## 3. Building blocks

### Recording traces from a crawler or an agent

The PWE model is built from interaction traces. A trace does not have to come
from a test suite: any browsing session can produce one.

```ts
import { attachRecorder, createSuiteTrace, buildPweModel, runMutationAnalysis } from 'multilayer-mt';

const context = await browser.newContext();
const rec = await attachRecorder(context, { pageKeyQuery: ['title', 'action'] });
await crawl(context);                                         // your crawler / agent
const t = await rec.stop({ testFile: 'crawler', testTitle: 'session-1' });

t.interactions;   // [{ kind: 'click'|'fill'|'focus'|'hover', pageKey, selector }]
t.snapshots;      // pageKey -> selector -> ElementInfo (tag, attrs, visibility, facts)
t.network;        // requests with endpoint, status and the shape of JSON bodies

const pwe = buildPweModel(createSuiteTrace([t]), 8);           // top-8 elements per page

// use the crawl to target mutants, and the test suite to kill them
const report = await runMutationAnalysis({ config: 'mlmt.config.json', trace: createSuiteTrace([t], baseline) });
```

When you pass your own trace, also pass the `baseline` (the test keys that pass).
Otherwise every failing test counts as a kill.

### Mutating a live page

Use this for robustness checks of crawlers or agents, for fault injection in
any Playwright script, or to stack mutations into higher-order mutants:

```ts
import { applyDomMutation, applyNetworkMutation } from 'multilayer-mt';

const a = await applyDomMutation(page, { operator: 'SVM.display.none', selector: '#save' });
const b = await applyDomMutation(page, { operator: 'TIM.node.removeSafe' });                // page scope
const c = await applyNetworkMutation(page, { operator: 'NSO.status.override', url: 'https://app/api/items', params: { status: 503 } });
await page.goto('https://app/');
a.applied();   // ['css rule injected for 1 element(s)'] (empty = target never matched)
```

- The target can be a `Page` or a `BrowserContext`.
- DOM mutations apply to the current document and to future navigations, and
  they are re-applied when the DOM changes (SPAs).
- Without `pageKey` a mutation applies on every page.
- `applyMutant(target, descriptor)` injects a descriptor produced by
  `generateMutants` or `engine.generate`.

### Test-script mutations on strings

```ts
import { listTestMutationSites, mutateTestSource } from 'multilayer-mt';

listTestMutationSites(source);              // [{ operator, site, line, description, snippet }]
const mutated = mutateTestSource(source, 'AOF.assert.flip', { site: 2 });
```

### Other stages

| Function | Purpose |
|---|---|
| `generateMutants(cfg, pwe, trace, { testSources })` | create mutant descriptors |
| `classify(mutant, runOutcome, baselinePassed, applications)` | decision tree of Fig. 4.4 |
| `countResults`, `perLayer`, `gapCategory` | metrics |
| `createSandbox`, `runPlaywright`, `parseJsonReport` | executor internals |
| `htmlReport`, `textSummary`, `aggregate` | report rendering |
| `payload.dropField/renameField/changeType/...` | JSON fault transformations |

---

## 4. Extension

### Plugins: custom operators

Plugins are modules referenced by path, in the config (`"plugins": ["./ops.js"]`)
or with `--plugin`. They are loaded by reference because network operators run
inside the Playwright worker processes. A plugin can be a plain object, so the
plugin file does not need to import this package:

```js
// ops.js
module.exports = {
  name: 'my-operators',
  operators: [
    {
      id: 'XAM.title.remove', layer: 'dom', category: 'Attribute Mutations', intent: 'Remove tooltips',
      applicable: (el) => 'title' in el.attrs,            // generation-time pre-check on the traced element
      // runs in the browser and is serialised: it must be self-contained
      apply(el, params, { rand }) {
        if (!el.hasAttribute('title')) return null;          // null = not applicable here
        el.removeAttribute('title');
        return 'title removed';
      },
    },
    {
      id: 'XNS.status.teapot', layer: 'network', defaults: { status: 418 },
      handle: async ({ route, request, params, applied, rand }) => {
        applied('418');
        await route.fulfill({ status: params.status, body: '{}' });
      },
    },
    {
      id: 'XTO.goto.remove', layer: 'test',
      findSites: (sourceFile, params, ts) => [/* { edits: [{ start, end, text }], line, snippet, description } */],
    },
  ],
};
```

Rules:
- Ids have the form `FAMILY.name[.variant]`.
- DOM operators can set `scope: 'page'`; their `apply` then receives
  `document.documentElement`.
- A mutant that never reports `applied` is SKIPPED.
- In-process alternatives: `registry.register(def)` and `new OperatorRegistry()`.

### Reporters

The `reporters` option accepts:
- built-in names: `json`, `html`, `markdown`, `console`;
- `[name, options]`, e.g. `["json", { "file": "mm.json" }]`;
- a module path whose default export is `(report, { outputDir, config }, options) => void`;
- a function (programmatic use only).

---

## Configuration

Configs can be `mlmt.config.json`, `.js`, `.cjs` or `.mjs` (an object or a
function returning one), or an object passed to the API. `defineConfig()` adds
typing. The JSON Schema in `docs/config.schema.json` provides editor completion
through `"$schema"`. All options with their defaults are in `src/config.ts`
(`MlmtConfig`, `DEFAULT_CONFIG`). Invalid configs raise a `ConfigError` that
lists every problem.

## CLI

```
mlmt init                                   # scaffold mlmt.config.json
mlmt run [--max-pwe 8] [--layers dom,network] [--operators SVM,NSO] [--threshold 60] [--json]
mlmt trace | pwe | generate                 # individual stages
mlmt operators [--json] [--plugin ./ops.js]
mlmt sites tests/login.spec.ts [--json]     # test-script mutation sites
mlmt mutate tests/login.spec.ts --operator AOF.assert.flip --site 0 [-o out.ts]
mlmt report .mlmt/report-pwe8.json          # re-render HTML
mlmt aggregate results/*.json -o study.md   # thesis Ch. 5 tables
```

- Without `-c`, `mlmt.config.*` is discovered in the current directory.
- Most config keys have a flag (`--project-root`, `--test-dir`,
  `--playwright-config`, `--output-dir`, `--plugin`, `--reporter`), so the CLI
  also works without a config file.
- `--json` writes machine-readable output to stdout and logs to stderr.
- Exit codes: `0` ok, `1` error, `2` usage or config error, `3` mutation score
  below `--threshold`, `130` interrupted.

### CI example (GitHub Actions)

```yaml
- run: docker compose up -d app && npx wait-on http://localhost:8080
- run: npx mlmt run --max-pwe 8 --threshold 60 --reporter json --reporter html
- uses: actions/upload-artifact@v4
  with: { name: mutation-report, path: .mlmt/report-pwe8.* }
```
