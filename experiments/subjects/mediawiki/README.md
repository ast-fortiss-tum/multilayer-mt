# MediaWiki subject (BEWT `mediawiki-1.40.0`)

Playwright (TypeScript) port of the BEWT MediaWiki suite
(<https://github.com/OlianasD/BenchmarkE2EWebTesting>, `mediawiki/baseline/mediawiki-1.40.0`,
Java + Selenium + JUnit, 27 tests). The thesis used Playwright versions of the
BEWT suites; those were not published, so this port was written from the Java
sources and the Gherkin specifications.

## Run

```bash
./docker/setup.sh            # MediaWiki 1.40.0 + MariaDB on http://localhost:8080
npx playwright test          # from this directory; all 27 tests should pass
# mutation testing (from the repository root)
node dist/src/cli.js run -c experiments/subjects/mediawiki.mlmt.json
```

`./docker/setup.sh --reset` wipes the database and reinstalls.

## Mapping

One spec per Java test class, numbered as in the BEWT `TestSuite` order
(and the Gherkin files): `01-create-user.spec.ts` = `CreateUserTest`, ...,
`27-create-empty-user-fails.spec.ts` = `CreateEmptyUser_Fails`. Each spec
performs the same UI steps and the same assertions as its Java test; the
steps of the Java page objects are written inline in the spec so that the
test-script mutation operators (which only mutate `*.spec.ts`) see them.
`tests/support/ui.ts` is the counterpart of `BaseTest` (login).

## Deviations from BEWT

| Topic | BEWT (Java) | Port | Why |
|---|---|---|---|
| Test independence | Tests share state and must run in suite order (User001 is created by test 1, the "Selenium WebDriver" page by test 8, ...) | Each test creates the state it needs through the MediaWiki API (`tests/support/api.ts`) with unique names (`… Q9xxxxxxxx`) | MultilayerMT runs tests per mutant, in parallel, repeatedly against one instance; order-dependent tests would fail for reasons unrelated to the mutant |
| "admin" account | One `admin` (sysop + bureaucrat) | A fresh sysop + bureaucrat per test (`freshAdmin`) | Per-user state (dismissed VisualEditor welcome dialog, preferred editor) would otherwise leak across tests |
| Implicit state | e.g. VisualEditor welcome dialog already dismissed after test 2; user is admin and blocked when the password tests run; source editor remembered before test 26 | Reproduced explicitly per test (user preferences `visualeditor-hidebetawelcome`, `visualeditor-editor`; groups; block) | Same behaviour as in the suite order |
| Expected texts | Fixed names (User001, "Admin", "Software testing") | Same texts with the generated names | Unique names |
| Locators | Mostly absolute XPaths, `linkText`, ids | Ids, names, roles/labels, MediaWiki/OOUI classes | Absolute XPaths depend on layout details that differ between Selenium/Chrome 138 and Playwright; ids are kept wherever the Java code used them |
| Waits | `Thread.sleep` + 30 s implicit wait | Playwright auto-waiting, plus explicit waits where the UI needs JS initialisation (`searchReady`, `moduleReady`) or a dialog to close | Equivalent synchronisation without fixed sleeps |
| `getText()` | Selenium visible text | `toHaveText(..., { useInnerText: true })` for page bodies | Same semantics (rendered text) |
| Ctrl+Home / Ctrl+End | Linux/Windows chords | `DOC_START` / `DOC_END` (Cmd+Up/Down on macOS) | Platform key bindings |
| Installation | Web wizard (`mediawiki.Installer`) | `maintenance/install.php` + the same settings | Scriptable; same site name, admin, rights profile (fishbowl), extensions, no e-mail, no object cache |

Deployment settings added for repeated parallel execution (see `docker/setup.sh`):
throttles/rate limits lifted, MariaDB at READ-COMMITTED (concurrent account
creation deadlocks otherwise), `$wgCachePages = false` and
`$wgParserCacheType = CACHE_NONE` (a page viewed within a second of being
changed is otherwise served stale; BEWT's sleeps hide this).

## MultilayerMT configuration

`../mediawiki.mlmt.json`. Page identity uses the `title`, `action` and
`veaction` query parameters, and `pageKeyNormalize` maps the run-specific ids
to a placeholder (`Q9#`) so that page keys and network endpoints are the same
in the trace run and in every mutant run.
