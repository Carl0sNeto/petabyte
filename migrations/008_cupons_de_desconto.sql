-- Migration 008: cupons de desconto
--
-- O cupom vale como o preço do produto: o carrinho manda só o código, e o
-- servidor recalcula o desconto do zero em toda etapa. O uso só é contado na
-- confirmação do pagamento (cupom_contabilizado, espelho de estoque_baixado),
-- e estorno, cancelamento e chargeback devolvem a vaga.
--
-- Idempotente: pode ser executada mais de uma vez com segurança.

BEGIN;

CREATE TABLE IF NOT EXISTS cupons (
    id SERIAL PRIMARY KEY,
    -- Gravado e comparado sempre em maiúsculas.
    codigo VARCHAR(50) NOT NULL UNIQUE,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('percentual', 'fixo')),
    valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
    -- Cupom não se apaga, se desativa: pedidos antigos continuam apontando
    -- para ele.
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    -- TIMESTAMPTZ, e não TIMESTAMP: a validade é um instante. Sem fuso, um
    -- cupom "até 30/09 23:59" cadastrado no Brasil venceria às 20:59, porque
    -- o banco (Neon) compara com NOW() em UTC.
    valido_de TIMESTAMPTZ,
    valido_ate TIMESTAMPTZ,
    valor_minimo_pedido NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (valor_minimo_pedido >= 0),
    -- NULL = sem limite geral.
    uso_maximo INTEGER CHECK (uso_maximo IS NULL OR uso_maximo > 0),
    uso_maximo_por_usuario INTEGER NOT NULL DEFAULT 1 CHECK (uso_maximo_por_usuario > 0),
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (tipo <> 'percentual' OR valor <= 100),
    CHECK (valido_de IS NULL OR valido_ate IS NULL OR valido_ate > valido_de)
);

CREATE TABLE IF NOT EXISTS cupom_usos (
    id SERIAL PRIMARY KEY,
    -- CASCADE nas três: sem ele, apagar uma conta falharia por chave
    -- estrangeira (usuarios -> pedidos cascateia, e o uso travaria no meio).
    cupom_id INTEGER NOT NULL REFERENCES cupons(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    -- Um pedido usa no máximo um cupom, uma vez. A flag cupom_contabilizado é
    -- a guarda principal contra contar duas vezes; o UNIQUE é a rede no banco.
    pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
    usado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cupom_usos_cupom_usuario ON cupom_usos (cupom_id, usuario_id);

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cupom_id INTEGER REFERENCES cupons(id) ON DELETE SET NULL;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS desconto NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cupom_contabilizado BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

SELECT 'Migration 008 aplicada com sucesso!' AS mensagem;
