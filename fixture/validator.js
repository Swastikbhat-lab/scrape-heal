/**
 * Example pluggable validator — replaces the built-in shape checks.
 *
 * Run with: npm run watch -- --demo --mutate 8 --interval 5 --cycles 6 --validator fixture/validator.js
 *
 * The contract: export a function (items, { config, baseline }) that returns
 * { ok, itemCount, issues }. Here we keep a couple of shape rules but add a
 * schema-style check the built-in validator doesn't have: prices must be USD.
 */
export default function schemaValidator(items, { config }) {
  const issues = [];

  if (items.length < config.minItems) {
    issues.push(`expected at least ${config.minItems} item(s), got ${items.length}`);
  }

  for (const f of config.fields) {
    const empties = items.filter((it) => !(it[f.name] ?? '').trim()).length;
    if (empties > 0) {
      issues.push(`field "${f.name}" is empty in ${empties} of ${items.length} item(s)`);
    }
  }

  if (config.fields.some((f) => f.name === 'price')) {
    for (const it of items) {
      const p = (it.price ?? '').trim();
      if (p && !/^\$\d+(\.\d{2})?$/.test(p)) {
        issues.push(`price "${p}" is not a USD amount`);
      }
    }
  }

  return { ok: issues.length === 0, itemCount: items.length, issues };
}
