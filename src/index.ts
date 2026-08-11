/**
 * scrape-heal's public API — the market-leading self-healing scraper.
 *
 * The whole loop is a few functions — plug it into your own code, scheduler,
 * or scraper in a handful of lines:
 *
 *   import { runWatchdog, commandRows } from 'scrape-heal';
 *
 *   // watch any scraper that prints JSON/CSV, every 5 minutes, forever
 *   const browser = await chromium.launch();
 *   runWatchdog(browser, await browser.newPage(), {
 *     intervalSeconds: 300,
 *     statePath: '.scrape-heal/state.json',
 *     fetchRows: commandRows('python my_scrapy_spider.py --json'),
 *     writeConfigPath: 'scraper.config.json',
 *     log: console.log,
 *   }, {
 *     url: 'https://example.com',
 *     items: '.product-card',
 *     fields: [{ name: 'name', selector: '.name' }],
 *     identityField: 'name',
 *     minItems: 4,
 *   });
 *
 * Or skip the loop and use the pieces directly: `extract` pulls rows out of a
 * page, `validate` checks them against the last good run, `heal` proposes and
 * verifies a repair.
 */

export type {
  ScraperConfig, FieldConfig, ExtractedItem, Validation, Validator,
  Extraction, FetchFailure, FetchFailureKind,
} from './scraper.js';
export { extract, validate, validateShape, classifyResponse } from './scraper.js';

export type { HealResult, HealOptions } from './heal.js';
export { heal } from './heal.js';

export type { WatchOptions, WatchState, LedgerEntry } from './watchdog.js';
export { runWatchdog, loadState } from './watchdog.js';

export type { LLMOptions, HealProposal, SkeletonNode, SiteLLMMemory, LLMSuccess } from './llm.js';
export { describeStructure, proposeWithLLM, parseProposal, rememberLLM } from './llm.js';

export { loadValidator } from './validator.js';

export type { ValueKind } from './valuetypes.js';
export {
  classifyValue, kindsCompatible, profileField, verifyValueTypes, describeKind,
} from './valuetypes.js';

export type { AlertChannel, AlertMessage } from './alert.js';
export { sendAlert } from './alert.js';

export { formatMemory } from './memory.js';

export type { TargetSnapshot, DashboardOptions, RunningDashboard } from './dashboard.js';
export { snapshotDir, startDashboard } from './dashboard.js';

export type { RowFetch, RowResult } from './source.js';
export { playwrightRows, commandRows, fileRows, parseRows } from './source.js';

export type { WatchFileConfig } from './config.js';
export {
  readConfigFile, fieldsFrom, initConfig, mergeTargetConfigs, TEMPLATE, CONFIG_FILENAME,
} from './config.js';

// ---- v2: proxy rotation for anti-bot handling
export type { ProxyEntry, ProxyPoolOptions } from './proxy.js';
export { ProxyPool, proxyLaunchOptions } from './proxy.js';

// ---- v2: visual/OCR extraction fallback
export type { VisualGrid, VisualBox, OcrEngine } from './visual.js';
export { detectGrid, extractByGrid, ocrPage, setOcrEngine, ocrAvailable } from './visual.js';

// ---- v2: multi-page pagination
export type { PaginationKind, PaginationConfig, PagedResult } from './pagination.js';
export { extractAllPages, detectPagination } from './pagination.js';

// ---- v2: REST API server
export type { ApiConfig } from './api.js';
export { startApi } from './api.js';

// ---- v2: data output pipelines
export type {
  PipelineKind, PipelineDef, WebhookPipeline, FilePipeline,
  PostgresPipeline, MysqlPipeline, Pipeline, PipelineResult, RetryOptions, DbRunner,
} from './pipeline.js';
export { runPipelines, retry, registerDbRunner } from './pipeline.js';

// ---- v2: authentication (login, profiles, session persistence)
export type { AuthKind, AuthConfig, AuthHandle } from './auth.js';
export { authenticate } from './auth.js';

// ---- v2: plugin system (extensible extractors, healers, transforms)
export type {
  PluginKind, BasePlugin, ExtractorPlugin, HealerPlugin, TransformPlugin, Plugin,
} from './plugins.js';
export {
  registerPlugin, unregisterPlugin, plugins, findPlugins,
  loadPlugins, tryExtractors, tryHealers, applyTransforms,
} from './plugins.js';

// ---- v3: change watching (diffs + thresholds)
export type { ChangeReport, FieldChange, ChangeThreshold, ThresholdHit } from './changes.js';
export { diffChanges, formatChanges, matchesThresholds, parseNumber, reportHasChanges } from './changes.js';

// ---- v3: evidence-on-red (screenshot + DOM + status per failed cycle)
export type { CycleEvidence } from './evidence.js';
export { captureEvidence } from './evidence.js';
