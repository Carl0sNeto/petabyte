-- Migration 009: destaques da home, curados pelo administrador
--
-- A home deixa de listar o catálogo inteiro e passa a mostrar só os produtos
-- marcados como destaque; a navegação completa vai para catalogo.html.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

-- Posição manual na home: menor número aparece primeiro. Fica NULL em produto
-- sem destaque — só tem sentido quando destaque = TRUE.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ordem_destaque INTEGER;

-- A coluna destaque nasce, e só quando nasce, com os primeiros destaques já
-- marcados: sem isso a home do deploy ficaria vazia até alguém abrir o painel.
-- Entram até 8 produtos à venda, os com desconto primeiro. O bloco confere se
-- a coluna já existe porque o runner roda tudo de novo a cada deploy — um
-- UPDATE solto aqui desfaria a curadoria do administrador a cada deploy.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'produtos'
          AND column_name = 'destaque'
    ) THEN
        ALTER TABLE produtos ADD COLUMN destaque BOOLEAN NOT NULL DEFAULT FALSE;

        UPDATE produtos p
           SET destaque = TRUE, ordem_destaque = escolhidos.posicao
          FROM (
              SELECT id, ROW_NUMBER() OVER (
                         ORDER BY (preco_original IS NOT NULL AND preco_original > preco) DESC, id
                     ) AS posicao
                FROM produtos
               WHERE ativo = TRUE AND estoque > 0
               LIMIT 8
          ) AS escolhidos
         WHERE p.id = escolhidos.id;
    END IF;
END $$;

-- Parcial: a consulta da home sempre filtra pelos dois booleanos juntos.
CREATE INDEX IF NOT EXISTS idx_produtos_destaque
    ON produtos (ordem_destaque)
    WHERE destaque = TRUE AND ativo = TRUE;

COMMIT;

SELECT 'Migration 009 aplicada com sucesso!' AS mensagem;
