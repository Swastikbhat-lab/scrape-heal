/**
 * Plugin system — extensible extractors, healers, and transformations.
 *
 * The core loop is closed: extract → validate → heal → verify. Plugins open
 * it at three points without touching the loop code:
 *
 *   1. **Extractor plugins** — change *how* rows are produced (e.g. graphQL
 *      introspection, CSV download, RSS feed parsing).
 *   2. **Healer plugins** — add site-specific repair logic (e.g. "this site
 *      always renames classes with a `v2-` prefix").
 *   3. **Transform plugins** — post-process extracted data (e.g. clean
 *      whitespace, parse dates, normalize currencies).
 *
 * Plugins are loaded from a directory or registered programmatically:
 *
 *   // Register at startup:
 *   import { registerPlugin } from 'scrape-heal';
 *   registerPlugin({
 *     name: 'my-site-healer',
 *     kind: 'healer',
 *     match: (url) => url.includes('example.com'),
 *     heal: async (config, baseline, page) => { ... },
 *   });
 *
 *   // Or load from a directory:
 *   import { loadPlugins } from 'scrape-heal';
 *   await loadPlugins('./my-plugins/');
 *
 * The loop calls plugins in registration order. The first plugin that handles
 * a request wins; the built-in healer is the fallback.
 */

import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import type { ScraperConfig, ExtractedItem, FieldConfig } from './scraper.js';

// ------------------------------------------------------------- plugin interface

export type PluginKind = 'extractor' | 'healer' | 'transform';

export interface BasePlugin {
  /** Unique name, used in logging. */
  name: string;
  /** What the plugin does. */
  kind: PluginKind;
  /** Optional: only apply to URLs matching this predicate. */
  match?: (url: string) => boolean;
}

/** Replace how rows are extracted. Return null to fall through to the next plugin. */
export interface ExtractorPlugin extends BasePlugin {
  kind: 'extractor';
  /**
   * Extract rows from a page. Receives the page (already navigated to
   * `config.url`) and the config. Return null to defer to the default
   * Playwright extractor.
   */
  extract: (page: Page, config: ScraperConfig) => Promise<ExtractedItem[] | null>;
}

/** Add a site-specific healing strategy. */
export interface HealerPlugin extends BasePlugin {
  kind: 'healer';
  /**
   * Attempt to heal a broken config. Receives the page (navigated to the
   * target URL), the failing config, and the last good baseline. Return
   * null to fall through; return a new config + the extracted verification
   * data to claim success.
   */
  heal: (
    page: Page,
    config: ScraperConfig,
    baseline: ExtractedItem[],
  ) => Promise<{ config: ScraperConfig; verified: ExtractedItem[] } | null>;
}

/** Post-process extracted rows. */
export interface TransformPlugin extends BasePlugin {
  kind: 'transform';
  /**
   * Transform extracted rows. Receives the rows and the config. Return the
   * transformed rows (or the same array if nothing changes).
   */
  transform: (rows: ExtractedItem[], config: ScraperConfig) => ExtractedItem[] | Promise<ExtractedItem[]>;
}

export type Plugin = ExtractorPlugin | HealerPlugin | TransformPlugin;

// ------------------------------------------------------------- registry

const registry: Plugin[] = [];

/** Register a plugin. Plugins are tried in registration order. */
export function registerPlugin(plugin: Plugin): void {
  // Dedupe by name.
  const idx = registry.findIndex((p) => p.name === plugin.name);
  if (idx !== -1) registry[idx] = plugin;
  else registry.push(plugin);
}

/** Remove a plugin by name. */
export function unregisterPlugin(name: string): void {
  const idx = registry.findIndex((p) => p.name === name);
  if (idx !== -1) registry.splice(idx, 1);
}

/** All registered plugins. */
export function plugins(): Readonly<Plugin[]> { return registry; }

/** Find plugins of a given kind matching a URL (or all when url is empty). */
export function findPlugins(kind: PluginKind, url?: string): Plugin[] {
  return registry.filter((p) => {
    if (p.kind !== kind) return false;
    if (url && p.match && !p.match(url)) return false;
    return true;
  });
}

// ------------------------------------------------------------- loader

/**
 * Load plugins from a directory. Each file must export a default plugin
 * object or a function that returns one (for async init). Only `.js`, `.mjs`,
 * and `.ts` (under tsx) files are loaded.
 */
export async function loadPlugins(dir: string): Promise<number> {
  const abs = resolve(dir);
  if (!existsSync(abs)) return 0;

  let loaded = 0;
  for (const entry of readdirSync(abs)) {
    if (!/\.(js|mjs|cjs|ts)$/.test(entry)) continue;
    try {
      const mod = await import(pathToFileURL(resolve(abs, entry)).href);
      let plugin = mod.default ?? mod.plugin;
      if (typeof plugin === 'function') plugin = await plugin();
      if (plugin && typeof plugin === 'object' && plugin.name && plugin.kind) {
        registerPlugin(plugin as Plugin);
        loaded++;
      }
    } catch (err) {
      // A broken plugin is logged but never fatal — one bad file must not
      // take the whole pipeline down.
      console.error(`plugin ${entry}: failed to load — ${(err as Error).message}`);
    }
  }

  return loaded;
}

// ------------------------------------------------------------- hook points

/** Try every registered extractor. Falls through to the default when all return null. */
export async function tryExtractors(
  page: Page,
  config: ScraperConfig,
): Promise<ExtractedItem[] | null> {
  for (const p of findPlugins('extractor', config.url)) {
    const result = await (p as ExtractorPlugin).extract(page, config);
    if (result !== null) return result;
  }
  return null; // caller falls back to the built-in extractor
}

/** Try every registered healer. Falls through when all return null. */
export async function tryHealers(
  page: Page,
  config: ScraperConfig,
  baseline: ExtractedItem[],
): Promise<{ config: ScraperConfig; verified: ExtractedItem[] } | null> {
  for (const p of findPlugins('healer', config.url)) {
    const result = await (p as HealerPlugin).heal(page, config, baseline);
    if (result !== null) return result;
  }
  return null;
}

/** Run all matching transforms in order, piping rows through each. */
export async function applyTransforms(
  rows: ExtractedItem[],
  config: ScraperConfig,
): Promise<ExtractedItem[]> {
  let out = rows;
  for (const p of findPlugins('transform', config.url)) {
    out = await (p as TransformPlugin).transform(out, config);
  }
  return out;
}
