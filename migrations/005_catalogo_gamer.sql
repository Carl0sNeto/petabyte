-- Migration 005: catálogo inicial de produtos gamer
--
-- Origem: lista fornecida em JSON com nome, categoria hierárquica, preço
-- estimado, descrição e tags.
--
-- Duas conversões foram necessárias:
--   * A categoria do JSON vinha em dois níveis ("Hardware > Placa de Vídeo").
--     O schema é plano, então guardamos apenas o nível superior; o segundo
--     nível vira tag, para não se perder.
--   * O JSON não informava estoque. Os valores abaixo são iniciais e devem ser
--     ajustados no painel: menores em placas de vídeo, maiores em periféricos.
--
-- imagem_url fica vazio de propósito: o JSON não trazia imagens. Cadastre-as
-- pelo painel, onde há prévia para conferir o link antes de salvar.
--
-- Idempotente: ON CONFLICT no nome evita duplicar em nova execução.

BEGIN;

INSERT INTO produtos (nome, descricao, preco, categoria, imagem_url, estoque, ativo, tags) VALUES
    ('Placa de Vídeo Gigabyte NVIDIA GeForce RTX 5070 Windforce OC SFF 12GB',
     'Alto desempenho e refrigeração robusta de nível de servidor em gabinetes compactos, ideal para rodar os jogos mais pesados da atualidade.',
     5882.30, 'hardware', '', 6, TRUE,
     ARRAY['rtx', 'gigabyte', 'gpu', 'gddr7', 'placa-de-video']),

    ('Placa de Vídeo RTX 5050 Ventus 2X OC 8GB GDDR6 MSI',
     'Ótimo custo-benefício e design neutro com solução térmica eficiente que combina com qualquer setup gamer.',
     2399.00, 'hardware', '', 12, TRUE,
     ARRAY['rtx', 'msi', 'gpu', 'gddr6', 'placa-de-video']),

    ('Processador AMD Ryzen 5 9600X',
     'Arquitetura Zen 5 com 6 núcleos e 12 threads. Ideal para entusiastas de performance e multitarefa avançada.',
     1404.80, 'hardware', '', 15, TRUE,
     ARRAY['amd', 'ryzen', 'cpu', 'zen5', 'processador']),

    ('Teclado Mecânico Gamer Logitech G PRO',
     'Switches mecânicos GX avançados e design compacto ultra portátil focado no cenário competitivo.',
     656.90, 'perifericos', '', 25, TRUE,
     ARRAY['teclado', 'logitech', 'mecanico', 'rgb']),

    ('Mouse Gamer Logitech G Pro X Superlight 2 Sem Fio',
     'Apenas 60 gramas, sensor HERO 2 de até 32.000 DPI e switches híbridos óptico-mecânicos LIGHTFORCE.',
     899.90, 'perifericos', '', 18, TRUE,
     ARRAY['mouse', 'logitech', 'wireless', 'competitivo']),

    ('Mouse Gamer Logitech G502 Hero',
     'Sensor óptico avançado, design ergonômico anti-fadiga, peso ajustável e 11 botões personalizáveis.',
     376.40, 'perifericos', '', 30, TRUE,
     ARRAY['mouse', 'logitech', 'hero', 'ergonomico']),

    ('Headset Gamer Sem Fio Logitech G Astro A20 X LIGHTSPEED',
     'Conectividade multiplataforma premium (PlaySync), áudio de alta precisão de 24 bits e conforto excepcional.',
     1349.90, 'audio', '', 10, TRUE,
     ARRAY['headset', 'astro', 'wireless', 'audio']),

    ('Headset Gamer G335 Logitech',
     'Opção de entrada confortável, leve, com design moderno, almofadas de memória e conexão plug-and-play.',
     442.20, 'audio', '', 28, TRUE,
     ARRAY['headset', 'logitech', 'p2', 'conforto']),

    ('Monitor Gamer 27 UltraGear 27G411A-B 144Hz Full HD',
     'Movimento fluido com 144Hz, tempo de resposta de 1ms, compatível com G-SYNC e FreeSync. 27 polegadas.',
     799.00, 'monitores', '', 14, TRUE,
     ARRAY['monitor', 'lg', '144hz', 'ultragear']),

    ('Monitor Gamer LG UltraGear 24G411A-B 144Hz Full HD',
     'Painel IPS com cores vivas, tela de 24 polegadas, 144Hz de atualização e suporte a FreeSync/G-Sync.',
     831.40, 'monitores', '', 4, TRUE,
     ARRAY['monitor', 'lg', '144hz', 'ips'])
ON CONFLICT (nome) DO NOTHING;

COMMIT;

SELECT 'Migration 005 aplicada com sucesso!' AS mensagem;
