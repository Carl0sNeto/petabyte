# Inicialização do Banco de Dados - Petabyte

## Configuração do Banco de Dados PostgreSQL

O projeto Petabyte utiliza as seguintes configurações de conexão:
- **Porta da API**: `PORT` (padrão: `3000`)
- **Host**: `PGHOST` (padrão: `localhost`)
- **Porta**: `PGPORT` (padrão: `5432`)
- **Usuário**: `PGUSER`
- **Senha**: `PGPASSWORD`
- **Banco de dados**: `PGDATABASE`

As `PG*` acima valem para o Postgres **local**. Se `DATABASE_URL` estiver
definida, ela tem precedência e as `PG*` são ignoradas por completo — é assim
que o deploy funciona, com o banco no Neon. A divisão Render (processo) + Neon
(banco), o motivo de usar o endpoint `-pooler` e a precedência do `sslmode` sobre
`DATABASE_SSL` estão no [`CLAUDE.md`](CLAUDE.md), seção *Deploy*.

Também são esperadas estas variáveis para o checkout:
- `JWT_SECRET` (**obrigatória**, mínimo de 32 caracteres — o servidor não inicia sem ela)
- `APP_BASE_URL`
- `CORS_ORIGINS` (lista separada por vírgula)
- `MP_ACCESS_TOKEN`
- `MP_PUBLIC_KEY` (opcional)
- `MP_WEBHOOK_SECRET` (opcional; sem ela o webhook aceita notificações sem verificar a assinatura)

## Tabelas Necessárias

### 1. **usuarios**
Armazena dados dos usuários cadastrados.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| nome | VARCHAR(100) NOT NULL | Nome completo do usuário |
| email | VARCHAR(255) NOT NULL UNIQUE | Email do usuário |
| senha | TEXT NOT NULL | Senha criptografada com bcrypt |
| admin | BOOLEAN NOT NULL DEFAULT FALSE | Acesso ao painel administrativo |
| criado_em | TIMESTAMP | Data/hora do cadastro |

