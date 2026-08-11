/**
 * Drop-in self-healing for plain Playwright scripts.
 *
 * Your selectors broke; you don't want a watchdog, you want the rows. The
 * whole loop in one call: extract → validate against your last good run →
 * when they stop matching, re-derive the selectors in the browser and PROVE
 * them against the live page before returning.
 *
 *   import { chromium } from 'playwright';
 *   import { scrapeWithSelfHealing } from './integrations/playwright.mjs';
 *
 *   const browser = await chromium.launch();
 *   const page = await browser.newPage();
 *   const config = {
 *     url: 'https://shop.example.com/products',
 *     items: '.product-card',
 *     fields: [{ name: 'name', selector: '.name' }, { name: 'price', selector: '.price' }],
 *     identityField: 'name',
 *     minItems: 4,
 *   };
 *   const lastGoodRows = await loadRows();        // your DB / last run; [] on first run
 *
 *   const { rows, config: fixed, repaired } = await scrapeWithSelfHealing({
 *     browser,
 *     config,
 *     extractRows: async () => {
 *       await page.goto(config.url);
 *       return rowsFromDom(page);                 // whatever you already do
 *     },
 *     lastGoodRows,
 *   });
 *   if (repaired) await saveConfig(fixed);        // fixed selectors — persist them
 *   await pushRows(rows);
 *
 * From npm the helpers come from the package root — no adapter import needed:
 *
 *   import { scrapeWithSelfHealing } from 'scrape-heal';
 */

export { scrapeWithSelfHealing, repairSelectors } from '../src/adapters.js';
