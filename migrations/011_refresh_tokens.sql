-- Migration 011: refresh tokens da sessão
--
-- O access token (JWT de 15 minutos) não é consultado no banco e por isso não
-- se revoga. O refresh token (30 dias) é o que mantém a sessão viva, e vive
-- aqui justamente para poder ser revogado: logout, troca de senha, reuso.
--
-- Guarda só o SHA-256 do token, como password_resets: o valor bruto existe
-- apenas no cookie do navegador, e um dump desta tabela não abre sessão nenhuma.
--
-- Entrou antes da 008, da 009 e da 010, que vieram depois. O
-- runner aplica em ordem alfabética e não se importa com lacunas nem com a
-- ordem em que os arquivos chegaram: tudo aqui é idempotente.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    -- CASCADE como nas demais tabelas ligadas a usuarios: sem ele, apagar uma
    -- conta falharia por chave estrangeira enquanto ela tivesse sessão gravada.
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    expira_em TIMESTAMP NOT NULL,
    revogado_em TIMESTAMP,
    -- Preenchido só na rotação, apontando para o token que substituiu este.
    -- Distingue "trocado por outro agora há pouco" (corrida entre abas, que não
    -- é ataque) de "revogado por logout ou por reuso".
    substituido_por INTEGER REFERENCES refresh_tokens(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario ON refresh_tokens (usuario_id);

COMMIT;

SELECT 'Migration 011 aplicada com sucesso!' AS mensagem;
