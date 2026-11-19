<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Masthead } from '@yesid/ui/layout';
  import { Button } from '@yesid/ui/button';
  import { Card } from '@yesid/ui/card';
  import Chrome from './Chrome.svelte';
  import { copy, accountCopy, throttleMessage } from './copy.ts';
  import { initialLocale } from './preferences.ts';
  import { siteKey, validTarget, retryMinutes } from './controller.ts';
  import { normalizeCode } from './code.ts';
  import { readAccount, saveAccount, clearAccount, type AccountStage } from './step.ts';
  const slug = new URLSearchParams(location.search).get('site') || '';
  const locale = initialLocale(), common = copy[locale];
  const text = accountCopy[locale];
  let email = $state(''), currentEmail = $state(''), code = $state(''), step = $state('ask'), busy = $state(true), message = $state('');
  const steps = { fr: ['Nouvelle adresse', 'Code à l’adresse actuelle', 'Code à la nouvelle adresse'], en: ['New address', 'Code to current address', 'Code to new address'], es: ['Nueva dirección', 'Código a la dirección actual', 'Código a la nueva dirección'] }[locale];
  let token = '', userId = '';
  let restored = $state(false), restoreFailed = $state(false), fieldMessage = $state(''), codeAttempt = $state(0), storageWarning = $state(false);
  // A-7: the local deadline of the code in A2 or A3. A-5: a lost reply to the address change.
  let expiresAt = 0, expired = $state(false), resending = $state(false), lostChange = $state(false);
  let emailInput = $state<HTMLInputElement>(), codeInput = $state<HTMLInputElement>(), resendButton = $state<HTMLButtonElement>(), lostAction = $state<HTMLButtonElement>();
  const codeMessage = $derived(expired ? common.expired : fieldMessage);
  const headers = () => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Login-Language': locale, 'X-Login-Theme': document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' });
  function clearRecord() { try { clearAccount(sessionStorage, slug); } catch { /* Storage itself may be blocked. */ } }
  function signIn() { clearRecord(); location.replace(validTarget(slug) ? '/?site=' + encodeURIComponent(slug) : '/'); }
  function retain(stage: AccountStage, sentAt = Date.now()) {
    try { if (!saveAccount(sessionStorage, slug, userId, stage, email, sentAt)) storageWarning = true; }
    catch { storageWarning = true; }
  }
  function restoreRecord() {
    try {
      const record = readAccount(sessionStorage, slug, userId);
      if (!record) return;
      email = record.newEmail;
      step = record.stage === 'address' || Date.now() >= record.expiresAt ? 'ask' : record.stage === 'current' ? 'current' : 'enter';
      if (record.stage !== 'address' && step === 'ask') message = common.expired;
      if (step !== 'ask') expiresAt = record.expiresAt;
    } catch { /* Storage is optional. */ }
  }
  /** A-7: the stage stays, the digits stay, the check is disabled and Request another code leads on. */
  function expire() {
    const moveFocus = document.activeElement?.id === 'account-submit';
    expired = true; message = '';
    if (moveFocus) void tick().then(() => resendButton?.focus({ preventScroll: true }));
  }
  onMount(() => {
    void restore();
    const timer = setInterval(() => {
      if ((step === 'current' || step === 'enter') && !expired && expiresAt && Date.now() >= expiresAt) expire();
    }, 250);
    return () => clearInterval(timer);
  });
  function restoreResponse(response: Response): boolean {
    if (response.status === 401 || response.status === 403) { signIn(); return false; }
    if (response.status === 429) { restoreFailed = true; message = text.loadFailed + ' ' + throttleMessage(locale, retryMinutes(response)); return false; }
    if (!response.ok) throw Error();
    return true;
  }
  async function restore() {
    busy = true; restored = false; restoreFailed = false; message = '';
    try {
      if (!validTarget(slug)) { signIn(); return; }
      token = JSON.parse(localStorage.getItem(siteKey(slug)) || 'null')?.token || '';
      if (!token) { signIn(); return; }
      const response = await fetch('/auth/api/get-session', { headers: headers() });
      if (!restoreResponse(response)) return;
      const data = await response.json();
      if (!data || !data.session) { signIn(); return; }
      if (typeof data.user?.email !== 'string' || typeof data.user?.id !== 'string') throw Error();
      currentEmail = data.user.email; userId = data.user.id;
      const access = await fetch('/account', { headers: headers() });
      if (!restoreResponse(access)) return;
      const sites = await fetch('/auth/sites', { headers: headers() });
      if (!restoreResponse(sites)) return;
      const list = await sites.json();
      if (!Array.isArray(list)) throw Error();
      if (!list.some(site => site.slug === slug)) { signIn(); return; }
      restoreRecord(); restored = true;
    } catch { restoreFailed = true; message = text.loadFailed; }
    finally { busy = false; }
  }
  const operationFailure = () => step === 'ask' ? text.sendFailed : step === 'current' ? text.checkFailed : text.changeFailed;
  async function codeError(value: string) {
    busy = false; fieldMessage = value; message = ''; codeAttempt += 1;
    await tick(); codeInput?.focus(); codeInput?.select();
  }
  /** Every Account request (A-2): a 401 follows A-9 and a 429 shows S-12. Other failures throw. */
  async function post(operation: string, body: object): Promise<'ok' | 'invalid' | 'lost' | 'handled'> {
    let response: Response;
    try { response = await fetch('/auth/api/email-otp/' + operation, { method: 'POST', headers: headers(), body: JSON.stringify(body) }); }
    catch { return 'lost'; }
    if (response.status === 401) { signIn(); return 'handled'; }
    if (response.status === 429) { message = throttleMessage(locale, retryMinutes(response)); return 'handled'; }
    if (response.status === 400) return 'invalid';
    if (!response.ok) throw Error();
    const data = await response.json();
    if (data?.success !== true && data?.status !== true) throw Error();
    return 'ok';
  }
  async function submit() {
    if (busy || !restored || expired) return;
    if (step !== 'ask' && expiresAt && Date.now() >= expiresAt) { expire(); return; }
    fieldMessage = ''; message = '';
    const normalized = step === 'ask' ? undefined : normalizeCode(code);
    if (step !== 'ask' && normalized === undefined) { await codeError(common.format); return; }
    busy = true;
    const sentAt = Date.now();
    try {
      const outcome = await post(step === 'ask' ? 'send-verification-otp' : step === 'current' ? 'request-email-change' : 'change-email',
        step === 'ask' ? { type: 'email-verification' } : { newEmail: email.trim(), otp: normalized });
      if (outcome === 'handled') return;
      if (outcome === 'invalid' && step !== 'ask') { await codeError(common.invalid); return; }
      // A-5: a lost reply to the change may hide a completed change, so both sign-ins are offered.
      if (outcome === 'lost' && step === 'enter') { lostChange = true; message = text.lost; return; }
      if (outcome !== 'ok') throw Error();
      if (step === 'ask' || step === 'current') {
        email = email.trim(); step = step === 'ask' ? 'current' : 'enter'; code = '';
        expiresAt = sentAt + 300000; expired = false;
        retain(step === 'current' ? 'current' : 'new', sentAt);
        message = step === 'current' ? text.sentCurrent : text.sent;
      } else {
        step = 'done'; code = ''; clearRecord();
        try { localStorage.removeItem(siteKey(slug)); } catch { /* All sessions are already closed. */ }
        message = text.done;
      }
    } catch { message = operationFailure(); }
    finally {
      busy = false;
      await tick();
      if (step === 'ask') emailInput?.focus();
      else if (lostChange) lostAction?.focus();
      else if (step !== 'done') codeInput?.focus();
    }
  }
  /** A-6 in A2: repeat A1's request for the same new address. In A3 a new current-address proof comes first. */
  async function requestAnother() {
    if (busy || !restored) return;
    if (step === 'enter') { await startAgain(); return; }
    fieldMessage = ''; message = ''; busy = true; resending = true;
    const sentAt = Date.now();
    let sent = false;
    try {
      const outcome = await post('send-verification-otp', { type: 'email-verification' });
      if (outcome === 'handled') return;
      if (outcome !== 'ok') throw Error();
      code = ''; expiresAt = sentAt + 300000; expired = false; sent = true;
      retain('current', sentAt); message = text.sentCurrent;
    } catch { message = text.sendFailed; }
    finally {
      busy = false; resending = false;
      await tick();
      if (sent) codeInput?.focus(); else resendButton?.focus();
    }
  }
  /** A-6: Back and Start again return to A1 with the new address kept. From A3 a note explains the next current-address code. */
  async function startAgain() {
    if (busy || !restored) return;
    const fromNew = step === 'enter';
    step = 'ask'; code = ''; fieldMessage = ''; expired = false; expiresAt = 0;
    message = fromNew ? text.again : '';
    retain('address');
    await tick(); emailInput?.focus();
  }
