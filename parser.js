// parser.js — separa um texto único em prompts numerados, sem alterar o conteúdo.
//
// Regra de segurança: um novo item só começa numa linha que inicia com "N." ou "N)"
// quando N é exatamente o próximo número esperado (1, 2, 3, ...). Assim, números dentro
// dos prompts ("1024x1536", "300 DPI", "3.5 mm", listas internas "1. 2. 3.") não quebram
// a divisão. Situações duvidosas viram erro (bloqueia) ou aviso (mostra e deixa conferir).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromptParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Opcional: marcadores markdown antes do número ("**1. Título**", "# 1. Título").
  // O número precisa ser seguido de "." ou ")" e depois espaço/fim de linha — por isso
  // "3.5 mm" e "2024" não contam.
  const HEADER_RE = /^[ \t]*(?:[#>*_]+[ \t]*)*(\d{1,3})[ \t]*([.)])(?=[ \t]|$)[ \t]*(.*)$/;

  function cleanTitle(s) {
    return String(s || '').replace(/[*_#`]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parse(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const out = { ok: false, total: 0, items: [], warnings: [], errors: [] };

    let expected = 1;
    let cur = null;
    const blocks = [];
    const preamble = [];

    lines.forEach((line, idx) => {
      const m = HEADER_RE.exec(line);
      if (m) {
        const num = parseInt(m[1], 10);
        const marker = m[1] + m[2];
        if (num === expected) {
          cur = {
            number: num,
            startLine: idx + 1,
            headerRest: m[3],
            lines: [line],
            blankBefore: idx === 0 || lines[idx - 1].trim() === ''
          };
          blocks.push(cur);
          expected++;
          return;
        }
        if (num > expected) {
          out.errors.push(
            `Linha ${idx + 1} começa com "${marker}", mas o próximo número esperado era ${expected}. ` +
            `Há um número faltando ou repetido na sequência. Corrija o texto antes de iniciar.`
          );
        } else if (cur) {
          out.warnings.push(
            `Linha ${idx + 1} começa com "${marker}" (número já usado) e foi tratada como parte do item ${cur.number}.`
          );
        }
      }
      if (cur) cur.lines.push(line);
      else preamble.push(line);
    });

    if (preamble.some(l => l.trim() !== '')) {
      out.warnings.push('Há texto antes do item 1. Ele foi ignorado e não será enviado ao ChatGPT.');
    }

    if (blocks.length === 0) {
      out.errors.push('Nenhum prompt numerado foi encontrado. Use o formato "1. Título" (ou "1) Título"), começando em 1.');
      return out;
    }

    // Consistência: se quase todos os itens são precedidos de linha em branco, um item
    // sem linha em branco antes pode ser, na verdade, uma lista numerada dentro do prompt.
    const withBlank = blocks.filter(b => b.blankBefore).length;
    if (blocks.length >= 3 && withBlank / blocks.length > 0.5) {
      blocks.forEach(b => {
        if (!b.blankBefore) {
          out.warnings.push(
            `O item ${b.number} (linha ${b.startLine}) não tem linha em branco antes, ao contrário dos demais. ` +
            `Confira se não é uma lista numerada dentro do prompt anterior.`
          );
        }
      });
    }

    for (const b of blocks) {
      // remove só linhas em branco nas pontas; o conteúdo interno fica intacto
      const ls = b.lines.slice();
      while (ls.length && ls[ls.length - 1].trim() === '') ls.pop();
      const body = ls.join('\n');

      let title = cleanTitle(b.headerRest);
      if (!title) {
        const next = ls.slice(1).find(l => l.trim() !== '');
        title = cleanTitle(next || '');
      }
      const hasContent = ls.slice(1).some(l => l.trim() !== '') || cleanTitle(b.headerRest) !== '';
      if (!hasContent) {
        out.errors.push(`O item ${b.number} (linha ${b.startLine}) está vazio.`);
      }
      out.items.push({
        id: 'p' + b.number,
        number: b.number,
        title: title || `Item ${b.number}`,
        text: body,
        startLine: b.startLine
      });
    }

    out.total = out.items.length;
    out.ok = out.errors.length === 0 && out.items.length > 0;
    return out;
  }

  return { parse };
});
