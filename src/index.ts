/**
 * MultilayerMT public API.
 *
 * Levels of integration, from high to low:
 *   1. runMutationAnalysis() / evaluateTestSuite()      one call, returns a RunReport
 *   2. createEngine() / MutationEngine                   step-by-step, typed events
 *   3. attachRecorder(), applyDomMutation(), applyNetworkMutation(), applyMutant()
 *                                                        instrument any Playwright page/context
 *      mutateTestSource(), listTestMutationSites()       test-script mutations on strings
 *      buildPweModel(), generateMutants(), classify()    individual pipeline stages
 *   4. registry / definePlugin / define*Operator         custom operators
 */

// types
export * from './types';

// high-level API
export { runMutationAnalysis, evaluateTestSuite, createEngine, createSuiteTrace, listTestMutationSites, mutateTestSource } from './api';
export type { AnalysisOptions, TestMutationSite } from './api';

// engine
export { MutationEngine, AbortError, VERSION } from './engine/engine';
export type { EngineEvents, EngineOptions, RunOptions, Phase } from './engine/engine';

// config
export { defineConfig, loadConfig, loadConfigAsync, validateConfig, findConfigFile, DEFAULT_CONFIG, ConfigError } from './config';
export type { MlmtConfig, UserConfig, ResolvedConfig, ReporterSpec, ReporterFn } from './config';

// runtime instrumentation (for crawlers, agents, custom harnesses)
export { attachRecorder, applyMutant, applyDomMutation, applyNetworkMutation, shapeOf } from './runtime/instrument';
export type { RecorderHandle, RecorderOptions, MutationHandle, ApplyOptions } from './runtime/instrument';

// operators and plugins
export { ALL_OPERATORS, DOM_OPERATORS, NETWORK_OPERATORS, TEST_OPERATORS } from './operators/catalog';
export { registry, OperatorRegistry, definePlugin, defineDomOperator, defineNetworkOperator, defineTestOperator } from './operators/registry';
export type { OperatorDef, DomOperatorDef, NetworkOperatorDef, TestOperatorDef, MlmtPlugin, NetworkHandlerContext, DomApplyHelpers, TestSite } from './operators/registry';
export { findSites, mutateSource, applyEdits, generalizeSelector, specializeSelector, isCssSelector } from './operators/test/astMutator';
export * as payload from './operators/network/payload';

// pipeline stages
export { buildPweModel, collectElements, pweScore, interactionPoints, visibilityPoints, semanticPoints, WEIGHTS } from './pwe/pwe';
export { generateMutants, domApplicable, inferNetworkParams, listTestFiles, readTestSources } from './engine/generator';
export { classify, countResults, countBy, perLayer, gapCategory } from './engine/classifier';
export { createSandbox, removeSandbox, rewriteImports } from './engine/sandbox';
export { runPlaywright, parseJsonReport } from './engine/executor';

// reporting
export { htmlReport, textSummary, aggregate } from './report/report';
export { runReporters, BUILTIN_REPORTERS } from './report/reporters';

// utilities
export { pageKeyOf } from './util/pageKey';
export type { PageKeyQuery } from './util/pageKey';
export { consoleLogger, silentLogger } from './util/log';
export type { Logger } from './util/log';
