#!/usr/bin/env node
// pptscript --username x --pass y [--headful] [--out cookies.json]
// Logs into Facebook Messenger and prints every conversation (thread) name.
// stdout = thread names only (one per line). All logs/prompts go to stderr,
// so `pptscript ... 2>/dev/null | grep Mom` works.
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

puppeteer.use(StealthPlugin());

// Exit codes: 0 ok · 1 bad args · 2 login/checkpoint failed · 3 scrape empty.
function parse() {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      pass: { type: 'string' },
      headful: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },  // ignore saved cookies, log in again
      manual: { type: 'boolean', default: false }, // you type creds/CAPTCHA/2FA by hand
      out: { type: 'string', default: 'cookies.json' },
    },
  });
  // Prefer env over flags for credentials — keeps the password out of shell
  // history and `ps`. Flags still win if explicitly passed.
  return {
    ...values,
    username: values.username ?? process.env.FB_USER,
    pass: values.pass ?? process.env.FB_PASS,
  };
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

  const browser = await puppeteer.launch({
    headless: !headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await ensureLoggedIn(browser, page, { ...opts, headful });

    const names = await collectThreadNames(page);
    if (names.length === 0) {
      process.stderr.write('[scrape] no rows — run with --headful and re-tune selectors in src/threads.js\n');
      await browser.close();
      process.exit(3);
    }

    for (const name of names) process.stdout.write(name + '\n');
    await browser.close();
  } catch (err) {
    await browser.close().catch(() => {});
    const code = err instanceof AuthError ? err.code : 2;
    process.stderr.write(`[error] ${err.message}\n`);
    process.exit(code);
  }
}

main();
