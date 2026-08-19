import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const SNAP = path.join(DATA, 'snapshots');
await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(SNAP, { recursive: true });

const SOURCE = 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/';
const now = new Date().toISOString();
const day = now.slice(0, 10);
const productionTypes = new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);

const browser = await chromium.launch({ headless: true });

function num(s) {
  if (s == null || s === '') return null;
  const x = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}

function total(rows, area) {
  const scoped = rows.filter(r => r.area === area);
  return { cases: scoped.length, mw: scoped.reduce((a, r) => a + (r.mw || 0), 0) };
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function newPage() {
  const context = await browser.newContext({
    locale: 'nb-NO',
    viewport: { width: 1920, height: 1400 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return { context, page };
}

async function load(page) {
  await page.goto(SOURCE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(10000);
}

async function findOverviewFrame(page, heading, listText, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames().filter(f => f.url().includes('app.powerbi.com'))) {
      const text = await frame.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      if (text.includes(heading) && text.includes(listText)) return frame;
    }
    await page.waitForTimeout(1200);
  }
  return null;
}

async function frameHasDetailGrid(frame) {
  const grids = frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
  const count = await grids.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const t = await grids.nth(i).innerText({ timeout: 3000 }).catch(() => '');
    if (t.includes('Prisområde') && (t.includes('(MW)') || t.includes('Næringstype'))) return true;
  }
  return false;
}

async function findDetailFrame(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames().filter(f => f.url().includes('app.powerbi.com'))) {
      if (await frameHasDetailGrid(frame)) return frame;
    }
    await page.waitForTimeout(800);
  }
  return null;
}

async function clickList(page, frame, text) {
  const re = new RegExp(esc(text), 'i');
  const locators = [
    frame.getByRole('button', { name: re }),
    frame.getByRole('link', { name: re }),
    frame.getByText(text, { exact: false }),
    frame.locator(`text=${text}`)
  ];

  for (const loc of locators) {
    try {
      if (!(await loc.count())) continue;
      const target = loc.first();
      await target.scrollIntoViewIfNeeded().catch(() => {});
      for (const force of [false, true]) {
        try {
          await target.click({ timeout: 8000, force });
          if (await findDetailFrame(page, 14000)) return true;
        } catch {}
      }
    } catch {}
  }

  const domClicked = await frame.evaluate(targetText => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = norm(targetText);
    const hits = [...document.querySelectorAll('body *')]
      .filter(el => norm(el.textContent).includes(wanted))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    if (!hits.length) return false;
    let target = hits[0];
    for (let i = 0; i < 8 && target.parentElement; i++) {
      const role = target.getAttribute?.('role');
      if (target.tagName === 'BUTTON' || target.tagName === 'A' || role === 'button' || role === 'link' || target.hasAttribute?.('tabindex')) break;
      target = target.parentElement;
    }
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch {}
    }
    try { target.click(); } catch {}
    return true;
  }, text).catch(() => false);

  if (domClicked && await findDetailFrame(page, 18000)) return true;
  return false;
}

async function visibleRows(grid) {
  const rows = grid.locator('[role="row"]');
  const count = await rows.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    const cells = await rows.nth(i)
      .locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]')
      .allInnerTexts().catch(() => []);
    const clean = cells.map(x => x.replace(/\s+/g, ' ').trim());
    if (clean.some(Boolean)) out.push(clean);
  }
  return out;
}

async function findScroller(grid) {
  return grid.evaluate(el => {
    const nodes = [el, ...el.querySelectorAll('*')];
    let p = el.parentElement;
    for (let i = 0; i < 7 && p; i++, p = p.parentElement) nodes.push(p);
    const candidates = [...new Set(nodes)]
      .filter(x => x.scrollHeight > x.clientHeight + 25 && x.clientHeight > 40)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const s = candidates[0];
    if (!s) return null;
    return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
  }).catch(() => null);
}

async function resetGrid(grid) {
  await grid.evaluate(el => {
    const nodes = [el, ...el.querySelectorAll('*')];
    let p = el.parentElement;
    for (let i = 0; i < 7 && p; i++, p = p.parentElement) nodes.push(p);
    for (const x of [...new Set(nodes)]) if (x.scrollHeight > x.clientHeight + 25) x.scrollTop = 0;
  }).catch(() => {});
}

