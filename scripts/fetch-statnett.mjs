import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'raw');
await fs.mkdir(OUT, { recursive: true });

const SOURCES = [
  {
    key: 'queue',
    page: 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8',
    label: 'Kapasitetskø'
  },
  {
    key: 'reservations',
    page: 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#reservasjoner',
    label: 'Reservasjoner'
  }
];

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  locale: 'nb-NO',
  viewport: { width: 1600, height: 1200 }
});

async function collect(source) {
  const page = await context.newPage();

  const now = new Date().toISOString();
  const day = now.slice(0, 10);

  console.log(`Åpner ${source.label}...`);

  await page.goto(source.page, {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });

  await page.waitForTimeout(10000);

  const frames = page
    .frames()
    .filter(frame => frame.url().includes('app.powerbi.com'));

  console.log(
    `${source.label}: fant ${frames.length} Power BI-frame(s)`
  );

  if (!frames.length) {
    await page.screenshot({
      path: path.join(OUT, `${source.key}-${day}-no-frame.png`),
      fullPage: true
    });

    throw new Error(
      `Fant ingen Power BI-frame for ${source.label}`
    );
  }

  const captures = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    try {
      await frame
        .waitForLoadState('domcontentloaded', { timeout: 30000 })
        .catch(() => {});

      await page.waitForTimeout(5000);

      const text = await frame
        .locator('body')
        .innerText({ timeout: 15000 })
        .catch(() => '');

      const html = await frame
        .locator('body')
        .innerHTML({ timeout: 15000 })
        .catch(() => '');

      captures.push({
        frameIndex: i,
        url: frame.url(),
        textLength: text.length,
        htmlLength: html.length,
        text
      });

      await fs.writeFile(
        path.join(
          OUT,
          `${source.key}-${day}-frame-${i}.txt`
        ),
        text,
        'utf-8'
      );

    } catch (error) {
      captures.push({
        frameIndex: i,
        url: frame.url(),
        error: String(error)
      });
    }
  }

  await page.screenshot({
    path: path.join(
      OUT,
      `${source.key}-${day}.png`
    ),
    fullPage: true
  });

  const result = {
    fetched_at: now,
    source: source.label,
    page_url: source.page,
    frames: captures
  };

  await fs.writeFile(
    path.join(
      OUT,
      `${source.key}-${day}.json`
    ),
    JSON.stringify(result, null, 2),
    'utf-8'
  );

  await page.close();

  return result;
}

let success = true;

for (const source of SOURCES) {
  try {
    await collect(source);
  } catch (error) {
    success = false;
    console.error(error);
  }
}

await browser.close();

if (!success) {
  console.error(
    'En eller flere Statnett-kilder feilet. Diagnostikk er lagret i data/raw.'
  );

  process.exitCode = 2;
} else {
  console.log('Statnett-fangst fullført.');
}
