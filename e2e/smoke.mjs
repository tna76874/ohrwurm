// End-to-End-Test des Mesh: drei Browser, Fake-Mikrofon mit synthetischer Sprache.
//   Anna startet die Sitzung, Ben tritt bei und spricht, Anna korrigiert Text und
//   Sprecher, Ben markiert. Dann fällt Anna aus – Clara (Handy) tritt bei und
//   bekommt alles von Ben. Zum Schluss PDF-Export und Screenshots.
// Aufruf über `make e2e` bzw. `make e2e-lan`.
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'https://localhost:8443';
const AUDIO = process.env.AUDIO || '/e2e/sample.wav';
const OUT = process.env.OUT || '/e2e/out';
mkdirSync(OUT, { recursive: true });
const DOCS = `${OUT}/docs`;
mkdirSync(DOCS, { recursive: true });
const step = (m) => console.log(`\n▶ ${m}`);
const USERS = { Anna: 'anna@example.com', Ben: 'ben@example.com', Clara: 'clara@example.com' };

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${AUDIO}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const logs = [];
async function page(name, extra = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'], viewport: { width: 1360, height: 900 }, ...extra });
  const p = await ctx.newPage();
  p.on('console', (m) => logs.push(`[${name}] ${m.type()}: ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`[${name}] PAGEERROR: ${e.message}`));
  return p;
}
async function login(p, name) {
  await p.goto(`${BASE}/`);
  const cfg = await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  if (cfg.auth === 'dev') {
    await p.fill('input[placeholder="Dein Name"]', name);
    await p.click('main button.primary');
  } else {
    await p.click('button:has-text("Anmelden über")');
    await p.fill('input[name="login"]', USERS[name]);
    await p.fill('input[name="password"]', 'password');
    await p.click('button[type="submit"]');
    await p.waitForURL((u) => u.origin === new URL(BASE).origin && !u.search.includes('code='), { timeout: 15_000 });
  }
  await p.waitForSelector('text=Neue Sitzung', { timeout: 15_000 });
  console.log(`  ${name} angemeldet (${cfg.auth})`);
}
async function dismissOnboarding(p) {
  const b = p.locator('button:has-text("Verstanden")');
  if (await b.isVisible().catch(() => false)) await b.click();
}
const lineTexts = (p) => p.$$eval('.transcript .line .text', (els) => els.map((e) => e.textContent));

let ok = false;
try {
  step('Anna startet eine Sitzung');
  const anna = await page('anna');
  await login(anna, 'Anna');
  await anna.screenshot({ path: `${DOCS}/start.png` });
  await anna.fill('input[placeholder^="Worum"]', 'Mesh-Test');
  await anna.click('button:has-text("Starten")');
  await anna.waitForURL(/#\/s\//);
  await dismissOnboarding(anna);
  await anna.click('button:has-text("Leute einladen")');
  const link = await anna.inputValue('.invite input[readonly]');
  await anna.locator('.invite').screenshot({ path: `${DOCS}/einladen.png`, mask: [anna.locator('.invite input[readonly]')], maskColor: '#eadfc8' });
  await anna.fill('input[placeholder^="Nächster Tagesordnungspunkt"]', 'Begrüßung');
  await anna.click('button:has-text("TOP beginnen")');
  console.log(`  Link: ${link.replace(/[^/]+$/, '<schlüssel>')}`);
  console.log(`  Schlüssel aus der Adresszeile entfernt: ${!(await anna.evaluate(() => location.hash)).includes(link.split('/').pop())}`);

  step('Ben tritt bei');
  const ben = await page('ben');
  await login(ben, 'Ben');
  await ben.goto(link);
  await dismissOnboarding(ben);
  await ben.waitForSelector('text=1 weiteres Gerät dabei', { timeout: 20_000 });
  await anna.waitForSelector('text=1 weiteres Gerät dabei', { timeout: 20_000 });
  console.log('  ✓ beide sehen sich');

  step('Ben spricht – Text erscheint bei beiden');
  await ben.waitForSelector('text=Bereit zum Mitschreiben', { timeout: 180_000 });
  await ben.click('button.mic');
  await ben.waitForSelector('.transcript .line', { timeout: 180_000 });
  await ben.click('button.mic');
  await anna.waitForSelector('.transcript .line', { timeout: 20_000 });
  console.log(`  Anna sieht: ${(await lineTexts(anna)).join(' | ')}`);

  step('Anna korrigiert Text und Sprecher, Ben markiert');
  await anna.dblclick('.transcript .line .text >> nth=0');
  await anna.fill('textarea.edit', 'Guten Morgen zusammen!');
  await anna.click('button:has-text("Speichern")');
  await anna.click('.transcript .line .who >> nth=0');
  await anna.fill('input.who-edit', 'Clara Test');
  await anna.press('input.who-edit', 'Enter');
  await ben.waitForSelector('.transcript .line .text:has-text("Guten Morgen zusammen!")', { timeout: 20_000 });
  await ben.waitForSelector('.transcript .line .who:has-text("Clara Test")', { timeout: 20_000 });
  await ben.click('.transcript .line button[title="Zum Prüfen markieren"] >> nth=0');
  await anna.waitForSelector('.transcript .line.flagged', { timeout: 20_000 });
  console.log('  ✓ Korrektur, Sprecherzuordnung und Markierung sind überall angekommen');

  step('Anna fällt aus – Clara (Handy) tritt bei und bekommt alles von Ben');
  await anna.context().close();
  const clara = await page('clara', { ...devices['iPhone 13'], defaultBrowserType: undefined });
  await login(clara, 'Clara');
  await clara.goto(link);
  await clara.waitForSelector('.transcript .line .text:has-text("Guten Morgen zusammen!")', { timeout: 30_000 });
  await clara.waitForSelector('.transcript .line.flagged', { timeout: 10_000 });
  console.log('  ✓ Clara hat das vollständige, korrigierte Protokoll – ohne Anna');
  await ben.waitForSelector('text=Alles gespeichert & gesichert', { timeout: 20_000 });
  console.log('  ✓ Ben sieht: seine Daten liegen jetzt auch vollständig bei Clara');
  await clara.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });
  await clara.evaluate(() => window.scrollTo(0, 0));
  await clara.screenshot({ path: `${DOCS}/handy-start.png` });
  await dismissOnboarding(clara);
  await clara.locator('.transcript').scrollIntoViewIfNeeded();
  await clara.evaluate(() => window.scrollBy(0, -170));
  await clara.screenshot({ path: `${DOCS}/handy-protokoll.png` });
  await dismissOnboarding(ben);
  await ben.screenshot({ path: `${DOCS}/sitzung.png`, fullPage: true });

  step('PDF-Export auf Claras Handy');
  const [dl] = await Promise.all([clara.waitForEvent('download'), clara.click('button:has-text("Protokoll als PDF")')]);
  const path = `${DOCS}/beispiel-protokoll.pdf`;
  await dl.saveAs(path);
  const head = (await import('node:fs')).readFileSync(path).subarray(0, 5).toString();
  if (head !== '%PDF-') throw new Error(`kein PDF: ${head}`);
  console.log(`  ✓ ${dl.suggestedFilename()}`);

  step('Pause gilt für alle');
  await clara.click('button:has-text("Für alle pausieren")');
  await ben.waitForSelector('button.mic:disabled', { timeout: 10_000 });
  console.log('  ✓ Bens Mikro ist gesperrt');
  ok = true;
} catch (e) {
  console.error(`\n✗ ${e.message}`);
} finally {
  const relevant = logs.filter((l) => /error|PAGEERROR/i.test(l));
  writeFileSync(`${OUT}/browser.log`, logs.join('\n'));
  if (relevant.length) console.log(`\nBrowser-Fehler:\n${relevant.slice(0, 30).join('\n')}`);
  await browser.close();
}
console.log(ok ? '\n✅ E2E-Test bestanden' : '\n❌ E2E-Test fehlgeschlagen');
process.exit(ok ? 0 : 1);
