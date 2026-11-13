#!/usr/bin/env node
/**
 * Generates docs/OPERATORS.md from the operator registry (run `npm run build`
 * first): node scripts/gen-operators-doc.js
 * Tables are derived from the code; the references and the "not implemented"
 * section below are maintained by hand.
 */
const fs = require('fs');
const path = require('path');
const { registry } = require('../dist/src/operators/registry');

const REFS = {
  Gozutok25: 'Gözütok, *Multi-Layer Mutation Testing for E2E Web Applications Testing*, MSc thesis, TUM, 2025 (the 51 thesis operators).',
  Yandrapally21: 'Yandrapally, Mesbah, *Mutation Analysis for Assessing End-to-End Web Tests*, ICSME 2021 (MAEWU).',
  Yandrapally22: 'Yandrapally, Mesbah, *Fragment-Based Test Generation for Web Apps*, TSE 2022 (DOM mutation of recorded pages).',
  Praphamontripong10: 'Praphamontripong, Offutt, *Applying Mutation Testing to Web Applications*, Mutation/ICSTW 2010 (webMuJava).',
  Praphamontripong17: 'Praphamontripong, *Testing Web Applications with Mutation Analysis*, PhD thesis, GMU 2017; Praphamontripong et al., Mutation 2016 / 2017 (WLUR, WLUD, WFUR, WFTR, WHID, WHIR, WOID, FOB, FOR, …).',
  Mirshokraie15: 'Mirshokraie, Mesbah, Pattabiraman, *Efficient JavaScript Mutation Testing*, ICST 2013; *Guided Mutation Testing for JavaScript Web Applications*, TSE 2015 (Mutandis).',
  Nishiura13: 'Nishiura, Maezawa, Washizaki, Honiden, *Mutation Analysis for JavaScript Web Application Testing*, SEKE 2013 (AjaxMutator).',
  Maezawa14: 'Maezawa, Nishiura, Washizaki, Honiden, *Validating Ajax Applications Using a Delay-Based Mutation Technique*, ASE 2014 (JSPreventer).',
  RodriguezBaquero18: 'Rodríguez-Baquero, Linares-Vásquez, *Mutode*, ISSTA 2018 (tool demo).',
  Stryker: 'StrykerJS supported mutators, https://stryker-mutator.io/docs/mutation-testing-elements/supported-mutators/',
  Augustin25: 'Augustin, Winkelmann, Kuchen, *Mutation Operators for Mutation Testing of Angular Web Applications*, ENASE 2025.',
  Walsh20: 'Walsh, Kapfhammer, McMinn, *Automatically identifying potential regressions in the layout of responsive web pages*, STVR 2020.',
  Mahajan15: 'Mahajan, Halfond, *WebSee*, ICST 2015; *Using Visual Symptoms for Debugging Presentation Failures*, ICST 2016 (presentation-fault seeding).',
  Tafreshipour24: 'Tafreshipour et al., *Ma11y: A Mutation Framework for Web Accessibility Testing*, ISSTA 2024.',
  Oliveira15: 'Oliveira, Alégroth, Gao, Memon, *Definition and Evaluation of Mutation Operators for GUI-level Mutation Analysis*, Mutation 2015.',
  Shahriar09: 'Shahriar, Zulkernine, *MUTEC: Mutation-based Testing of Cross Site Scripting*, SESS 2009.',
  Loise17: 'Loise, Devroey, Perrouin, Papadakis, Heymans, *Towards Security-aware Mutation Testing*, Mutation 2017.',
  Almeida19: 'Almeida, Paiva, Restivo, *Mutation-Based Web Test Case Generation*, QUATIC 2019.',
  Maciel17: 'Maciel, Oliveira, Delamaro, *Quality Evaluation of Test Oracles Using Mutation*, SOFTENG 2017.',
  Danglot19: 'Danglot et al., DSpot input amplifiers, EMSE 2019.',
  Hammoudi16: 'Hammoudi, Rothermel, Tonella, *Why do record/replay tests of web applications break?*, ICST 2016.',
  Romano21: 'Romano et al., *An Empirical Analysis of UI-based Flaky Tests*, ICSE 2021.',
  Liu24: 'Liu et al., *WEFix*, WWW 2024.',
  Pei23: 'Pei et al., *TRaf* (time-based repair of async-wait flakiness), 2023.',
  FlakeMonster: 'FlakeMonster (AST delay injection), https://flakemonster.pages.dev/',
  Moran20: 'Morán et al., *FlakyLoc*, J. Web Engineering 2020.',
  Silva20: 'Silva et al., *Shaker*, ICST 2020.',
  LinaresVasquez17: 'Linares-Vásquez et al., *Enabling Mutation Testing for Android Apps* (MDroid+), FSE 2017.',
  Adamsen18: 'Adamsen, Møller et al., *AjaxRacer*, FSE 2018 / *InitRacer*, OOPSLA 2017.',
  Offutt04: 'Offutt, Xu, *Generating test cases for web services using data perturbation*, SIGSOFT SEN 2004.',
  Xu05: 'Xu, Offutt, Luo, *Testing Web Services by XML Perturbation*, ISSRE 2005.',
  deMelo11: 'de Melo, Silveira, *Improving data perturbation testing techniques for Web services*, Information Sciences 2011 (incl. Almeida & Vergilio SOAP operators).',
  Siblini05: 'Siblini, Mansour, *Testing Web services*, AICCSA 2005 (WSDL operators).',
  Espinha14: 'Espinha, Zaidman, Gross, *Web API Fragility: How Robust is Your Web API Client*, 2014/2015.',
  HTTPMutator: 'HTTPMutator (formerly JSONMutator), isa-group, https://github.com/isa-group/HTTPMutator',
  RESTest: 'RESTest (request violations), https://github.com/isa-group/RESTest',
  Heorhiadi16: 'Heorhiadi et al., *Gremlin*, ICDCS 2016.',
  Meiklejohn21: 'Meiklejohn et al., *Filibuster*, SoCC 2021.',
  Toxiproxy: 'Toxiproxy toxics, https://github.com/Shopify/toxiproxy',
  ChaosMesh: 'Chaos Mesh HTTPChaos, https://chaos-mesh.org/docs/simulate-http-chaos-on-kubernetes/',
  WireMock: 'WireMock faults and delays, https://wiremock.org/',
  Playwright: 'Playwright network and browser APIs (route.abort error kinds, setOffline, CDP emulation).',
};

