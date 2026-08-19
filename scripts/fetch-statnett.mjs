import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'raw');
await fs.mkdir(OUT, { recursive: true });

const STATNETT =
  'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8';

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  locale: 'nb-NO',
  viewport: {
    width: 1920,
    height: 1400
  }
});

const page = await context.newPage();

const now = new Date().toISOString();
const day = now.slice(0, 10);

console.log('Åpner Statnett...');

await page.goto(STATNETT, {
  waitUntil: 'domcontentloaded',
  timeout: 90000
});

await page.waitForTimeout(10000);

// ----------------------------------------------------
// 1. Finn riktig Power BI-frame
// ----------------------------------------------------

console.log('Leter etter Kapasitetskø-rapporten...');

const powerBIFrames = page
  .frames()
  .filter(frame => frame.url().includes('app.powerbi.com'));

console.log(
  `Fant ${powerBIFrames.length} Power BI-frame(s)`
);

let queueFrame = null;

for (const frame of powerBIFrames) {

  const text = await frame
    .locator('body')
    .innerText({ timeout: 15000 })
    .catch(() => '');

  if (
    text.includes('Kapasitetskø') &&
    text.includes('Se liste over saker i kapasitetskø')
  ) {
    queueFrame = frame;
    console.log('Fant Kapasitetskø-frame!');
    break;
  }
}

if (!queueFrame) {
  throw new Error(
    'Fant ikke Power BI-framen for Kapasitetskø.'
  );
}

// ----------------------------------------------------
// 2. Lagre BEFORE-diagnostikk
// ----------------------------------------------------

const beforeText = await queueFrame
  .locator('body')
  .innerText()
  .catch(() => '');

await fs.writeFile(
  path.join(OUT, `queue-${day}-before-click.txt`),
  beforeText,
  'utf-8'
);

await page.screenshot({
  path: path.join(OUT, `queue-${day}-before-click.png`),
  fullPage: true
});

// ----------------------------------------------------
// 3. Finn "Se liste over saker i kapasitetskø"
// ----------------------------------------------------

console.log(
  'Forsøker å åpne listen over saker i kapasitetskø...'
);

let clicked = false;

// Først forsøker vi semantiske Playwright-lokatorer.

const candidates = [
  queueFrame.getByText(
    'Se liste over saker i kapasitetskø',
    { exact: false }
  ),

  queueFrame.getByRole('button', {
    name: /Se liste over saker i kapasitetskø/i
  }),

  queueFrame.getByRole('link', {
    name: /Se liste over saker i kapasitetskø/i
  })
];

for (const locator of candidates) {

  try {

    const count = await locator.count();

    console.log(
      `Klikk-kandidat har ${count} treff`
    );

    if (count > 0) {

      await locator.first().scrollIntoViewIfNeeded();

      await locator.first().click({
        timeout: 15000,
        force: true
      });

      clicked = true;

      console.log('Klikket på listevisningen.');

      break;
    }

  } catch (error) {

    console.log(
      `Klikkforsøk feilet: ${String(error)}`
    );
  }
}

// ----------------------------------------------------
// 4. Hvis vanlig klikk ikke fungerer:
//    forsøk å finne tekst-elementet direkte
// ----------------------------------------------------

if (!clicked) {

  console.log(
    'Vanlig klikk fungerte ikke. Forsøker DOM-klikk...'
  );

  clicked = await queueFrame.evaluate(() => {

    const targetText =
      'Se liste over saker i kapasitetskø';

    const elements = Array.from(
      document.querySelectorAll('*')
    );

    const target = elements.find(el => {

      const text =
        (el.textContent || '').trim();

      return text === targetText;
    });

    if (!target) {
      return false;
    }

    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );

    return true;
  }).catch(() => false);
}

console.log(`Klikk registrert: ${clicked}`);

// ----------------------------------------------------
// 5. Vent på at Power BI navigerer
// ----------------------------------------------------

await page.waitForTimeout(10000);

// Power BI kan navigere i samme frame eller opprette/endret frame.
// Derfor søker vi gjennom alle frames på nytt.

const framesAfterClick = page
  .frames()
  .filter(frame => frame.url().includes('app.powerbi.com'));

const afterFrames = [];

for (let i = 0; i < framesAfterClick.length; i++) {

  const frame = framesAfterClick[i];

  const text = await frame
    .locator('body')
    .innerText({ timeout: 15000 })
    .catch(() => '');

  afterFrames.push({
    frameIndex: i,
    url: frame.url(),
    textLength: text.length,
    text
  });

  await fs.writeFile(
    path.join(
      OUT,
      `queue-${day}-after-click-frame-${i}.txt`
    ),
    text,
    'utf-8'
  );
}

// ----------------------------------------------------
// 6. Lagre skjermbilde etter klikk
// ----------------------------------------------------

await page.screenshot({
  path: path.join(
    OUT,
    `queue-${day}-after-click.png`
  ),
  fullPage: true
});

// ----------------------------------------------------
// 7. Finn mest sannsynlige detalj-frame
// ----------------------------------------------------

let detailCandidate = null;

for (const frame of afterFrames) {

  const t = frame.text || '';

  // Vi gir poeng for begreper vi forventer i detaljlisten.

  let score = 0;

  const keywords = [
    'Prisområde',
    'Næringstype',
    'Forbruk',
    'Produksjon',
    'MW',
    'Områdeplan',
    'Tilknytning'
  ];

  for (const keyword of keywords) {
    if (t.includes(keyword)) {
      score++;
    }
  }

  // En detaljtabell bør normalt inneholde
  // vesentlig mer tekst enn oversiktssiden.

  if (t.length > 1500) {
    score += 3;
  }

  frame.score = score;

  if (
    !detailCandidate ||
    score > detailCandidate.score
  ) {
    detailCandidate = frame;
  }
}

// ----------------------------------------------------
// 8. Lagre samlet resultat
// ----------------------------------------------------

const result = {
  fetched_at: now,
  source: 'Statnett Kapasitetskø',
  clicked_list_view: clicked,

  frames_found_before_click:
    powerBIFrames.length,

  frames_found_after_click:
    framesAfterClick.length,

  detail_candidate:
    detailCandidate
      ? {
          frameIndex:
            detailCandidate.frameIndex,

          url:
            detailCandidate.url,

          textLength:
            detailCandidate.textLength,

          score:
            detailCandidate.score
        }
      : null,

  frames: afterFrames.map(frame => ({
    frameIndex: frame.frameIndex,
    url: frame.url,
    textLength: frame.textLength,
    score: frame.score
  }))
};

await fs.writeFile(
  path.join(
    OUT,
    `queue-${day}-detail-result.json`
  ),
  JSON.stringify(result, null, 2),
  'utf-8'
);

// Hvis vi har en kandidat, lagrer vi også teksten
// separat slik at den er enkel å åpne i GitHub.

if (detailCandidate) {

  await fs.writeFile(
    path.join(
      OUT,
      `queue-${day}-DETAIL.txt`
    ),
    detailCandidate.text,
    'utf-8'
  );

  console.log(
    `Detaljkandidat: frame ${detailCandidate.frameIndex}, ` +
    `${detailCandidate.textLength} tegn, ` +
    `score ${detailCandidate.score}`
  );
}

console.log('Ferdig.');

await browser.close();
