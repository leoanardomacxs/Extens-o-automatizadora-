# Nautilus – Fila de Imagens para ChatGPT

Extensão do Chrome (Manifest V3) que recebe um texto com vários prompts numerados, separa cada um e
gera as imagens **uma por vez** na interface normal do ChatGPT (sua conta já logada). Só envia o
próximo prompt depois que a imagem anterior foi realmente gerada. Sem API paga, sem servidor, sem
bibliotecas externas.

## Instalar (modo desenvolvedor)

1. Descompacte o ZIP numa pasta que você vá manter (o Chrome lê a extensão direto dela).
2. No Chrome, abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta `nautilus-image-automation`
   (a que contém o `manifest.json`).
5. (Opcional) Fixe a extensão pelo ícone de quebra-cabeça da barra do Chrome.

Se o ChatGPT já estava aberto antes de instalar, **recarregue a aba (F5)**.

## Usar

1. Abra `https://chatgpt.com`, entre na sua conta e deixe o ChatGPT pronto para gerar imagens
   (por exemplo, selecione **Criar imagem** no menu "+", ou use prompts que peçam imagem).
   Dica: abra uma conversa nova para a fila.
2. Clique no ícone da extensão e cole o texto com os prompts numerados (veja `exemplo-prompts.txt`).
3. Clique em **Analisar prompts**. Confira a quantidade e clique em qualquer item da fila para ver o texto
   separado. Se houver erro de estrutura, corrija e analise de novo; a fila não inicia com prompts duvidosos.
4. Clique em **Iniciar**. Você pode fechar o popup; a fila continua enquanto a aba do ChatGPT estiver aberta.

Controles:

- **Pausar**: não envia novos prompts; se uma imagem está sendo gerada, ela termina antes de a fila parar.
- **Continuar**: retoma do próximo item pendente.
- **Cancelar**: interrompe. Se havia uma imagem em geração, ela fica como "erro" (conclusão não confirmada).
- **Reiniciar fila**: pede confirmação, apaga o progresso e volta todos os itens a "pendente".
- **Tentar novamente** (dentro de um item com erro): reenvia só aquele item.

## Formato dos prompts

Cada item começa numa linha com `1.` ou `1)`, `2.`, `3.`… em sequência. Tudo até o próximo número da
sequência pertence ao item e é enviado **exatamente como escrito** (inclusive a linha do título).

```
1. O Baú Perdido
Descrição: ...
Prompt: ...

2. O Tesouro Esquecido
...
```

Números dentro do texto (`1024x1536`, `300 DPI`, `3.5 mm`) não atrapalham. Uma lista numerada dentro de um
prompt é tratada como conteúdo, e gera um aviso, exceto quando ela continua exatamente a sequência
(ex.: um "2." logo no item 1); nesse caso o parser avisa quando falta linha em branco antes dele,
mas a conferência final é sua, na lista da fila.

## Como a conclusão é detectada

Uma imagem só conta como concluída quando **todos** estes sinais aparecem: existe uma imagem nova
após a mensagem enviada, ela terminou de carregar, o botão "parar" do ChatGPT sumiu há alguns segundos e a
página parou de mudar. Texto sem imagem **não** conta. Em caso de dúvida a fila pausa; ela nunca avança
"no chute".

A fila para (preservando o progresso) quando: a resposta vem só em texto, aparece aviso de limite de uso ou de
erro, o envio não é confirmado, a geração passa de 12 minutos, a conexão cai, a sessão expira ou o campo de
mensagem não é encontrado. Não há tentativas automáticas, para não duplicar imagens nem gastar seu limite.

## Persistência

O estado (texto, prompts, ordem, status, índice atual, datas) fica em `chrome.storage.local`. Fechar o popup não
afeta a fila. Se a aba for recarregada/fechada ou o navegador reiniciar, a fila fica **pausada** e o item que estava
em andamento aparece como erro ("conferir no ChatGPT"); nada é reenviado sozinho. Abra o ChatGPT e clique em **Continuar**.

## Limitações

- A extensão lê a página do ChatGPT. Se o ChatGPT mudar a interface, a detecção pode falhar; nesse caso a fila pausa
  com mensagem clara. Os seletores e tempos estão no topo de `content.js` (`CFG` e funções `find*`).
- Mantenha a aba do ChatGPT aberta, de preferência visível (pode ser numa janela separada). O Chrome desacelera
  abas em segundo plano por muito tempo e isso pode atrasar cada etapa.
- Toda a fila roda numa só conversa. Em filas longas (50+), a conversa fica pesada e o contexto de imagens anteriores
  pode influenciar as seguintes.
- A extensão não contorna limites de uso, login, CAPTCHA ou restrições do ChatGPT.

## Solução de problemas

| Sintoma | O que fazer |
|---|---|
| "Não consegui falar com a aba do ChatGPT" | Recarregue a aba do ChatGPT (F5) e tente de novo. |
| "Campo de mensagem não localizado" | Aguarde a página carregar, confira o login e clique em Continuar. |
| "Respondeu só com texto" | O ChatGPT não entendeu como pedido de imagem. Selecione "Criar imagem" ou ajuste o prompt e use Tentar novamente. |
| "Limite de utilização" | Aguarde o limite liberar e clique em Continuar. |
| "Envio não confirmado" | Veja no ChatGPT se o prompt foi enviado antes de tentar novamente. |
| Fila "Pausada" depois de reiniciar/recarregar | Normal. Confira a última imagem e clique em Continuar. |
| Item conclui cedo demais ou nunca conclui | Ajuste os tempos/seletores em `content.js` e me envie o caso. |

## Testes

```
node tests/parser.test.js        # parser: 5/50/100 prompts, limites, preservação do texto, erros
python3 tests/integration.py     # motor da fila contra uma página SIMULADA do ChatGPT (precisa de Playwright)
```

O teste de integração usa `tests/mock-chatgpt.html`, uma página que imita a estrutura que a extensão espera.
Ele valida a lógica (sequência, pausa/retomada, erros, recarga, ausência de duplicatas), **não** o ChatGPT real.

## Arquivos

`manifest.json` · `popup.html/css/js` (interface) · `content.js` (motor da fila na aba do ChatGPT) ·
`background.js` (selo no ícone e recuperação ao iniciar o navegador) · `parser.js` (separação dos prompts) ·
`state.js` (formato do estado) · `icons/` · `exemplo-prompts.txt` · `tests/`