const SAME_AS_THESIS = `
## Source operators identical to a thesis operator

Implemented once, as the thesis operator; not repeated in the library.

| Source operator | Thesis operator |
|---|---|
| MAEWU SVM, StyleVisibility | \`SVM.display.none\` |
| MAEWU CDM, ContentDelete | \`CDM.text.delete\` |
| MAEWU EHDM, Oliveira REL | \`EHDM.click.remove\` |
| Oliveira SWI | \`SVM.visibility.hide\` |
| HTTPMutator OPA, Espinha field addition | \`NPA.field.add\` |
| HTTPMutator OPR/OTPR (single field), Espinha field removal, de Melo Incomplete | \`NPF.field.drop\` |
| HTTPMutator PTC, Espinha data type change | \`NPT.type.change\` |
| HTTPMutator R5XX, Gremlin Disconnect, Filibuster error responses | \`NSO.status.override\` |
| Gremlin Delay, Toxiproxy latency, JSPreventer asynchronous delay (network side) | \`NLF.delay.fixed\`, \`NLR.delay.jitter\` |
| Gremlin Hang, Toxiproxy timeout, Filibuster Timeout (immediate) | \`NLT.timeout.inject\` |
| HTTPMutator AEE, de Melo Inversion | \`NOR.response.reorder\` |
| Offutt DCP α*α | \`NOD.response.duplicate\` |
| RESTest breakAnEnumeration | \`NPE.enum.invalid\` |
| WEFix wait deletion, Hammoudi page-reloading breakages | \`TWR.wait.remove\` |
| FlakeMonster seeded delay | \`TWA.wait.add\` |
| Maciel ICfTV on screenshot tolerance | \`AOV.visual.tolerance\` |
| Maciel RBA, negation | \`AOF.assert.flip\` |
`;

