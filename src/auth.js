// Facebook/Messenger login + cookie session persistence.
// Strategy: reuse a saved cookie session whenever possible (headless). Only fall
// back to a real password login when there are no valid cookies, and that path
// requires a visible browser so the human can clear 2FA / checkpoints by hand.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { automatedLogin } from './checkpoints.js';

// messenger.com doesn't share facebook.com's session, so we use the full
// Messenger UI hosted INSIDE Facebook (same domain as login — no SSO bridge).
const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
const LOGIN_URL = 'https://www.facebook.com/login/';
// Login state == chat list is present. NEVER infer from URL — FB bounces through
// /login, /checkpoint/, /two_step_verification/ etc.
const CHATLIST_SELECTOR = '[role="grid"] [role="row"], a[href*="/messages/t/"], [role="navigation"] a[href*="/t/"]';
const LOGIN_PROBE_MS = 30000; // headless renders the chat list slower — be patient before calling cookies stale

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
  const { username, pass, headful, out, fresh, manual, totp } = opts;

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

  // A persistent --profile may already hold a logged-in session (no cookies.json
  // needed) — check before attempting any login. This is the path that avoids
  // repeated reCAPTCHA: log in once into the profile, reuse forever.
  if (!fresh) {
    await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' });
    if (await isLoggedIn(page)) {
      log('already logged in (browser profile session)');
      await saveCookies(browser, out);
      return true;
    }
  }

  // ---- manual login: open the page, the HUMAN does everything (email,
  //      password, CAPTCHA, 2FA). No automated typing, so nothing looks like a
  //      bot — the most reliable way past FB's login defenses. One time; cookies
  //      are saved and later runs go headless. ----
  if (manual) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    process.stderr.write(
      '\n>> Manual login. In the browser window:\n' +
      '   type email + password, solve any reCAPTCHA, enter your 2FA code,\n' +
      '   and if asked, APPROVE the login on your other device/phone.\n' +
      '   Wait until your Facebook News Feed actually loads, THEN press Enter.\n' +
      '   (No rush — it waits up to 2 min for you to finish.)\n\n'
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await rl.question('Press Enter once your Facebook feed is visible... ');
    rl.close();
    if (await finishLogin(browser, page, out)) return true;
    throw new AuthError('manual login not completed (chat list not detected)', 2);
  }

  // ---- automated login: creds + TOTP 2FA + checkpoint passing. ----
  if (!username || !pass) {
    throw new AuthError('no valid cookies and missing --username/--pass', 1);
  }

  const ok = await automatedLogin(page, { username, pass, totpSecret: totp });
  if (ok) {
    await saveCookies(browser, out);
    log('login OK, cookies saved');
    return true;
  }

  // Fallback: if a window is open, let the human finish whatever the automation
  // couldn't pass (reCAPTCHA, unexpected screen).
  if (headful) {
    process.stderr.write(
      '\n>> Automation stalled (likely reCAPTCHA). Finish in the browser window:\n' +
      '   solve the reCAPTCHA / 2FA / checkpoints until you land on Facebook,\n' +
      '   THEN press Enter here.\n\n'
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await rl.question('Press Enter once you are logged in to Facebook... ');
    rl.close();
    if (await finishLogin(browser, page, out)) return true;
  }
  throw new AuthError('login failed (checkpoint not passed — set FB_TOTP, or use --manual)', 2);
}

// Poll the CURRENT page until it reflects a logged-in Facebook session, WITHOUT
// navigating. Navigating early throws away an in-progress login — e.g. while an
// "approve on another device" / 2FA / reCAPTCHA prompt is still pending. Gives
// the human up to 2 minutes to finish (e.g. tap approve on their phone).
async function waitForFacebookLogin(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Check the PATH only — the logged-in home page can carry a
      // ?checkpoint_src=any query param that must not count as a challenge.
      const path = new URL(page.url()).pathname;
      const onChallenge = /login|checkpoint|two_step|recover|authentication/.test(path);
      if (!onChallenge && (await page.$('[role="banner"], [aria-label="Your profile"]'))) {
        return true;
      }
    } catch {
      /* page mid-navigation — retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Once Facebook login has actually completed, open the Messenger inbox inside
// Facebook, confirm the chat list, and persist cookies.
async function finishLogin(browser, page, out) {
  if (!(await waitForFacebookLogin(page))) {
    log('Facebook home not reached — login not completed in time');
    return false;
  }
  await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) {
    await saveCookies(browser, out);
    log('cookies saved');
    return true;
  }
  return false;
}

function log(msg) {
  process.stderr.write(`[auth] ${msg}\n`);
}
