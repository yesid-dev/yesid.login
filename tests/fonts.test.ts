import { test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { preloadFont } from '@yesid/tokens/fonts';
import { PRELOADED_FONTS, homeHtml, publicHtml } from '../src/pages.ts';

// With font-display: optional, a face that is not preloaded misses the first paint and keeps the fallback.
test('every Login page preloads exactly the latin faces the kit marks for preloading', () => {
  const kit = readdirSync('node_modules/@yesid/tokens/fonts').filter(file => preloadFont(file)).sort();
  expect(kit.length).toBeGreaterThan(0);
  const preloaded: string[] = [...PRELOADED_FONTS].sort();
  expect(preloaded).toEqual(kit);
  for (const html of [homeHtml('en'), publicHtml('not-found', 'fr'), publicHtml('privacy', 'es'), publicHtml('terms', 'en')]) {
    for (const file of kit) expect(html).toContain(`<link rel="preload" href="/login/fonts/${file}" as="font" type="font/woff2" crossorigin>`);
    expect(html.indexOf('rel="preload"')).toBeLessThan(html.indexOf('href="/login/fonts.css"'));
  }
});
