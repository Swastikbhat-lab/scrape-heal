import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Validator } from './scraper.js';

/**
 * Load a pluggable validator from a file. The file exports a function as
 * default:
 *
 *   export default (items, { config, baseline }) => ({
 *     ok: ...,
 *     itemCount: items.length,
 *     issues: [...],
 *   });
 *
 * Plain JS (.js/.mjs/.cjs) always works; under tsx (which runs the CLI),
 * a .ts file works too. Relative paths resolve from the current directory.
 */
export async function loadValidator(path: string): Promise<Validator> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: unknown;
    validator?: unknown;
  };
  const fn = mod.default ?? mod.validator;
  if (typeof fn !== 'function') {
    throw new Error(`validator ${path} must export a function as default`);
  }
  return fn as Validator;
}
