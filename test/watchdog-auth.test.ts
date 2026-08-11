import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ScraperConfig } from '../src/scraper.js';
import { extract } from '../src/scraper.js';
import { heal } from '../src/heal.js';
import { authenticate } from '../src/auth.js';
import { runWatchdog } from '../src/watchdog.js';

const statePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.scrape-heal', 'test-auth-watch.json');

// The catalog markup behind the wall, in two redesigns (like site-v1/v2).
const V1 = `
<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog</h1>
  <article class="product-card"><h2 class="name">Wireless Mouse</h2><p class="price">$24.99</p></article>
  <article class="product-card"><h2 class="name">Mechanical Keyboard</h2><p class="price">$89.00</p></article>
  <article class="product-card"><h2 class="name">USB-C Hub</h2><p class="price">$39.50</p></article>
  <article class="product-card"><h2 class="name">4K Monitor</h2><p class="price">$299.00</p></article>
</main></body></html>`;

const V2 = `
<!DOCTYPE html><html><body><main id="catalog"><h1>Catalog — refreshed</h1>
  <section class="item"><h2 class="title">Wireless Mouse</h2><span class="amount">$24.99</span></section>
  <section class="item"><h2 class="title">Mechanical Keyboard</h2><span class="amount">$89.00</span></section>
  <section class="item"><h2 class="title">USB-C Hub</h2><span class="amount">$39.50</span></section>
  <section class="item"><h2 class="title">4K Monitor</h2><span class="amount">$299.00</span></section>
</main></body></html>`;

const LOGIN_WALL = `
<!DOCTYPE html><html><body><main>
  <h1>Sign in</h1>
  <form method="post" action="/login">
    <input id="user" name="user" />
    <input id="pass" name="pass" type="password" />
    <button id="submit" type="submit">Sign in</button>
  </form>
</main></body></html>`;

/**
 * A site that serves its catalog ONLY to a browser holding the session
 * cookie; everyone else gets the login wall. The catalog markup can be
 * swapped between redesigns mid-test, like the heal fixture server.
 */
