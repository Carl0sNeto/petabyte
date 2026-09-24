# Petabyte — contexto do projeto

Loja de tecnologia e eletrônicos. Este arquivo existe para que o raciocínio por
trás das decisões sobreviva à troca de contexto: se você está lendo isto sem ter
acompanhado o histórico, comece por aqui.

O companheiro dele é o [`DATABASE.md`](DATABASE.md), que descreve as tabelas
coluna a coluna, a taxonomia de categorias, as 7 migrations e como criar o
primeiro administrador. Aqui ficam as decisões e o porquê; lá, o schema.

**Repositório:** https://github.com/Carl0sNeto/petabyte (público)
**Última revisão deste documento:** 23/09/2026 (sessão em cookies httpOnly com
refresh token).

> A data acima já ficou parada em 17/08 enquanto o corpo do arquivo era alterado
> em 22/08 e 09/09. Se você mexer neste documento, mexa nesta linha junto.

---

## Stack

| Camada | Tecnologia |
|--------|------------|
| Servidor | Node.js 24 + Express 5, arquivo único `server.js` (~2.830 linhas) |
| Banco | PostgreSQL, acesso via `pg` sem ORM |
| Front-end | HTML + CSS + JavaScript puro, sem framework nem build |
| Pagamento | Mercado Pago (Checkout Pro, por redirecionamento) |
| Autenticação | JWT de 15 min + refresh token rotativo, ambos em cookie httpOnly; senha com bcrypt |
| Testes | `node:test` nativo, sem dependência extra |

Não há etapa de build. Os arquivos em `public/` são servidos como estão.

A versão do Node está fixada em `engines: { node: "24.x" }` no `package.json`,
para que o Render não escolha outra por conta própria entre um deploy e o
seguinte.

## Comandos

```bash
npm start           # sobe na porta 3000
npm test            # 87 casos, em série, contra o banco real
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
- **Commit sem mudança real usa `git commit --allow-empty`.** O `.env.example`
  já carregou um comentário inventado só para o arquivo ficar sujo e o commit
  passar; foi limpo em 22/08. Não repita o contorno.

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
hora, sem esperar os 15 minutos de expiração do access token.

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

### O desconto anunciado arredonda para baixo

O selo aparece quando `preco_original > preco`, com o percentual por
`Math.floor`: um desconto real de 14,6% vira "-14%", nunca "-15%". Anunciar
mais do que o real é propaganda enganosa, então a conta erra sempre a favor de
subestimar. O painel, por sua vez, recusa `preco_original` menor ou igual ao
preço.

A conta é feita em **centavos inteiros**. Em ponto flutuante,
`(1 - 80 / 100) * 100` dá `19.999999999999996`, e o floor transformaria 20% reais
em "-19%". Abaixo de 1% o preço antigo aparece riscado, mas sem selo — "-0%"
não é selo que se mostre.

A regra mora **só** em `calcularDescontoPercentual()` e `renderDesconto()`, em
`public/script.js`, usadas pelo card da vitrine e pela página de produto. O
servidor devolve `preco` e `precoOriginal` e não calcula percentual — já
calculou, com `Math.round`, e era a segunda cópia divergente da regra.

> Para leitor de tela o riscado é `<del>` com texto oculto ("Preço original:"),
> não `aria-label`: a especificação ARIA proíbe nome acessível em `<del>` e em
> `<span>`, e os leitores o ignoram ali. O "-21%" visual fica `aria-hidden` —
> colado no preço, seria lido como subtração.

### Nada de diálogos nativos do navegador

`window.confirm()` e `alert()` podem ser **suprimidos** pelo navegador — o
Chrome oferece "Impedir que esta página crie diálogos adicionais" após alguns
seguidos, e navegadores embarcados suprimem por padrão. Suprimido, `confirm()`
devolve `false` em 1 milissegundo sem perguntar nada.

Isso já causou um bug real: o botão Excluir do painel não fazia absolutamente
nada, sem erro nem mensagem, porque o código lia esse `false` como cancelamento.

O painel usa `confirmar()`, baseado no elemento `<dialog>`. As páginas escritas
depois seguiram a regra: `admin.js`, `produto.js` e `conta.js` têm **zero**
chamadas a `alert()` — `conta.js` avisa pela caixa `#avisoConta` na própria
página.

