#!/usr/bin/env node
// fb-scraper --username x --pass y [--headful] [--out cookies.json]
// Logs into Facebook Messenger and prints every conversation (thread) name.
// stdout = thread names only (one per line). All logs/prompts go to stderr,
// so `fb-scraper ... 2>/dev/null | grep Mom` works.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { ensureLoggedIn, AuthError } from './auth.js';
import { collectThreadNames } from './threads.js';

// Auto-load .env (CWD) and make it AUTHORITATIVE for creds. loadEnvFile won't
// overwrite a var that's already in the environment, so a stale `export FB_PASS=`
// in the user's shell would silently shadow an edited .env (and a node child
// can't unset the parent shell). Work around it: snapshot the shell values, drop
// the keys so .env can set them, then restore the shell value only if .env had none.
// Farm mode (PPT_FARM=1): the orchestrator passes per-account creds via the child
// env and they are AUTHORITATIVE — skip .env entirely so a stray root .env can't
// shadow account B with account A's credentials. Creds go via env, not argv, so
// they don't leak into `ps` across 200+ spawns.
if (process.env.PPT_FARM !== '1') {
  const _shell = { FB_USER: process.env.FB_USER, FB_PASS: process.env.FB_PASS };
  delete process.env.FB_USER;
  delete process.env.FB_PASS;
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env — rely on shell env / flags */
  }
  process.env.FB_USER ??= _shell.FB_USER;
  process.env.FB_PASS ??= _shell.FB_PASS;
}

puppeteer.use(StealthPlugin());

// Exit codes: 0 ok · 1 bad args · 2 login/checkpoint failed · 3 scrape empty.
function parse() {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      pass: { type: 'string' },
      totp: { type: 'string' }, // TOTP/2FA secret (or $FB_TOTP) for auto 2FA
      profile: { type: 'string' }, // persistent browser profile dir (or $FB_PROFILE)
      proxy: { type: 'string' }, // per-account proxy URL (or $FB_PROXY): http://user:pass@host:port
      headful: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },  // ignore saved cookies, log in again
      manual: { type: 'boolean', default: false }, // you type creds/CAPTCHA/2FA by hand
      out: { type: 'string', default: 'cookies.json' },
      json: { type: 'string' }, // also write the scraped names + meta to this JSON file
    },
  });
  // Prefer env over flags for credentials — keeps the password out of shell
  // history and `ps`. Flags still win if explicitly passed.
  return {
    ...values,
    username: values.username ?? process.env.FB_USER,
    pass: values.pass ?? process.env.FB_PASS,
    totp: values.totp ?? process.env.FB_TOTP,
  };
}

// Tear the browser down for real: a stuck FB page can make browser.close() hang
// forever, which leaves Chrome alive holding the --profile lock (→ corruption next
// run). Race close() against a timeout, then SIGKILL the Chrome process regardless.
async function shutdown(browser) {
  try {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
  } catch {
    /* close threw — fall through to the hard kill */
  }
  try {
    browser.process()?.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

async function main() {
  let opts;
  try {
    opts = parse();
  } catch (err) {
    process.stderr.write(`[args] ${err.message}\n`);
    process.exit(1);
  }

  // First login needs a visible window (2FA); a valid cookie cache lets us go
  // headless. So: headful if explicitly asked, on a forced --fresh re-login, OR
  // when no cache exists yet.
  const headful = opts.headful || opts.fresh || opts.manual || !fs.existsSync(opts.out);

  // A persistent profile dir keeps the whole browser session + device trust, so
  // once you log in (solving any reCAPTCHA once), Facebook stops challenging it.
  const profile = opts.profile ?? process.env.FB_PROFILE;

  // Per-account proxy. One sticky IP per account is the point — never share an IP
  // across accounts, that's the fastest way to get a whole batch flagged. URL form
  // http://user:pass@host:port; auth (if any) is applied per-page below.
  const proxyUrl = opts.proxy ?? process.env.FB_PROXY;
  let proxyAuth = null;
  // Tall window so FB's 2FA "Choose a way to confirm" modal fits — its Continue
  // button sits below an 900px fold and FB locks page scroll, so a short viewport
  // strands it off-screen for both the automation AND a human taking over.
  const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,1696'];
  if (proxyUrl) {
    let u;
    try {
      u = new URL(proxyUrl);
    } catch {
      process.stderr.write(`[args] bad --proxy URL: ${proxyUrl}\n`);
      process.exit(1);
    }
    args.push(`--proxy-server=${u.protocol}//${u.host}`); // host = host:port
    if (u.username) proxyAuth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  }

  const browser = await puppeteer.launch({
    headless: !headful,
    userDataDir: profile || undefined,
    // headful: defaultViewport null = page fills the real window, so it scrolls like
    // a normal browser and you can reach anything. headless: force a tall viewport so
    // off-fold buttons (the 2FA Continue) still render in-view for the auto-clicker.
    defaultViewport: headful ? null : { width: 1280, height: 1696 },
    args,
  });

  // Hard ceiling on the whole run: a hung scrape would otherwise never reach the
  // close() below, leaving Chrome alive on the profile lock. When it fires we tear
  // the browser down and exit non-zero so nothing lingers (override: $PPT_MAX_RUN_MS).
  const watchdog = setTimeout(async () => {
    process.stderr.write('[watchdog] run exceeded time limit — forcing teardown\n');
    await shutdown(browser);
    process.exit(2);
  }, Number(process.env.PPT_MAX_RUN_MS || 240000));

  try {
    const page = await browser.newPage();
    if (proxyAuth) await page.authenticate(proxyAuth); // proxy creds can't ride in --proxy-server

    await ensureLoggedIn(browser, page, { ...opts, headful });

    const names = await collectThreadNames(page);
    if (names.length === 0) {
      process.stderr.write('[scrape] no rows — run with --headful and re-tune selectors in src/threads.js\n');
      clearTimeout(watchdog);
      await shutdown(browser);
      process.exit(3);
    }

    for (const name of names) process.stdout.write(name + '\n');
    // --json: persist the run result alongside the stdout stream (stdout stays
    // names-only so pipes keep working; the file gets names + count + timestamp).
    if (opts.json) {
      const result = { username: opts.username ?? null, threadCount: names.length, names, scrapedAt: new Date().toISOString() };
      fs.writeFileSync(opts.json, JSON.stringify(result, null, 2));
      process.stderr.write(`[out] wrote ${names.length} names to ${opts.json}\n`);
    }
    clearTimeout(watchdog);
    await shutdown(browser);
  } catch (err) {
    clearTimeout(watchdog);
    await shutdown(browser);
    const code = err instanceof AuthError ? err.code : 2;
    process.stderr.write(`[error] ${err.message}\n`);
    process.exit(code);
  }
}

main();
