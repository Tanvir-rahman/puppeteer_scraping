// Automated Facebook/Messenger login with TOTP-based 2FA and checkpoint passing.
// Adapted from the reference loginAndPassCheckpoints.txt to Puppeteer +
// totp-generator v2 (async `TOTP.generate`). FB removed mbasic, so this runs on
// the messenger.com login form and passes checkpoints with a generic loop:
// enter the 2FA code (from your authenticator secret), then click through
// "Continue"/"Trust this device"/"Save"/etc. until the chat list appears.
import { TOTP } from 'totp-generator';
import { setTimeout as sleep } from 'node:timers/promises';

// messenger.com/login redirects to facebook.com and messenger.com doesn't share
// the facebook.com session — so we log in on facebook.com AND read messages from
// facebook.com/messages (the full Messenger UI inside Facebook). One domain.
const FB_LOGIN_URL = 'https://www.facebook.com/login/';
const MESSAGES_URL = 'https://www.facebook.com/messages/t/';
const CHATLIST = '[role="grid"] [role="row"], a[href*="/messages/t/"], [role="navigation"] a[href*="/t/"]';
// 2FA code field — FB has used several over time; try them all.
const CODE_INPUTS = [
  'input[name="approvals_code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
];
// Buttons that advance a checkpoint. Order-independent; matched case-insensitively
// against trimmed text. "not now"/"don't save" dismiss optional upsells.
const CONTINUE_TEXT = "^(continue|submit|trust this device|this was me|yes,? continue|save|ok|continue as .*|not now|don.?t save)$";
// FB now front-loads a passkey/biometric prompt ("Use face scan, fingerprint…")
// BEFORE the authenticator field. Its "Continue" tries to use a passkey we don't
// have (headless). With a TOTP secret we route around it: click "Try another way",
// then pick the authenticator-app option, which finally reveals the code input.
const TRY_ANOTHER_WAY = "^try another way$";
const AUTH_APP_OPTION = "(authentication app|code generator|authenticator app|security code is generated|use your authenticator)";

const log = (m) => process.stderr.write(`[login] ${m}\n`);
const loggedIn = (page, ms = 6000) =>
  page.waitForSelector(CHATLIST, { timeout: ms }).then(() => true).catch(() => false);

// Debug: if PPT_DEBUG_DIR is set, dump a screenshot + the page title/url so we
// can see exactly where a login attempt landed.
async function shot(page, name) {
  const dir = process.env.PPT_DEBUG_DIR;
  if (!dir) return;
  try {
    await page.screenshot({ path: `${dir}/${name}.png` });
    log(`[debug] ${name}: "${await page.title()}" ${page.url()}`);
  } catch (e) {
    log(`[debug] shot ${name} failed: ${e.message}`);
  }
}

async function fillLogin(page, username, pass) {
  await page.waitForSelector('input[name="email"]', { timeout: 20000 });
  // Locator.fill sets the value in one shot — page.type drops characters because
  // the form re-renders mid-typing.
  await page.locator('input[name="email"]').fill(username);
  await page.locator('input[name="pass"]').fill(pass);
  const btn = await page.$('button[name="login"], button[type="submit"]');
  if (btn) await btn.click();
  else await page.keyboard.press('Enter');
}

async function fillTotp(page, secret) {
  if (!secret) return false;
  for (const sel of CODE_INPUTS) {
    const el = await page.$(sel);
    if (!el) continue;
    const { otp } = await TOTP.generate(secret.replace(/[\s-]/g, ''));
    await el.click({ clickCount: 3 }); // select any existing text
    await el.type(otp, { delay: 60 });
    log('entered 2FA code');
    return true;
  }
  return false;
}

// Logged into Facebook == the top blue bar / profile control is present (these
// don't exist on login, checkpoint, or loading-splash pages).
const fbHome = (page) =>
  page.$('[role="banner"], [aria-label="Your profile"], a[href="/messages/"]').then((h) => !!h);

// Click the first visible button/link whose trimmed text matches reSrc (case-i).
async function clickButton(page, reSrc) {
  const handle = await page.evaluateHandle((src) => {
    const re = new RegExp(src, 'i');
    const els = [...document.querySelectorAll('div[role="button"], button, input[type="submit"], a[role="button"], [role="link"]')];
    return els.find((e) => {
      const t = (e.textContent || e.value || '').trim();
      return re.test(t) && e.offsetParent !== null;
    }) || null;
  }, reSrc);
  const el = handle.asElement();
  if (!el) return false;
  const label = await el.evaluate((e) => (e.textContent || e.value || '').trim());
  await el.click();
  log(`clicked "${label}"`);
  return true;
}

const clickContinue = (page) => clickButton(page, CONTINUE_TEXT);

async function hasCodeInput(page) {
  for (const sel of CODE_INPUTS) {
    if (await page.$(sel)) return true;
  }
  return false;
}

// Which actionable step (if any) is currently on screen.
async function currentStep(page) {
  for (const sel of CODE_INPUTS) {
    if (await page.$(sel)) return 'code';
  }
  if (await page.$('input[name="pass"]')) return 'login';
  const hasContinue = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    return [...document.querySelectorAll('div[role="button"], button, input[type="submit"]')]
      .some((e) => re.test((e.textContent || e.value || '').trim()) && e.offsetParent !== null);
  }, CONTINUE_TEXT);
  return hasContinue ? 'continue' : 'none';
}