O cadastro público sempre grava `admin = FALSE`. A promoção acontece apenas pela
linha de comando (`npm run criar-admin`), nunca pela interface — veja
[Painel administrativo](#painel-administrativo).

### 2. **produtos**
Catálogo e **fonte de verdade dos preços**. O servidor nunca aceita preço vindo
do cliente: no checkout ele recebe apenas `{ id, quantidade }` e lê nome e preço
desta tabela.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| nome | VARCHAR(150) NOT NULL UNIQUE | Nome exibido na vitrine |
| descricao | TEXT NOT NULL | Descrição curta |
| preco | NUMERIC(10,2) NOT NULL CHECK (preco > 0) | Preço unitário |
| categoria | VARCHAR(50) NOT NULL | Slug da taxonomia abaixo |
| imagem_url | TEXT NOT NULL | URL da imagem (https) |
| estoque | INTEGER NOT NULL CHECK (estoque >= 0) | Saldo disponível |
| ativo | BOOLEAN NOT NULL DEFAULT TRUE | Produtos inativos somem da vitrine e do checkout |
| tags | TEXT[] NOT NULL DEFAULT '{}' | Rótulos de busca, com índice GIN |
| criado_em | TIMESTAMP | Data/hora da criação |
| atualizado_em | TIMESTAMP | Última atualização |

#### Taxonomia de categorias

O banco guarda o **slug**; a interface mostra o **rótulo**. Os dois vivem juntos
na constante `CATEGORIAS` em `server.js`, para que a loja e o painel não inventem
traduções próprias. A lista é plana, sem hierarquia.

| Slug | Rótulo | O que entra |
|------|--------|-------------|
| `hardware` | Hardware | Placas de vídeo, processadores, memória |
| `perifericos` | Periféricos | Teclados, mouses, mousepads |
| `audio` | Áudio | Headsets, caixas de som |
| `monitores` | Monitores | Monitores e telas |
| `computadores` | Computadores | Notebooks e desktops |
| `mobile` | Celulares e wearables | Smartphones, smartwatches |

`GET /produtos` devolve apenas as categorias que têm produto à venda, e a loja
monta os botões de filtro a partir daí — não há categorias fixas no HTML.
`GET /admin/produtos` devolve a lista completa, para o seletor do painel.

Para acrescentar uma categoria, basta incluí-la em `CATEGORIAS`. Não há
migration envolvida, já que a coluna é um texto livre validado na aplicação.

### 3. **historico_compras**
Armazena o histórico de compras de cada usuário.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id |
| pedido | VARCHAR(100) NOT NULL | Descrição do pedido |
| status | VARCHAR(50) NOT NULL | Status do pedido (ex: "Entregue", "Em transporte") |
| criado_em | TIMESTAMP | Data/hora da criação do pedido |

### 4. **pedidos**
Armazena os pedidos criados no checkout e o status sincronizado com o gateway.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id |
| historico_id | INTEGER NOT NULL | FK para historico_compras.id |
| external_reference | TEXT NOT NULL | Referência usada no Mercado Pago |
| preference_id | TEXT | ID da preferência de checkout |
| payment_id | TEXT | ID do pagamento confirmado |
| status | VARCHAR(50) NOT NULL | Status exibido no sistema |
| payment_status | VARCHAR(50) NOT NULL | Status bruto retornado pelo gateway |
| subtotal | NUMERIC(10,2) NOT NULL | Soma dos itens |
| frete | NUMERIC(10,2) NOT NULL | Valor do frete |
| total | NUMERIC(10,2) NOT NULL | Total do pedido |
| moeda | VARCHAR(10) NOT NULL | Moeda usada no checkout |
| estoque_baixado | BOOLEAN NOT NULL DEFAULT FALSE | Impede que a confirmação manual e o webhook debitem o estoque duas vezes |
| criado_em | TIMESTAMP | Data/hora da criação |
| atualizado_em | TIMESTAMP | Última atualização |

### 5. **pedido_itens**
Armazena os itens individuais de cada pedido. `nome` e `preco_unitario` ficam
congelados na linha: o histórico não muda se o produto for renomeado,
reprecificado ou removido depois.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| pedido_id | INTEGER NOT NULL | FK para pedidos.id |
| produto_id | INTEGER | FK para produtos.id (ON DELETE SET NULL) |
| nome | VARCHAR(150) NOT NULL | Nome do item no momento da compra |
| preco_unitario | NUMERIC(10,2) NOT NULL | Preço unitário no momento da compra |
| quantidade | INTEGER NOT NULL | Quantidade comprada |
| total | NUMERIC(10,2) NOT NULL | Total do item |
| criado_em | TIMESTAMP | Data/hora da criação |

### 6. **password_resets**
Armazena tokens para recuperação de senha.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id |
| token | TEXT NOT NULL UNIQUE | SHA-256 do token de recuperação. O valor bruto só vai no e-mail |
| expira_em | TIMESTAMP NOT NULL | Data/hora de expiração (30 minutos) |
| usado | BOOLEAN DEFAULT FALSE | Indica se o token foi utilizado |
| criado_em | TIMESTAMP | Data/hora da criação do token |

### 7. **refresh_tokens**
Sessões de login. O access token (JWT de 15 minutos) não passa pelo banco; o
refresh token, que renova a sessão por até 30 dias, fica aqui para poder ser
revogado.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id (ON DELETE CASCADE) |
| token_hash | TEXT NOT NULL UNIQUE | SHA-256 do refresh token. O valor bruto só existe no cookie do navegador |
| criado_em | TIMESTAMP NOT NULL | Data/hora de emissão |
| expira_em | TIMESTAMP NOT NULL | 30 dias depois da emissão, calculado no banco |
| revogado_em | TIMESTAMP | Preenchido na rotação, no logout, na troca de senha ou quando se detecta reuso |
| substituido_por | INTEGER | FK para o token que o substituiu na rotação. Distingue "trocado por outro" (reapresentar é reuso) de "sessão encerrada" |

## Como Executar o Script

### Opção 1: Usando pgAdmin (GUI)
1. Abra o **pgAdmin**
2. Conecte-se ao banco de dados usando as credenciais acima
3. Abra um novo **Query Tool**
4. Copie e cole o conteúdo de `inicializar_banco.sql`
5. Clique em **Execute** (ou Ctrl+Enter)

### Opção 2: Usando psql (Command Line)
```bash
# Conectar ao PostgreSQL
psql -h <host> -p <porta> -U <usuario> -d <banco>

# Dentro do psql, executar:
\i 'inicializar_banco.sql'

# Ou copiar e colar o conteúdo diretamente
```

### Opção 3: Usando Node.js (Automático)
O `server.js` já cria as tabelas automaticamente quando inicia:
```bash
npm start
```

## Migrations

Bancos que já existiam antes do catálogo precisam rodar as migrations, que são
idempotentes e podem ser executadas mais de uma vez:

```bash
npm run migrate
```

Num banco **novo e vazio** — caso do Neon recém-criado — o mesmo comando serve
para montar tudo do zero: o runner aplica `inicializar_banco.sql` antes das
migrations. Para apontar da sua máquina para o banco da hospedagem, defina a
`DATABASE_URL` na mesma linha, sem gravá-la em arquivo (PowerShell):

```powershell
$env:DATABASE_URL="postgresql://..."; npm run migrate
```

No deploy isso já acontece sozinho: o `startCommand` do `render.yaml` roda
`npm run migrate` antes do `npm start`.

| Arquivo | O que faz |
|---------|-----------|
| `migrations/001_catalogo_e_integridade.sql` | Cria `produtos` com os 6 itens iniciais, adiciona `pedido_itens.produto_id` e a constraint UNIQUE em `usuarios.email` |
| `migrations/002_controle_de_estoque.sql` | Adiciona `pedidos.estoque_baixado` |
| `migrations/003_perfil_administrador.sql` | Adiciona `usuarios.admin` e um índice parcial dos administradores |
| `migrations/004_taxonomia_e_tags.sql` | Adiciona `produtos.tags` e remapeia as categorias antigas para a taxonomia de eletrônicos |
| `migrations/005_catalogo_gamer.sql` | Cadastra os 10 produtos gamer iniciais |
| `migrations/006_reconcilia_placas_duplicadas.sql` | Reconcilia duas placas de vídeo que já existiam cadastradas à mão |
| `migrations/007_pagina_de_produto.sql` | Adiciona `preco_original` e `especificacoes` em produtos, e cria `produto_imagens` e `avaliacoes` |
| `migrations/011_refresh_tokens.sql` | Cria `refresh_tokens`, que guarda as sessões de login. A numeração pula 008 a 010, reservados para specs que ainda não entraram |

A migration 001 aborta com erro se houver e-mails duplicados em `usuarios`.
Nesse caso, consolide os registros antes de aplicá-la.

## Painel administrativo

Fica em `/admin.html` e reaproveita o login normal da loja — não há senha nem
sessão separada.

### Criando o primeiro administrador

1. Cadastre-se normalmente pelo site, como qualquer cliente.
2. Rode, no servidor:

```bash
npm run criar-admin -- seu-email@exemplo.com
```

3. Saia e entre de novo para o token passar a refletir a permissão.

Outros comandos:

```bash
npm run criar-admin -- --listar                     # lista os administradores
npm run criar-admin -- alguem@exemplo.com --revogar # revoga o acesso
```

O script recusa revogar o último administrador, o que deixaria o painel
inacessível.

### O que o painel faz

| Área | Operações |
|------|-----------|
| Produtos | Criar, editar, excluir; ajustar preço, estoque, categoria, imagem e descrição; tirar de circulação sem excluir |
| Pedidos | Consultar com filtro por status e paginação, e abrir o detalhe com itens e cliente |

Pedidos são **somente leitura**. Alterar status de pagamento pela mão criaria
divergência com o Mercado Pago, que é a fonte de verdade — a sincronização
acontece pelo webhook e por `/pagamentos/confirmar`.

### Como o acesso é verificado

Toda rota `/admin/*` passa por `autenticarToken` e depois por `exigirAdmin`, que
**consulta a flag no banco a cada requisição** em vez de ler do JWT. Por isso
revogar o acesso tem efeito imediato: um token emitido antes da revogação para
de funcionar na hora, sem esperar os 15 minutos de expiração do access token.

Esconder a interface no navegador é conveniência de usabilidade, não segurança.
A proteção real está no servidor.

## Variáveis de Ambiente

Use `.env.example` como base e configure pelo menos:
- `PORT`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- `JWT_SECRET` (obrigatória, mínimo de 32 caracteres)
- `APP_BASE_URL`
- `CORS_ORIGINS`
- `MP_ACCESS_TOKEN`

## Notas Importantes

- As tabelas são criadas com `IF NOT EXISTS`, então é seguro executar o script múltiplas vezes
- Ao deletar um usuário, seus registros em `historico_compras`, `pedidos` e `password_resets` são deletados automaticamente (ON DELETE CASCADE)
- Ao deletar um produto, os itens de pedido apenas perdem a referência (`produto_id` vira NULL) e mantêm nome e preço históricos
- Indices foram adicionados para melhor performance nas queries de busca
- O estoque é debitado apenas quando o pagamento é aprovado, e devolvido em caso de `refunded`, `cancelled` ou `charged_back`

## Verificação

Para verificar se as tabelas foram criadas corretamente, execute:

```sql
-- Listar todas as tabelas
\dt

-- Ver a estrutura de uma tabela
\d usuarios
\d historico_compras
\d password_resets

-- Contar registros
SELECT COUNT(*) FROM usuarios;
SELECT COUNT(*) FROM historico_compras;
SELECT COUNT(*) FROM password_resets;
```
