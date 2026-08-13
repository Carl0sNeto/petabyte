-- Script de inicialização do banco de dados Petabyte
-- Ajuste host/porta/usuario conforme as variáveis de ambiente da máquina atual.

-- Tabela de Usuários
CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    senha TEXT NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Histórico de Compras
CREATE TABLE IF NOT EXISTS historico_compras (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    pedido VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabela de Recuperação de Senha
CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expira_em TIMESTAMP NOT NULL,
    usado BOOLEAN DEFAULT FALSE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reset_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabela de Pedidos
CREATE TABLE IF NOT EXISTS pedidos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    historico_id INTEGER NOT NULL UNIQUE,
    external_reference TEXT NOT NULL UNIQUE,
    preference_id TEXT UNIQUE,
    payment_id TEXT UNIQUE,
    status VARCHAR(50) NOT NULL,
    payment_status VARCHAR(50) NOT NULL,
    expira_em TIMESTAMP,
    subtotal NUMERIC(10,2) NOT NULL,
    frete NUMERIC(10,2) NOT NULL,
    total NUMERIC(10,2) NOT NULL,
    moeda VARCHAR(10) NOT NULL DEFAULT 'BRL',
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pedido_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    CONSTRAINT fk_pedido_historico FOREIGN KEY (historico_id) REFERENCES historico_compras(id) ON DELETE CASCADE
);

-- Tabela de Itens do Pedido
CREATE TABLE IF NOT EXISTS pedido_itens (
    id SERIAL PRIMARY KEY,
    pedido_id INTEGER NOT NULL,
    nome VARCHAR(150) NOT NULL,
    preco_unitario NUMERIC(10,2) NOT NULL,
    quantidade INTEGER NOT NULL,
    total NUMERIC(10,2) NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_item_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
);

-- Índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_historico_usuario ON historico_compras(usuario_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_password_resets_usuario ON password_resets(usuario_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_usuario ON pedidos(usuario_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_historico ON pedidos(historico_id);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido ON pedido_itens(pedido_id);

-- Confirmação
SELECT 'Banco de dados inicializado com sucesso!' AS mensagem;
