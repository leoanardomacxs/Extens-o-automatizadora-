"""
Teste de integração SIMULADO: carrega content.js numa página que imita a estrutura do ChatGPT
(tests/mock-chatgpt.html) e um shim de chrome.storage/runtime. Valida a lógica do motor
(sequência, pausa, erros, recuperação, ausência de duplicatas). NÃO valida o ChatGPT real.
Uso: python3 tests/integration.py
"""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
MOCK = (ROOT / 'tests' / 'mock-chatgpt.html').as_uri()

SHIM = """
(() => {
  const read = () => JSON.parse(localStorage.getItem('__store') || '{}');
  window.chrome = {
    storage: {
      local: {
        get: async (k) => { const a = read(); if (typeof k === 'string') return k in a ? { [k]: JSON.parse(JSON.stringify(a[k])) } : {};
          const o = {}; (k || Object.keys(a)).forEach(x => { if (x in a) o[x] = a[x]; }); return o; },
        set: async (o) => { const a = read(); Object.assign(a, JSON.parse(JSON.stringify(o))); localStorage.setItem('__store', JSON.stringify(a)); }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener(fn) { window.__handler = fn; } },
      sendMessage: async () => ({ tabId: 7 })
    }
  };
  window.__NAUTILUS_TEST_CFG = {
    POLL_MS: 100, SEND_READY_TIMEOUT: 3000, SEND_CONFIRM_TIMEOUT: 3000, IDLE_WAIT_TIMEOUT: 3000,
    GEN_TIMEOUT: 20000, STOP_ABSENT_MS: 500, IMG_STABLE_MS: 500, DOM_QUIET_MS: 300,
    IMG_STABLE_FORCE_MS: 2000, NO_IMAGE_GRACE: 2500, BETWEEN_ITEMS_MS: 200, MIN_IMG_PX: 200
  };
})();
"""

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('  ok   ' if cond else '  FALHOU ') + name + (f'  [{detail}]' if detail and not cond else ''))

def make_items(prompts):
    return [dict(id=f'p{i+1}', number=i+1, title=f'Carta {i+1}', text=t, status='pendente', error=None,
                 attempts=0, startedAt=None, finishedAt=None) for i, t in enumerate(prompts)]

def seed_state(page, prompts):
    st = dict(version=1, rawText='x', items=make_items(prompts), queue='idle', queueMessage='', current=-1,
              ownerTabId=None, startedAt=None, finishedAt=None, parseWarnings=[], parseErrors=[], updatedAt=0)
    page.evaluate("s => localStorage.setItem('__store', JSON.stringify({state: s}))", st)

def load_engine(page):
    page.add_script_tag(content=SHIM)
    page.add_script_tag(path=str(ROOT / 'state.js'))
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.wait_for_function("typeof window.__handler === 'function'")
    page.wait_for_timeout(200)

def fresh_page(browser, prompts, modes=None, gen_ms=None):
    page = browser.new_page()
    page.goto(MOCK)
    page.evaluate("() => localStorage.clear()")
    if modes is not None: page.evaluate("m => window.mock.modes = m", modes)
    if gen_ms: page.evaluate("g => window.mock.genMs = g", gen_ms)
    seed_state(page, prompts)
    load_engine(page)
    return page

def cmd(page, msg):
    return page.evaluate("m => new Promise(r => window.__handler(m, {}, r))", dict(tabId=7, **msg))

def get_state(page):
    return page.evaluate("() => JSON.parse(localStorage.getItem('__store')).state")

