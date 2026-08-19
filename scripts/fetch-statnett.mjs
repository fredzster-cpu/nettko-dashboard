import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'raw');
const DATA_OUT = path.join(ROOT, 'data');
await fs.mkdir(OUT, { recursive: true });

const STATNETT = 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8';
const now = new Date().toISOString();
const day = now.slice(0, 10);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'nb-NO', viewport: { width: 1920, height: 1400 } });
const page = await context.newPage();

console.log('Åpner Statnett...');
await page.goto(STATNETT, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);

const powerBIFrames = page.frames().filter(f => f.url().includes('app.powerbi.com'));
console.log(`Fant ${powerBIFrames.length} Power BI-frame(s)`);
let queueFrame = null;
for (const frame of powerBIFrames) {
  const text = await frame.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  if (text.includes('Kapasitetskø') && text.includes('Se liste over saker i kapasitetskø')) { queueFrame = frame; break; }
}
if (!queueFrame) throw new Error('Fant ikke Power BI-framen for Kapasitetskø.');
console.log('Fant Kapasitetskø-frame.');

const candidates = [
  queueFrame.getByText('Se liste over saker i kapasitetskø', { exact: false }),
  queueFrame.getByRole('button', { name: /Se liste over saker i kapasitetskø/i }),
  queueFrame.getByRole('link', { name: /Se liste over saker i kapasitetskø/i })
];
let clicked = false;
for (const locator of candidates) {
  try {
    if (await locator.count()) {
      await locator.first().scrollIntoViewIfNeeded();
      await locator.first().click({ timeout: 15000, force: true });
      clicked = true; break;
    }
  } catch {}
}
if (!clicked) throw new Error('Klarte ikke åpne detaljlisten.');
console.log('Detaljlisten åpnet.');
await page.waitForTimeout(10000);

// Power BI eksponerer tabellinnholdet som tilgjengelighetsroller. Vi leser radene
// i stedet for å lagre hele body.innerText (som tidligere ga ~2,7 MB støy).
const framesAfter = page.frames().filter(f => f.url().includes('app.powerbi.com'));
let best = null;
for (let i = 0; i < framesAfter.length; i++) {
  const frame = framesAfter[i];
  const rows = await frame.locator('[role="row"]').evaluateAll(els => els.slice(0, 5000).map(el => ({
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
    aria: el.getAttribute('aria-label') || ''
  })).filter(x => x.text || x.aria)).catch(() => []);
  const grids = await frame.locator('[role="grid"], [role="table"], [role="treegrid"]').count().catch(() => 0);
  const bodyText = await frame.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const score = rows.length * 10 + grids * 100 + (bodyText.includes('Prisområde') ? 50 : 0) + (bodyText.includes('Næringstype') ? 50 : 0);
  if (!best || score > best.score) best = { frame, index: i, rows, grids, bodyText, score };
}
if (!best) throw new Error('Fant ingen detalj-frame etter klikk.');

// Hvis Power BI bruker virtuelle celler, les også synlige celler og deres aria-attributter.
const cells = await best.frame.locator('[role="gridcell"], [role="columnheader"], [role="rowheader"]').evaluateAll(els => els.slice(0, 20000).map(el => ({
  role: el.getAttribute('role'),
  text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
  ariaLabel: el.getAttribute('aria-label'),
  colIndex: el.getAttribute('aria-colindex'),
  rowIndex: el.getAttribute('aria-rowindex')
})).filter(x => x.text || x.ariaLabel)).catch(() => []);

const diagnostic = {
  fetched_at: now,
  source: 'Statnett Kapasitetskø',
  clicked_list_view: clicked,
  frame_index: best.index,
  frame_url: best.frame.url(),
  grid_count: best.grids,
  row_count: best.rows.length,
  cell_count: cells.length,
  rows_sample: best.rows.slice(0, 100),
  cells_sample: cells.slice(0, 300)
};
await fs.writeFile(path.join(OUT, `queue-${day}-table-diagnostic.json`), JSON.stringify(diagnostic, null, 2));

// Lag et kompakt tekstutdrag som er enkelt å inspisere i GitHub.
const compact = best.rows.length
  ? best.rows.map((r, i) => `${i + 1}\t${r.text || r.aria}`).join('\n')
  : cells.map(c => `${c.rowIndex || ''}\t${c.colIndex || ''}\t${c.role}\t${c.text || c.ariaLabel || ''}`).join('\n');
await fs.writeFile(path.join(OUT, `queue-${day}-table.txt`), compact, 'utf-8');

// Første strukturerte datasett. Vi publiserer aldri gjetninger: bare rader hvor
// NO1/NO5 og et MW-tall kan identifiseres eksplisitt i samme radtekst.
function parseNumber(s) {
  if (!s) return null;
  const m = s.match(/(?:^|\s)(\d{1,3}(?:[ .]\d{3})*|\d+)(?:[,.]\d+)?\s*MW\b/i);
  if (!m) return null;
  return Number(m[1].replace(/[ .]/g, ''));
}
const projects = [];
for (const [i, row] of best.rows.entries()) {
  const text = row.text || row.aria || '';
  const area = text.match(/\bNO[15]\b/i)?.[0]?.toUpperCase();
  const mw = parseNumber(text);
  if (!area || mw == null) continue;
  projects.push({ id: `statnett-${day}-${i + 1}`, area, mw, raw: text, status: 'Kapasitetskø', source: 'Statnett' });
}
const structured = {
  updated_at: now,
  source: 'Statnett – Kapasitetskø',
  source_url: STATNETT,
  areas: ['NO1', 'NO5'],
  extraction: { method: 'Power BI accessibility table', frame_index: best.index, rows_seen: best.rows.length, cells_seen: cells.length },
  projects,
  totals: {
    NO1: { cases: projects.filter(p => p.area === 'NO1').length, mw: projects.filter(p => p.area === 'NO1').reduce((a,p)=>a+p.mw,0) },
    NO5: { cases: projects.filter(p => p.area === 'NO5').length, mw: projects.filter(p => p.area === 'NO5').reduce((a,p)=>a+p.mw,0) }
  }
};
await fs.writeFile(path.join(DATA_OUT, 'statnett-queue.json'), JSON.stringify(structured, null, 2));
console.log(`Tabell: ${best.rows.length} rader / ${cells.length} celler. Strukturerte NO1/NO5-rader: ${projects.length}.`);
await browser.close();