**Pendência conhecida:** `public/script.js` ainda tem 19 chamadas a `alert()`,
sujeitas ao mesmo problema. É o único arquivo que falta converter.

### Só quem comprou avalia

`comprouOProduto()` procura um pedido com status `Pago` do usuário contendo
aquele `produto_id`. A mesma consulta decide se o formulário aparece **e** se o
POST é aceito — um cliente adulterado que poste direto no endpoint recebe 403.

O autor é exibido abreviado (`João S.`), nunca o nome completo nem o e-mail.
A constraint `UNIQUE (produto_id, usuario_id)` faz o reenvio substituir a
avaliação anterior em vez de acumular.

São cinco rotas: `GET /produtos/:id/avaliacoes` (lista pública),
`GET /produtos/:id/avaliacoes/minha` (para o formulário vir preenchido),
`POST` e `DELETE /produtos/:id/avaliacoes/minha`, e `GET /auth/me/avaliacoes`,
que alimenta a aba da central da conta. A última traz o produto junto, e devolve
`ativo` para que um item tirado do catálogo continue listado — sem link, mas
sem sumir do histórico de quem escreveu.

> Consequência do deploy de demonstração: com `CHECKOUT_HABILITADO=false`
> ninguém consegue comprar, logo ninguém consegue avaliar. A página avisa isso
> em vez de deixar a seção vazia sem explicação.

### Carrinho e conta ficam fora do `<nav>`

No celular a navegação vira faixa rolável com `overflow-x: auto`, e **overflow
recorta qualquer painel suspenso dentro dele**. Com o menu da conta dentro do
`<nav>`, o botão abria (`aria-expanded` mudava) e nada aparecia na tela.

Por isso `.topo-acoes` é irmão do `<nav>`, não filho. Semanticamente também é
mais correto: carrinho e conta são ações, não links de navegação.

### Trocar senha exige a senha atual

`POST /auth/alterar-senha` confere a senha antiga com bcrypt antes de gravar a
nova. Sem isso, um token vazado — sessão esquecida em máquina compartilhada —
bastaria para tomar a conta, porque o JWT sozinho já autoriza tudo.

O e-mail não é editável: é a identidade de login, e trocá-lo com segurança
exigiria confirmação por link, que não funciona sem SMTP configurado.

Trocar a senha **derruba as outras sessões**: revoga todos os refresh tokens da
pessoa e abre uma sessão nova só para o navegador que trocou. Os outros
dispositivos ainda têm o access token, que não se revoga, e caem em até 15
minutos — a resposta diz exatamente isso, sem prometer "na hora". Redefinir a
senha pelo e-mail revoga tudo, porque esse é o caminho de quem perdeu o
controle da conta.

### Sessão em cookies httpOnly, com refresh token rotativo

O JWT saiu do `localStorage` e do header `Authorization`. Agora:

| Cookie | httpOnly | Path | Dura | O que é |
|--------|----------|------|------|---------|
| `access_token` | sim | `/` | 15 min | JWT `{ id, email }`, lido por `autenticarToken`. Não se revoga |
| `refresh_token` | sim | `/auth` | 30 dias | Aleatório; só o SHA-256 fica em `refresh_tokens` |
| `csrf_token` | **não** | `/` | 30 dias | Double-submit: o front o devolve no header `X-CSRF-Token` |

Todos com `SameSite=Lax` e `Secure` quando `NODE_ENV=production`. `Lax`, e não
`Strict`, porque a volta do Mercado Pago é navegação vinda de outro domínio, e
com `Strict` a pessoa chegaria deslogada exatamente ao voltar de pagar.

Decisões que não são óbvias, e onde o desenho saiu da spec original:

- **`Path=/auth`, não `/auth/refresh`.** O logout precisa ler o refresh token
  para revogá-lo, e com `Path=/auth/refresh` o navegador nunca o mandaria para
  `/auth/logout`.
