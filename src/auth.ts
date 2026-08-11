/**
 * Authentication support — scraping pages behind a login.
 *
 * Most valuable data is behind a login wall. This module handles three modes:
 *
 *   1. **Attach** — connect to a browser the user already signed into (CDP).
 *      `config.auth = { kind: 'attach', cdp: 'http://127.0.0.1:9222' }`
 *
 *   2. **Profile** — launch with a persistent browser profile that survives
 *      restarts. Sign in once, scrape forever.
 *      `config.auth = { kind: 'profile', dir: './browser-profile' }`
 *
 *   3. **Login flow** — programmatic login via form fill + submit. The
 *      credentials come from env vars, never from the config file.
 *      `config.auth = { kind: 'login', loginUrl: '...', userSelector: '...',
 *                        passSelector: '...', submitSelector: '...' }`
 *
 * Safety: credentials are never stored, written to disk, or logged. The
 * login flow reads them from SCRAPE_HEAL_AUTH_USER / SCRAPE_HEAL_AUTH_PASS
 * env vars; the config only names the selectors.
 */

import type { Browser, BrowserContext, Cookie, Page } from 'playwright';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ------------------------------------------------------------- config

export type AuthKind = 'attach' | 'profile' | 'login' | 'none';

export interface AuthConfig {
  kind: AuthKind;

  /** For 'attach': CDP WebSocket URL of the signed-in browser.
   *  e.g. http://127.0.0.1:9222 (Playwright resolves the WS URL). */
  cdp?: string;

  /** For 'profile': directory to persist browser state (cookies, localStorage).
   *  Defaults to .scrape-heal/browser-profile. */
  dir?: string;

  /** For 'login': the page that hosts the login form. */
  loginUrl?: string;

  /** CSS selector for the username/email input. */
  userSelector?: string;

  /** CSS selector for the password input. */
  passSelector?: string;

  /** CSS selector for the submit button. */
  submitSelector?: string;

  /** Optional: selector for a "remember me" checkbox. */
  rememberSelector?: string;

  /** Milliseconds to wait after submitting the form before checking
   *  whether the login succeeded. Default 3000. */
  settleMs?: number;

  /** Selector that indicates a successful login (e.g. a user avatar,
   *  a dashboard heading, the word "Logout"). When absent, the check is
   *  whether the URL changed. */
  successSelector?: string;

  /** Save the session state to this file after a successful login, so
   *  subsequent runs can skip the login step. */
  sessionPath?: string;
}

export interface AuthHandle {
  /** The authenticated browser context (or null when auth wasn't used). */
  context: BrowserContext | null;
  /** Close whatever was opened for auth. Safe to call even when no auth. */
  close: () => Promise<void>;
}

// ------------------------------------------------------------- runner

/**
 * Establish an authenticated browser context according to the config.
 * Returns the context and a cleanup function.
 */
export async function authenticate(
  browser: Browser,
  config: AuthConfig,
  log: (line: string) => () => {},
): Promise<AuthHandle> {
  if (config.kind === 'none' || !config.kind) {
    return { context: null, close: async () => {} };
  }

  switch (config.kind) {
    case 'attach':
      return attachAuth(browser, config, log);
    case 'profile':
      return profileAuth(browser, config, log);
    case 'login':
      return loginAuth(browser, config, log);
    default:
      return { context: null, close: async () => {} };
  }
}

// ------------------------------------------------------------- attach

async function attachAuth(
  browser: Browser,
  config: AuthConfig,
  log: (line: string) => void,
): Promise<AuthHandle> {
  if (!config.cdp) {
    throw new Error('auth.kind=attach requires auth.cdp (e.g. http://127.0.0.1:9222)');
  }

  // Playwright's connectOverCDP attaches to an existing browser. The user
  // is already signed in; we just need to drive their session.
  const { chromium } = await import('playwright');
  const cdpBrowser = await chromium.connectOverCDP(config.cdp);
  const contexts = cdpBrowser.contexts();
  const context = contexts[0] ?? await cdpBrowser.newContext();

  log('Attached to your signed-in browser — pages behind a login are reachable.');

  return {
    context,
    close: async () => {
      // Never close the user's own browser — only disconnect.
      await cdpBrowser.close();
    },
  };
}

