// Cadastro com senha: lista de provedores, força da senha e confirmação do
// e-mail por link antes do primeiro login.
//
// O SMTP é simulado: as variáveis ganham valores falsos (o servidor só monta
// o envio se as três existirem) e o nodemailer.createTransport que o próprio
// servidor usa passa a devolver uma caixa de saída em memória. O teste lê o
// link do e-mail "enviado", como a pessoa faria. Nenhum e-mail sai de verdade,
// mesmo com o SMTP real configurado no .env.
//
// Requisições por limitador neste arquivo (cada arquivo roda em processo
// próprio, então os contadores começam zerados):
// - limitadorCadastro (20/h, cadastro + newsletter + confirmação): 19
// - limitadorSenha (5/h, reenvio + troca + redefinição): 4
// - limitadorLogin (10 falhas/15 min): 2
// Ao acrescentar caso novo, conte — a requisição que passar do teto recebe 429.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

process.env.SMTP_HOST = 'smtp.teste.invalid';
process.env.SMTP_USER = 'teste';
process.env.SMTP_PASS = 'teste';

const caixaDeSaida = [];
let falharEnvio = false;

nodemailer.createTransport = () => ({
    verify: async () => {},
    sendMail: async (mensagem) => {
        if (falharEnvio) throw new Error('SMTP simulado fora do ar');
        caixaDeSaida.push(mensagem);
    }
});

const { app, pool, criarTokenRecuperacao } = require('../server.js');
const { criarUsuario, limpar, PREFIXO } = require('./ajuda.js');

const SENHA = 'SenhaForte2026';
let servidor;
let base;
let contador = 0;

