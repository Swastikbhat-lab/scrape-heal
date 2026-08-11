/**
 * Renders `npm run demo` as a terminal-style animated GIF.
 *
 * Pure-JS pipeline (no ffmpeg needed):
 *   Playwright renders a fake terminal window and we screenshot frames,
 *   pngjs decodes each frame, gif-encoder writes the GIF.
 *
 *   node scripts/make-demo-gif.mjs   ->   docs/demo.gif
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'docs', 'demo.gif');

// Colors — GitHub-dark terminal palette.
const C = {
  cmd: '#e6edf3',
  green: '#3fb950',
  red: '#f85149',
  yellow: '#d29922',
  cyan: '#58a6ff',
  dim: '#8b949e',
};

// The story, timed. `t` = start (s), `d` = typing duration (s), `c` = color.
const transcript = [
  { t: 0.0, d: 2.2, c: C.cmd, s: '$ npm run demo' },
  { t: 2.6, d: 0.1, c: C.dim, s: '┌──────────────────────────────────────────────────────────┐' },
  { t: 2.8, d: 0.1, c: C.cyan, s: 'STEP 1 — the site is healthy, the scraper works' },
  { t: 3.4, d: 0.1, c: C.green, s: '  ✓ extracted 4 item(s) — schema OK' },
  { t: 3.9, d: 0.25, c: C.cmd, s: '      1. Wireless Mouse        |  $24.99' },
  { t: 4.3, d: 0.25, c: C.cmd, s: '      2. Mechanical Keyboard   |  $89.00' },
  { t: 4.7, d: 0.25, c: C.cmd, s: '      3. USB-C Hub             |  $39.50' },
  { t: 5.1, d: 0.25, c: C.cmd, s: '      4. 4K Monitor            |  $299.00' },
  { t: 5.8, d: 0.1, c: C.cyan, s: 'STEP 2 — the site redeploys overnight. Nobody tells the scraper.' },
  { t: 6.3, d: 0.1, c: C.red, s: '  ✗ extracted 0 item(s) — BROKEN' },
  { t: 6.7, d: 0.3, c: C.yellow, s: '    - expected at least 4 item(s), got 0' },
  { t: 7.1, d: 0.3, c: C.yellow, s: '    - missing known value(s): Wireless Mouse, Mechanical Keyboard, …' },
  { t: 7.8, d: 0.1, c: C.cyan, s: 'STEP 3 — the healer wakes up. It knows what the data used to look like.' },
  { t: 8.3, d: 0.5, c: C.cmd, s: '  heal: item container candidate ".item" — 4 match(es)' },
  { t: 9.0, d: 0.5, c: C.cmd, s: '  heal: field "name" — candidate "h2.title" (4 match(es))' },
  { t: 9.7, d: 0.5, c: C.cmd, s: '  heal: field "price" — candidate "span.amount" (4 match(es))' },
  { t: 10.4, d: 0.6, c: C.cmd, s: '  heal: verifying on the live page…' },
  { t: 11.2, d: 0.3, c: C.green, s: '  heal: PASS — 4 item(s), every known "name" present. Shipping the repair.' },
  { t: 12.2, d: 0.1, c: C.cyan, s: 'STEP 4 — repaired, and only because verification passed' },
  { t: 12.7, d: 0.3, c: C.cmd, s: '  new config: items ".item"' },
  { t: 13.2, d: 0.3, c: C.cmd, s: '              name -> "h2.title"    price -> "span.amount"' },
  { t: 13.9, d: 0.25, c: C.cmd, s: '      1. Wireless Mouse        |  $24.99' },
  { t: 14.3, d: 0.25, c: C.cmd, s: '      2. Mechanical Keyboard   |  $89.00' },
  { t: 14.7, d: 0.25, c: C.cmd, s: '      3. USB-C Hub             |  $39.50' },
  { t: 15.1, d: 0.25, c: C.cmd, s: '      4. 4K Monitor            |  $299.00' },
  { t: 15.9, d: 0.4, c: C.green, s: '  ✓ data is identical to the last good run — nothing lost, nothing invented.' },
  { t: 16.7, d: 0.6, c: C.dim, s: '  If verification had failed, nothing would have been shipped.' },
];

const TOTAL = 24; // seconds; typing finishes ~17.5s, then a hold so readers can read the ending
const FPS = 5;
const W = 652;
const H = 470;

// The terminal window. The in-page script drives a time-based reveal so every
// screenshot is deterministic.
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #010409; display: flex; align-items: center; justify-content: center;
         height: 100vh; font-family: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace; }
  .win { width: 640px; background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
         overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
  .bar { display: flex; align-items: center; gap: 6px; padding: 9px 12px;
         background: #161b22; border-bottom: 1px solid #30363d; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.r { background: #ff5f56; } .dot.y { background: #ffbd2e; } .dot.g { background: #27c93f; }
  .title { margin-left: 10px; font-size: 11px; color: #8b949e; }
  pre { padding: 16px 18px 18px; font-size: 12.5px; line-height: 1.5; color: #e6edf3;
        white-space: pre; min-height: 420px; }
  .cursor { display: inline-block; width: 7px; height: 14px; background: #3fb950;
            vertical-align: text-bottom; }
</style></head><body>
  <div class="win">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">scrape-heal — npm run demo</span></div>
    <pre id="term"></pre>
  </div>
  <script>
    var T = __TRANSCRIPT__;
    var term = document.getElementById('term');
    // Deterministic, time-based render. Node drives the clock: it calls
    // window.__render(seconds) before every screenshot, so frames are exact
    // (requestAnimationFrame is throttled in headless and cannot be trusted).
    function render(now) {
      var out = '';
      for (var i = 0; i < T.length; i++) {
        var ln = T[i];
        if (now < ln.t) break;
        var elapsed = now - ln.t;
        var frac = ln.d <= 0 ? 1 : Math.min(1, elapsed / ln.d);
        var n = Math.max(1, Math.floor(ln.s.length * frac));
        out += '<span style="color:' + ln.c + '">' + ln.s.slice(0, n) + '</span>\\n';
      }
      var blink = Math.floor(now / 0.5) % 2 === 0;
      if (blink) out += '<span class="cursor"></span>';
      term.innerHTML = out;
    }
    window.__render = render;
    render(0);
  </script>
</body></html>`;

// escape < > & so the transcript can never inject markup
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pageHtml = html
  .replace('__TRANSCRIPT__', JSON.stringify(transcript.map((l) => ({ ...l, s: esc(l.s) }))))
  .replace('__TOTAL__', String(TOTAL));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
// A real file load, not setContent: setContent goes through document.write,
// which trips over inline scripts containing '<' / '>' sequences.
const FRAME_HTML = resolve(__dirname, '..', '.demo-frame.html');
writeFileSync(FRAME_HTML, pageHtml);
await page.goto(`file://${FRAME_HTML.replace(/\\/g, '/')}`, { waitUntil: 'load' });

const frames = [];
const nFrames = Math.floor(TOTAL * FPS);
console.log(`capturing ${nFrames} frames @ ${FPS}fps over ${TOTAL}s…`);
for (let i = 0; i < nFrames; i++) {
  await page.evaluate((t) => window.__render(t), i / FPS);
  const buf = await page.screenshot({ type: 'png' });
  frames.push(buf);
  await new Promise((r) => setTimeout(r, 1000 / FPS));
}

if (process.env.GIF_VERIFY) {
  // The last captured frame is the finished story — assert it all landed and
  // that nothing overflowed the terminal window.
  await page.evaluate((t) => window.__render(t), TOTAL - 0.05);
  const final = await page.evaluate(() => {
    const win = document.querySelector('.win');
    const term = document.getElementById('term');
    const lines = term.innerText.split('\n');
    return {
      text: term.innerText,
      last: lines.slice(-4),
      overflow: win.scrollWidth > win.clientWidth,
    };
  });
  console.log('last lines:', JSON.stringify(final.last));
  const must = [
    'STEP 4 — repaired, and only because verification passed',
    'PASS — 4 item(s)',
    'identical to the last good run',
    'nothing would have been shipped',
  ];
  const missing = must.filter((m) => !final.text.includes(m));
  if (missing.length) console.error(`VERIFY FAIL — missing: ${missing.join(' | ')}`);
  else console.log(`VERIFY OK — ${final.text.split('\n').length} lines, overflow=${final.overflow}`);
  if (missing.length || final.overflow) process.exitCode = 1;
}

await browser.close();
rmSync(FRAME_HTML);

// --- encode ---------------------------------------------------------------
// One global palette: the terminal uses a handful of colours and they never
// change, so a shared palette keeps the file small (per-frame palettes
// ballooned the PoC to 3 MB).
const gif = GIFEncoder();
const first = PNG.sync.read(frames[0]);
const palette = quantize(first.data, 256);
for (let i = 0; i < frames.length; i++) {
  const png = PNG.sync.read(frames[i]);
  const index = applyPalette(png.data, palette);
  gif.writeFrame(index, png.width, png.height, { palette, delay: Math.round(1000 / FPS) });
}
gif.finish();
writeFileSync(OUT, gif.bytes());

const kb = Math.round(gif.bytes().length / 1024);
console.log(`wrote ${OUT} (${frames.length} frames, ${kb} KB)`);
