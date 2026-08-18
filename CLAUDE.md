# Petabyte — contexto do projeto

Loja de tecnologia e eletrônicos. Este arquivo existe para que o raciocínio por
trás das decisões sobreviva à troca de contexto: se você está lendo isto sem ter
acompanhado o histórico, comece por aqui.

**Repositório:** https://github.com/Carl0sNeto/petabyte (público)
**Última revisão deste documento:** 17/08/2026

---

## Stack

| Camada | Tecnologia |
|--------|------------|
| Servidor | Node.js + Express 5, arquivo único `server.js` |
| Banco | PostgreSQL, acesso via `pg` sem ORM |
| Front-end | HTML + CSS + JavaScript puro, sem framework nem build |
| Pagamento | Mercado Pago (Checkout Pro, por redirecionamento) |
| Autenticação | JWT próprio, senha com bcrypt |
| Testes | `node:test` nativo, sem dependência extra |

Não há etapa de build. Os arquivos em `public/` são servidos como estão.

## Comandos

```bash
npm start           # sobe na porta 3000
npm test            # 41 testes, em série, contra o banco real
npm run migrate     # aplica migrations/*.sql em ordem
npm run criar-admin -- email@exemplo.com    # promove uma conta a administrador
```

## Convenções

- **Código e comentários em português.** Nomes de função, variável e mensagem
  seguem o idioma do projeto (`resolverItensCarrinho`, `exigirAdmin`).
- **Migrations são idempotentes.** O runner não guarda registro do que já rodou;
  cada arquivo precisa poder ser executado de novo sem efeito colateral.
- **Comentário explica o porquê, não o quê.** Vários trechos do código carregam
  a razão da decisão, porque ela não é óbvia pela leitura.

---

## Decisões estruturais e o motivo delas

### O servidor nunca aceita preço do cliente

**A falha original:** o checkout montava a preferência do Mercado Pago com o
`unit_price` recebido no corpo da requisição. Como o carrinho vive no
`localStorage`, bastava editá-lo no DevTools para comprar qualquer produto por
R$ 0,01. O pedido era gravado como legítimo e o webhook o marcava como pago.

**A causa raiz era estrutural:** não existia tabela de produtos. Os preços eram
texto em `E-Commerce.html`, então o servidor não tinha contra o que validar.

**Como está hoje:** o cliente envia apenas `{ id, quantidade }`. O servidor lê
nome e preço da tabela `produtos` em `resolverItensCarrinho()` e descarta
qualquer preço recebido. O carrinho no navegador não guarda preço nenhum.

> Nunca reintroduza preço, nome ou total vindos do cliente em rota de pagamento.

### Baixa de estoque é idempotente

`/pagamentos/confirmar` e o webhook podem processar a mesma notificação. A baixa
roda em transação com `SELECT ... FOR UPDATE` e é controlada pela flag
`pedidos.estoque_baixado`. Estorno, cancelamento e chargeback devolvem as
unidades. Se faltar saldo no momento da aprovação, registra aviso em log para
revisão manual em vez de falhar — o pagamento já foi aprovado nesse ponto.

### Permissão de administrador é conferida no banco, a cada requisição

`exigirAdmin` consulta `usuarios.admin` em vez de ler do JWT. Isso torna a
revogação imediata: um token emitido antes da revogação para de funcionar na
hora, sem esperar as 2h de expiração.

Ninguém vira admin sozinho: o cadastro público sempre grava `FALSE` e a promoção
passa por `npm run criar-admin`, que exige acesso ao servidor.

> Esconder a interface no navegador é conveniência de usabilidade, não
> segurança. A proteção real são os middlewares.

### Assinatura do webhook é opcional, de propósito

Sem `MP_WEBHOOK_SECRET` definido, a validação HMAC é pulada e um aviso vai para
o log. Foi escolha consciente para não derrubar o webhook em produção. O risco é
baixo porque o handler refaz o `payment.get()` na API do Mercado Pago e nunca
confia no corpo recebido — forjar uma notificação não cria pagamento.

### Categorias são planas, com slug e rótulo juntos

A constante `CATEGORIAS` em `server.js` guarda `{ slug, rotulo }`. O banco
armazena o slug; a interface mostra o rótulo. Manter os dois no mesmo lugar
evita que a loja e o painel inventem traduções próprias.

`GET /produtos` devolve só as categorias que têm produto à venda, e a loja monta
os filtros a partir daí. Não há categoria fixa no HTML.

### Nada de diálogos nativos do navegador

`window.confirm()` e `alert()` podem ser **suprimidos** pelo navegador — o
Chrome oferece "Impedir que esta página crie diálogos adicionais" após alguns
seguidos, e navegadores embarcados suprimem por padrão. Suprimido, `confirm()`
devolve `false` em 1 milissegundo sem perguntar nada.

Isso já causou um bug real: o botão Excluir do painel não fazia absolutamente
nada, sem erro nem mensagem, porque o código lia esse `false` como cancelamento.

O painel usa `confirmar()`, baseado no elemento `<dialog>`. **Pendência
conhecida:** a loja ainda tem 19 chamadas a `alert()` em `public/script.js`,
sujeitas ao mesmo problema.

### `express.static` serve apenas `public/`