function iniciar() {
    return new Promise((resolve) => {
        servidor = http.createServer(app);
        servidor.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${servidor.address().port}`;
            resolve();
        });
    });
}

async function pedir(metodo, caminho, { corpo = null, cookies = null } = {}) {
    const cabecalhos = { 'Content-Type': 'application/json' };

    if (cookies) {
        cabecalhos.Cookie = `access_token=${cookies.access_token}; csrf_token=${cookies.csrf_token}`;
        cabecalhos['X-CSRF-Token'] = cookies.csrf_token;
    }

    const resposta = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: cabecalhos,
        body: corpo ? JSON.stringify(corpo) : undefined
    });

    const recebidos = {};
    for (const bruto of resposta.headers.getSetCookie()) {
        const [par] = bruto.split(';');
        const igual = par.indexOf('=');
        recebidos[par.slice(0, igual)] = par.slice(igual + 1);
    }

    const texto = await resposta.text();
    let dados = {};
    if (texto) {
        try { dados = JSON.parse(texto); } catch (erro) { dados = { mensagem: texto }; }
    }

    return { status: resposta.status, dados, cookies: recebidos.access_token ? recebidos : null };
}

// E-mail num provedor da lista, com o prefixo que o limpar() apaga.
function novoEmail() {
    contador += 1;
    return `${PREFIXO}conta_${contador}@gmail.com`;
}

function tokenDoUltimoEmail(para) {
    const mensagem = caixaDeSaida.filter((m) => m.to === para).at(-1);
    assert.ok(mensagem, `nenhum e-mail foi enviado para ${para}`);
    const achado = mensagem.html.match(/verificar-email\.html\?token=([a-f0-9]{64})/);
    assert.ok(achado, 'o e-mail precisa levar o link de confirmação');
    return achado[1];
}

async function lerConta(email) {
    const resultado = await pool.query('SELECT id, email, email_verificado FROM usuarios WHERE email = $1', [email]);
    return resultado.rows[0];
}

test('verificação de e-mail e senha no cadastro', async (t) => {
    t.before(async () => {
        await limpar();
        await iniciar();
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    await t.test('recusa e-mail de provedor fora da lista, como os temporários', async () => {
        const recusados = ['mailinator.com', 'guerrillamail.com', 'empresa-desconhecida.com.br']
            .map((dominio) => `${PREFIXO}temp@${dominio}`);

        for (const email of [...recusados, 'sem-arroba.gmail.com']) {
            const { status, dados } = await pedir('POST', '/auth/cadastro', { corpo: { nome: 'Alguém', email, senha: SENHA } });
            assert.equal(status, 400, `deveria recusar ${email}`);

            if (email.includes('mailinator')) {
                assert.match(dados.mensagem, /temporários não são aceitos/);
            }
        }

        const criadas = await pool.query('SELECT count(*)::int AS n FROM usuarios WHERE email LIKE $1', [`${PREFIXO}temp@%`]);
        assert.equal(criadas.rows[0].n, 0);
    });

    await t.test('recusa senha fraca, dizendo o motivo', async () => {
        // Com o prefixo do limpar(): se a validação quebrar, o cadastro passa
        // e a conta sai no after, em vez de ficar de lixo no banco.
        const email = `${PREFIXO}marcelinho@gmail.com`;
        const usuarioDoEmail = email.split('@')[0];

        const casos = [
            ['Curta1', /8 caracteres/],
            ['somenteletras', /letras e números/],
            ['12345678901', /letras e números/],
            ['Senha123', /comum demais/],
            [`${usuarioDoEmail.toUpperCase()}2026`, /não pode conter o seu e-mail/]
        ];

        for (const [senha, motivo] of casos) {
            const { status, dados } = await pedir('POST', '/auth/cadastro', {
                corpo: { nome: 'Marcelo', email, senha }
            });
            assert.equal(status, 400, `deveria recusar a senha "${senha}"`);
            assert.match(dados.mensagem, motivo);
        }
    });

    let emailConfirmado;

    await t.test('cadastro válido cria a conta sem sessão e manda o link; o banco guarda só o hash', async () => {
        const email = novoEmail();
        // Maiúsculas no que a pessoa digita: grava em minúsculas.
        const digitado = email.replace('conta_', 'CONTA_').replace('gmail.com', 'Gmail.com');

        const { status, dados, cookies } = await pedir('POST', '/auth/cadastro', {
            corpo: { nome: 'Pessoa Nova', email: digitado, senha: SENHA }
        });

        assert.equal(status, 201);
        assert.equal(cookies, null, 'sem sessão antes de confirmar o e-mail');
        assert.equal(dados.email, email, 'o e-mail é gravado em minúsculas');

        const conta = await lerConta(email);
        assert.equal(conta.email_verificado, false);

        const token = tokenDoUltimoEmail(email);
        const gravado = await pool.query('SELECT token_hash FROM verificacoes_email WHERE usuario_id = $1', [conta.id]);
        assert.equal(gravado.rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
        assert.notEqual(gravado.rows[0].token_hash, token);

        emailConfirmado = email;
    });

    await t.test('antes de confirmar, o login recusa com código próprio — mas só com a senha certa', async () => {
        const errada = await pedir('POST', '/auth/login', { corpo: { email: emailConfirmado, senha: 'OutraSenha999' } });
        assert.equal(errada.status, 401, 'sem a senha, não se descobre se a conta está confirmada');

        const certa = await pedir('POST', '/auth/login', { corpo: { email: emailConfirmado, senha: SENHA } });
        assert.equal(certa.status, 403);
        assert.equal(certa.dados.codigo, 'email_nao_verificado');
        assert.equal(certa.cookies, null);
    });

    let sessao;

    await t.test('o link confirma o e-mail, e o login passa, ignorando maiúsculas', async () => {
        const token = tokenDoUltimoEmail(emailConfirmado);

        const confirmacao = await pedir('POST', '/auth/verificar-email', { corpo: { token } });
        assert.equal(confirmacao.status, 200);
        assert.equal((await lerConta(emailConfirmado)).email_verificado, true);

        const login = await pedir('POST', '/auth/login', { corpo: { email: emailConfirmado.toUpperCase(), senha: SENHA } });
        assert.equal(login.status, 200);
        assert.ok(login.cookies, 'agora a sessão abre');
        sessao = login.cookies;
    });

    await t.test('link já usado ou inventado não confirma nada', async () => {
        const usado = await pedir('POST', '/auth/verificar-email', { corpo: { token: tokenDoUltimoEmail(emailConfirmado) } });
        assert.equal(usado.status, 400);

        const inventado = await pedir('POST', '/auth/verificar-email', { corpo: { token: 'a'.repeat(64) } });
        assert.equal(inventado.status, 400);
    });

    await t.test('link expirado pede outro; o reenvio exige a senha e o link novo substitui o antigo', async () => {
        const email = novoEmail();
        await pedir('POST', '/auth/cadastro', { corpo: { nome: 'Pessoa Atrasada', email, senha: SENHA } });
        const antigo = tokenDoUltimoEmail(email);

        await pool.query(
            "UPDATE verificacoes_email SET expira_em = NOW() - INTERVAL '1 minute' WHERE token_hash = $1",
            [crypto.createHash('sha256').update(antigo).digest('hex')]
        );
        const expirado = await pedir('POST', '/auth/verificar-email', { corpo: { token: antigo } });
        assert.equal(expirado.status, 400);
        assert.match(expirado.dados.mensagem, /expirou/);

        const semSenha = await pedir('POST', '/auth/reenviar-verificacao', { corpo: { email, senha: 'Chute12345' } });
        assert.equal(semSenha.status, 401, 'só quem criou a conta pede o reenvio');

        const reenvio = await pedir('POST', '/auth/reenviar-verificacao', { corpo: { email, senha: SENHA } });
        assert.equal(reenvio.status, 200);
        const novo = tokenDoUltimoEmail(email);
        assert.notEqual(novo, antigo);

        // O antigo agora está invalidado — não só expirado.
        const deNovo = await pedir('POST', '/auth/verificar-email', { corpo: { token: antigo } });
        assert.match(deNovo.dados.mensagem, /não vale mais/);

        assert.equal((await pedir('POST', '/auth/verificar-email', { corpo: { token: novo } })).status, 200);
    });

    await t.test('redefinir a senha pelo link do e-mail também confirma o e-mail', async () => {
        const conta = await criarUsuario({ emailVerificado: false });
        const token = await criarTokenRecuperacao(conta.id);

        const redefinicao = await pedir('POST', '/auth/redefinir-senha', { corpo: { token, senha: 'SenhaRedefinida2026' } });
        assert.equal(redefinicao.status, 200);

        const login = await pedir('POST', '/auth/login', { corpo: { email: conta.email, senha: 'SenhaRedefinida2026' } });
        assert.equal(login.status, 200, 'quem recebeu o link no e-mail provou ser dono dele');
    });

    await t.test('a troca de senha aplica a mesma regra de força', async () => {
        const { status, dados } = await pedir('POST', '/auth/alterar-senha', {
            cookies: sessao,
            corpo: { senhaAtual: SENHA, novaSenha: 'somenteletras' }
        });

        assert.equal(status, 400);
        assert.match(dados.mensagem, /letras e números/);
    });

    await t.test('se o e-mail de confirmação não sai, a conta não fica criada', async () => {
        const email = novoEmail();
        falharEnvio = true;

        try {
            const { status } = await pedir('POST', '/auth/cadastro', { corpo: { nome: 'Sem Sorte', email, senha: SENHA } });
            assert.equal(status, 502);
        } finally {
            falharEnvio = false;
        }

        assert.equal(await lerConta(email), undefined, 'uma conta que nunca poderia ser confirmada não pode ocupar o e-mail');
    });

    await t.test('a newsletter aplica a mesma lista de provedores a conta nova', async () => {
        const { status } = await pedir('POST', '/usuarios', {
            corpo: { nome: 'Assinante', email: `${PREFIXO}news@mailinator.com` }
        });
        assert.equal(status, 400);
    });
});
