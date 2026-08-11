/**
 * Terminal-style animated GIF renderer — the shared machinery behind the
 * README demos. Pure JS, no ffmpeg:
 *
 *   Playwright renders a fake terminal window, screenshots are decoded with
 *   pngjs, and gifenc encodes a shared-palette GIF (the terminal colors never
 *   change, so one palette keeps the file small).
 *
 * Usage:
 *   import { renderTerminalGif, C } from './gif-lib.mjs';
 *   await renderTerminalGif({
 *     transcript,        // [{ t, d, c, s }] — start (s), typing duration (s), color, text
 *     out,               // absolute path for the GIF
 *     title,             // terminal window title
 *     total,             // total seconds of animation
 *     verify,            // phrases that must appear in the final frame
 *   });
 *
 * Deterministic by design: Node drives the clock (page.evaluate) instead of
 * requestAnimationFrame, which headless Chromium throttles.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Colors — GitHub-dark terminal palette.
export const C = {
  cmd: '#e6edf3',
  green: '#3fb950',
  red: '#f85149',
  yellow: '#d29922',
  cyan: '#58a6ff',
  dim: '#8b949e',
};

// escape < > & so the transcript can never inject markup
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      <span class="title">__TITLE__</span></div>
    <pre id="term"></pre>
  </div>
  <script>
    var T = __TRANSCRIPT__;
    var term = document.getElementById('term');
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

export async function renderTerminalGif(opts) {
  const {
    transcript,
    out,
    title,
    total,
    fps = 5,
    w = 652,
    h = 470,
    verify = [],
  } = opts;

  const pageHtml = html
    .replace('__TITLE__', esc(title))
    .replace('__TRANSCRIPT__', JSON.stringify(transcript.map((l) => ({ ...l, s: esc(l.s) }))));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  // A real file load, not setContent: setContent goes through document.write,
  // which trips over inline scripts containing '<' / '>' sequences.
  const FRAME_HTML = resolve(__dirname, `.gif-frame-${Date.now()}.html`);
  writeFileSync(FRAME_HTML, pageHtml);
  await page.goto(`file://${FRAME_HTML.replace(/\\/g, '/')}`, { waitUntil: 'load' });

  const frames = [];
  const nFrames = Math.floor(total * fps);
  console.log(`capturing ${nFrames} frames @ ${fps}fps over ${total}s…`);
  for (let i = 0; i < nFrames; i++) {
    await page.evaluate((t) => window.__render(t), i / fps);
    const buf = await page.screenshot({ type: 'png' });
    frames.push(buf);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }

  if (process.env.GIF_VERIFY) {
    await page.evaluate((t) => window.__render(t), total - 0.05);
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
    const missing = verify.filter((m) => !final.text.includes(m));
    if (missing.length) console.error(`VERIFY FAIL — missing: ${missing.join(' | ')}`);
    else console.log(`VERIFY OK — ${final.text.split('\n').length} lines, overflow=${final.overflow}`);
    if (missing.length || final.overflow) process.exitCode = 1;
  }

  await browser.close();
  rmSync(FRAME_HTML);

  // One global palette: terminal colors are constant, so a shared palette
  // keeps the GIF small (per-frame palettes ballooned a PoC to 3 MB).
  const gif = GIFEncoder();
  const first = PNG.sync.read(frames[0]);
  const palette = quantize(first.data, 256);
  for (let i = 0; i < frames.length; i++) {
    const png = PNG.sync.read(frames[i]);
    const index = applyPalette(png.data, palette);
    gif.writeFrame(index, png.width, png.height, { palette, delay: Math.round(1000 / fps) });
  }
  gif.finish();
  writeFileSync(out, gif.bytes());

  const kb = Math.round(gif.bytes().length / 1024);
  console.log(`wrote ${out} (${frames.length} frames, ${kb} KB)`);
}