const NOT_IMPLEMENTED = `
## Not implemented

MultilayerMT injects mutations into a running application it has no source for.
Operators that change server-side code or configuration cannot be injected that
way. Where a runtime counterpart exists it is implemented and listed above; the
rest is listed here so nothing from the survey is dropped silently.

**Server-side web operators (no runtime equivalent).** webMuJava / Praphamontripong:
WIR, WID (server-side include replacement/deletion), WRR, WRD (\`jsp:forward\`),
WGR/WSIR (\`getSession(true/false)\`; approximated by NRQ.cookie.drop /
NRS.setCookie.drop), WRUR (\`sendRedirect\`; approximated by HTM.location.change),
WCUR, WPVD, WCTR, WSCR, WSAD. Security (server code): MUSIC (RMWH, NEGC, FADP,
UNPR, MQFT, OVCR, SMRZ, SQDZ, OVEP), MUTEC PHP operators (RHEN, AHEN/AHSC/RHSC),
Fonseca's VAIT field-fault operators (MFC, MVIV, MIA, MIFS, MLAC, MLOC, WVAV, WPFV,
WFCS, ELOC, EFC), Loise et al.'s Java crypto/XML operators (PSQLI, RPTS, RRS,
UPPRNG, UWMD, RHNV, XMLPVXXE, XMLPVXEE, REIS, URSAWSK, UBFWSK, UDESISE, UECBISE),
μWebPHP (54 PHP operators; names unpublished).

**Not applicable to a browser-side tool.** Praphamontripong's failOnForward
(\`pushState\` disables Forward; the thesis calls it not implementable); Oliveira's
MWL (change of GUI library); MAEWU's MaskMutator/DistortMutator (empty stubs in
the tool); Toxiproxy slow_close, slicer, packet_loss and Envoy response_rate_limit
(TCP-level behaviour, unreachable through \`page.route\`, which delivers bodies
atomically; bandwidth is approximated by ENV.network.throttle in Chromium).
Test-order shuffling and CPU-memory stress (Romano21 test-order dependency,
Shaker memory stress, FlakeShovel event scheduling) need runner or OS
configuration, not mutation.

**Not found in the literature.** Operators specific to React/Vue, Promises and
async/await, LLM-generated DOM-level mutation for E2E tests, and GraphQL-specific
operators (GQL.errors.inject fills the last gap by analogy).

**Sources read only partially** (operators inferred from abstracts, slides or
secondary sources; may be incomplete): Praphamontripong et al. 2016/2017 papers
(the dissertation was used), Nishiura et al. SEKE 2013 (slides and tool code),
Maezawa et al. ASE 2014 (excerpt), MUTEC (4 of 11 operators recovered),
Lee & Offutt 2001, Yamashita et al. PROFES 2025, Paiva et al. SQJ 2020, bBOXRT,
Habibi 2015, Belli et al. (model-based event-sequence mutation).
`;

function esc(s) {
  return String(s).replace(/\|/g, '\\|');
}

function table(ops) {
  const rows = ['| Id | Intent | Sources | Aliases |', '|---|---|---|---|'];
  for (const o of ops) rows.push(`| \`${o.id}\` | ${esc(o.intent)} | ${esc((o.refs || []).join(', '))} | ${esc((o.aliases || []).join(', '))} |`);
  return rows.join('\n');
}

const all = registry.list();
const thesis = all.filter((o) => o.set === 'thesis');
const lit = all.filter((o) => o.set === 'literature');
const LAYERS = [['dom', 'DOM layer'], ['network', 'Network layer'], ['test', 'Test-script layer']];

let md = `# Operator catalogue

Generated by \`scripts/gen-operators-doc.js\` from the operator registry — do not edit
by hand. Select operators with \`operatorSet\` (\`thesis\` | \`literature\` | \`all\`, default
\`all\`; the replication configs in \`experiments/\` pin \`thesis\`), \`operators.include\` /
\`operators.exclude\` (ids or family prefixes), \`layers\`, or on the command line with
\`mlmt operators --set literature --layer network\` and \`mlmt run --operator-set thesis\`.

**${all.length} operators**: ${thesis.length} from the thesis, ${lit.length} from the literature library.
Operators marked as aliases have the same intent as an operator of another source;
each is implemented once.

`;
for (const [set, label, ops] of [['thesis', 'Thesis operators', thesis], ['literature', 'Literature operators', lit]]) {
  md += `## ${label} (${ops.length})\n\n`;
  for (const [layer, name] of LAYERS) {
    const ls = ops.filter((o) => o.layer === layer);
    if (!ls.length) continue;
    md += `### ${name} (${ls.length})\n\n`;
    const cats = [...new Set(ls.map((o) => o.category))];
    for (const c of cats) md += `**${c}**\n\n${table(ls.filter((o) => o.category === c))}\n\n`;
  }
}
md += `## Coverage by source\n\nNumber of operators of the library that cite each source (an operator with several sources is counted for each).\n\n| Source | Operators |\n|---|---|\n`;
const counts = {};
for (const o of all) for (const r of o.refs || []) counts[r] = (counts[r] || 0) + 1;
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
md += `\n## References\n\n`;
const used = new Set(all.flatMap((o) => o.refs || []));
for (const k of Object.keys(REFS)) md += `- **${k}** — ${REFS[k]}\n`;
const unknown = [...used].filter((k) => !REFS[k]);
if (unknown.length) {
  console.error('unknown reference keys: ' + unknown.join(', '));
  process.exitCode = 1;
}
md += SAME_AS_THESIS + NOT_IMPLEMENTED;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'OPERATORS.md'), md);
console.log(`docs/OPERATORS.md: ${all.length} operators (${thesis.length} thesis, ${lit.length} literature)`);
