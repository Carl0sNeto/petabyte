-- Migration 012: verificação de e-mail no cadastro com senha
--
-- Conta criada com senha só entra depois de confirmar o e-mail por link. Sem
-- isso, qualquer um cadastrava o e-mail de outra pessoa — e, com o login do
-- Google vinculando por e-mail, continuava entrando na conta dela depois.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

-- As contas que JÁ existiam entram como verificadas, e só elas: a coluna nasce
-- com DEFAULT TRUE (preenchendo as linhas atuais) e o padrão vira FALSE logo em
-- seguida, para as novas. Como o runner roda tudo de novo a cada deploy, um
-- UPDATE ... SET TRUE aqui confirmaria toda conta pendente a cada deploy; o
-- ADD COLUMN IF NOT EXISTS só preenche uma vez, quando a coluna é criada.
--
-- Sem isso, quem já tinha conta ficaria trancado para fora — inclusive o
-- administrador, num deploy sem SMTP configurado para mandar a confirmação.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE usuarios ALTER COLUMN email_verificado SET DEFAULT FALSE;

-- Mesmo desenho de password_resets: só o SHA-256 do token é gravado; o valor
-- bruto existe apenas no link do e-mail.
CREATE TABLE IF NOT EXISTS verificacoes_email (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Calculado e comparado no banco, com NOW(), como refresh_tokens.
    expira_em TIMESTAMP NOT NULL,
    usado_em TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verificacoes_email_usuario ON verificacoes_email (usuario_id);

COMMIT;

SELECT 'Migration 012 aplicada com sucesso!' AS mensagem;
