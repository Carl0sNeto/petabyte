// Recuperação de senha: o token por e-mail e o que o banco guarda dele.
//
// O token dá acesso à conta enquanto vale, então o banco guarda só o hash, e
// usar um link invalida os outros pendentes da mesma pessoa.
//
// Arquivo próprio por causa do limitadorSenha: 5 requisições por hora, somando
// /auth/recuperar-senha e /auth/redefinir-senha. conta.test.js já gasta as 5
// em /auth/alterar-senha. Este arquivo usa 4 — ao acrescentar caso novo,
// conte, ou a sexta requisição recebe 429 e o teste falha sem motivo aparente.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { app, pool, criarTokenRecuperacao } = require('../server.js');
const { criarUsuario, limpar } = require('./ajuda.js');

// O .env local tem SMTP configurado: sem isto, a rota mandaria e-mail de
// verdade para os endereços de fixture. Precisa vir depois do require do
// server.js, porque o dotenv dele repopularia as variáveis apagadas antes.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

let servidor;
let base;

function iniciar() {
    return new Promise((resolve) => {
        servidor = http.createServer(app);
        servidor.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${servidor.address().port}`;
            resolve();
        });
    });
}

async function pedir(metodo, caminho, corpo) {
    const resposta = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo)
    });

    const texto = await resposta.text();
    let dados = {};
    if (texto) {
        try { dados = JSON.parse(texto); } catch (erro) { dados = { mensagem: texto }; }
    }

    return { status: resposta.status, dados };
}

// Calculado aqui, sem reaproveitar a função do servidor: se ela estivesse
// errada, usá-la no teste esconderia o erro.
function sha256(valor) {
    return crypto.createHash('sha256').update(valor).digest('hex');
}

async function tokensGravados(usuarioId) {
    const resultado = await pool.query(
        'SELECT token, usado FROM password_resets WHERE usuario_id = $1 ORDER BY id',
        [usuarioId]
    );
    return resultado.rows;
}

test('recuperação de senha', async (t) => {
    t.before(async () => {
        await limpar();
        await iniciar();
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        // password_resets sai junto com o usuário, pelo ON DELETE CASCADE.
        await limpar();
        await pool.end();
    });

    await t.test('grava só o hash do token, nunca o valor que vai no e-mail', async () => {
        const usuario = await criarUsuario();
        const token = await criarTokenRecuperacao(usuario.id);

        const [gravado] = await tokensGravados(usuario.id);

        assert.notEqual(gravado.token, token, 'o token bruto não pode estar no banco');
        assert.equal(gravado.token, sha256(token));
    });

    await t.test('o valor vazado do banco não serve como token', async () => {
        const usuario = await criarUsuario();
        await criarTokenRecuperacao(usuario.id);
        const [gravado] = await tokensGravados(usuario.id);

        // É o que alguém com um dump de password_resets teria nas mãos.
        const { status } = await pedir('POST', '/auth/redefinir-senha', {
            token: gravado.token,
            senha: 'SenhaDoInvasor123'
        });

        assert.equal(status, 404);
    });

    await t.test('usar um link invalida os outros pendentes da mesma pessoa', async () => {
        const usuario = await criarUsuario();
        const primeiro = await criarTokenRecuperacao(usuario.id);
        const segundo = await criarTokenRecuperacao(usuario.id);

        const comSegundo = await pedir('POST', '/auth/redefinir-senha', {
            token: segundo,
            senha: 'SenhaDoSegundoLink1'
        });
        assert.equal(comSegundo.status, 200, 'o token bruto do e-mail precisa funcionar');

        const comPrimeiro = await pedir('POST', '/auth/redefinir-senha', {
            token: primeiro,
            senha: 'SenhaDoPrimeiroLink1'
        });
        assert.notEqual(comPrimeiro.status, 200, 'o link antigo não pode trocar a senha de novo');
        assert.equal(comPrimeiro.status, 400);

        const conta = await pool.query('SELECT senha FROM usuarios WHERE id = $1', [usuario.id]);
        assert.ok(
            await bcrypt.compare('SenhaDoSegundoLink1', conta.rows[0].senha),
            'a senha que vale é a do segundo link'
        );

        const pendentes = (await tokensGravados(usuario.id)).filter((linha) => !linha.usado);
        assert.equal(pendentes.length, 0);
    });

    await t.test('sem SMTP, a rota apaga o token que não conseguiu enviar', async () => {
        const usuario = await criarUsuario();

        const { status } = await pedir('POST', '/auth/recuperar-senha', { email: usuario.email });
        assert.equal(status, 502);

        // O DELETE precisa procurar pelo hash. Pelo valor bruto não acharia a
        // linha, e sobraria um link válido que ninguém recebeu.
        assert.deepEqual(await tokensGravados(usuario.id), []);
    });
});