- **CSRF só com cookie de sessão presente.** CSRF é abuso da credencial que o
  navegador anexa sozinho; sem cookie de sessão não há o que abusar, e a rota
  responde 401, o que deixa o front renovar em vez de mostrar um 403 sem sentido.
  As rotas de entrada (`/auth/login`, `/auth/cadastro`, `/usuarios`, recuperação
  e redefinição de senha, webhook) ficam isentas: o `csrf_token` nasce no login,
  e exigi-lo no próprio login impediria o primeiro acesso.
- **Reuso só conta para token rotacionado.** Apresentar um refresh token que já
  foi *trocado por outro* é sinal de cópia: derruba todas as sessões. Um token
  revogado por logout ou troca de senha é só sessão encerrada — tratá-lo como
  reuso fazia o dispositivo que ficou para trás derrubar a sessão nova de quem
  acabou de trocar a senha. A coluna `substituido_por` é o que distingue os dois.
- **Janela de corrida de 60 segundos.** Duas abas com o access vencido mandam o
  mesmo refresh token juntas; a segunda recebe 401 sem derrubar nada, e usa os
  cookies que a primeira já renovou. Nenhum token novo sai nesse caso.
- **Logout sem `autenticarToken`.** Sair precisa funcionar com o access token já
  vencido; a sessão é identificada pelo próprio cookie de refresh.
- **Prazos comparados no banco.** `expira_em` e `revogado_em` vêm de `NOW()`, e
  as comparações também. Misturar relógio do Node com `TIMESTAMP` sem fuso daria
  horas de erro com processo e banco em fusos diferentes (Render e Neon em UTC,
  máquina local em -03:00).

> O `localStorage` guarda só `petabyte-user` (nome, e-mail, id), como cache de
> exibição do cabeçalho. `hasValidSession()` é otimista por isso; quem decide é
> o servidor, na primeira rota autenticada que a página chamar.

### O token de recuperação é tratado como senha

Enquanto vale (30 minutos), o token do e-mail troca a senha da conta. Por isso
`password_resets.token` guarda o **SHA-256** dele, nunca o valor bruto: um dump
do banco não dá acesso a conta nenhuma. SHA-256 sem sal basta porque o token
tem 256 bits aleatórios; bcrypt não serviria, porque com sal não dá para buscar
por `WHERE token = $1`. Qualquer consulta ou `DELETE` pelo token precisa passar
por `hashToken()` — pelo valor bruto não acha nada, em silêncio. A mesma função
serve ao refresh token da sessão.

Usar um link invalida **todos** os pedidos pendentes da pessoa, não só o
clicado. E nenhum log do fluxo leva e-mail, token ou link: o log sai idêntico
exista a conta ou não, para não revelar no servidor o que a resposta genérica
esconde do cliente.

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

## Deploy (Render + Neon)

Deploy de **demonstração**: a loja fica navegável, mas a compra não conclui.

**A divisão desde 22/09/2026:** o Render roda o processo Node; o **Neon** guarda
o Postgres. O banco gerenciado do Render expirava em 30 dias no free tier e
expirou de fato — o do Neon não tem prazo. O Neon **não hospeda o site**, só o
banco; quem serve HTTP continua sendo o Render.

**Por que Render e não Vercel.** A Vercel roda funções serverless efêmeras;
este app assume processo vivo. Lá seria preciso exportar handler, trocar o pool
por um driver com pooler, tirar `inicializarBanco()` do caminho quente e aceitar
que o rate limit em memória vira decorativo. No Render, `npm start` roda como
foi escrito.

O `render.yaml` na raiz descreve **apenas o serviço web** — o bloco `databases:`
saiu junto com o banco do Render. No painel: **New > Blueprint**, apontando para
o repositório. O `healthCheckPath` aponta para `GET /health`, que é rota do
próprio `server.js` — se ela mudar de caminho, o Render passa a considerar o
serviço morto e reinicia em loop.

### Use o endpoint com `-pooler`

A string do Neon vem em duas variantes, com e sem `-pooler` no host. Use a **com
pooler**. O free tier do Render dorme por inatividade, e cada wake-up reabre o
pool inteiro de uma vez; contra o endpoint direto isso encosta no teto de
conexões do Neon. O pooler existe exatamente para absorver esse padrão.

