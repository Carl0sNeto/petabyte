-- Migration 004: taxonomia de eletrônicos e coluna de tags
--
-- As categorias antigas (tecnologia / acessorios / casa) vieram do catálogo
-- genérico de demonstração. "casa" não faz sentido numa loja de tecnologia, e
-- "tecnologia" acabaria absorvendo quase tudo conforme o catálogo cresce.
--
-- Nova taxonomia, plana e com slug em minúsculas sem acento:
--   hardware      placas de vídeo, processadores, memória
--   perifericos   teclados, mouses, mousepads
--   audio         headsets, caixas de som
--   monitores     monitores e telas
--   computadores  notebooks e desktops montados
--   mobile        celulares e wearables
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

-- 1. Tags -------------------------------------------------------------------
-- TEXT[] em vez de tabela separada: as tags são apenas rótulos de busca, sem
-- atributos próprios, e o índice GIN resolve a consulta "produtos com a tag X".

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_produtos_tags ON produtos USING GIN (tags);

-- 2. Remapeamento das categorias existentes ---------------------------------
-- Feito por nome porque os produtos de demonstração são conhecidos. Produtos
-- cadastrados depois, que ainda estejam nas categorias antigas, caem nas regras
-- genéricas do final.

UPDATE produtos SET categoria = 'computadores'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND (nome ILIKE '%notebook%' OR nome ILIKE '%macbook%' OR nome ILIKE '%desktop%');

UPDATE produtos SET categoria = 'audio'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND (nome ILIKE '%fone%' OR nome ILIKE '%headset%' OR nome ILIKE '%caixa de som%' OR nome ILIKE '%speaker%');

UPDATE produtos SET categoria = 'mobile'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND (nome ILIKE '%smartphone%' OR nome ILIKE '%samsung%' OR nome ILIKE '%iphone%' OR nome ILIKE '%smartwatch%' OR nome ILIKE '%watch%');

UPDATE produtos SET categoria = 'hardware'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND (nome ILIKE '%placa de v%' OR nome ILIKE '%processador%' OR nome ILIKE '%mem%ria%' OR nome ILIKE '%rtx%');

UPDATE produtos SET categoria = 'monitores'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND nome ILIKE '%monitor%';

UPDATE produtos SET categoria = 'perifericos'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa')
   AND (nome ILIKE '%teclado%' OR nome ILIKE '%mouse%' OR nome ILIKE '%headset%');

-- Rede de segurança: o que sobrou das categorias antigas vira 'hardware',
-- para que nenhum produto fique com uma categoria que o servidor recusa.
UPDATE produtos SET categoria = 'hardware'
 WHERE categoria IN ('tecnologia', 'acessorios', 'casa');

-- 3. Conferência -------------------------------------------------------------

DO $$
DECLARE
    restantes INTEGER;
BEGIN
    SELECT COUNT(*) INTO restantes FROM produtos
     WHERE categoria NOT IN ('hardware', 'perifericos', 'audio', 'monitores', 'computadores', 'mobile');

    IF restantes > 0 THEN
        RAISE EXCEPTION 'Ainda há % produto(s) fora da nova taxonomia.', restantes;
    END IF;
END $$;

COMMIT;

SELECT 'Migration 004 aplicada com sucesso!' AS mensagem;
