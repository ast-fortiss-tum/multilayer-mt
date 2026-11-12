# Reconstruction notes

This codebase was rebuilt from the thesis PDF alone; the original code was not
available. This document maps thesis sections to code and lists every place
where the thesis leaves a detail open, along with the decision taken.
Nothing here claims to match the original implementation byte for byte.

## Mapping thesis → code

| Thesis | Code |
|---|---|
| Fig. 4.1 architecture: Mutation Engine | `src/engine/engine.ts` |
| Fig. 4.1: Coverage map / trace analysis | `src/runtime/fixture.ts` (trace mode), `src/browser/recorder.ts` |
| Sec. 4.3 PWE selector, Table 4.3, Eq. 4.1 | `src/pwe/pwe.ts` |
| Table 4.2 and Sec. 4.2.1 operator catalog (51) | `src/operators/catalog.ts` |
| DOM layer operators (32) | `src/browser/domMutator.ts` |
| Network layer operators (11) | `src/operators/network/payload.ts`, `src/operators/network/runtime.ts` |
| Test-script layer operators (8) | `src/operators/test/astMutator.ts` |
| Sandbox (`.mutants/`, temporary AST-transformed copies) | `src/engine/sandbox.ts` |
| Test executor | `src/engine/executor.ts` |
| Result classifier, Fig. 4.4 / Fig. 5.1, metrics of Sec. 5.2 | `src/engine/classifier.ts` |
| Sec. 4.5 step 3, mutant generation | `src/engine/generator.ts` |
| Sec. 4.5 step 6, JSON+HTML report; Ch. 5 tables | `src/report/report.ts` |
| Ch. 5 procedure (7 apps × PWE-4/8/16) | `experiments/run-study.sh` |

## Decisions where the thesis is underspecified

### Trace collection
The thesis says "Playwright records all page interactions … analyze the trace".
Parsing Playwright trace archives is fragile across versions. Instead, a runtime
fixture injects an in-page recorder (capture-phase listeners for click / input /
focusin / mouseover) and takes element snapshots on load and after DOM changes.
Network responses are recorded with `context.on('response')`, together with a
shape summary of JSON bodies.
- A `fill`/`type` burst of `input` events counts as one fill.
- The `focus` and `mouseover` that a click produces are not counted separately.
- An interaction is credited to the nearest interactive ancestor (`button`, `a`,
  form controls, `label`, `[role=button|link]`, `[onclick]`).

### Injecting mutations without changing the tests
Playwright offers no hook to instrument an unmodified suite. Like the thesis's
test-script sandbox, every run executes a copy of the test directory whose
`@playwright/test` imports point to a fixture that re-exports Playwright and
overrides the `context` fixture. Tests that create contexts manually through
`browser.newContext()` are not instrumented.

### PWE normalisation
Sec. 4.3 gives the scores in points. The case study uses I, V, S in [0, 1]. The
points are normalised as follows: interaction / max interaction on the same
page, visibility / 25, semantic / 20. Elements whose semantic tag is not listed
(e.g. `h1`, `img`, `li`) get S = 0. Pages are identified by origin + path + the
query parameters chosen with `pageKeyQuery`.

### DOM operator details
- Element operators also re-apply to elements that appear later (SPA
  re-rendering) via a `MutationObserver`. Applied nodes are marked with
  `data-mlmt-mutated`.
- `CDM.text.*` operate on descendant text nodes, so that the element structure
  is kept intact.
- `CDM.input.prependWhitespace` pads the value on change/blur/submit/click/Enter.
- `EVD.click.stopPropagation` uses a non-capturing listener on the target. A
  capturing one would also suppress the target's own handlers, which goes beyond
  the intent "parent handler not triggered".
- `EVD.click.delay` / `EVD.submit.delay` cancel the event and replay it after a
  random delay in [300, 800] ms (seeded).
- `TIM.node.removeSafe`, `SFM.script.fail` and `SFM.stylesheet.fail` are
  page-scoped: one mutant per page, or one per external resource for SFM.
  Parser-inserted resources are fetched before any DOM rewrite can happen, so
  SFM additionally fails the request with a 404 at the network boundary.
- `TIM.form.reorderFields` and `EVD.submit.delay` target the enclosing form and
  are deduplicated per form.
- `ATD.alt.delete` / `BSM.img.break` also apply to images inside the PWE (e.g. a
  logo inside a link). `ARM.role.modify` also maps implicit roles
  (button → link, …).
- `PVM.pattern.break` decrements the first `{n}` / `{n,m}` quantifier, otherwise
  turns `+` into `*`, otherwise uses the impossible pattern `(?!)`.

### Network operator details
- Targets are endpoints (`METHOD origin+path`, query ignored) observed during
  tracing for the configured resource types (default: xhr, fetch, document) on
  the application's origin(s).
- Every endpoint gets all 11 operators (as in the thesis, where most network
  mutants are skipped). Payload operator parameters are inferred from the
  observed JSON when the thesis default field (`userId`, `username`, `age`,
  `status`) is not present.
- Requests reached only through an HTTP redirect cannot be intercepted by
  Playwright, so their mutants are SKIPPED.
- Interception itself adds a little latency. That can expose real races in the
  application. The demo app has one (a todo added before the initial load
  finishes gets overwritten).

### Test-script operator details
- Sites are found on the AST and applied as text edits, so formatting and line
  numbers stay intact. One mutant is generated per site, up to
  `test.maxSitesPerOperator` per file. A (file, operator) pair with no site
  becomes a single SKIPPED mutant, consistent with the thesis's high skip rate
  for this layer.
- AOL/AOT matcher maps extend the thesis defaults (`toEqual ↔ toContain`) with
  the Playwright web-first matchers (`toHaveText ↔ toContainText`, …).
- SOG rewrite rules: `tag#id → tag`, `tag[attr] → tag`, `.a.b → .a`,
  `ancestor > child → child`, `#id → [id]`, `getByRole(r, {name}) → getByRole(r)`.
  The thesis example `#login-btn → .btn` needs knowledge of the element's class,
  which a static rewrite does not have.
- SOS appends `:nth-child(3)` to CSS selectors and `.nth(2)` to `getBy*` locators.

### Execution and classification
- A baseline run without instrumentation comes first. Only tests that pass in
  the baseline can kill a mutant.
- By default only the test files that reached the mutated page or endpoint are
  run (`testSelection: "covering"`); `"all"` runs the full suite as in Sec. 4.5.
- Mutants run in parallel (`workers`, default 4), each in its own Playwright
  process with one worker, retries 0, and a fresh browser context per test.
- DOM and network mutants that were never applied during the run are SKIPPED.
  This is the runtime "pre-check".
- Gap categories of survived mutants (Table 5.6) are assigned by operator
  family: timing (EVD delays, NLF/NLR/NOR/NOD, TWR/TWA), error handling
  (NSO/NLT/payload/SFM/BSM/RLB), and weak assertions (all others).
- The speedup in the aggregate is the sum of the per-mutant run times divided by
  the wall time.