async function scrollGrid(grid) {
  return grid.evaluate(el => {
    const nodes = [el, ...el.querySelectorAll('*')];
    let p = el.parentElement;
    for (let i = 0; i < 7 && p; i++, p = p.parentElement) nodes.push(p);
    const candidates = [...new Set(nodes)]
      .filter(x => x.scrollHeight > x.clientHeight + 25 && x.clientHeight > 40)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const s = candidates[0];
    if (!s) return { moved: false, bottom: true };
    const before = s.scrollTop;
    const max = s.scrollHeight - s.clientHeight;
    s.scrollTop = Math.min(max, before + Math.max(140, s.clientHeight * 0.65));
    s.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { moved: s.scrollTop > before, bottom: s.scrollTop >= max - 3, before, after: s.scrollTop, max };
  }).catch(() => ({ moved: false, bottom: false }));
}

async function collectAllRows(grid, page) {
  await resetGrid(grid);
  await page.waitForTimeout(500);
  const unique = new Map();
  let stale = 0;
  let bottomSeen = 0;

  for (let step = 0; step < 320; step++) {
    const rows = await visibleRows(grid);
    const before = unique.size;
    for (const r of rows) unique.set(r.join('|'), r);
    stale = unique.size === before ? stale + 1 : 0;

    const scroll = await scrollGrid(grid);
    bottomSeen = scroll.bottom ? bottomSeen + 1 : 0;
    if (!scroll.moved) {
      try { await grid.press('PageDown'); } catch {}
    }
    await page.waitForTimeout(220);
    if (bottomSeen >= 3 && stale >= 3) break;
    if (stale >= 16) break;
  }
  return [...unique.values()];
}