// Logs into facebook.com (creds + TOTP 2FA + checkpoints), then bridges to
// messenger.com. Returns true once the Messenger chat list is reachable.
export async function automatedLogin(page, { username, pass, totpSecret }, maxRounds = 10) {
  await page.goto(FB_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await shot(page, '1-fb-login');
  await fillLogin(page, username, pass);
  await sleep(3000);
  await shot(page, '2-after-submit');

  // Pass Facebook's post-login checkpoints. A 'none' step is usually just the
  // Meta loading splash between pages — wait it out, don't bail. Exit when the
  // Facebook home chrome appears, a reCAPTCHA blocks us, or rounds run out.
  let twoFaNavs = 0; // cap "Try another way" clicks so a chooser loop can't spin
  for (let round = 0; round < maxRounds; round++) {
    try {
      if (await fbHome(page)) {
        log(`facebook home reached after ${round} round(s)`);
        break;
      }
      // reCAPTCHA can't be auto-solved — stop so the caller can hand off to a human.
      if (await page.$('iframe[src*="recaptcha"], iframe[title*="recaptcha" i], div.g-recaptcha')) {
        log('reCAPTCHA detected — automation cannot pass this; finish in the window');
        return false;
      }
      // 2FA routing: FB shows a passkey prompt first whose "Continue" we must NOT
      // click (it invokes a passkey we don't have). With a TOTP secret and no code
      // field yet, steer to the code: prefer the authenticator-app option if it's
      // on screen; otherwise click "Try another way" to reveal the method list.
      // Order matters — the method list ALSO has a "Try another way" (would loop).
      if (totpSecret && !(await hasCodeInput(page))) {
        await shot(page, `r${round}-2fa`);
        // The chooser is a list of custom-rendered rows (no real <input>/role=radio).
        // Return an element handle for the VISIBLY-SIZED row (filter out hidden zero-
        // rect duplicates) that holds both the title and its description, then use
        // Puppeteer's elementHandle.click() — it scrolls in and clicks the real
        // center. Then Continue. Capped so a non-advancing chooser can't spin forever.
        const handle = await page.evaluateHandle(() => {
          const titleRe = /authentication app/i;
          const descRe = /get a code from your authentication/i;
          const sized = [...document.querySelectorAll('div, label, li')]
            .filter((e) => titleRe.test(e.textContent || '') && descRe.test(e.textContent || ''))
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 120 && r.height > 28 && r.height < 130;
            })
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
          return sized[0] || null;
        });
        const row = handle.asElement();
        // If we've already tried the auth-app route twice and we're STILL on the
        // chooser, FB is refusing to advance under automation. Stop clicking — every
        // extra Continue can fire a passkey/WebAuthn OS prompt that freezes the tab
        // and fights the human. Break so the caller hands an INTERACTIVE page over.
        if (row && twoFaNavs >= 1) {
          log('2FA chooser will not advance under automation — stopping auto-clicks so you can finish by hand');
          break;
        }
        if (row && twoFaNavs < 1) {
          twoFaNavs++;
          await row.click();
          await sleep(700);
          // Submit via the REAL bottom button: the WIDEST visible element whose text
          // is exactly "Continue" (the full-width blue bar), not the first text match
          // (which can be a wrapper/stale button and miss the real click target).
          const contHandle = await page.evaluateHandle(() => {
            const cands = [...document.querySelectorAll('div[role="button"], button')]
              .filter((e) => /^continue$/i.test((e.textContent || '').trim()) && e.offsetParent !== null);
            cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            return cands[0] || null;
          });
          const cont = contHandle.asElement();
          if (cont) {
            const w = await cont.evaluate((e) => Math.round(e.getBoundingClientRect().width));
            // FB rejects a scripted mouse-click on this 2FA submit (a human's works).
            // Try keyboard activation too: focus the tab, focus the button, press
            // Enter, then also click — whichever FB honors advances to the code field.
            await page.bringToFront().catch(() => {});
            await cont.focus().catch(() => {});
            await page.keyboard.press('Enter').catch(() => {});
            await sleep(500);
            await cont.click().catch(() => {});
            log(`selected "Authentication app" → submitted Continue (w=${w})`);
          } else {
            log('selected "Authentication app" but no Continue button found');
          }
          await sleep(2800);
          await shot(page, `r${round}-postcont`);
          log(`post-continue url=${page.url()} hasCode=${await hasCodeInput(page)}`);
          continue;
        }
        // Passkey prompt (no list yet) — reveal the list with "Try another way".
        if (twoFaNavs < 2 && (await clickButton(page, TRY_ANOTHER_WAY))) {
          twoFaNavs++;
          log('passkey prompt — clicked "Try another way"');
          await sleep(2500);
          continue;
        }
      }
      const step = await currentStep(page);
      log(`round ${round}: step=${step} url=${page.url()}`);
      await shot(page, `r${round}-${step}`);
      if (step === 'login') {
        log('login form — entering credentials');
        await fillLogin(page, username, pass);
      } else if (step === 'code') {
        const ok = await fillTotp(page, totpSecret);
        if (!ok) log('2FA code page but no FB_TOTP set — set it or finish in the window');
        await sleep(600);
        await clickContinue(page);
      } else if (step === 'continue') {
        await clickContinue(page);
      } else {
        log('loading / unknown page — waiting');
      }
    } catch (e) {
      // page navigated mid-step (frame detached) — just retry next round.
      log(`round ${round}: transient (${e.message.slice(0, 60)})`);
    }
    await sleep(3000);
  }

  await shot(page, '3-after-fb-checkpoints');

  // Only bridge to the inbox if Facebook login actually completed. If we're
  // still on a checkpoint (reCAPTCHA, "approve on another device", 2FA), DON'T
  // navigate away — that throws the pending login out. Hand back to the caller
  // so a human can finish it.
  if (!(await fbHome(page))) {
    log('still on a checkpoint — not logged in, handing back');
    return false;
  }
  log('opening facebook.com/messages');
  await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await shot(page, '4-fb-messages');
  return loggedIn(page, 15000);
}
