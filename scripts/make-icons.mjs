/**
 * Renders the PNG app icons from the SVG masters.
 *
 * Android needs raster icons for the install prompt and, more importantly, for
 * the splash screen it draws itself when a standalone app launches. With only
 * SVG in the manifest that splash falls back to a plain letter, so the launch
 * starts on something that is not the app's logo and then jumps to something
 * that is.
 *
 *   npm run icons
 *
 * Uses the Chrome that is already installed rather than adding an image
 * dependency to the project for a file that changes once a year.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('No Chrome found — install Chrome or edit CHROME_CANDIDATES.');
  process.exit(1);
}

// [source svg, output png, size, pad] — the maskable master already carries its
// own safe-zone padding, so it is rendered edge to edge.
const JOBS = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });

for (const [src, out, size] of JOBS) {
  const svg = fs.readFileSync(path.join(PUB, src), 'utf8');
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">
       <div style="width:${size}px;height:${size}px">${svg}</div>
     </body></html>`,
    { waitUntil: 'load' },
  );
  await page.evaluate((s) => {
    const el = document.querySelector('svg');
    el.setAttribute('width', s);
    el.setAttribute('height', s);
    el.style.display = 'block';
  }, size);
  await page.screenshot({ path: path.join(PUB, out), omitBackground: true });
  await page.close();
  const kb = (fs.statSync(path.join(PUB, out)).size / 1024).toFixed(1);
  console.log(`  ${out.padEnd(24)} ${size}x${size}  ${kb} KB`);
}

await browser.close();
console.log('done');
