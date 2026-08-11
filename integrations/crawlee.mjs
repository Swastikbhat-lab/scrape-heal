/**
 * Drop-in self-healing for Crawlee.
 *
 * Wrap your extraction with `withSelfHealing`: every row set is validated
 * against your last good run; when the site redesigns and the rows stop
 * matching, the guard runs scrape-heal's repair loop in the browser and
 * returns the repaired rows + fixed config for that request. Your crawler
 * keeps crawling; the loop quietly fixes what broke.
 *
 *   import { PlaywrightCrawler } from 'crawlee';
 *   import { withSelfHealing } from './integrations/crawlee.mjs';
 *
 *   const guard = withSelfHealing({
 *     config,                              // { url, items, fields, identityField, minItems }
 *     lastGoodRows,                        // from your storage; [] on first run
 *     getBrowser: async () => browser,     // the browser the crawler uses
 *     llm,                                 // optional: { apiKey | baseUrl, model }
 *     onRepair: (fixed) => saveConfig(fixed),
 *   });
 *
 *   const crawler = new PlaywrightCrawler({
 *     async requestHandler({ page, pushData }) {
 *       const rows = extractFromDom(page);
 *       const { rows: good, repaired } = await guard(rows);
 *       await pushData(good);
 *       if (!repaired) logBroken(rows);    // still broken: alert, don't fake it
 *     },
 *   });
 *
 * From npm the helpers come from the package root — no adapter import needed:
 *
 *   import { withSelfHealing } from 'scrape-heal';
 */

export { withSelfHealing, scrapeWithSelfHealing, repairSelectors } from '../src/adapters.js';
