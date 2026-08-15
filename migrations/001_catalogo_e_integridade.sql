-- Migration 001: catalogo de produtos e integridade de dados
--
-- Motivacao: ate aqui os precos existiam apenas como texto no HTML e eram
-- enviados pelo cliente no checkout, permitindo que qualquer pessoa alterasse
-- o valor a pagar. Esta migration cria a fonte de verdade no banco.
--
-- Idempotente: pode ser executada mais de uma vez com seguranca.

BEGIN;

-- 1. Catalogo de produtos -----------------------------------------------------

CREATE TABLE IF NOT EXISTS produtos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(150) NOT NULL UNIQUE,
    descricao TEXT NOT NULL DEFAULT '',
    preco NUMERIC(10,2) NOT NULL CHECK (preco > 0),
    categoria VARCHAR(50) NOT NULL,
    imagem_url TEXT NOT NULL DEFAULT '',
    estoque INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo ON produtos(ativo);

-- Seed com o catalogo que estava fixo em public/E-Commerce.html.
-- ON CONFLICT evita duplicar quando a migration roda de novo, e preserva
-- qualquer ajuste de preco/estoque feito depois pelo operador.
INSERT INTO produtos (nome, descricao, preco, categoria, imagem_url, estoque) VALUES
    ('Notebook Ultra', 'Leve, rápido e com bateria de longa duração.', 4899.00, 'tecnologia', 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80', 10),
    ('Smartwatch Pro', 'Monitore sua rotina com precisão e estilo.', 1199.00, 'acessorios', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=80', 25),
    ('Caixa de Som Portátil', 'Som potente com conexão Bluetooth de alta qualidade.', 649.00, 'casa', 'https://images.unsplash.com/photo-1518444065439-e933c06ce9cd?auto=format&fit=crop&w=900&q=80', 30),
    ('Fone Premium', 'Audio imersivo e cancelamento de ruído.', 799.00, 'tecnologia', 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=900&q=80', 40),
    ('Smartphone X1', 'Câmera tripla e desempenho para o dia a dia.', 2499.00, 'acessorios', 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=900&q=80', 15),
    ('Setup Gamer', 'Estação completa com conforto e organização.', 3199.00, 'casa', 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=900&q=80', 8)
ON CONFLICT (nome) DO NOTHING;

-- 2. Rastrear qual produto originou cada item do pedido -----------------------
-- ON DELETE SET NULL: o historico do pedido sobrevive a exclusao do produto,
-- e nome/preco_unitario ja ficam congelados na propria linha.

ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS produto_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_item_produto'
    ) THEN
        ALTER TABLE pedido_itens
            ADD CONSTRAINT fk_item_produto
            FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto ON pedido_itens(produto_id);

-- 3. Impedir contas duplicadas -------------------------------------------------
-- Sem esta constraint, /usuarios (newsletter) criava linhas repetidas e o login
-- resolvia o e-mail com rows[0], tornando indefinido em qual conta se entra.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM usuarios GROUP BY email HAVING COUNT(*) > 1) THEN
        RAISE EXCEPTION 'Existem e-mails duplicados em usuarios. Consolide os registros antes de aplicar esta migration.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_usuarios_email'
    ) THEN
        ALTER TABLE usuarios ADD CONSTRAINT uq_usuarios_email UNIQUE (email);
    END IF;
END $$;

COMMIT;

SELECT 'Migration 001 aplicada com sucesso!' AS mensagem;
