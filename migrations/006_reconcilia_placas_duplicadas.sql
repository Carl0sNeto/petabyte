-- Migration 006: reconciliação das placas de vídeo duplicadas
--
-- Duas placas do seed 005 já haviam sido cadastradas manualmente pelo painel,
-- com preço real de mercado e imagem:
--
--   * RTX 5070 Gigabyte — o nome cadastrado terminava em " GDDR7", então o
--     ON CONFLICT (nome) do seed não reconheceu e criou um segundo registro.
--   * RTX 5050 MSI — nome idêntico, o seed foi corretamente ignorado, mas o
--     registro ficou sem a descrição e as tags.
--
-- Critério da reconciliação: preço, imagem e estoque cadastrados à mão valem
-- mais que os do JSON, que traziam "preço estimado" e nenhuma imagem. Do seed
-- aproveitamos apenas descrição e tags.
--
-- Em banco novo, onde só existe a linha vinda do seed, nada aqui tem efeito.
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

-- 1. RTX 5070: leva descrição e tags do registro do seed para o manual --------

UPDATE produtos manual
   SET descricao = seed.descricao,
       tags = seed.tags,
       atualizado_em = CURRENT_TIMESTAMP
  FROM produtos seed
 WHERE manual.nome = 'Placa de Vídeo Gigabyte NVIDIA GeForce RTX 5070 Windforce OC SFF 12GB GDDR7'
   AND seed.nome   = 'Placa de Vídeo Gigabyte NVIDIA GeForce RTX 5070 Windforce OC SFF 12GB'
   AND manual.descricao = '';

-- 2. Remove o duplicado criado pelo seed --------------------------------------
-- Só apaga se o registro manual existir, para não sumir com o produto num
-- banco onde apenas o seed rodou.

DELETE FROM produtos seed
 WHERE seed.nome = 'Placa de Vídeo Gigabyte NVIDIA GeForce RTX 5070 Windforce OC SFF 12GB'
   AND EXISTS (
        SELECT 1 FROM produtos manual
         WHERE manual.nome = 'Placa de Vídeo Gigabyte NVIDIA GeForce RTX 5070 Windforce OC SFF 12GB GDDR7'
   );

-- 3. RTX 5050: completa o registro existente ----------------------------------

UPDATE produtos
   SET descricao = 'Ótimo custo-benefício e design neutro com solução térmica eficiente que combina com qualquer setup gamer.',
       tags = ARRAY['rtx', 'msi', 'gpu', 'gddr6', 'placa-de-video'],
       atualizado_em = CURRENT_TIMESTAMP
 WHERE nome = 'Placa de Vídeo RTX 5050 Ventus 2X OC 8GB GDDR6 MSI'
   AND descricao = '';

COMMIT;

SELECT 'Migration 006 aplicada com sucesso!' AS mensagem;