def wait_queue(page, targets, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = get_state(page)
        if st['queue'] in targets: return st
        page.wait_for_timeout(150)
    raise TimeoutError(f"fila não chegou a {targets}; atual={get_state(page)['queue']}")

def sent_log(page): return [e for e in page.evaluate("() => window.__log") if e['ev'] == 'user_sent']
def norm(s): return ' '.join(s.split())

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # 1) fila completa, ordem, texto longo íntegro, próximo só após a imagem
        print('1) Fila sequencial com 4 prompts (um deles longo, com quebras de linha)')
        long_prompt = '3. Carta longa\n' + '\n'.join(f'Linha {i}: ilustração detalhada, 1024x1536, aquarela.' for i in range(120))
        prompts = ['1. Primeira\nPrompt A com 300 DPI', '2. Segunda\nPrompt B', long_prompt, '4. Quarta\nPrompt D']
        page = fresh_page(browser, prompts)
        check('start aceito', cmd(page, {'type': 'start'})['ok'])
        st = wait_queue(page, ['finished'])
        log = page.evaluate("() => window.__log")
        sends = [e for e in log if e['ev'] == 'user_sent']
        check('todos os itens concluídos', all(i['status'] == 'concluido' for i in st['items']), [i['status'] for i in st['items']])
        check('exatamente 4 envios (sem duplicatas)', len(sends) == 4, len(sends))
        check('ordem preservada', [norm(s['text']) for s in sends] == [norm(t) for t in prompts])
        check('texto longo chegou íntegro', norm(sends[2]['text']) == norm(long_prompt))
        ok_seq = True
        for n in (1, 2, 3):
            img_t = next(e['t'] for e in log if e['ev'] == 'image_shown' and e['n'] == n)
            nxt_t = next(e['t'] for e in log if e['ev'] == 'user_sent' and e['n'] == n + 1)
            if nxt_t < img_t: ok_seq = False
        check('próximo prompt só depois da imagem anterior aparecer', ok_seq)
        check('relatório final na mensagem da fila', '4 concluída' in st['queueMessage'], st['queueMessage'])
        page.close()

        # 2) pausa e retomada
        print('2) Pausar durante a geração e continuar')
        page = fresh_page(browser, [f'{i}. Item {i}\ntexto {i}' for i in range(1, 5)], gen_ms=1500)
        cmd(page, {'type': 'start'})
        page.wait_for_function("() => window.__log.some(e => e.ev === 'user_sent')")
        cmd(page, {'type': 'pause'})
        st = wait_queue(page, ['paused'])
        n_sent = len(sent_log(page))
        check('pausou após terminar a imagem em andamento', st['items'][0]['status'] == 'concluido' and st['items'][1]['status'] == 'pendente')
        page.wait_for_timeout(1500)
        check('nenhum envio novo enquanto pausado', len(sent_log(page)) == n_sent == 1)
        cmd(page, {'type': 'continue'})
        st = wait_queue(page, ['finished'])
        check('retomou e concluiu sem duplicar', len(sent_log(page)) == 4 and all(i['status'] == 'concluido' for i in st['items']))
        page.close()

        # 3) resposta só com texto: para, não avança; retry individual; continuar
        print('3) Resposta textual sem imagem pausa a fila')
        page = fresh_page(browser, [f'{i}. Item {i}\ntexto {i}' for i in range(1, 4)], modes=['image', 'text', 'image'])
        cmd(page, {'type': 'start'})
        st = wait_queue(page, ['error'])
        check('item 2 em erro por resposta textual', st['items'][1]['status'] == 'erro' and 'texto' in st['items'][1]['error'], st['items'][1]['error'])
        check('item 3 não foi enviado', st['items'][2]['status'] == 'pendente' and len(sent_log(page)) == 2)
        page.evaluate("() => window.mock.modes[2] = 'image'")  # a próxima resposta (reenvio do item 2) gera imagem
        check('retry individual aceito', cmd(page, {'type': 'retry', 'index': 1})['ok'])
        st = wait_queue(page, ['paused'])
        check('item 2 concluído após retry; item 3 segue pendente', st['items'][1]['status'] == 'concluido' and st['items'][2]['status'] == 'pendente')
        page.evaluate("() => window.mock.modes[3] = 'image'")
        cmd(page, {'type': 'continue'})
        st = wait_queue(page, ['finished'])
        check('continuar finaliza a fila', all(i['status'] == 'concluido' for i in st['items']))
        page.close()

        # 4) limite de utilização
        print('4) Aviso de limite de utilização')
        page = fresh_page(browser, ['1. A\ntexto', '2. B\ntexto'], modes=['limit'])
        cmd(page, {'type': 'start'})
        st = wait_queue(page, ['error'])
        check('detectou limite e parou', 'Limite' in st['items'][0]['error'] and len(sent_log(page)) == 1, st['items'][0]['error'])
        page.close()

        # 5) recarregar a página no meio da execução
        print('5) Recarregar a aba durante a geração')
        page = fresh_page(browser, [f'{i}. Item {i}\ntexto {i}' for i in range(1, 4)], gen_ms=2500)
        cmd(page, {'type': 'start'})
        page.wait_for_function("() => window.__log.some(e => e.ev === 'user_sent')")
        page.reload()
        page.evaluate("m => { window.mock.genMs = 800; }")
        load_engine(page)
        page.wait_for_timeout(600)
        st = get_state(page)
        check('fila pausada após recarregar', st['queue'] == 'paused', st['queue'])
        check('item em andamento NÃO foi marcado como concluído', st['items'][0]['status'] == 'erro')
        check('nada foi reenviado após recarregar', len(sent_log(page)) == 0)
        check('itens restantes preservados como pendentes', [i['status'] for i in st['items'][1:]] == ['pendente', 'pendente'])
        cmd(page, {'type': 'continue'})
        st = wait_queue(page, ['finished'])
        check('continuar retoma do próximo pendente (itens 2 e 3)', len(sent_log(page)) == 2 and st['items'][1]['status'] == 'concluido' and st['items'][2]['status'] == 'concluido')
        page.close()

        # 6) cancelar durante a geração
        print('6) Cancelar durante a geração')
        page = fresh_page(browser, [f'{i}. Item {i}\ntexto {i}' for i in range(1, 4)], gen_ms=3000)
        cmd(page, {'type': 'start'})
        page.wait_for_function("() => window.__log.some(e => e.ev === 'user_sent')")
        cmd(page, {'type': 'cancel'})
        st = wait_queue(page, ['cancelled'])
        check('cancelado com segurança, item atual sem conclusão confirmada', st['items'][0]['status'] == 'erro' and st['items'][1]['status'] == 'pendente')
        page.wait_for_timeout(1200)
        check('nenhum envio após cancelar', len(sent_log(page)) == 1)
        page.close()

        # 7) campo de mensagem ausente
        print('7) Interface sem campo de mensagem')
        page = fresh_page(browser, ['1. A\ntexto'])
        page.evaluate("() => document.getElementById('composer').remove()")
        cmd(page, {'type': 'start'})
        st = wait_queue(page, ['error'], timeout=30)
        check('erro claro e item continua pendente', 'Campo de mensagem' in st['queueMessage'] and st['items'][0]['status'] == 'pendente', st['queueMessage'])
        page.close()

        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} verificações passaram")
    sys.exit(1 if failed else 0)

run()
