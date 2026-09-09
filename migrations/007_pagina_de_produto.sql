-- Migration 007: página de produto — galeria, especificações, preço "de/por"
--                e avaliações de quem comprou
--
-- Até aqui o produto tinha uma imagem só, descrição em texto corrido e nenhum
-- lugar para nota ou comentário. Esta migration cria o que falta para uma
-- página de detalhe de verdade.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

-- 1. Preço original, para o "de/por" ------------------------------------------
-- Opcional: quando NULL, a página mostra só o preço atual, sem selo de
-- desconto. A regra "original tem que ser maior que o atual" fica na aplicação,
-- porque um CHECK entre duas colunas atrapalharia edições parciais no painel
-- (baixar o preço original antes do atual passaria a ser impossível).

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_original NUMERIC(10,2)
    CHECK (preco_original IS NULL OR preco_original > 0);

-- 2. Especificações técnicas --------------------------------------------------
-- JSONB com uma lista de pares: [{"rotulo": "Soquete", "valor": "AM4"}, ...].
-- Tabela separada seria mais normalizada, mas especificação não tem vida
-- própria: nunca é consultada fora do produto nem compartilhada entre produtos.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS especificacoes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3. Galeria de imagens -------------------------------------------------------
-- imagem_url continua sendo a foto principal, usada na vitrine e no carrinho.
-- Esta tabela guarda as fotos adicionais, exibidas como miniaturas.

CREATE TABLE IF NOT EXISTS produto_imagens (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    descricao VARCHAR(150) NOT NULL DEFAULT '',
    posicao INTEGER NOT NULL DEFAULT 0,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_imagem_produto FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE,
    CONSTRAINT uq_imagem_produto_url UNIQUE (produto_id, url)
);

CREATE INDEX IF NOT EXISTS idx_produto_imagens_produto ON produto_imagens(produto_id, posicao);

-- 4. Avaliações ---------------------------------------------------------------
-- Só quem comprou avalia, e a verificação acontece no servidor consultando
-- pedidos pagos. A constraint UNIQUE garante uma avaliação por pessoa por
-- produto; editar substitui a anterior em vez de acumular.
--
-- ON DELETE CASCADE nos dois lados: apagar o produto ou a conta leva junto as
-- avaliações, que não fazem sentido órfãs.

CREATE TABLE IF NOT EXISTS avaliacoes (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    nota SMALLINT NOT NULL CHECK (nota BETWEEN 1 AND 5),
    titulo VARCHAR(120) NOT NULL DEFAULT '',
    comentario TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_avaliacao_produto FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE,
    CONSTRAINT fk_avaliacao_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT uq_avaliacao_produto_usuario UNIQUE (produto_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_avaliacoes_produto ON avaliacoes(produto_id, criado_em DESC);

-- 5. Conferência --------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'produtos' AND column_name = 'preco_original') THEN
        RAISE EXCEPTION 'preco_original não foi criada.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'avaliacoes') THEN
        RAISE EXCEPTION 'Tabela avaliacoes não foi criada.';
    END IF;
END $$;

COMMIT;

SELECT 'Migration 007 aplicada com sucesso!' AS mensagem;
