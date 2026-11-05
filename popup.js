// popup.js — interface. A automação roda no content script; o popup só lê/grava o estado
// e envia comandos, então pode ser fechado sem afetar a fila.
(() => {
  'use strict';
  const S = NautilusState;
  const $ = id => document.getElementById(id);
  const CHAT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  const STATUS = { pendente: 'Pendente', enviando: 'Enviando', gerando: 'Gerando', concluido: 'Concluída', erro: 'Erro' };
  const QUEUE = { idle: 'Pronta', running: 'Em execução', pausing: 'Pausando…', paused: 'Pausada', cancelled: 'Cancelada', error: 'Parada por erro', finished: 'Concluída' };

  let state = S.emptyState();
  let draft = '';
  let flash = null;
  let lastCurrent = -2;
  const expanded = new Set();

  const isRunning = () => state.queue === 'running' || state.queue === 'pausing';
  const hasProgress = () => state.queue !== 'idle' || state.items.some(i => i.status !== 'pendente');

  async function save() { state.updatedAt = Date.now(); await chrome.storage.local.set({ state }); }

  async function findChatTab() {
    const tabs = await chrome.tabs.query({ url: CHAT_URLS });
    if (!tabs.length) return null;
    if (isRunning() && state.ownerTabId != null) {
      const owner = tabs.find(t => t.id === state.ownerTabId);
      if (owner) return owner;
    }
    return tabs.find(t => t.active && t.currentWindow) || tabs.find(t => t.active) || tabs[0];
  }

  async function command(type, extra = {}) {
    const tab = await findChatTab();
    if (!tab) return setFlash('Abra o ChatGPT (chatgpt.com) em uma aba e tente de novo.');
    try {
      const r = await chrome.tabs.sendMessage(tab.id, Object.assign({ type, tabId: tab.id }, extra));
      if (!r || !r.ok) setFlash((r && r.error) || 'O comando não foi aceito.');
      else setFlash(null);
    } catch (_) {
      setFlash('Não consegui falar com a aba do ChatGPT. Recarregue a aba (F5) e tente de novo.');
    }
  }

  function setFlash(msg) { flash = msg; render(); }

  // Se a fila consta como "em execução" mas a aba dona não responde (aba fechada/recarregada,
  // navegador reiniciado), marca como interrompida em vez de deixar o estado enganoso.
  async function reconcile() {
    if (!isRunning()) return;
    let alive = false;
    try {
      if (state.ownerTabId != null) {
        const r = await chrome.tabs.sendMessage(state.ownerTabId, { type: 'ping' });
        alive = !!(r && r.ok && r.active);
      }
    } catch (_) { alive = false; }
    if (!alive) {
      S.interrupt(state, 'A automação foi interrompida (aba do ChatGPT fechada ou recarregada).');
      await save();
    }
  }

  // ---------- ações ----------
  async function analyze() {
    const text = $('input').value;
    const res = PromptParser.parse(text);
    const st = S.emptyState();
    st.rawText = text;
    st.parseWarnings = res.warnings;
    st.parseErrors = res.errors;
    if (res.ok) {
      st.items = res.items.map(p => ({
        id: p.id, number: p.number, title: p.title, text: p.text,
        status: 'pendente', error: null, attempts: 0, startedAt: null, finishedAt: null
      }));
    }
    state = st;
    expanded.clear();
    await save();
    render();
  }

  async function clearAll() {
    if (hasProgress() && !confirm('Apagar o texto, a fila e todo o progresso?')) return;
    state = S.emptyState();
    draft = '';
    $('input').value = '';
    expanded.clear();
    await chrome.storage.local.set({ state, draft: '' });
    render();
  }

  async function resetQueue() {
    if (!confirm('Reiniciar a fila? O progresso será apagado e todos os prompts voltam a ficar pendentes.')) return;
    for (const it of state.items) {
      it.status = 'pendente'; it.error = null; it.attempts = 0; it.startedAt = null; it.finishedAt = null;
    }
    state.queue = 'idle'; state.queueMessage = ''; state.current = -1;
    state.startedAt = null; state.finishedAt = null; state.ownerTabId = null;
    await save();
    render();
  }

  // ---------- renderização ----------
  function fmt(ts) { return ts ? new Date(ts).toLocaleString('pt-BR') : ''; }

  function renderNotes() {
    const box = $('notes');
    box.textContent = '';
    const add = (cls, title, list) => {
      const d = document.createElement('div');
      d.className = 'note ' + cls;
      const p = document.createElement('div');
      p.textContent = title;
      d.appendChild(p);
      if (list && list.length) {
        const ul = document.createElement('ul');
        list.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
        d.appendChild(ul);
      }
      box.appendChild(d);
    };
    if (flash) add('err', flash);
    if (state.parseErrors.length) add('err', 'A estrutura está ambígua. Corrija o texto e analise de novo:', state.parseErrors);
    if (state.items.length) {
      add('ok', `${state.items.length} prompt(s) identificado(s). Clique em um item da fila para ver o texto separado.`);
      if (state.parseWarnings.length) add('warn', 'Confira estes pontos:', state.parseWarnings);
      if (draft !== state.rawText && !hasProgress()) add('warn', 'O texto foi alterado depois da análise. Analise de novo antes de iniciar.');
    }
  }

  function renderList() {
    const ul = $('list');
    ul.textContent = '';
    state.items.forEach((it, idx) => {
      const li = document.createElement('li');
      li.className = `item st-${it.status}` + (idx === state.current ? ' current' : '');

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'item-head';
      head.setAttribute('aria-expanded', expanded.has(idx) ? 'true' : 'false');
      const num = document.createElement('span'); num.className = 'item-num'; num.textContent = String(it.number).padStart(3, '0');
      const title = document.createElement('span'); title.className = 'item-title'; title.textContent = it.title;
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = STATUS[it.status] || it.status;
      head.append(num, title, chip);
      head.addEventListener('click', () => { expanded.has(idx) ? expanded.delete(idx) : expanded.add(idx); renderList(); });
      li.appendChild(head);

      if (expanded.has(idx)) {
        const body = document.createElement('div');
        body.className = 'item-body';
        if (it.error) { const e = document.createElement('p'); e.className = 'item-err'; e.textContent = it.error; body.appendChild(e); }
        if (it.status === 'erro') {
          const b = document.createElement('button');
          b.className = 'btn retry'; b.textContent = 'Tentar novamente'; b.disabled = isRunning();
          b.addEventListener('click', () => command('retry', { index: idx }));
          body.appendChild(b);
        }
        const pre = document.createElement('pre'); pre.textContent = it.text; body.appendChild(pre);
        li.appendChild(body);
      }
      ul.appendChild(li);
    });
    if (state.current !== lastCurrent && state.current >= 0) {
      lastCurrent = state.current;
      const el = ul.children[state.current];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function render() {
    const c = S.counts(state);
    const running = isRunning();
    const q = state.queue;

    const pill = $('statusPill');
    pill.textContent = QUEUE[q] || q;
    pill.className = 'pill ' + q;

    $('sTotal').textContent = c.total;
    $('sDone').textContent = c.done;
    $('sPending').textContent = c.pending;
    $('sErrors').textContent = c.errors;
    $('sErrors').classList.toggle('has', c.errors > 0);
    const cur = state.items.find(it => it.status === 'enviando' || it.status === 'gerando');
    $('sCurrent').textContent = cur ? String(cur.number).padStart(3, '0') : '–';
    $('barFill').style.width = c.total ? Math.round((c.done / c.total) * 100) + '%' : '0%';

    const msg = $('message');
    msg.hidden = !state.queueMessage;
    msg.textContent = state.queueMessage;
    msg.className = 'message ' + q;

    const t = [];
    if (state.startedAt) t.push('Início: ' + fmt(state.startedAt));
    if (state.finishedAt) t.push('Fim: ' + fmt(state.finishedAt));
    $('times').textContent = t.join('  •  ');

    const matches = draft === state.rawText;
    $('input').disabled = running;
    $('btnAnalyze').disabled = running || hasProgress();
    $('btnClear').disabled = running;
    $('btnStart').disabled = running || q !== 'idle' || c.total === 0 || c.pending === 0 || !matches;
    $('btnPause').disabled = q !== 'running';
    $('btnContinue').disabled = !(q === 'paused' || q === 'cancelled' || q === 'error') || c.pending === 0;
    $('btnCancel').disabled = !(running || q === 'paused');
    $('btnReset').disabled = running || c.total === 0;

    renderNotes();
    renderList();
  }

  // ---------- eventos ----------
  let draftTimer = null;
  $('input').addEventListener('input', () => {
    draft = $('input').value;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => chrome.storage.local.set({ draft }), 300);
    render();
  });
  $('btnAnalyze').addEventListener('click', analyze);
  $('btnClear').addEventListener('click', clearAll);
  $('btnStart').addEventListener('click', () => command('start'));
  $('btnContinue').addEventListener('click', () => command('continue'));
  $('btnPause').addEventListener('click', () => command('pause'));
  $('btnCancel').addEventListener('click', () => {
    if (confirm('Cancelar a automação? Se houver uma imagem em geração, a conclusão dela não será confirmada.')) command('cancel');
  });
  $('btnReset').addEventListener('click', resetQueue);

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.state && ch.state.newValue) { state = ch.state.newValue; render(); }
  });

  (async function init() {
    const data = await chrome.storage.local.get(['state', 'draft']);
    state = data.state && data.state.version === S.VERSION ? data.state : S.emptyState();
    draft = typeof data.draft === 'string' ? data.draft : (state.rawText || '');
    $('input').value = draft;
    await reconcile();
    render();
  })();
})();
