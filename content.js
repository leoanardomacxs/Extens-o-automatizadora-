// content.js — motor da fila. Roda dentro da aba do ChatGPT e continua funcionando
// mesmo com o popup fechado. Todo o progresso é gravado em chrome.storage.local.
(() => {
  'use strict';
  if (window.__nautilusEngineLoaded) return;
  window.__nautilusEngineLoaded = true;

  const S = self.NautilusState;

  // Tempos em ms. Se o ChatGPT mudar de comportamento, ajuste aqui.
  const CFG = Object.assign({
    POLL_MS: 500,
    SEND_READY_TIMEOUT: 15000,     // esperar o botão de envio habilitar
    SEND_CONFIRM_TIMEOUT: 20000,   // esperar o ChatGPT aceitar o envio
    IDLE_WAIT_TIMEOUT: 180000,     // esperar o ChatGPT ficar livre antes de enviar
    GEN_TIMEOUT: 12 * 60 * 1000,   // limite para uma geração
    STOP_ABSENT_MS: 4000,          // botão "parar" ausente por este tempo = resposta encerrada
    IMG_STABLE_MS: 3000,           // imagens sem mudar por este tempo
    DOM_QUIET_MS: 2000,            // página sem alterações por este tempo
    IMG_STABLE_FORCE_MS: 8000,     // se a página nunca "silencia", aceita após este tempo estável
    NO_IMAGE_GRACE: 45000,         // sem imagem e sem "parar" por este tempo = resposta sem imagem
    OFFLINE_LIMIT: 30000,
    BETWEEN_ITEMS_MS: 2500,
    MIN_IMG_PX: 200                // imagens menores que isso (ícones, avatares) são ignoradas
  }, window.__NAUTILUS_TEST_CFG || {});

  // ---------- utilidades ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && el.getClientRects().length > 0;

  async function waitFor(fn, timeout, interval = 150) {
    const t0 = now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (now() - t0 >= timeout) return null;
      await sleep(interval);
    }
  }

  // ---------- DOM do ChatGPT (seletores por atributos estáveis, com alternativas) ----------
  const USER_MSG = '[data-message-author-role="user"]';
  const ASSISTANT_MSG = '[data-message-author-role="assistant"]';

  function findComposer() {
    const sels = [
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'textarea[data-testid="prompt-textarea"]',
      'form [contenteditable="true"]',
      'form textarea'
    ];
    for (const s of sels) {
      const el = $$(s).find(visible);
      if (el) return el;
    }
    return null;
  }
  const composerScope = () => { const c = findComposer(); return (c && c.closest('form')) || document; };
  const composerText = el => (el.tagName === 'TEXTAREA' ? el.value : el.innerText) || '';

  function findSend() {
    const sc = composerScope();
    return $('button[data-testid="send-button"]', sc) ||
      $$('button', sc).find(b => /^(send|enviar)/i.test(b.getAttribute('aria-label') || '')) || null;
  }
  function findStop() {
    const sc = composerScope(); // restrito ao compositor: evita confundir com "parar leitura em voz alta"
    const b = $('button[data-testid="stop-button"]', sc) ||
      $$('button', sc).find(x => /^(stop|parar|interromper|detener|arr[êe]ter)/i.test(x.getAttribute('aria-label') || ''));
    return b && visible(b) ? b : null;
  }
  const isGenerating = () => !!findStop();
  const userCount = () => $$(USER_MSG).length;
  const assistantCount = () => $$(ASSISTANT_MSG).length;

  function isLoggedOut() {
    return !!($('[data-testid="login-button"]') || $('[data-testid="signup-button"]') ||
      /\/auth\/(login|signin)/.test(location.pathname));
  }

  // ---------- imagens ----------
  const srcOf = img => img.currentSrc || img.src || '';
  const isLoaded = img => img.complete && img.naturalWidth >= CFG.MIN_IMG_PX;

  // Imagens "de conteúdo" na conversa. Com `base`, só as que são novas: ausentes no
  // instantâneo anterior ao envio e posicionadas depois da mensagem que acabamos de enviar.
  function candidateImages(base) {
    const root = $('main') || document.body;
    let lastUser = null;
    if (base) {
      const users = $$(USER_MSG);
      if (users.length > base.userCount) lastUser = users[users.length - 1];
    }
    return $$('img', root).filter(img => {
      if (img.closest(USER_MSG)) return false;
      if (img.closest('form, nav, aside')) return false;
      const src = srcOf(img);
      if (!src || /^data:image\/svg/.test(src)) return false;
      if (base && base.srcs.has(src)) return false;
      if (lastUser && !(lastUser.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return img.clientWidth >= CFG.MIN_IMG_PX && img.clientHeight >= CFG.MIN_IMG_PX;
    });
  }

  function snapshot() {
    return {
      userCount: userCount(),
      assistantCount: assistantCount(),
      srcs: new Set(candidateImages(null).map(srcOf))
    };
  }

  // ---------- observador de mudanças na página ----------
  let lastMutation = now();
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList' || m.type === 'characterData') { lastMutation = now(); return; }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------- classificação quando não há imagem ----------
  const LIMIT_RE = /(you['’]ve|you have) (hit|reached)|limit (reached|exceeded)|reached (the|your|our)[^.]{0,40}limit|rate limit|too many requests|atingiu o limite|limite[^.]{0,30}(atingido|excedido)|muitas solicita[çc][õo]es|try again (later|in)|tente novamente (mais tarde|em)/i;
  const ERROR_RE = /something went wrong|algo deu errado|network error|erro de rede|error generating|erro ao gerar|there was an error|ocorreu um erro/i;

  function latestAssistantText(base) {
    const as = $$(ASSISTANT_MSG);
    return as.length > base.assistantCount ? (as[as.length - 1].innerText || '') : '';
  }
  const alertText = () => $$('[role="alert"], [role="dialog"], [data-testid*="toast" i]').map(e => e.innerText).join('\n');

  function classifyNoImage(base) {
    const text = latestAssistantText(base);
    const all = text + '\n' + alertText();
    if (LIMIT_RE.test(all)) return 'Limite de utilização do ChatGPT atingido (ou aviso de limite detectado). Aguarde e clique em CONTINUAR.';
    if (ERROR_RE.test(all)) return 'O ChatGPT exibiu um erro durante a geração.';
    if (norm(text)) return 'O ChatGPT respondeu só com texto, sem imagem: "' + norm(text).slice(0, 140) + '…"';
    return 'Nenhuma imagem foi detectada após a resposta. Confira no ChatGPT.';
  }

  // ---------- estado persistido ----------
  let state = S.emptyState();
  let engineActive = false;
  const control = { pause: false, cancel: false };

  async function loadState() {
    const { state: st } = await chrome.storage.local.get('state');
    return st && st.version === S.VERSION ? st : S.emptyState();
  }
  async function persist() {
    state.updatedAt = now();
    await chrome.storage.local.set({ state });
  }
  async function setItem(i, patch) {
    Object.assign(state.items[i], patch);
    await persist();
  }
  async function endQueue(queue, message) {
    state.queue = queue;
    state.queueMessage = message || '';
    state.current = -1;
    if (queue === 'finished') state.finishedAt = now();
    await persist();
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.state && !engineActive) state = ch.state.newValue || S.emptyState();
  });

  // ---------- inserir o prompt no compositor ----------
  function setTextareaValue(el, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function clearEditable(el) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  // O texto é aceito se não foi truncado: início, fim e tamanho conferem.
  function composerHolds(el, text) {
    const got = norm(composerText(el));
    const want = norm(text);
    if (!want) return false;
    return got.length >= want.length * 0.98 &&
      got.startsWith(want.slice(0, 40)) &&
      got.includes(want.slice(-40));
  }

  async function insertPrompt(text) {
    const el = await waitFor(findComposer, 8000);
    if (!el) throw new Error('Campo de mensagem do ChatGPT não localizado.');
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      setTextareaValue(el, text);
    } else {
      clearEditable(el);
      // Colar via evento é o caminho que editores como o do ChatGPT tratam melhor para textos longos com quebras de linha.
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (!(await waitFor(() => composerHolds(el, text), 1500, 100))) {
        clearEditable(el); // alternativa: inserção de texto nativa (limpa antes, sem duplicar)
        document.execCommand('insertText', false, text);
      }
    }
    if (!(await waitFor(() => composerHolds(el, text), 2000, 100))) {
      throw new Error('Não foi possível inserir o prompt completo no campo de mensagem (texto ausente ou truncado).');
    }
  }

  // ---------- aguardar a conclusão da geração ----------
  async function waitForCompletion(base) {
    const t0 = now();
    let stopGoneAt = null;
    let sig = '';
    let sigSince = now();
    let offlineSince = null;

    for (;;) {
      if (control.cancel) return { status: 'cancelled' };
      const t = now();
      if (t - t0 > CFG.GEN_TIMEOUT) return { status: 'timeout' };
      if (!navigator.onLine) {
        if (offlineSince == null) offlineSince = t;
        if (t - offlineSince > CFG.OFFLINE_LIMIT) return { status: 'offline' };
      } else offlineSince = null;
      if (isLoggedOut()) return { status: 'loggedout' };

      if (findStop()) {
        stopGoneAt = null; // ainda gerando
      } else {
        if (stopGoneAt == null) stopGoneAt = t;
        const imgs = candidateImages(base);
        const s = imgs.map(srcOf).join('|');
        if (s !== sig) { sig = s; sigSince = t; }

        const stopAbsent = t - stopGoneAt >= CFG.STOP_ABSENT_MS;
        const imgStable = t - sigSince >= CFG.IMG_STABLE_MS;
        const quiet = t - lastMutation >= CFG.DOM_QUIET_MS;
        const allLoaded = imgs.length > 0 && imgs.every(isLoaded);

        // Concluída = há imagem nova carregada E a resposta encerrou E a página assentou.
        if (allLoaded && stopAbsent && imgStable && (quiet || t - sigSince >= CFG.IMG_STABLE_FORCE_MS)) {
          return { status: 'done', images: imgs.length };
        }
        if (imgs.length === 0 && t - stopGoneAt >= CFG.NO_IMAGE_GRACE) {
          return { status: 'noimage', message: classifyNoImage(base) };
        }
      }
      await sleep(CFG.POLL_MS);
    }
  }

  // ---------- processamento de um item ----------
  async function preflight() {
    if (!navigator.onLine) return 'Sem conexão com a internet.';
    if (!(await waitFor(findComposer, 8000))) {
      return isLoggedOut()
        ? 'Você não está autenticado no ChatGPT. Faça login e clique em CONTINUAR.'
        : 'Campo de mensagem do ChatGPT não localizado (a página ainda carrega ou a interface mudou).';
    }
    if (isGenerating()) {
      const idle = await waitFor(() => !isGenerating(), CFG.IDLE_WAIT_TIMEOUT, 500);
      if (!idle) return 'O ChatGPT continua ocupado com outra resposta. Aguarde terminar e clique em CONTINUAR.';
    }
    return null;
  }

  // Retorna {ok:true} ou {ok:false, queue, message}
  async function processItem(i) {
    state.current = i;
    const it = state.items[i];
    const fail = async msg => {
      await setItem(i, { status: 'erro', error: msg, finishedAt: now() });
      return { ok: false, queue: 'error', message: `Item ${it.number}: ${msg}` };
    };

    const pre = await preflight();
    if (pre) { await persist(); return { ok: false, queue: 'error', message: pre }; } // item continua pendente

    const base = snapshot();
    await setItem(i, { status: 'enviando', error: null, startedAt: now(), finishedAt: null, attempts: (it.attempts || 0) + 1 });

    try { await insertPrompt(it.text); } catch (e) { return fail(e.message); }

    const sendBtn = await waitFor(() => {
      const b = findSend();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, CFG.SEND_READY_TIMEOUT);
    if (!sendBtn) return fail('O botão de envio não ficou disponível.');

    if (control.cancel) { // ainda nada foi enviado: volta o item para a fila
      await setItem(i, { status: 'pendente', startedAt: null });
      return { ok: false, queue: 'cancelled', message: 'Cancelado pelo usuário.' };
    }

    sendBtn.click();

    const sent = await waitFor(() => (userCount() > base.userCount || isGenerating()) ? true : null, CFG.SEND_CONFIRM_TIMEOUT);
    if (!sent) {
      // Não clica de novo (evita duplicar). O usuário confere e decide.
      return fail('Envio não confirmado. Confira no ChatGPT se o prompt foi enviado antes de tentar novamente.');
    }
    await setItem(i, { status: 'gerando' });

    const res = await waitForCompletion(base);
    switch (res.status) {
      case 'done':
        await setItem(i, { status: 'concluido', error: null, finishedAt: now(), images: res.images });
        return { ok: true };
      case 'cancelled':
        await setItem(i, { status: 'erro', error: 'Cancelado durante a geração; a conclusão não foi confirmada. Confira no ChatGPT.', finishedAt: now() });
        return { ok: false, queue: 'cancelled', message: 'Cancelado pelo usuário.' };
      case 'timeout':
        return fail('A geração demorou demais (limite de tempo excedido). Confira no ChatGPT.');
      case 'offline':
        return fail('Conexão perdida durante a geração.');
      case 'loggedout':
        return fail('A sessão do ChatGPT parece ter expirado. Faça login novamente.');
      case 'noimage':
      default:
        return fail(res.message || 'Resposta sem imagem.');
    }
  }

  async function sleepChecked(ms) {
    const t0 = now();
    while (now() - t0 < ms && !control.cancel && !control.pause) await sleep(200);
  }

  async function runLoop(only = null) {
    if (engineActive) return;
    engineActive = true;
    control.pause = false;
    control.cancel = false;
    try {
      state.queue = 'running';
      state.queueMessage = '';
      state.finishedAt = null;
      if (!state.startedAt) state.startedAt = now();
      await persist();

      for (;;) {
        if (control.cancel) { await endQueue('cancelled', 'Cancelado pelo usuário.'); break; }
        if (control.pause && only === null) { await endQueue('paused', 'Fila pausada. Clique em CONTINUAR para retomar do próximo item pendente.'); break; }

        const i = only !== null
          ? (state.items[only] && state.items[only].status === 'pendente' ? only : -1)
          : state.items.findIndex(it => it.status === 'pendente');
        if (i < 0) { await finish(); break; }

        const r = await processItem(i);
        if (!r.ok) { await endQueue(r.queue, r.message); break; }

        if (only !== null) {
          const pend = state.items.some(it => it.status === 'pendente');
          if (pend) await endQueue('paused', 'Item reprocessado. Clique em CONTINUAR para seguir a fila.');
          else await finish();
          break;
        }
        await sleepChecked(CFG.BETWEEN_ITEMS_MS);
      }
    } catch (e) {
      await endQueue('error', 'Erro inesperado: ' + (e && e.message ? e.message : e));
    } finally {
      engineActive = false;
    }
  }

  async function finish() {
    const c = S.counts(state);
    const msg = `Fila encerrada: ${c.done} concluída(s), ${c.errors} com erro, ${c.pending} pendente(s) de ${c.total}.`;
    await endQueue(c.pending > 0 ? 'paused' : 'finished', msg);
  }

  // ---------- comandos vindos do popup ----------
  async function handle(msg) {
    switch (msg && msg.type) {
      case 'ping':
        return { ok: true, active: engineActive };

      case 'start':
      case 'continue': {
        if (engineActive) return { ok: false, error: 'A fila já está em execução.' };
        state = await loadState();
        if (!state.items.length) return { ok: false, error: 'A fila está vazia. Analise os prompts primeiro.' };
        if (!state.items.some(it => it.status === 'pendente')) return { ok: false, error: 'Não há itens pendentes.' };
        state.ownerTabId = msg.tabId != null ? msg.tabId : myTabId;
        runLoop();
        return { ok: true };
      }

      case 'pause':
        if (engineActive) {
          control.pause = true;
          state.queue = 'pausing';
          state.queueMessage = 'Pausando: aguardando a imagem atual terminar para suspender a fila.';
          await persist();
        }
        return { ok: true };

      case 'cancel':
        if (engineActive) {
          control.cancel = true;
        } else {
          state = await loadState();
          state.queue = 'cancelled';
          state.queueMessage = 'Cancelado pelo usuário.';
          state.current = -1;
          await persist();
        }
        return { ok: true };

      case 'retry': {
        if (engineActive) return { ok: false, error: 'Aguarde a fila parar para tentar novamente um item.' };
        state = await loadState();
        const it = state.items[msg.index];
        if (!it || it.status !== 'erro') return { ok: false, error: 'Só itens com erro podem ser reenviados.' };
        it.status = 'pendente';
        it.error = null;
        state.ownerTabId = msg.tabId != null ? msg.tabId : myTabId;
        runLoop(msg.index);
        return { ok: true };
      }

      default:
        return { ok: false, error: 'Comando desconhecido.' };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  });

  // ---------- inicialização e recuperação ----------
  let myTabId = null;
  (async () => {
    try { const r = await chrome.runtime.sendMessage({ type: 'whoami' }); myTabId = r && r.tabId; } catch (_) { /* ignora */ }
    state = await loadState();
    // Se esta aba era a dona de uma fila "em execução" e a página foi recarregada, o estado
    // da imagem em andamento é incerto: pausa em vez de reenviar qualquer coisa.
    if (myTabId != null && state.ownerTabId === myTabId && (state.queue === 'running' || state.queue === 'pausing')) {
      S.interrupt(state, 'A página do ChatGPT foi recarregada durante a execução.');
      await persist();
    }
  })();
})();
