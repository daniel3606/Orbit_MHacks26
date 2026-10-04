// Rasterizes the Figma star exports (assets/images/stars/*.svg) to transparent PNGs at their
// own size, at @1x/@2x/@3x. Like the constellations, each glow is six stacked drop shadows;
// drawn live they arrive late and block the UI thread, so StarField shows these images instead.
// Needs Google Chrome.
// Usage: node scripts/rasterize-stars.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = resolve(import.meta.dirname, '../assets/images/stars');

const work = mkdtempSync(join(tmpdir(), 'stars-'));
for (const file of readdirSync(DIR).filter(f => f.endsWith('.svg'))) {
  const name = file.replace(/\.svg$/, '');
  const svg = join(DIR, file);
  const head = readFileSync(svg, 'utf8').slice(0, 400);
  const size = Math.ceil(Number(/width="([\d.]+)"/.exec(head)[1]));
  const page = join(work, `${name}.html`);
  writeFileSync(
    page,
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}` +
      `img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="file://${svg}"></body></html>`
  );
  for (const scale of [1, 2, 3]) {
    const out = join(DIR, scale === 1 ? `${name}.png` : `${name}@${scale}x.png`);
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
      `--force-device-scale-factor=${scale}`, `--window-size=${size},${size}`, `--screenshot=${out}`, `file://${page}`,
    ], { stdio: 'ignore' });
  }
  console.log(`${name}: ${size}×${size} pt`);
}
