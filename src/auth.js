// Facebook/Messenger login + cookie session persistence.
// Strategy: reuse a saved cookie session whenever possible (headless). Only fall
// back to a real password login when there are no valid cookies, and that path
// requires a visible browser so the human can clear 2FA / checkpoints by hand.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const MESSENGER_URL = 'https://www.messenger.com/';
const LOGIN_URL = 'https://www.messenger.com/login/';
// Login state == chat list is present. NEVER infer from URL — FB bounces through
// /login, /checkpoint/, /two_step_verification/ etc.
const CHATLIST_SELECTOR = '[role="grid"] [role="row"], [role="navigation"] a[href*="/t/"]';
const LOGIN_PROBE_MS = 15000;

// Only these fields round-trip cleanly through browser.setCookie(); extras like
// `size`/`session` that browser.cookies() returns can make setCookie throw.
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // maps to process exit code: 1 bad args, 2 login failed
  }
}

// Single source of truth, used in three places: cookie fast-path, post-login,
// and after the manual 2FA step.
export function isLoggedIn(page) {
  return page
    .waitForSelector(CHATLIST_SELECTOR, { timeout: LOGIN_PROBE_MS })
    .then(() => true)
    .catch(() => false);
}

function loadCookies(out) {
  try {
    const cookies = JSON.parse(fs.readFileSync(out, 'utf8'));
    return Array.isArray(cookies) && cookies.length ? cookies : null;
  } catch {
    return null;
  }
}

async function saveCookies(browser, out) {
  const cookies = await browser.cookies(); // v23+ browser-level API (not page.cookies)
  fs.writeFileSync(out, JSON.stringify(cookies, null, 2));
}

function sanitize(cookie) {
  const clean = {};
  for (const k of COOKIE_FIELDS) {
    if (cookie[k] !== undefined) clean[k] = cookie[k];
  }
  return clean;
}

// Returns true when the page is logged in and ready to scrape. Throws AuthError
// (with an exit code) when it can't get there.
export async function ensureLoggedIn(browser, page, opts) {
  const { username, pass, headful, out, fresh, manual } = opts;

  // ---- fast path: restore cookies BEFORE navigating, else the first request
  //      goes out unauthenticated and we always land on the login wall.
  //      --fresh skips this entirely to force a new login. ----
  const cookies = fresh ? null : loadCookies(out);
  if (fresh) log('--fresh: ignoring saved cookies, logging in again');
  if (cookies) {
    await browser.setCookie(...cookies.map(sanitize));
    await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' });
    if (await isLoggedIn(page)) {
      log('logged in from cookie cache');
      return true;
    }
    log('cookies stale — need to log in again');
  }

  // ---- manual login: open the page, the HUMAN does everything (email,
  //      password, CAPTCHA, 2FA). No automated typing, so nothing looks like a
  //      bot — the most reliable way past FB's login defenses. One time; cookies
  //      are saved and later runs go headless. ----
  if (manual) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    process.stderr.write(
      '\n>> Manual login. In the browser window:\n' +
      '   type your email + password, solve any CAPTCHA / 2FA, and continue\n' +
      '   until your chat list is fully visible. THEN press Enter here.\n\n'
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await rl.question('Press Enter once you see your chats... ');
    rl.close();
    if (await isLoggedIn(page)) {
      await saveCookies(browser, out);
      log('manual login OK, cookies saved');
      return true;
    }
    throw new AuthError('manual login not completed (chat list not detected)', 2);
  }

  // ---- automated password login: needs creds and a visible window for 2FA.
  //      Tends to trip CAPTCHA (instant fill looks robotic) — prefer --manual. ----
  if (!username || !pass) {
    throw new AuthError('no valid cookies and missing --username/--pass', 1);
  }
  if (!headful) {
    throw new AuthError('login required — re-run with --headful (2FA/checkpoint may appear)', 2);
  }

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  // Locator.fill sets the value in one shot — page.type drops characters here
  // because the login form re-renders mid-typing and eats keystrokes.
  await page.locator('input[name="email"]').fill(username);
  await page.locator('input[name="pass"]').fill(pass);
  const btn = await page.$('button[name="login"], button[type="submit"]');
  if (btn) await btn.click();
  else await page.keyboard.press('Enter');
  await sleep(1500);

  if (await isLoggedIn(page)) {
    await saveCookies(browser, out);
    log('logged in, cookies saved');
    return true;
  }

  // 2FA / checkpoint / "Trust this device" — only a human can clear these.
  process.stderr.write(
    '\n>> Action needed in the browser window:\n' +
    '   solve any 2FA / checkpoint, click through "Trust"/"Continue"\n' +
    '   until the chat list is visible, THEN press Enter here.\n\n'
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await rl.question('Press Enter once the chat list shows... ');
  rl.close();

  if (await isLoggedIn(page)) {
    await saveCookies(browser, out);
    log('logged in after manual step, cookies saved');
    return true;
  }
  throw new AuthError('still not logged in after manual step', 2);
}

function log(msg) {
  process.stderr.write(`[auth] ${msg}\n`);
}