### `sslmode` na URL manda, e `DATABASE_SSL` vira decorativa

Descoberto ao migrar, e não é óbvio: quando a `DATABASE_URL` traz `sslmode=`,
o `pg` usa esse valor e **ignora** o que `configuracaoDoBanco()` passa em `ssl`.
Testado com `pg` 8.22 — com `sslmode=require` na URL, o `ssl` efetivo é o mesmo
com `DATABASE_SSL=false` ou sem a variável.

Consequência prática: para mexer no TLS do deploy, edite o `sslmode` da própria
URL. `DATABASE_SSL` só tem efeito em URL que não traz `sslmode`, e por isso nem
aparece mais no `render.yaml`.

> Prefira `sslmode=verify-full` a `sslmode=require`. Hoje o `pg` trata os dois
> como verificação completa do certificado, mas avisa em log que no `pg` 9 o
> `require` passa a adotar a semântica do libpq — TLS **sem** verificar
> certificado. Escrever `verify-full` hoje trava o comportamento forte.

O `channel_binding=require` que o Neon põe na string é parâmetro de libpq: o
`pg` o carrega na configuração mas não o aplica como exigência. Não atrapalha,
só não garante nada.

`/health` responde `{ status: 'ok' }` sem encostar no banco. É proposital: mede
se o processo está vivo, não se o Postgres está de pé. Consequência a ter em
mente — **com o banco fora, o health check continua verde**.

### Variáveis que o deploy usa

| Variável | Papel |
|----------|-------|
| `DATABASE_URL` | String do Neon, colada à mão no painel (`sync: false`). Tem precedência sobre as `PG*` |
| `TRUST_PROXY` | `1` atrás de proxy. Sem isto o rate limit vê um IP só e bloqueia geral |
| `CHECKOUT_HABILITADO` | `false` desliga o pagamento |
| `APP_BASE_URL` | Preencher com a URL do Render após o primeiro deploy |
| `JWT_SECRET` | Gerado pelo Render (`generateValue`), nunca versionado |
| `NODE_ENV` | `production` liga o `Secure` dos cookies de sessão (só vão por HTTPS) |

`DATABASE_SSL` saiu da lista: com `sslmode` na URL do Neon, ela não faz nada.

A `DATABASE_URL` carrega usuário e senha. Ela vive **só** no painel do Render e
no `.env` local — nunca no `render.yaml`, que é público. É o mesmo tipo de
descuido que causou o vazamento registrado em *Segurança — histórico*.

### Como o checkout desligado funciona

A decisão é **do servidor**, não da interface. Com `CHECKOUT_HABILITADO=false`:

- `/pagamentos/criar` e `/pagamentos/confirmar` respondem 503 com mensagem clara
- o webhook responde 200 com `ignorado`, para o Mercado Pago não retentar
- `GET /config` informa o estado, e o carrinho mostra aviso e desabilita o botão

Remover o `disabled` no DevTools não contorna nada: o servidor recusa igual.

### Ordem do schema no deploy

`startCommand` roda `npm run migrate` antes de `npm start`. O runner aplica
`inicializar_banco.sql` **antes** das migrations, porque num banco vazio a 001
faria `ALTER TABLE pedido_itens` numa tabela que ainda não existe. Tudo é
idempotente, então repetir a cada deploy é seguro.

### Cuidados com o deploy público

- O painel fica acessível em `/admin.html`. Os middlewares protegem, mas a senha
  da conta admin passa a ser o que separa qualquer pessoa do catálogo.
- Não use credenciais de produção do Mercado Pago num deploy de hobby.
- O free tier do Render dorme após inatividade (~30s para acordar). O banco no
  Neon não expira, mas o free tier dele também suspende o *compute* por
  inatividade — a primeira consulta depois da pausa demora, e as duas esperas se
  somam no primeiro acesso do dia.
