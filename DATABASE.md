# Inicialização do Banco de Dados - Petabyte

## Configuração do Banco de Dados PostgreSQL

O projeto Petabyte utiliza as seguintes configurações de conexão:
- **Porta da API**: `PORT` (padrão: `3000`)
- **Host**: `PGHOST` (padrão: `localhost`)
- **Porta**: `PGPORT` (padrão: `5432`)
- **Usuário**: `PGUSER`
- **Senha**: `PGPASSWORD`
- **Banco de dados**: `PGDATABASE`

Também são esperadas estas variáveis para o checkout:
- `JWT_SECRET`
- `APP_BASE_URL`
- `CORS_ORIGINS` (lista separada por vírgula)
- `MP_ACCESS_TOKEN`
- `MP_PUBLIC_KEY` (opcional)

## Tabelas Necessárias

### 1. **usuarios**
Armazena dados dos usuários cadastrados.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| nome | VARCHAR(100) NOT NULL | Nome completo do usuário |
| email | VARCHAR(255) NOT NULL | Email do usuário (único) |
| senha | TEXT NOT NULL | Senha criptografada com bcrypt |
| criado_em | TIMESTAMP | Data/hora do cadastro |

### 2. **historico_compras**
Armazena o histórico de compras de cada usuário.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id |
| pedido | VARCHAR(100) NOT NULL | Descrição do pedido |
| status | VARCHAR(50) NOT NULL | Status do pedido (ex: "Entregue", "Em transporte") |
| criado_em | TIMESTAMP | Data/hora da criação do pedido |

### 3. **pedidos**
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
| criado_em | TIMESTAMP | Data/hora da criação |
| atualizado_em | TIMESTAMP | Última atualização |

### 4. **pedido_itens**
Armazena os itens individuais de cada pedido.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| pedido_id | INTEGER NOT NULL | FK para pedidos.id |
| nome | VARCHAR(150) NOT NULL | Nome do item |
| preco_unitario | NUMERIC(10,2) NOT NULL | Preço unitário |
| quantidade | INTEGER NOT NULL | Quantidade comprada |
| total | NUMERIC(10,2) NOT NULL | Total do item |
| criado_em | TIMESTAMP | Data/hora da criação |

### 5. **password_resets**
Armazena tokens para recuperação de senha.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | SERIAL PRIMARY KEY | Identificador único |
| usuario_id | INTEGER NOT NULL | FK para usuarios.id |
| token | TEXT NOT NULL UNIQUE | Token de recuperação |
| expira_em | TIMESTAMP NOT NULL | Data/hora de expiração (30 minutos) |
| usado | BOOLEAN DEFAULT FALSE | Indica se o token foi utilizado |
| criado_em | TIMESTAMP | Data/hora da criação do token |

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

## Variáveis de Ambiente

Use `.env.example` como base e configure pelo menos:
- `PORT`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
- `JWT_SECRET`
- `APP_BASE_URL`
- `CORS_ORIGINS`
- `MP_ACCESS_TOKEN`

## Notas Importantes

- As tabelas são criadas com `IF NOT EXISTS`, então é seguro executar o script múltiplas vezes
- Ao deletar um usuário, seus registros em `historico_compras` e `password_resets` são deletados automaticamente (ON DELETE CASCADE)
- Indices foram adicionados para melhor performance nas queries de busca

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
