// End-to-End-Smoke-Test: zwei Browser (Host + Teilnehmer), Fake-Mikrofon mit
// synthetischer Sprache, Whisper im Browser, verschlüsselte Übertragung.
// Aufruf über `make e2e` (läuft im Playwright-Container, Server muss mit `make run` laufen).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://localhost:8443';
const AUDIO = process.env.AUDIO || '/e2e/sample.wav';
const step = (m) => console.log(`\n▶ ${m}`);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${AUDIO}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const opts = { ignoreHTTPSErrors: true, permissions: ['microphone'] };
const logs = [];
async function page(name) {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.on('console', (m) => logs.push(`[${name}] ${m.type()}: ${m.text()}`));
  p.on('pageerror', (e) => logs.push(`[${name}] PAGEERROR: ${e.message}`));
  return p;
}
const USERS = { Moderation: 'moderation@example.com', Anna: 'anna@example.com' };
async function devLogin(p, name) {
  await p.goto(`${BASE}/`);
  const cfg = await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  if (cfg.auth === 'dev') {
    await p.fill('input[placeholder="Dein Name"]', name);
    await p.click('button:has-text("Weiter")');
    return;
  }
  // OIDC über Dex: Login-Formular ausfüllen, zurück zu Ohrwurm
  await p.click('button:has-text("Anmelden über")');
  await p.fill('input[name="login"]', USERS[name]);
  await p.fill('input[name="password"]', 'password');
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => u.origin === new URL(BASE).origin && !u.search.includes('code='), { timeout: 15_000 });
  await p.waitForSelector('text=Neue Sitzung leiten', { timeout: 15_000 });
  console.log(`  OIDC-Login ${USERS[name]} ✓`);
}

let ok = false;
try {
  step('Host meldet sich an und startet eine Sitzung');
  const host = await page('host');
  await devLogin(host, 'Moderation');
  await host.fill('input[placeholder^="Titel"]', 'Smoke-Test');
  await host.click('button:has-text("Sitzung starten")');
  await host.waitForURL(/#\/host\//);
  const link = await host.inputValue('input[readonly]');
  console.log(`  Einladungslink: ${link}`);
  console.log(`  crossOriginIsolated: ${await host.evaluate(() => crossOriginIsolated)}`);

  step('Teilnehmerin tritt bei und prüft den Host-Schlüssel');
  const anna = await page('anna');
  await devLogin(anna, 'Anna');
  await anna.goto(link);
  await anna.waitForSelector('text=Host-Schlüssel geprüft', { timeout: 15_000 });
  await host.waitForSelector('text=1 Geräte online', { timeout: 15_000 });
  console.log('  ✓ Fingerprint passt, Host sieht das Gerät');
  if ((await host.evaluate(() => fetch('/api/config').then((r) => r.json()))).auth === 'oidc') {
    await host.waitForSelector('text=IdP-geprüft', { timeout: 15_000 });
    console.log('  ✓ Host hat das ID-Token der Teilnehmerin selbst gegen Dex geprüft');
  }

  step('Whisper-Modell lädt im Browser');
  await anna.waitForSelector('text=Spracherkennung bereit', { timeout: 180_000 });
  console.log(`  ${await anna.textContent('.micpanel .small:last-child')}`);

  step('Mikrofon an – Fake-Audio wird lokal transkribiert');
  await anna.click('button.mic');
  await anna.waitForSelector('text=✓ beim Host gespeichert', { timeout: 180_000 });
  await anna.click('button.mic');
  const mine = await anna.$$eval('.item', (els) => els.map((e) => e.textContent));
  console.log(`  Teilnehmerin: ${mine.join(' | ')}`);

  step('Host hat den entschlüsselten Text im Protokoll');
  await host.waitForSelector('.transcript .line', { timeout: 15_000 });
  const lines = await host.$$eval('.transcript .line', (els) => els.map((e) => e.textContent));
  console.log(`  Host: ${lines.join(' | ')}`);
  if (!lines.length) throw new Error('kein Protokolleintrag beim Host');

  step('Host pausiert das Protokoll → Teilnehmer-Mikrofon gesperrt');
  await host.click('button:has-text("Protokoll für alle pausieren")');
  await anna.waitForSelector('button.mic:disabled', { timeout: 10_000 });
  console.log('  ✓ gesperrt');

  step('Markdown-Export');
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('button:has-text("Protokoll (Markdown)")')]);
  console.log(`  ✓ ${dl.suggestedFilename()}`);
  ok = true;
} catch (e) {
  console.error(`\n✗ ${e.message}`);
} finally {
  const relevant = logs.filter((l) => /error|PAGEERROR|warn/i.test(l));
  if (relevant.length) console.log(`\nBrowser-Meldungen:\n${relevant.slice(0, 40).join('\n')}`);
  await browser.close();
}
console.log(ok ? '\n✅ E2E-Smoke-Test bestanden' : '\n❌ E2E-Smoke-Test fehlgeschlagen');
process.exit(ok ? 0 : 1);