function startWalledSite() {
  const current = { html: V1 };
  const server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    if (req.method === 'POST' && req.url === '/login') {
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('Set-Cookie', 'session=ok; Path=/');
        res.end(current.html);
      });
      return;
    }
    if (req.url === '/login') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(LOGIN_WALL);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(cookie.includes('session=ok') ? current.html : LOGIN_WALL);
  });
  return new Promise<{ url: string; serve: (html: string) => void; close: () => void }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}/`,
        serve: (html) => { current.html = html; },
        close: () => server.close(),
      });
    });
  });
}

const config: ScraperConfig = {
  url: '', // set per test
  items: '.product-card',
  fields: [
    { name: 'name', selector: '.name' },
    { name: 'price', selector: '.price' },
  ],
  identityField: 'name',
  minItems: 4,
};

let browser: Browser;
let site: { url: string; serve: (html: string) => void; close: () => void };

before(async () => {
  browser = await chromium.launch();
  site = await startWalledSite();
});

after(async () => {
  await browser.close();
  site.close();
});

function loginAuth() {
  return {
    kind: 'login' as const,
    loginUrl: `${site.url}login`,
    userSelector: '#user',
    passSelector: '#pass',
    submitSelector: '#submit',
    successSelector: '.product-card',
  };
}

test('watchdog: a login-walled page is scraped behind the wall when auth is configured', async () => {
  const user = process.env.SCRAPE_HEAL_AUTH_USER;
  const pass = process.env.SCRAPE_HEAL_AUTH_PASS;
  process.env.SCRAPE_HEAL_AUTH_USER = 'alice';
  process.env.SCRAPE_HEAL_AUTH_PASS = 'correct-horse';
  try {
    const page = await browser.newPage();
    const lines: string[] = [];
    const exitCode = await runWatchdog(browser, page, {
      intervalSeconds: 1,
      cycles: 1,
      statePath,
      auth: loginAuth(),
      log: (l) => lines.push(l),
    }, { ...config, url: site.url });
    await page.close();

    assert.equal(exitCode, 0, `expected the walled page to scrape OK, log:\n${lines.join('\n')}`);
    assert.ok(lines.some((l) => l.includes('authenticated context held across cycles')));
    assert.ok(lines.some((l) => l.includes('OK — 4 item(s)')));

    // The state file holds the authenticated baseline.
    const state = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(statePath, 'utf8')));
    assert.equal(state.baseline.length, 4);
    assert.equal(state.baseline[0].name, 'Wireless Mouse');
  } finally {
    if (user === undefined) delete process.env.SCRAPE_HEAL_AUTH_USER; else process.env.SCRAPE_HEAL_AUTH_USER = user;
    if (pass === undefined) delete process.env.SCRAPE_HEAL_AUTH_PASS; else process.env.SCRAPE_HEAL_AUTH_PASS = pass;
  }
});

test('watchdog: without auth, the same walled page is red — the wall is not a redesign', async () => {
  const page = await browser.newPage();
  const lines: string[] = [];
  const exitCode = await runWatchdog(browser, page, {
    intervalSeconds: 1,
    cycles: 1,
    statePath,
    log: (l) => lines.push(l),
  }, { ...config, url: site.url });
  await page.close();

  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.includes('RED')));
});

test('watchdog: a broken auth config fails fast instead of scraping anonymously', async () => {
  const user = process.env.SCRAPE_HEAL_AUTH_USER;
  const pass = process.env.SCRAPE_HEAL_AUTH_PASS;
  delete process.env.SCRAPE_HEAL_AUTH_USER;
  delete process.env.SCRAPE_HEAL_AUTH_PASS;
  try {
    const page = await browser.newPage();
    const lines: string[] = [];
    const exitCode = await runWatchdog(browser, page, {
      intervalSeconds: 1,
      cycles: 1,
      statePath,
      auth: loginAuth(),
      log: (l) => lines.push(l),
    }, { ...config, url: site.url });
    await page.close();

    assert.equal(exitCode, 1);
    assert.ok(
      lines.some((l) => l.includes('auth failed') && l.includes('SCRAPE_HEAL_AUTH_USER')),
      `expected a loud auth failure, log:\n${lines.join('\n')}`,
    );
  } finally {
    if (user !== undefined) process.env.SCRAPE_HEAL_AUTH_USER = user;
    if (pass !== undefined) process.env.SCRAPE_HEAL_AUTH_PASS = pass;
  }
});

test('heal: repairs through the authenticated context when the page is behind a login wall', async () => {
  const user = process.env.SCRAPE_HEAL_AUTH_USER;
  const pass = process.env.SCRAPE_HEAL_AUTH_PASS;
  process.env.SCRAPE_HEAL_AUTH_USER = 'alice';
  process.env.SCRAPE_HEAL_AUTH_PASS = 'correct-horse';
  try {
    site.serve(V1);
    const auth = await authenticate(browser, loginAuth(), () => {});
    try {
      // Baseline: captured from inside the wall.
      const ctxPage = await auth.context!.newPage();
      const baseline = (await extract({ ...config, url: site.url }, ctxPage)).items;
      await ctxPage.close();
      assert.equal(baseline.length, 4);

      // The site redesigns — but only inside the wall.
      site.serve(V2);

      // Control: an anonymous heal sees the login wall and refuses.
      const anonymous = await heal(browser, { ...config, url: site.url }, baseline);
      assert.equal(anonymous.repaired, false, 'an anonymous heal must not repair behind the wall');

      // The real heal runs through the session and repairs like any page.
      const result = await heal(browser, { ...config, url: site.url }, baseline, {
        context: auth.context ?? undefined,
      });
      assert.equal(result.repaired, true, result.attempts.join('\n'));
      assert.equal(result.config.items, '.item');
      assert.ok(result.config.fields[1].selector.includes('amount'), result.config.fields[1].selector);
    } finally {
      await auth.close();
    }
  } finally {
    if (user === undefined) delete process.env.SCRAPE_HEAL_AUTH_USER; else process.env.SCRAPE_HEAL_AUTH_USER = user;
    if (pass === undefined) delete process.env.SCRAPE_HEAL_AUTH_PASS; else process.env.SCRAPE_HEAL_AUTH_PASS = pass;
  }
});