- Trocar de banco **não leva os dados**. O Postgres do Render expirou com o
  catálogo, os pedidos e as contas dentro; o Neon subiu vazio. Rodar as
  migrations recria o schema e o catálogo inicial, mas contas e pedidos antigos
  não voltam, e o primeiro admin precisa ser promovido de novo
  (`npm run criar-admin`).

---

## Testes

São **de integração**: batem no banco configurado no `.env`, não em mocks.

Sete arquivos, cada um com um `test()` de nível superior e os casos como
subtestes (`await t.test(...)`):

| Arquivo | Casos | Cobre |
|---------|-------|-------|
| `tests/admin.test.js` | 18 | Rotas `/admin/*`, permissão, CRUD de produto, tags, paginação |
| `tests/auth-sessao.test.js` | 13 | Cookies, rotação, reuso, janela de corrida, logout, CSRF, revogação por senha |
| `tests/produto.test.js` | 13 | Página de detalhe, galeria, avaliações e quem pode avaliar |
| `tests/checkout.test.js` | 12 | Resolução do carrinho, preço do banco, estoque, frete |
| `tests/conta.test.js` | 12 | Central da conta: nome, troca de senha, avaliações próprias; cadastro de newsletter |
| `tests/estoque.test.js` | 8 | Baixa, idempotência, devolução por estorno |
| `tests/recuperacao.test.js` | 4 | Token gravado como hash, invalidação dos links pendentes |

São 80 subtestes mais os 7 de nível superior — daí os 87 que o runner conta
(conferido rodando a suíte em 23/09/2026).

- **Autenticação por cookie, como o navegador.** `cabecalhosDeSessao(token)`, em
  `tests/ajuda.js`, monta o cookie `access_token` e o CSRF em dobro. O header
  `Authorization` não autentica mais — há um teste que garante isso.
- `auth-sessao.test.js` simula cada navegador como um pote de cookies que
  respeita `Path` e expiração. É o que prova que o refresh token chega ao logout.

- Rodam em série (`--test-concurrency=1`).
- As fixtures usam prefixo com o **pid do processo**. O runner do Node executa
  cada arquivo em um processo separado; com prefixo comum, o `limpar()` de um
  arquivo apagava as fixtures do outro e os `DELETE` concorrentes travavam em
  deadlock.
- `tests/admin.test.js` sobe o app Express numa porta efêmera, sem abrir 3000.
- **O rate limit vale dentro dos testes.** O `limitadorSenha` permite 5
  requisições por hora, somando `/auth/alterar-senha`, `/auth/recuperar-senha` e
  `/auth/redefinir-senha`. `conta.test.js` já gasta as 5; `recuperacao.test.js`
  gasta 4; `auth-sessao.test.js`, 2. A sexta recebe 429 e o teste falha sem
  motivo aparente. Como cada
  arquivo roda em processo próprio, o contador zera entre arquivos — por isso a
  recuperação de senha tem arquivo separado.
- **O `.env` local tem SMTP de verdade.** `recuperacao.test.js` apaga as
  variáveis `SMTP_*` do próprio processo para não mandar e-mail aos endereços
  de fixture. Qualquer teste novo que passe por envio de e-mail precisa do mesmo.

O teste mais importante é o que envia preço adulterado no checkout e verifica
que o servidor usa o preço do banco. Ele existe para impedir a regressão da
falha que originou boa parte deste projeto.

---

## Front-end

São sete páginas: `E-Commerce.html` (vitrine, servida como índice), `cart.html`,
`produto.html`, `auth.html`, `redefinir-senha.html`, `perfil.html` e
`admin.html`.

- `public/sessao.js` — **carrega primeiro em toda página** (antes de `script.js`
  e de `admin.js`). Base da API, cache do usuário e `chamarApi()`, a única
  chamada autenticada da aplicação: manda cookies e `X-CSRF-Token`, em 401
  renova a sessão uma vez e repete a chamada uma vez. Várias chamadas com 401 ao
  mesmo tempo esperam a mesma renovação. Arquivo próprio porque o painel não
  carrega `script.js`, e essa lógica não pode existir em cópias que divergem.
