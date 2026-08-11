/**
 * scrape-heal's public API.
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

export type { ScraperConfig, FieldConfig, ExtractedItem, Validation, Validator } from './scraper.js';
export { extract, validate, validateShape } from './scraper.js';

export type { HealResult, HealOptions } from './heal.js';
export { heal } from './heal.js';

export type { WatchOptions, WatchState, LedgerEntry } from './watchdog.js';
export { runWatchdog, loadState } from './watchdog.js';

export type { LLMOptions, HealProposal, SkeletonNode } from './llm.js';
export { describeStructure, proposeWithLLM, parseProposal } from './llm.js';

export { loadValidator } from './validator.js';

export type { RowFetch } from './source.js';
export { playwrightRows, commandRows, fileRows, parseRows } from './source.js';

export type { WatchFileConfig } from './config.js';
export { readConfigFile, fieldsFrom, initConfig, TEMPLATE, CONFIG_FILENAME } from './config.js';
