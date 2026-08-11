import type { SiteLLMMemory } from './llm.js';

/**
 * Render the per-site LLM repair memory as readable text for
 * `scrape-heal --memory [site]`. With no site, every site with memory is
 * shown; with one, the key must be an exact origin or a substring of it.
 */
export function formatMemory(
  memory: Record<string, SiteLLMMemory>,
  site?: string,
): string {
  const all = Object.keys(memory);
  // Normalize trailing slashes so "https://shop.example.com/" matches the
  // origin key "https://shop.example.com".
  const norm = (s: string) => s.replace(/\/+$/, '');
  const keys = site
    ? all.filter((k) => norm(k) === norm(site) || norm(k).includes(norm(site)))
    : all;
  if (!keys.length) {
    const hint = all.length ? ` (remembered sites: ${all.join(', ')})` : '';
    return `no per-site LLM memory found${site ? ` for "${site}"` : ''}${hint}.`;
  }

  const lines: string[] = [];
  for (const key of keys) {
    const m = memory[key];
    lines.push(`site: ${key}`);
    lines.push('');
    lines.push('  verified repairs (newest first):');
    if (!m.successes.length) {
      lines.push('    (none)');
    } else {
      for (const s of m.successes) {
        lines.push(`    at ${s.at} — old ${s.old} → new ${JSON.stringify(s.proposal)}`);
      }
    }
    lines.push('');
    lines.push('  failed proposals (newest first):');
    if (!m.misses.length) {
      lines.push('    (none)');
    } else {
      for (const miss of m.misses) lines.push(`    - ${miss}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
