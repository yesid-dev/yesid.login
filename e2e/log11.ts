import type { Page } from 'playwright-core';
type Check = (name: string, passed: boolean, detail?: string) => void;

/** LOG-11 changes presentation only; S-1/S-5, S-17 and A-1 proofs remain unchanged. */
export async function log11Chrome(page: Page, name: string, check: Check) {
  const pill = page.getByTestId('nav-pill');
  check(`LOG-11 no menu control ${name}`, await page.getByTestId('nav-menu-toggle').count() === 0
    && await page.getByRole('button', { name: 'Menu', exact: true }).count() === 0);
  check(`LOG-11 house and product brand ${name}`, await pill.getByRole('link', { name: /^yesid\s*\.$/ }).isVisible()
    && await pill.getByRole('link', { name: 'Login', exact: true }).isVisible(), await pill.ariaSnapshot());
  const geometry = await pill.evaluate(el => {
    const box = el.getBoundingClientRect();
    const divider = el.querySelector('.brand-divider')!;
    const d = divider.getBoundingClientRect();
    const controls = [...el.querySelectorAll('[data-slot="theme-toggle"], [data-slot="language-toggle"]')];
    return { fits: box.left >= 0 && box.right <= innerWidth, divider: d.width > 0 && d.height > 0
      && getComputedStyle(divider).backgroundColor !== 'rgba(0, 0, 0, 0)',
      controls: controls.length === 2 && controls.every(control => {
        const r = control.getBoundingClientRect();
        return r.width >= 44 && r.height >= 44 && r.left >= box.left && r.right <= box.right;
      }), unlabeled: [...el.querySelectorAll('.fallback-control-label')].every(label => getComputedStyle(label).display === 'none') };
  });
  check(`LOG-11 divider and navbar controls fit ${name}`, geometry.fits && geometry.divider && geometry.controls && geometry.unlabeled, JSON.stringify(geometry));
  const language = page.getByTestId('language-toggle');
  const lang = await page.locator('html').getAttribute('lang') as 'en' | 'fr' | 'es';
  check(`LOG-11 language spoken by name ${name}`, (await language.getAttribute('aria-label'))!.includes({ en: 'English', fr: 'Français', es: 'Español' }[lang]));
  const moving = await pill.locator('[data-slot="wordmark"]').evaluateAll(nodes => nodes.flatMap(node => [node, ...node.querySelectorAll('*')]).some(node => node.getAnimations().some(a => a.playState === 'running')));
  check(`LOG-11 wordmark still with motion allowed ${name}`, !moving && await page.evaluate(() => matchMedia('(prefers-reduced-motion: no-preference)').matches));
}

export async function log11Error(page: Page, name: string, check: Check) {
  const error = page.locator('[data-slot="error-page"]');
  if (!await error.count()) return;
  const heading = await error.getByRole('heading', { level: 1 }).innerText();
  check(`LOG-11 error navigation named by heading ${name}`, await error.getByRole('navigation', { name: heading, exact: true }).count() === 1);
  check(`LOG-11 error starts quietly ${name}`, await error.getByTestId('hazard-tape').count() === 0 && await error.getByTestId('error-label').count() === 0);
  check(`LOG-11 recovery precedes illustration ${name}`, await error.evaluate(el => {
    const nav = el.querySelector('nav')!, scene = el.querySelector('.error-illustration')!;
    return !!(nav.compareDocumentPosition(scene) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
}

export async function log11Links(page: Page, name: string, check: Check) {
  const failures = await page.locator('main a:not([class]), .legal-toc a, [data-heading-anchor]').evaluateAll(nodes => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
    const rgb = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const luminance = (c: number[]) => c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
    return nodes.flatMap(node => {
      if (!node.getBoundingClientRect().width) return [];
      const style = getComputedStyle(node), ink = rgb(style.color);
      const probe = document.createElement('span'); probe.style.color = 'var(--primary)'; node.appendChild(probe);
      const orange = rgb(getComputedStyle(probe).color); probe.remove();
      let parent: Element | null = node, bg: number[] = [];
      while (parent) { bg = rgb(getComputedStyle(parent).backgroundColor); if (bg[3] === 255) break; parent = parent.parentElement; }
      const a = luminance(ink), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      return ink.slice(0, 3).some((v, i) => v !== orange[i]) || ratio < 4.5 ? [`${node.textContent}: ${style.color}, ${ratio.toFixed(2)}`] : [];
    });
  });
  check(`LOG-11 text links orange and contrast >=4.5 ${name}`, failures.length === 0, failures.join('; '));
}

/** Isolate the release contract from the real-code journeys; no email or privileged write is sent. */
export async function log11Acceptance(browser: import('playwright-core').Browser, origin: string, check: Check) {
  for (const lang of ['en', 'fr', 'es']) for (const theme of ['light', 'dark'] as const) for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: 'no-preference' });
    try {
      const page = await context.newPage(), name = `${lang}/${theme}/${width}`;
      for (const path of ['/', '/legal/privacy', '/legal/terms', '/missing/']) {
        await page.goto(`${origin}${path}?lang=${lang}`, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('footer').waitFor();
        await log11Chrome(page, name + path, check);
        await log11Links(page, name + path, check);
        await log11Error(page, name + path, check);
      }
      await page.evaluate(() => localStorage.setItem('login.session.example', JSON.stringify({ token: 'release-test' })));
      await page.route('**/auth/api/get-session', route => route.fulfill({ json: { session: {}, user: { id: 'release-user', email: 'current@example.test' } } }));
      await page.route('**/auth/sites', route => route.fulfill({ json: [{ slug: 'example' }] }));
      await page.route('**/account', route => route.request().headers().authorization ? route.fulfill({ json: {} }) : route.continue());
      for (const status of [200, 403, 502]) {
        await page.route('**/example/people/members', route => route.fulfill({ status, json: status === 200 ? [] : {} }));
        await page.goto(`${origin}/example/people?lang=${lang}`, { waitUntil: 'domcontentloaded' });
        await page.locator(status === 200 ? '#email' : '[data-slot="error-page"]').waitFor();
        await log11Chrome(page, name + status, check);
        await log11Error(page, name + status, check);
        await log11Links(page, name + status, check);
        await page.unroute('**/example/people/members');
      }
      await page.goto(`${origin}/account?site=example&lang=${lang}`, { waitUntil: 'domcontentloaded' });
      await page.locator('#email:enabled').waitFor();
      await log11Chrome(page, name + '/account', check);
      await log11Links(page, name + '/account', check);
    } finally { await context.close(); }
  }
}
