// Fixtures compartilhados pelos testes.
//
// Os testes tocam o banco configurado no .env. Para não interferir no catálogo
// real, cada suíte cria seus próprios produtos e usuários com prefixo
// reconhecível e os remove ao final.
//
// O prefixo inclui o pid porque o runner do Node executa cada arquivo de teste
// em um processo separado. Com um prefixo comum, o limpar() de um arquivo
// apagava as fixtures do outro e os DELETE concorrentes geravam deadlock.

const { pool } = require('../server.js');

const PREFIXO = `__teste_${process.pid}_${Math.random().toString(36).slice(2, 8)}__`;

async function criarProduto({ preco, estoque, nome = null, ativo = true }) {
    const nomeUnico = nome || `${PREFIXO}produto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const resultado = await pool.query(
        `INSERT INTO produtos (nome, descricao, preco, categoria, imagem_url, estoque, ativo)
         VALUES ($1, 'Produto de teste', $2, 'teste', '', $3, $4)
         RETURNING id, nome, preco, estoque`,
        [nomeUnico, preco, estoque, ativo]
    );

    return resultado.rows[0];
}

async function criarUsuario() {
    const email = `${PREFIXO}${Date.now()}_${Math.random().toString(36).slice(2, 8)}@local.test`;

    const resultado = await pool.query(
        `INSERT INTO usuarios (nome, email, senha) VALUES ('Usuario de Teste', $1, 'hash-irrelevante')
         RETURNING id, email`,
        [email]
    );

    return resultado.rows[0];
}

async function lerEstoque(produtoId) {
    const resultado = await pool.query('SELECT estoque FROM produtos WHERE id = $1', [produtoId]);
    return resultado.rowCount === 0 ? null : Number(resultado.rows[0].estoque);
}

// Remove tudo que os testes criaram. Pedidos e histórico saem junto com o
// usuário pelo ON DELETE CASCADE.
async function limpar() {
    await pool.query('DELETE FROM usuarios WHERE email LIKE $1', [`${PREFIXO}%`]);
    await pool.query('DELETE FROM produtos WHERE nome LIKE $1', [`${PREFIXO}%`]);
}

module.exports = { criarProduto, criarUsuario, lerEstoque, limpar, pool, PREFIXO };
