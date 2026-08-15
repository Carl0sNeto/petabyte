-- Migration 002: controle de baixa de estoque
--
-- A baixa acontece quando o pagamento é aprovado, e tanto /pagamentos/confirmar
-- quanto o webhook do Mercado Pago podem processar o mesmo pagamento. Sem uma
-- marca no pedido, o estoque seria debitado mais de uma vez.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estoque_baixado BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

SELECT 'Migration 002 aplicada com sucesso!' AS mensagem;