Já serviu `__dirname`, expondo `server.js`, `package.json`, o schema SQL e todo
o `node_modules` por HTTP. Use a opção `index: 'E-Commerce.html'` porque não há
`index.html`.

### Imagens da vitrine não usam `loading="lazy"`

A vitrine é a primeira coisa que o visitante vê; adiar essas imagens atrasa
justamente o que importa na tela. Com catálogo pequeno não há o que economizar.

### A porta 3000 é obrigatória

`APP_BASE_URL=http://localhost:3000` alimenta os links de redefinição de senha e
as `back_urls` do Mercado Pago. Em outra porta, esses links apontam para o lugar
errado. Para testes paralelos, use portas alternativas (3100, 3200).

> Antes de encerrar qualquer `node.exe` na 3000, verifique o processo pai — pode
> ser o servidor do Carlos rodando no terminal do VS Code, não sobra de teste.

---

## Testes

São **de integração**: batem no banco configurado no `.env`, não em mocks.

- Rodam em série (`--test-concurrency=1`).
- As fixtures usam prefixo com o **pid do processo**. O runner do Node executa
  cada arquivo em um processo separado; com prefixo comum, o `limpar()` de um
  arquivo apagava as fixtures do outro e os `DELETE` concorrentes travavam em
  deadlock.
- `tests/admin.test.js` sobe o app Express numa porta efêmera, sem abrir 3000.

O teste mais importante é o que envia preço adulterado no checkout e verifica
que o servidor usa o preço do banco. Ele existe para impedir a regressão da
falha que originou boa parte deste projeto.

---

## Front-end

- `public/estilos.css` — sistema de design compartilhado por todas as páginas.
  Base marinho, azul para ações, **laranja exclusivo para preço e oferta**.
  Diluir o laranja em outros elementos mata o destaque.
- `public/admin.css` — só o que é exclusivo do painel: tabelas densas, modais,
  selos, miniaturas. Carrega **depois** de `estilos.css` e reaproveita os tokens.
- O painel mantém fonte menor e tabelas mais densas de propósito: é operado por
  varredura, não lido como a vitrine.
- Tudo que vem da API passa por `escapeHtml()` antes de entrar no DOM.

---

## Segurança — histórico

O `.env` completo já foi commitado em repositório público. Foram rotacionadas as
chaves do Mercado Pago, a `PGPASSWORD`, a `SMTP_PASS` e o `JWT_SECRET`. Apagar o
repositório antigo **não** garante remoção: bots indexam commits públicos em
segundos e forks sobrevivem à exclusão.

Se aparecer comportamento estranho em contas, e-mails ou pagamentos, este
vazamento é o primeiro suspeito.

Proteções em vigor: `helmet` com CSP, rate limit em login, recuperação de senha,
cadastro, painel e webhook; `JWT_SECRET` obrigatório com mínimo de 32
caracteres; `UNIQUE` em `usuarios.email`.

---

## Pendências conhecidas

1. **19 `alert()` na loja** (`public/script.js`) — mesmo bug de supressão que
   quebrou o botão Excluir. Afeta mensagens de carrinho vazio, falha de
   pagamento e confirmação de compra.
2. **`MP_WEBHOOK_SECRET` ausente do `.env`** — a variável nem existe no arquivo,
   então o webhook aceita notificações sem verificar assinatura. O código da
   validação HMAC já está pronto; falta só preencher com o segredo do painel do
   Mercado Pago.
3. **`.env.bak` no disco** com o `JWT_SECRET` antigo comprometido. Está fora do
   Git, mas deveria ser apagado.
4. **Push protection do GitHub** — recomendada, nunca confirmada.
5. **Branches mescladas** `feat/painel-admin` e `melhorias/catalogo-seguro`
   ainda existem, local e remotamente.
6. **`.env.example` linha 20** tem um comentário residual de contorno
   (`#Apenas alteração para que eu consiga fazer commit`). Para commit sem
   mudanças reais, use `git commit --allow-empty`.

> O catálogo é editado pelo painel e muda com frequência. Confira o estado real
> no banco antes de afirmar quantidades — não confie em números escritos aqui.

---

## Sobre o Claude Cookbooks

O repositório `claude-cookbooks-main` foi avaliado em 17/08/2026 para uso neste
projeto. **Conclusão: não se aplica ao código atual.**

Ele ensina a construir aplicações que *chamam a API do Claude* — RAG,
embeddings, classificação, tool use, agentes — em Python e notebooks Jupyter.
Não contém material sobre Node, Express, PostgreSQL, CSS ou e-commerce. Nenhuma
receita dele foi incorporada, e seguir suas orientações não melhoraria o código
que existe aqui.

Ele **passa a ser relevante** apenas se o projeto ganhar recursos de IA. Neste
caso, o mapa é:

| Se você quiser | Pasta do cookbook |
|----------------|-------------------|
| Busca por linguagem natural no catálogo | `capabilities/text_to_sql` |
| Busca semântica ("placa boa pra jogos") | `capabilities/retrieval_augmented_generation`, `contextual-embeddings` |
| Categorizar produto novo automaticamente | `capabilities/classification` |
| Gerar descrição a partir da ficha técnica | `capabilities/summarization` |
| Moderar avaliações de clientes | `capabilities/content_moderation` |

Qualquer um desses seria um recurso **novo**, com custo por chamada de API e uma
chave a mais no `.env` — não uma melhoria do que já está pronto.
