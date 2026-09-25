-- Migration 010: login com Google
--
-- senha passa a aceitar NULL: conta criada pelo Google não tem senha até a
-- pessoa definir uma. "senha IS NULL" responde sozinho se a conta tem senha de
-- verdade, sem coluna extra para distinguir hash real de hash descartável.
--
-- google_id é o "sub" do token da Google: estável por conta Google, ao
-- contrário do e-mail, que a pessoa pode trocar lá.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

ALTER TABLE usuarios ALTER COLUMN senha DROP NOT NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

COMMIT;

SELECT 'Migration 010 aplicada com sucesso!' AS mensagem;
