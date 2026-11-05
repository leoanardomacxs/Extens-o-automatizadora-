// state.js — formato do estado persistido em chrome.storage.local e utilitários
// compartilhados por popup, content script e service worker.
(function (root) {
  'use strict';

  const VERSION = 1;

  function emptyState() {
    return {
      version: VERSION,
      rawText: '',          // texto analisado (para detectar edições posteriores)
      items: [],            // {id, number, title, text, status, error, attempts, startedAt, finishedAt}
      queue: 'idle',        // idle | running | pausing | paused | cancelled | error | finished
      queueMessage: '',
      current: -1,          // índice do item em andamento
      ownerTabId: null,     // aba do ChatGPT que executa a fila
      startedAt: null,
      finishedAt: null,
      parseWarnings: [],
      parseErrors: [],
      updatedAt: 0
    };
  }

  function counts(state) {
    const c = { total: state.items.length, done: 0, pending: 0, errors: 0, active: 0 };
    for (const it of state.items) {
      if (it.status === 'concluido') c.done++;
      else if (it.status === 'pendente') c.pending++;
      else if (it.status === 'erro') c.errors++;
      else c.active++; // enviando | gerando
    }
    return c;
  }

  // Chamada quando a execução foi cortada (aba recarregada/fechada, navegador reiniciado).
  // Itens que estavam "enviando/gerando" têm estado incerto: nunca são marcados como
  // concluídos; ficam como erro para o usuário conferir e tentar novamente se quiser.
  function interrupt(state, reason) {
    for (const it of state.items) {
      if (it.status === 'enviando' || it.status === 'gerando') {
        it.status = 'erro';
        it.error = reason + ' Confira no ChatGPT se esta imagem foi gerada antes de tentar novamente.';
        it.finishedAt = Date.now();
      }
    }
    state.queue = 'paused';
    state.queueMessage = reason + ' O progresso foi preservado. Abra o ChatGPT e clique em CONTINUAR.';
    state.current = -1;
    state.updatedAt = Date.now();
    return state;
  }

  root.NautilusState = { VERSION, emptyState, counts, interrupt };
})(typeof self !== 'undefined' ? self : this);
