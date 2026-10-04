// Rasterizes the Figma constellation exports (assets/images/constellations/source/*.svg) to
// transparent PNGs at the size the Discover header shows them, at @1x/@2x/@3x.
// Their glows are six stacked drop shadows per star; drawn live by react-native-svg they block
// the UI thread, so the app ships these images instead. Needs Google Chrome.
// Usage: node scripts/rasterize-constellations.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = resolve(import.meta.dirname, '../assets/images/constellations');
// Stars-and-lines box of each Figma group (w × h); must match ZodiacHeader.tsx.
const CORE = {
  aries: [383, 244], taurus: [428, 312], gemini: [370, 402], cancer: [230, 403],
  leo: [434, 254], virgo: [426, 354], libra: [229, 388], scorpio: [368, 381],
  sagittarius: [365, 329], capricorn: [432, 299], aquarius: [429, 323], pisces: [439, 318],
};
const BOX = { width: 287, height: 194 };

const work = mkdtempSync(join(tmpdir(), 'constellations-'));
for (const file of readdirSync(join(DIR, 'source')).filter(f => f.endsWith('.svg'))) {
  const sign = file.replace(/\.svg$/, '');
  const svg = join(DIR, 'source', file);
  const head = readFileSync(svg, 'utf8').slice(0, 400);
  const svgW = Number(/width="([\d.]+)"/.exec(head)[1]);
  const svgH = Number(/height="([\d.]+)"/.exec(head)[1]);
  const [w, h] = CORE[sign];
  const fit = Math.min(BOX.width / w, BOX.height / h);
  const width = Math.ceil(svgW * fit);
  const height = Math.ceil(svgH * fit);
  const page = join(work, `${sign}.html`);
  writeFileSync(
    page,
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}` +
      `img{display:block;width:${width}px;height:${height}px}</style></head><body><img src="file://${svg}"></body></html>`
  );
  for (const scale of [1, 2, 3]) {
    const out = join(DIR, scale === 1 ? `${sign}.png` : `${sign}@${scale}x.png`);
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
      `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${page}`,
    ], { stdio: 'ignore' });
  }
  console.log(`${sign}: ${width}×${height} pt`);
}
