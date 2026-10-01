-- Migration 013: carrinho salvo na conta
--
-- O carrinho vivia só no localStorage: trocando de computador ou saindo da
-- conta, ele ficava para trás. Com sessão aberta, ele passa a ser gravado aqui
-- e aparece em qualquer navegador onde a pessoa entrar. Sem sessão, continua
-- só no navegador.
--
-- Como no carrinho do navegador, só id e quantidade: o preço nunca é guardado,
-- é sempre lido de produtos na hora de mostrar e de cobrar.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

CREATE TABLE IF NOT EXISTS carrinho_itens (
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    -- Produto excluído do catálogo sai dos carrinhos junto.
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade INTEGER NOT NULL CHECK (quantidade BETWEEN 1 AND 10),
    -- Ordem em que os itens aparecem, a mesma do carrinho que foi enviado.
    posicao INTEGER NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (usuario_id, produto_id)
);

COMMIT;

SELECT 'Migration 013 aplicada com sucesso!' AS mensagem;
