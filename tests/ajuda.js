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
         VALUES ($1, 'Produto de teste', $2, 'hardware', '', $3, $4)
         RETURNING id, nome, preco, estoque`,
        [nomeUnico, preco, estoque, ativo]
    );

    return resultado.rows[0];
}

// Conta de teste com e-mail já confirmado, por padrão: a maioria dos testes
// quer uma conta que entra, e o banco cria contas novas NÃO confirmadas. Quem
// testa a confirmação em si passa emailVerificado: false.
async function criarUsuario({ admin = false, emailVerificado = true } = {}) {
    const email = `${PREFIXO}${Date.now()}_${Math.random().toString(36).slice(2, 8)}@local.test`;

    const resultado = await pool.query(
        `INSERT INTO usuarios (nome, email, senha, admin, email_verificado)
         VALUES ('Usuario de Teste', $1, 'hash-irrelevante', $2, $3)
         RETURNING id, email, admin`,
        [email, admin, emailVerificado]
    );

    return resultado.rows[0];
}

// Emite um access token igual ao do login, sem passar por bcrypt: os testes de
// autorização se importam com o que o middleware faz com o token, não com a
// verificação de senha, que já é coberta em outro lugar.
function emitirToken(usuario) {
    const jwt = require('jsonwebtoken');
    return jwt.sign({ id: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '15m' });
}

// Cabeçalhos de uma requisição autenticada do jeito que o navegador manda: o
// access token em cookie e o CSRF em dobro, cookie e header. O middleware de
// CSRF exige os dois em toda escrita que carregue cookie de sessão.
const CSRF_DE_TESTE = 'csrf-de-teste';

function cabecalhosDeSessao(token) {
    return {
        Cookie: `access_token=${token}; csrf_token=${CSRF_DE_TESTE}`,
        'X-CSRF-Token': CSRF_DE_TESTE
    };
}

async function definirAdmin(usuarioId, admin) {
    await pool.query('UPDATE usuarios SET admin = $1 WHERE id = $2', [admin, usuarioId]);
}

async function lerEstoque(produtoId) {
    const resultado = await pool.query('SELECT estoque FROM produtos WHERE id = $1', [produtoId]);
    return resultado.rowCount === 0 ? null : Number(resultado.rows[0].estoque);
}

// Código de cupom com o prefixo da suíte, em maiúsculas como o banco grava.
function codigoDeCupom(sufixo) {
    return `${PREFIXO}${sufixo}`.toUpperCase();
}

// Cria um cupom direto no banco. Os campos seguem os nomes das colunas.
async function criarCupom({
    sufixo = Math.random().toString(36).slice(2, 8),
    tipo = 'percentual',
    valor = 10,
    ativo = true,
    validoDe = null,
    validoAte = null,
    valorMinimoPedido = 0,
    usoMaximo = null,
    usoMaximoPorUsuario = 1
} = {}) {
    const resultado = await pool.query(
        `INSERT INTO cupons (codigo, tipo, valor, ativo, valido_de, valido_ate,
                             valor_minimo_pedido, uso_maximo, uso_maximo_por_usuario)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, codigo`,
        [codigoDeCupom(sufixo), tipo, valor, ativo, validoDe, validoAte, valorMinimoPedido, usoMaximo, usoMaximoPorUsuario]
    );

    return resultado.rows[0];
}

// Remove tudo que os testes criaram. Pedidos, histórico, sessões e usos de
// cupom saem junto com o usuário pelo ON DELETE CASCADE; por isso os cupons
// vêm depois dos usuários.
async function limpar() {
    await pool.query('DELETE FROM usuarios WHERE email LIKE $1', [`${PREFIXO}%`]);
    await pool.query('DELETE FROM cupons WHERE codigo LIKE $1', [`${PREFIXO.toUpperCase()}%`]);
    await pool.query('DELETE FROM produtos WHERE nome LIKE $1', [`${PREFIXO}%`]);
}

module.exports = {
    criarProduto,
    criarUsuario,
    criarCupom,
    codigoDeCupom,
    emitirToken,
    cabecalhosDeSessao,
    definirAdmin,
    lerEstoque,
    limpar,
    pool,
    PREFIXO
};
