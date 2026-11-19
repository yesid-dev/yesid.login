import type { Browser, Page } from 'playwright-core';
import { resolve } from 'node:path';
import { LEGAL_UPDATED } from '../login/legal/copy.ts';
import { copy } from '../login/copy.ts';

type Check = (name: string, passed: boolean, detail?: string) => void;
const members = Array.from({ length: 25 }, (_, i) => ({ id: `layout-${i}`, email: `person-${i + 1}@example.test`, role: 'employee', status: 'active', lastEdit: null }));

async function fits(page: Page, name: string, check: Check) {
  check(`layouts reflow ${name}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function brand(page: Page, name: string, check: Check) {
  const clusters = page.locator('[data-slot="product-brand"]');
  check(`layouts public brand in header and footer ${name}`, await clusters.count() === 2);
  const footer = page.getByTestId('footer');
  const house = footer.getByRole('link', { name: /^yesid/ });
  const product = footer.getByRole('link', { name: 'login', exact: true });
  const sizes = [await house.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), await product.evaluate(el => parseFloat(getComputedStyle(el).fontSize))];
  check(`layouts retained footer sizes ${name}`, sizes[0] === 18 && sizes[1] === 24, JSON.stringify(sizes));
  const geometry = await footer.locator('[data-slot="product-brand"]').evaluate(el => {
    const divider = el.querySelector(':scope > [aria-hidden="true"]')!.getBoundingClientRect();
    return { divider: divider.height, gap: parseFloat(getComputedStyle(el).columnGap) };
  });
  check(`layouts footer divider and gap ${name}`, geometry.divider === 18 && geometry.gap === 8, JSON.stringify(geometry));
  check(`layouts footer lowercase name ${name}`, await product.innerText() === 'login');
  // DEV-43: footer tops use the kit hazard strip, not the street edge.
  check(`layouts footer top is the hazard strip ${name}`, await footer.locator('[data-slot="footer-hazard-edge"]').count() === 1 && await footer.locator('[data-slot="footer-street-edge"]').count() === 0);

  for (const cluster of await clusters.all()) {
    const links = cluster.getByRole('link');
    check(`layouts brand destinations ${name}`, await links.first().getAttribute('href') === 'https://yesid.dev'
      && await links.last().getAttribute('href') === '/?lang=' + await page.locator('html').getAttribute('lang')
      && await links.first().getAttribute('target') === '_blank' && (await links.first().getAttribute('rel'))?.includes('noopener') === true);
    check(`layouts brand targets ${name}`, await links.evaluateAll(nodes => nodes.every(node => { const r = node.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })));
    await links.last().focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    check(`layouts brand keyboard outline ${name}`, await links.last().evaluate(node => {
      const s = getComputedStyle(node); return node === document.activeElement && node.matches(':focus-visible') && parseFloat(s.outlineWidth) >= 2 && s.outlineStyle !== 'none';
    }));
  }
  if (name.endsWith('/768')) {
    await page.emulateMedia({ forcedColors: 'active' });
    for (const cluster of await clusters.all()) {
      const link = cluster.getByRole('link').last();
      await link.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      check(`layouts forced-colors focus ${name}`, await link.evaluate(el => getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 2));
    }
    await page.emulateMedia({ forcedColors: 'none' });
    check(`layouts reduced motion still ${name}`, await page.evaluate(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations !== Infinity)));
  }
}

type Fixture = { page: Page; origin: string; shots: string; lang: keyof typeof copy; theme: 'light' | 'dark'; width: number; name: string; check: Check };
async function task({ page, origin, shots, lang, theme, width, name, check }: Fixture) {
  await page.goto(`${origin}/?lang=${lang}`); await page.locator('#email').waitFor();
  check(`layouts heading first ${name}`, await page.locator('main').evaluate(el => el.firstElementChild?.tagName === 'H1'));
  check(`layouts plain localized step ${name}`, await page.getByText(copy[lang].step1, { exact: true }).evaluate(el => getComputedStyle(el).textTransform === 'none'));
  check(`layouts one task surface ${name}`, await page.locator('main [data-slot="card"]').count() === 1);
  check(`layouts nearby privacy ${name}`, await page.locator('main a[href^="mailto:"]').count() === 1 && await page.locator('main a[href^="/legal/privacy"]').count() === 1);
  check(`layouts expressive scene below task ${name}`, await page.locator('[data-register="expressive"]').evaluate(el => {
    const r = el.getBoundingClientRect(), main = document.querySelector('main')!.getBoundingClientRect();
    return r.top >= main.bottom && [...el.querySelectorAll('[data-construction-prop]')].every(prop => { const p = prop.getBoundingClientRect(); return p.top >= r.top - 1 && p.bottom <= r.bottom + 1 && p.left >= r.left - 1 && p.right <= r.right + 1; });
  }));
  await brand(page, name, check); await fits(page, name, check);
  if (width === 320) {
    // A longer local-fixture label exercises the real public component's wrapping, not product copy.
    for (const product of await page.locator('[data-slot="product-brand-name"]').all()) {
      const label = await product.innerText();
      await product.evaluate(el => { el.textContent = 'Local fixture longer product name'; });
      check(`layouts public brand wraps ${name}`, await product.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return new Set([...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top))).size > 1;
      }));
      await fits(page, name + ' longer brand', check);
      await product.evaluate((el, text) => { el.textContent = text; }, label);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await fits(page, name + ' enlarged text', check);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    // WCAG 1.4.12: reader text spacing wraps the button instead of pushing the form past its card.
    const spacing = await page.addStyleTag({ content: '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}' });
    check(`layouts text spacing keeps the form inside its card ${name}`, await page.locator('.form-card').first().evaluate(card => {
      const c = card.getBoundingClientRect();
      return card.scrollWidth <= card.clientWidth && [...card.querySelectorAll('label, input, button')].every(el => { const r = el.getBoundingClientRect(); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5; });
    }));
    await fits(page, name + ' text spacing', check);
    await spacing.evaluate(el => (el as Element).remove());
  }

  if (lang === 'en' && width === 390) await page.screenshot({ path: resolve(shots, `L-M1-${theme}.png`), fullPage: true });
  await page.route('**/auth/api/email-otp/send-verification-otp', route => route.fulfill({ json: {} }));
  await page.locator('#email').fill('person@example.test'); await page.locator('form button').click(); await page.locator('#code').waitFor();
  check(`layouts code heading first ${name}`, await page.locator('main').evaluate(el => el.firstElementChild?.tagName === 'H1'));
  if (lang === 'en' && width === 390) await page.screenshot({ path: resolve(shots, `L-M2-${theme}.png`), fullPage: true });
}

async function people({ page, origin, shots, lang, theme, width, name, check }: Fixture) {
  await page.evaluate(() => localStorage.setItem('login.session.example', JSON.stringify({ token: 'local-layout-fixture' })));
  await page.route('**/auth/sites', route => route.fulfill({ json: [{ slug: 'example', label: 'Example' }] }));
  await page.route('**/example/people/members', route => route.fulfill({ json: members }));
  await page.goto(`${origin}/example/people?lang=${lang}`); await page.locator('#email').waitFor();
  const rows = page.getByRole('main').getByRole('listitem');
  check(`layouts 25 native rows ${name}`, await rows.count() === 25);
  check(`layouts one member list surface ${name}`, await rows.first().evaluate(el => !!el.closest('[data-slot="card"]') && !el.querySelector('[data-slot="card"]')));
  check(`layouts list before add in DOM ${name}`, await rows.first().evaluate(el => !!(el.compareDocumentPosition(document.querySelector('#email')!) & Node.DOCUMENT_POSITION_FOLLOWING)));
  if (width < 1024) check(`layouts list before add visually ${name}`, await rows.first().evaluate(el => el.getBoundingClientRect().top < document.querySelector('#email')!.getBoundingClientRect().top));
  await rows.first().getByRole('button').last().focus();
  for (let i = 1; i < 25; i++) {
    await page.keyboard.press('Tab');
    check(`layouts native row focus order ${name}/${i}`, await rows.nth(i).getByRole('button').last().evaluate(el => el === document.activeElement));
  }
  await page.keyboard.press('Tab');
  check(`layouts add follows rows in focus order ${name}`, await page.locator('#email').evaluate(el => el === document.activeElement));
  const remove = rows.last().getByRole('button').last(); await remove.click();
  const question = rows.last().getByRole('group');
  check(`layouts inline question focus ${name}`, await question.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  check(`layouts cancel returns focus ${name}`, await remove.evaluate(el => el === document.activeElement));
  await fits(page, name + ' people', check);
  if (lang === 'en' && width === 390) { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: resolve(shots, `L-M3-${theme}.png`), fullPage: true }); }
}

async function reading({ page, origin, shots, lang, theme, width, name, check }: Fixture) {
  await page.route('**/auth/api/get-session', route => route.fulfill({ json: { session: {}, user: { id: 'layout-user', email: 'person@example.test' } } }));
  await page.route('**/account', route => route.request().headers().authorization ? route.fulfill({ json: {} }) : route.continue());
  await page.goto(`${origin}/account?site=example&lang=${lang}`); await page.locator('#email:enabled').waitFor();
  check(`layouts account bounded ${name}`, await page.locator('main').evaluate(el => el.getBoundingClientRect().width <= 448.5));
  await fits(page, name + ' account', check);
  if (lang === 'en' && width === 390) await page.screenshot({ path: resolve(shots, `L-M4-${theme}.png`), fullPage: true });
  await page.goto(`${origin}/legal/privacy?lang=${lang}#contact`); await page.locator('[data-slot="reading-frame"]').waitFor();
  check(`layouts public reading frame ${name}`, await page.locator('[data-slot="reading-frame"]').count() === 1);
  check(`layouts real legal date ${name}`, await page.locator('main time').getAttribute('datetime') === LEGAL_UPDATED);
  check(`layouts legal fragment retained ${name}`, await page.locator('#contact').count() === 1 && new URL(page.url()).hash === '#contact');
  await fits(page, name + ' legal', check);
}

/** Real callers with local replies only: no email, production session or privileged write. */
export async function brandLayouts(browser: Browser, origin: string, shots: string, check: Check) {
  for (const lang of ['en', 'fr', 'es'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [320, 390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: width === 768 ? 'reduce' : 'no-preference' });
    try {
      const page = await context.newPage(), name = `${lang}/${theme}/${width}`;
      const fixture = { page, origin, shots, lang, theme, width, name, check };
      await task(fixture); await people(fixture); await reading(fixture);
    } finally { await context.close(); }
  }
}
