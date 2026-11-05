// background.js — service worker enxuto:
//  1) informa ao content script o id da própria aba;
//  2) mostra o andamento no ícone da extensão;
//  3) ao iniciar o navegador, marca uma fila "em execução" como interrompida (sem reenviar nada).
importScripts('state.js');

function updateBadge(state) {
  const S = self.NautilusState;
  if (!state || !state.items || !state.items.length) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const c = S.counts(state);
  let text = '';
  let color = '#4fb3a9';
  switch (state.queue) {
    case 'running':   text = `${c.done}/${c.total}`; break;
    case 'pausing':   text = `${c.done}/${c.total}`; color = '#d4a85a'; break;
    case 'paused':    text = 'II'; color = '#d4a85a'; break;
    case 'error':     text = '!'; color = '#e07a5f'; break;
    case 'finished':  text = c.errors ? '!' : 'OK'; color = c.errors ? '#e07a5f' : '#4fb3a9'; break;
    default:          text = '';
  }
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

async function readState() {
  const { state } = await chrome.storage.local.get('state');
  return state && state.version === self.NautilusState.VERSION ? state : null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) updateBadge(changes.state.newValue);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await readState();
  if (state && (state.queue === 'running' || state.queue === 'pausing')) {
    self.NautilusState.interrupt(state, 'O navegador foi reiniciado durante a execução.');
    await chrome.storage.local.set({ state });
  }
  updateBadge(state);
});

chrome.runtime.onInstalled.addListener(async () => updateBadge(await readState()));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'whoami') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
  }
  return false;
});
