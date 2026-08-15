-- Migration 003: perfil de administrador
--
-- A flag mora em usuarios porque o painel reaproveita o login e o JWT que já
-- existem. Ninguém vira admin sozinho: o cadastro público sempre grava FALSE e
-- a promoção passa por `npm run criar-admin`, executado por quem tem acesso ao
-- servidor.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice parcial: a consulta de interesse é sempre "quem são os admins",
-- e eles são poucos frente ao total de usuários.
CREATE INDEX IF NOT EXISTS idx_usuarios_admin ON usuarios(admin) WHERE admin = TRUE;

COMMIT;

SELECT 'Migration 003 aplicada com sucesso!' AS mensagem;
