// Testes do parser (Node, sem dependências): node tests/parser.test.js
const assert = require('assert');
const { parse } = require('../parser.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FALHOU ' + name + '\n   ' + e.message); process.exitCode = 1; }
}

// Gera N blocos "n. Título\nDescrição...\nPrompt..." com números "perigosos" dentro do texto.
function makeBlock(n, style) {
  if (style === 'B') {
    return `${n}) Carta ${n}\nIlustração vertical, 1024x1536, 300 DPI, margem de 3.5 mm.\n${n * 7} peças de ouro e 12 moedas.`;
  }
  const inner = n >= 3 ? '\nElementos:\n1. baú\n2. mapa\n3. bússola' : '';
  return `${n}. Carta ${n}\nDescrição: cena número ${n}.\nPrompt: Ilustração em ${2000 + n} px, estilo aquarela.${inner}\nFormato 63x88 mm, 2 cm de sangria.`;
}
function makeText(count, style, sep = '\n\n') {
  const blocks = [];
  for (let i = 1; i <= count; i++) blocks.push(makeBlock(i, style));
  return { blocks, text: blocks.join(sep) };
}

console.log('Parser');

for (const n of [5, 50, 100]) {
  test(`importa ${n} prompts e preserva o texto integralmente`, () => {
    const { blocks, text } = makeText(n, 'A');
    const r = parse(text);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(r.items.length, n);
    r.items.forEach((it, i) => {
      assert.strictEqual(it.number, i + 1);
      assert.strictEqual(it.text, blocks[i], `texto do item ${i + 1} alterado`);
    });
  });
}

test('formato com parênteses "1)" e linhas com números soltos', () => {
  const { blocks, text } = makeText(10, 'B');
  const r = parse(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 10);
  assert.deepStrictEqual(r.items.map(i => i.text), blocks);
});

test('listas numeradas internas (1. 2. 3.) não criam itens novos e geram aviso', () => {
  const { text } = makeText(6, 'A');
  const r = parse(text);
  assert.strictEqual(r.items.length, 6);
  assert.ok(r.warnings.some(w => /já usado/.test(w)));
});

test('separador de um único \\n entre itens também funciona', () => {
  const { blocks, text } = makeText(8, 'B', '\n');
  const r = parse(text);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items.map(i => i.text), blocks);
});

test('CRLF (Windows) é aceito', () => {
  const { text } = makeText(5, 'A');
  const r = parse(text.replace(/\n/g, '\r\n'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 5);
  assert.ok(!r.items[0].text.includes('\r'));
});

test('título em linha própria após o número e marcadores markdown', () => {
  const r = parse('**1. O Baú Perdido**\nTexto A\n\n**2. O Tesouro Esquecido**\nTexto B\n\n3.\nA Bússola do Capitão\nTexto C');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items.map(i => i.title), ['O Baú Perdido', 'O Tesouro Esquecido', 'A Bússola do Capitão']);
});

test('preserva linhas em branco internas, indentação e acentos', () => {
  const body = '1. Título\n  linha indentada\n\nparágrafo 2 — “aspas” e ção\n';
  const r = parse(body + '\n2. Outro\ntexto');
  assert.strictEqual(r.items[0].text, '1. Título\n  linha indentada\n\nparágrafo 2 — “aspas” e ção');
});

test('números que não são marcadores ("3.5 mm", "2024", "10 cm") não separam itens', () => {
  const r = parse('1. A\n3.5 mm de borda\n2024 foi o ano\n10 cm\n\n2. B\ntexto');
  assert.strictEqual(r.items.length, 2);
});

test('erro: salto na numeração (1, 2, 4)', () => {
  const r = parse('1. A\ntexto\n\n2. B\ntexto\n\n4. D\ntexto');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /esperado era 3/.test(e)));
});

test('erro: nenhum prompt numerado', () => {
  const r = parse('só um texto qualquer\nsem numeração');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.items.length, 0);
});

test('erro: texto vazio', () => {
  assert.strictEqual(parse('').ok, false);
  assert.strictEqual(parse('   \n  ').ok, false);
});

test('erro: item vazio', () => {
  const r = parse('1. A\ntexto\n\n2.\n\n3. C\ntexto');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /item 2/.test(e) && /vazio/.test(e)));
});

test('numeração que não começa em 1 é bloqueada', () => {
  const r = parse('2. A\ntexto\n\n3. B\ntexto');
  assert.strictEqual(r.ok, false);
});

test('aviso: texto antes do item 1 é ignorado', () => {
  const r = parse('Aqui estão os prompts:\n\n1. A\ntexto\n\n2. B\ntexto');
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some(w => /antes do item 1/.test(w)));
  assert.ok(!r.items[0].text.includes('Aqui estão'));
});

test('aviso: lista interna que continua a sequência (ambiguidade) é sinalizada', () => {
  // item 2 contém "3. x" colado, sem linha em branco: o parser divide, mas avisa.
  const txt = ['1. A\ntexto', '2. B\ntexto\n3. isto parece lista interna', '4. D\ntexto', '5. E\ntexto'].join('\n\n');
  const r = parse(txt.replace('\n3. isto parece lista interna', '\n3. isto parece lista interna'));
  assert.ok(r.warnings.some(w => /não tem linha em branco/.test(w)));
});

test('ordem original preservada e sem itens duplicados', () => {
  const { text } = makeText(100, 'A');
  const r = parse(text);
  const nums = r.items.map(i => i.number);
  assert.deepStrictEqual(nums, Array.from({ length: 100 }, (_, i) => i + 1));
  assert.strictEqual(new Set(r.items.map(i => i.id)).size, 100);
});

console.log(`\n${passed} testes passaram` + (process.exitCode ? ' — HÁ FALHAS' : ''));