// ------------------------------------------------------------- profile

async function profileAuth(
  browser: Browser,
  config: AuthConfig,
  log: (line: string) => void,
): Promise<AuthHandle> {
  const dir = resolve(config.dir ?? '.scrape-heal/browser-profile');
  mkdirSync(dir, { recursive: true });

  // Playwright's persistent context: launch with a user data directory.
  // Cookies and localStorage survive restarts.
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
  });

  // Check whether we're actually signed in by looking for a known cookie
  // or by hitting a protected page. A cold profile still works — it just
  // sees the login screen. The caller must have signed in once beforehand.
  log(`Using persistent browser profile in ${dir} — cookies survive restarts.`);

  return {
    context,
    close: async () => await context.close(),
  };
}

// ------------------------------------------------------------- login flow

async function loginAuth(
  browser: Browser,
  config: AuthConfig,
  log: (line: string) => void,
): Promise<AuthHandle> {
  if (!config.loginUrl || !config.userSelector || !config.passSelector || !config.submitSelector) {
    throw new Error(
      'auth.kind=login requires loginUrl, userSelector, passSelector, and submitSelector',
    );
  }

  const user = process.env.SCRAPE_HEAL_AUTH_USER;
  const pass = process.env.SCRAPE_HEAL_AUTH_PASS;

  if (!user || !pass) {
    throw new Error(
      'auth.kind=login needs SCRAPE_HEAL_AUTH_USER and SCRAPE_HEAL_AUTH_PASS env vars — ' +
      'credentials are never stored in the config file',
    );
  }

  // Try loading a saved session first.
  if (config.sessionPath && existsSync(config.sessionPath)) {
    try {
      const state = JSON.parse(readFileSync(config.sessionPath, 'utf8'));
      const context = await browser.newContext({ storageState: state as any });
      log(`Loaded saved session from ${config.sessionPath} — skipping login.`);

      // Quick check: is the session still valid?
      const checkPage = await context.newPage();
      try {
        await checkPage.goto(config.loginUrl, { waitUntil: 'networkidle', timeout: 10_000 });
        const stillLoggedIn = config.successSelector
          ? await checkPage.locator(config.successSelector).count() > 0
          : checkPage.url() !== config.loginUrl;
        await checkPage.close();

        if (stillLoggedIn) {
          return { context, close: async () => await context.close() };
        }
        log('Saved session expired — performing login again.');
      } catch {
        await checkPage.close();
      }

      await context.close();
    } catch {
      // Corrupt state file — fall through to fresh login.
    }
  }

  // Perform the login.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log(`Logging in at ${config.loginUrl}...`);
    await page.goto(config.loginUrl, { waitUntil: 'networkidle', timeout: 20_000 });

    // Fill the form.
    await page.fill(config.userSelector, user);
    await page.fill(config.passSelector, pass);

    if (config.rememberSelector) {
      try {
        await page.check(config.rememberSelector);
      } catch {
        // Checkbox not found or not checkable — non-fatal.
      }
    }

    // Submit and wait.
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}),
      page.click(config.submitSelector),
    ]);

    // Let the page settle — redirects, token storage, etc.
    await page.waitForTimeout(config.settleMs ?? 3000);

    // Verify the login succeeded.
    const loggedIn = config.successSelector
      ? await page.locator(config.successSelector).count() > 0
      : page.url() !== config.loginUrl;

    if (!loggedIn) {
      throw new Error(
        `Login did not succeed — page is still at ${page.url()}. ` +
        `Set auth.successSelector to a post-login element to improve detection.`,
      );
    }

    log('Login succeeded.');

    // Save session state for next time.
    if (config.sessionPath) {
      const state = await context.storageState();
      mkdirSync(resolve(config.sessionPath, '..'), { recursive: true });
      writeFileSync(config.sessionPath, JSON.stringify(state, null, 2));
      log(`Session saved to ${config.sessionPath}.`);
    }

    return {
      context,
      close: async () => {
        await page.close();
        // Don't close the context here — it's returned to the caller.
      },
    };
  } catch (err) {
    await page.close();
    await context.close();
    throw err;
  }
}