function parseGrid(rows, status) {
  const header = rows.find(r => r.some(x => x.includes('Prisområde')) && r.some(x => x.includes('(MW)')));
  if (!header) return [];
  const idx = needle => header.findIndex(h => h.toLowerCase().includes(needle.toLowerCase()));
  const iCase = idx('Statnett saksnr');
  const iTilko = idx('Tilko saksnr');
  const iStation = idx('Stasjon for tilknytning');
  const iPlan = idx('Områdeplan');
  const iArea = idx('Prisområde');
  const iCustomer = idx('Statnetts kunde');
  const iEnd = idx('Sluttkunde');
  const iIndustry = idx('Næringstype');
  const iMw = header.findIndex(h => h.includes('(MW)'));
  const iDate = header.findIndex(h => h.toLowerCase().includes('dato'));
  if ([iArea, iEnd, iIndustry, iMw].some(i => i < 0)) return [];

  return rows.filter(r => r !== header && r[iArea] && /^NO\d$/i.test(r[iArea])).map(r => ({
    id: (r[iCase] || r[iTilko] || `${status}-${r[iEnd]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g, '-'),
    statnett_case: iCase >= 0 ? r[iCase] || null : null,
    tilko_case: iTilko >= 0 ? r[iTilko] || null : null,
    station: iStation >= 0 ? r[iStation] || null : null,
    area_plan: iPlan >= 0 ? r[iPlan] || null : null,
    area: r[iArea].toUpperCase(),
    grid_customer: iCustomer >= 0 ? r[iCustomer] || null : null,
    end_customer: r[iEnd] || null,
    industry: r[iIndustry] || null,
    mw: num(r[iMw]),
    date: iDate >= 0 ? r[iDate] || null : null,
    status,
    source: 'Statnett'
  })).filter(r => r.mw != null && r.mw >= 0);
}

async function extractOnce(config, attempt) {
  const { context, page } = await newPage();
  try {
    await load(page);
    const overview = await findOverviewFrame(page, config.heading, config.listText);
    if (!overview) throw new Error(`Fant ikke ${config.heading}-oversikt`);

    if (!await clickList(page, overview, config.listText)) {
      throw new Error(`Klarte ikke åpne ${config.heading}-listen`);
    }

    const detail = await findDetailFrame(page, 30000);
    if (!detail) throw new Error(`${config.heading}: detalj-frame mangler etter klikk`);

    const grids = detail.locator('[role="grid"],[role="table"],[role="treegrid"]');
    const gc = await grids.count();
    if (!gc) throw new Error(`${config.heading}: ingen tabeller funnet`);

    const candidates = [];
    const diagnostics = [];
    for (let i = 0; i < gc; i++) {
      const rows = await collectAllRows(grids.nth(i), page);
      const parsed = parseGrid(rows, config.status);
      const productionCount = parsed.filter(x => productionTypes.has(x.industry)).length;
      const consumption = parsed.filter(x => !productionTypes.has(x.industry));
      diagnostics.push({ grid: i, unique_rows: rows.length, parsed_count: parsed.length, production_count: productionCount, consumption_count: consumption.length, sample: rows.slice(0, 5) });
      candidates.push(consumption);
    }

    candidates.sort((a, b) => b.length - a.length);
    const scoped = (candidates[0] || []).filter(x => x.area === 'NO1' || x.area === 'NO5');
    const mw = scoped.reduce((a, x) => a + (x.mw || 0), 0);

    await fs.writeFile(path.join(RAW, `${config.key}-${day}-diagnostic.json`), JSON.stringify({
      fetched_at: now,
      heading: config.heading,
      attempt,
      grid_count: gc,
      selected_count: scoped.length,
      selected_mw: mw,
      diagnostics
    }, null, 2));

    if (!scoped.length || mw <= 0) throw new Error(`${config.heading}: tomt/ugyldig NO1/NO5-forbruksdatasett`);
    return scoped;
  } finally {
    await context.close().catch(() => {});
  }
}

async function extractWithRetry(config) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      console.log(`${config.heading}: forsøk ${attempt}/4`);
      const rows = await extractOnce(config, attempt);
      console.log(`${config.heading}: ${rows.length} NO1/NO5-saker, ${rows.reduce((a, r) => a + r.mw, 0)} MW`);
      return rows;
    } catch (e) {
      last = e;
      console.error(`${config.heading}: forsøk ${attempt} feilet: ${e.message}`);
      if (attempt < 4) await new Promise(r => setTimeout(r, 2500 * attempt));
    }
  }
  throw last;
}

async function readPrevious() {
  try { return JSON.parse(await fs.readFile(path.join(DATA, 'current.json'), 'utf8')); }
  catch { return null; }
}

function validate(current, previous) {
  const errors = [];
  for (const kind of ['queue', 'reservations']) {
    if (!current[kind].length) errors.push(`${kind} er tom`);
    for (const area of ['NO1', 'NO5']) {
      const t = current.totals[kind][area];
      if (t.cases <= 0 || t.mw <= 0) errors.push(`${kind} ${area} mangler saker/MW`);
      const old = previous?.totals?.[kind]?.[area]?.mw || 0;
      if (old > 100 && t.mw < old * 0.55) errors.push(`${kind} ${area} falt under 55% av forrige gode datasett`);
    }
  }
  const all = [...current.queue, ...current.reservations];
  if (all.some(r => !['NO1', 'NO5'].includes(r.area))) errors.push('Uventet prisområde');
  if (all.some(r => !Number.isFinite(r.mw) || r.mw < 0)) errors.push('Ugyldig MW');
  return errors;
}

try {
  const previous = await readPrevious();
  console.log('Henter kapasitetskø...');
  const queue = await extractWithRetry({ heading: 'Kapasitetskø', listText: 'Se liste over saker i kapasitetskø', status: 'Kapasitetskø', key: 'queue' });

  console.log('Henter reservasjoner...');
  const reservations = await extractWithRetry({ heading: 'Reservasjoner', listText: 'Se liste over reservasjoner', status: 'Reservert', key: 'reservations' });

  const current = {
    updated_at: now,
    source: 'Statnett – offentlige Power BI-lister',
    source_url: SOURCE,
    scope: 'Forbruk, NO1 og NO5',
    queue,
    reservations,
    totals: {
      queue: { NO1: total(queue, 'NO1'), NO5: total(queue, 'NO5') },
      reservations: { NO1: total(reservations, 'NO1'), NO5: total(reservations, 'NO5') }
    }
  };

  const errors = validate(current, previous);
  await fs.writeFile(path.join(RAW, `validation-${day}.json`), JSON.stringify({ updated_at: now, ok: !errors.length, errors, totals: current.totals }, null, 2));
  if (errors.length) throw new Error(`Datasett avvist: ${errors.join('; ')}`);

  await fs.writeFile(path.join(DATA, 'current.json'), JSON.stringify(current, null, 2));
  await fs.writeFile(path.join(SNAP, `${day}.json`), JSON.stringify(current, null, 2));

  let history = [];
  try { history = JSON.parse(await fs.readFile(path.join(DATA, 'history.json'), 'utf8')); } catch {}
  const point = {
    date: day,
    updated_at: now,
    queue_NO1: current.totals.queue.NO1.mw,
    queue_NO5: current.totals.queue.NO5.mw,
    reserved_NO1: current.totals.reservations.NO1.mw,
    reserved_NO5: current.totals.reservations.NO5.mw
  };
  history = history.filter(x => x.date !== day);
  history.push(point);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await fs.writeFile(path.join(DATA, 'history.json'), JSON.stringify(history, null, 2));

  console.log('Kvalitetskontroll: OK');
  console.log('Ferdig:', JSON.stringify(current.totals));
} finally {
  await browser.close().catch(() => {});
}