</script>
<svelte:head><title>{text.title} | yesid.dev</title></svelte:head>
<Chrome {locale}>
  <main id="main" tabindex="-1">
    <Masthead heading={text.title} lede={text.lead} tape={false} /><a href="/">{text.back}</a>
    <p class="task-step">{step === 'ask' ? '1 / 3' : step === 'current' ? '2 / 3' : '3 / 3'} · {steps[step === 'ask' ? 0 : step === 'current' ? 1 : 2]}</p>
    {#if step !== 'done' && !lostChange}
      <Card edge="neutral" textSize="inherit" class="form-card"><form onsubmit={event => { event.preventDefault(); void submit(); }}>
        {#if step === 'ask'}<label for="email">{common.email}</label><input id="email" name="email" type="email" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="email" disabled={busy || !restored} required bind:this={emailInput} bind:value={email} oninput={event => { email = event.currentTarget.value; if (restored) retain('address'); }} />
        {:else}
          <p class="confirm-address">{text.current} {currentEmail}</p>
          <p class="confirm-address">{text.next} {email}</p>
          <label for="code">{common.code}</label>
          <input id="code" name="code" bind:this={codeInput} inputmode="numeric" autocomplete="one-time-code" disabled={busy || !restored} aria-describedby={codeMessage ? 'code-error' : undefined} aria-invalid={codeMessage ? 'true' : undefined} bind:value={code} />
          {#key codeAttempt}{#if codeMessage}<p id="code-error" role="alert">{codeMessage}</p>{/if}{/key}
        {/if}
        <Button id="account-submit" type="submit" size="cta" disabled={busy || !restored || expired}>{step === 'ask' ? common.send : text.save}</Button>
      </form></Card>
      {#if step !== 'ask'}
        <div class="step-actions"><button type="button" disabled={busy || !restored} bind:this={resendButton} onclick={() => void requestAnother()}>{resending ? common.requesting : common.resend}</button><button type="button" disabled={busy || !restored} onclick={() => void startAgain()}>{text.startAgain}</button></div>
      {/if}
    {/if}
    {#if restoreFailed}<Button onclick={() => void restore()} disabled={busy}>{text.retry}</Button>{/if}
    {#if storageWarning}<p role="status">{text.storage}</p>{/if}
    <p role="status" class="message state-panel">{message}</p>
    {#if lostChange}
      <div class="step-actions"><button type="button" bind:this={lostAction} onclick={signIn}>{text.signInNew}</button><button type="button" onclick={signIn}>{text.signInCurrent}</button></div>
    {/if}
  </main>
</Chrome>
