/**
 * Core data model of MultilayerMT (thesis Ch. 4).
 */

export type Layer = 'dom' | 'network' | 'test';

/** Classification outcomes (thesis Fig. 4.4 / Sec. 4.5). */
export type MutantStatus = 'KILLED' | 'SURVIVED' | 'SKIPPED' | 'TIMEOUT' | 'ERROR';

/** How a DOM operator is scoped. */
export type DomScope =
  /** Applied to a PWE element (or, where stated, to descendants/associates of it). */
  | 'element'
  /** Applied once per page (e.g. remove footer, fail stylesheets). */
  | 'page';

export interface OperatorInfo {
  /** Operator id as written in the thesis, e.g. `AAM.required.add`. */
  id: string;
  /** Family acronym, e.g. `AAM`. */
  family: string;
  layer: Layer;
  /** Category as in Table 4.2, e.g. "Attribute Mutations". */
  category: string;
  intent: string;
  /** Default parameter values (thesis Sec. 4.2.1). */
  defaults: Record<string, unknown>;
  /** DOM only. */
  scope?: DomScope;
}

/* ------------------------------------------------------------------------- */
/* Trace model                                                               */
/* ------------------------------------------------------------------------- */

export interface VisibilityInfo {
  inViewport: boolean;
  displayed: boolean;
  opaque: boolean;
  nonZeroSize: boolean;
}

/** One DOM element as observed by the in-page recorder. */
export interface ElementInfo {
  selector: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  visibility: VisibilityInfo;
  /** Additional facts used by static operator applicability. */
  facts: {
    textNodeWords: number;
    childElementCount: number;
    inForm: boolean;
    formSelector: string | null;
    formControlCount: number;
    hasImgDescendant: boolean;
    hasImgWithAlt: boolean;
    associatedLabel: boolean;
    implicitRole: string | null;
  };
}

export type InteractionKind = 'click' | 'fill' | 'focus' | 'hover';

export interface InteractionRecord {
  kind: InteractionKind;
  pageKey: string;
  selector: string;
}

export interface NetworkRecord {
  pageKey: string;
  method: string;
  url: string;
  /** Endpoint key: METHOD origin+pathname */
  endpoint: string;
  resourceType: string;
  status: number;
  contentType: string;
  /** Sample of the JSON body shape (when JSON). */
  json?: JsonShape;
}

export interface JsonShape {
  /** field name -> observed primitive type(s) */
  fields: Record<string, string>;
  /** sample values for enum-like string fields */
  samples: Record<string, unknown>;
  hasArray: boolean;
  maxArrayLength: number;
}

export interface ResourceRecord {
  pageKey: string;
  kind: 'script' | 'stylesheet';
  url: string;
}

/** Per-test trace written by the runtime fixture in `trace` mode. */
export interface TestTrace {
  testFile: string;
  testTitle: string;
  status: string;
  snapshots: Record<string, Record<string, ElementInfo>>; // pageKey -> selector -> info
  interactions: InteractionRecord[];
  network: NetworkRecord[];
  resources: ResourceRecord[];
}

/** Merged trace for the whole baseline suite run. */
export interface SuiteTrace {
  createdAt: string;
  baseline: BaselineResult;
  tests: TestTrace[];
}

export interface BaselineResult {
  durationMs: number;
  passed: string[];
  failed: string[];
  ok: boolean;
}

/* ------------------------------------------------------------------------- */
/* PWE model                                                                  */
/* ------------------------------------------------------------------------- */

export interface InteractionCounts {
  click: number;
  fill: number;
  focus: number;
  hover: number;
}

export interface PweElement {
  pageKey: string;
  selector: string;
  element: ElementInfo;
  interactions: InteractionCounts;
  /** Raw points (Sec. 4.3.1-4.3.3). */
  raw: { interaction: number; visibility: number; semantic: number };
  /** Normalised to [0,1]. */
  norm: { interaction: number; visibility: number; semantic: number };
  /** PWE_Score = 0.4 I + 0.3 V + 0.3 S (Eq. 4.1) */
  score: number;
  rank: number;
  testFiles: string[];
}

export interface PwePage {
  pageKey: string;
  candidates: number;
  selected: PweElement[];
  testFiles: string[];
}

/* ------------------------------------------------------------------------- */
/* Mutants                                                                    */
/* ------------------------------------------------------------------------- */

export interface DomTarget {
  kind: 'dom';
  pageKey: string;
  /** CSS selector of the PWE (absent for page-scoped operators). */
  selector?: string;
  /** Resource URL for SFM.* operators. */
  resourceUrl?: string;
  description: string;
}

export interface NetworkTarget {
  kind: 'network';
  endpoint: string;
  method: string;
  /** origin + pathname; query is ignored for matching */
  urlBase: string;
  description: string;
}

export interface TestTarget {
  kind: 'test';
  /** test file path relative to the test directory */
  file: string;
  /** index of the AST site within the file (for operators with several sites) */
  site: number;
  line?: number;
  snippet?: string;
  description: string;
}

export type MutantTarget = DomTarget | NetworkTarget | TestTarget;

export interface MutantDescriptor {
  id: string;
  operator: string;
  layer: Layer;
  target: MutantTarget;
  params: Record<string, unknown>;
  /** Test files (relative to testDir) to run for this mutant. Empty = all. */
  testFiles: string[];
  /** Set when the mutant fails a static pre-check at generation time. */
  precheckFailed?: string;
}

export interface TestOutcome {
  title: string;
  file: string;
  status: string;
  error?: string;
}

export interface MutantResult {
  mutant: MutantDescriptor;
  status: MutantStatus;
  applied: boolean;
  applications: number;
  durationMs: number;
  tests: TestOutcome[];
  reason?: string;
  gapCategory?: GapCategory;
}

export type GapCategory = 'Weak Assertions' | 'Missing Error Handling' | 'Timing Dependencies';

/* ------------------------------------------------------------------------- */
/* Reports                                                                    */
/* ------------------------------------------------------------------------- */

export interface Counts {
  generated: number;
  executed: number;
  skipped: number;
  killed: number;
  survived: number;
  timeout: number;
  error: number;
  mutationScore: number | null;
  applicability: number | null;
}

export interface RunReport {
  tool: 'MultilayerMT';
  version: string;
  app: string;
  config: { maxPwe: number; workers: number; layers: Layer[]; testSelection: string };
  startedAt: string;
  finishedAt: string;
  wallTimeMs: number;
  /** Sum of the per-mutant durations (sequential estimate). */
  sumMutantTimeMs: number;
  baselineMs: number;
  totals: Counts;
  perLayer: Record<Layer, Counts>;
  perOperator: Record<string, Counts>;
  gapCategories: Record<GapCategory, number>;
  pwe: PwePage[];
  results: MutantResult[];
}