- Login e cadastro usam `requisitar()`, sem retry: ali 401 é senha errada, não
  sessão vencida. Páginas com tela própria de "sem sessão" (conta, painel)
  chamam `chamarApi(..., { redirecionarSeDeslogado: false })`.
- `public/produto.html` + `produto.js` — página de detalhe, aberta pela vitrine
  em `produto.html?id=N`. Carrega **depois** de `script.js`, de quem reaproveita
  `escapeHtml`, `formatCurrency`, `addToCart` e `renderDesconto`.
- `public/perfil.html` + `conta.js` — central da conta, em três abas dentro da
  mesma página (Minhas compras, Minhas avaliações, Configurações). Também carrega
  **depois** de `script.js`, reaproveitando `escapeHtml` e `iniciaisDoNome`.
- Estrelas são SVG inline, não o caractere `★`: o glifo muda de desenho conforme
  a fonte instalada e não existe meia estrela em texto.
- `renderDesconto()` em `script.js` é o único lugar que monta preço riscado e
  selo. Página nova que mostre preço (um catálogo, por exemplo) usa ela, não
  refaz a conta.
- `.so-leitor` em `estilos.css` é o texto só para leitor de tela. Use onde
  `aria-label` não vale (`<del>`, `<span>` genérico).
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
caracteres; `UNIQUE` em `usuarios.email`; token de recuperação gravado como
hash; aviso no log de subida quando `CORS_ORIGINS` está vazia (nesse caso
qualquer origem é aceita).

---

## Pendências conhecidas

1. **19 `alert()` na loja** (`public/script.js`) — mesmo bug de supressão que
   quebrou o botão Excluir. Afeta mensagens de carrinho vazio, falha de
   pagamento e confirmação de compra. Único arquivo que falta; os outros três
   já usam aviso na página.
2. **`MP_WEBHOOK_SECRET` vazio no `.env`** — a variável já está documentada no
   `.env.example` (linhas 31-34), mas o `.env` local sequer a declara, então o
   webhook aceita notificações sem verificar assinatura. O código da validação
   HMAC está pronto; falta preencher com o segredo do painel do Mercado Pago.
3. **`.env.bak` no disco** com o `JWT_SECRET` antigo comprometido. Está fora do
   Git (o `.gitignore` cobre `.env.*` com exceção do `.example`), mas deveria
   ser apagado.
4. **Push protection do GitHub** — recomendada, nunca confirmada. Não dá para
   verificar pelo repositório local; é preciso olhar em Settings > Code security.
5. **Branches mescladas sobrando.** O estado hoje:

   | Branch | Local | No `origin` |
   |--------|-------|-------------|
   | `feat/painel-admin` | sim | sim |
   | `feat/pagina-de-produto` | sim | sim |
   | `feat/central-da-conta` | sim | sim |
   | `melhorias/catalogo-seguro` | sim | **não** (já removida) |
   | `fix/dependencias-vulneraveis` | sim | **não** |

   Todas já estão em `main`. Apagar é seguro, mas confirme com `git branch
   --merged main` antes.
6. **Andaimes de depuração que sobraram.** Dois, ambos do início do projeto:
   - `trigger-request.js` na raiz — dispara um POST em `/auth/recuperar-senha`
     com e-mail fixo. Não é chamado por nada nem aparece em `npm run`.
   - `POST /debug/teste` em `server.js:1176` — ecoa o corpo recebido. Fica atrás
     de `NODE_ENV !== 'production'`, então **não** existe no Render, mas responde
     em qualquer execução local.

   Nenhum dos dois é falha de segurança hoje. São candidatos a remoção, ou a
   virar teste de verdade.

**Resolvidas desde a última revisão**, mantidas aqui para não serem reabertas:

- O comentário residual na linha 20 do `.env.example` saiu; a linha hoje é
  `CHECKOUT_HABILITADO=true`.
- `MP_WEBHOOK_SECRET` passou a constar do `.env.example`, com instrução de onde
  buscar o valor. Só o preenchimento continua pendente.
- `package.json` teve o campo `main` corrigido (apontava para arquivo
  inexistente) e `qs` e `nodemailer` foram atualizados para versões sem
  vulnerabilidade conhecida.

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
