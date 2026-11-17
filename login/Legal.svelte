<script lang="ts">
  import { onMount } from 'svelte';
  import Chrome from './Chrome.svelte';
  import { ReadingFrame } from '@yesid/ui/layout';
  import { LEGAL_UPDATED } from './legal/copy.ts';
  import { legalLabels } from './legal/labels.ts';
  import { legalLocale, legalPage, legalDate, legalIntro, legalBody, contents as legalContents } from './legal/render.ts';
  const locale = legalLocale(new URLSearchParams(location.search).get('lang'));
  const text = legalPage(location.pathname === '/legal/privacy' ? 'privacy' : 'terms', locale);
  // Mounting replaces the server DOM after the browser's initial fragment jump.
  onMount(() => {
    try {
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    } catch { /* An invalid fragment does not prevent reading. */ }
  });
</script>
<svelte:head><title>{text.title} | yesid.dev</title></svelte:head>
<Chrome {locale}>
  <main id="main" class="legal-screen" tabindex="-1" data-testid="page-legal">
    <a href={'/?lang=' + locale}>{legalLabels[locale].back}</a>
    <ReadingFrame title={text.title} updated={{ datetime: LEGAL_UPDATED, label: text.updatedLabel, text: legalDate(locale) }}>
      {#snippet summary()}<p>{@html legalIntro(text)}</p>{/snippet}
      {#snippet contents()}<nav class="legal-toc" aria-label={legalLabels[locale].contents}><p>{legalLabels[locale].contents}</p>{@html legalContents(text.sections)}</nav>{/snippet}
      <div data-testid="legal-body">{@html legalBody(text)}</div>
    </ReadingFrame>
  </main>
</Chrome>
