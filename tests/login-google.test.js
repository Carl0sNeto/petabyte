// Login com Google: criação de conta, vínculo por e-mail verificado, conta sem
// senha e desconexão.
//
// O endpoint tokeninfo da Google é simulado interceptando o fetch global só
// para a URL dele; o resto (inclusive as chamadas deste arquivo ao app) passa
// direto. Nada no servidor muda para acomodar o teste. A "credencial" é um
// JSON em base64 com os campos que o tokeninfo devolveria.
//
// Arquivo próprio, e não conta.test.js, por causa do limitadorSenha (5 por
// hora): conta.test.js já gasta as 5 e aqui a troca de senha é usada 3 vezes.
// Falhas de login contam no limitadorLogin (10): este arquivo gera 6.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');

const CLIENT_ID = 'cliente-de-teste.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;

const { app, pool } = require('../server.js');
const { criarUsuario, limpar, PREFIXO } = require('./ajuda.js');

let servidor;
let base;
let contador = 0;
const tokensConsultados = [];

const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opcoes) => {
    const endereco = String(url);

    if (!endereco.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return fetchOriginal(url, opcoes);
    }

    const credencial = new URL(endereco).searchParams.get('id_token');
    tokensConsultados.push(credencial);
    const campos = JSON.parse(Buffer.from(credencial.split('.')[1], 'base64url').toString('utf8'));

    if (campos.recusadoPeloGoogle) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 });
    }

    const resposta = {
        aud: CLIENT_ID,
        iss: 'https://accounts.google.com',
        exp: String(Math.floor(Date.now() / 1000) + 3600),
        email_verified: 'true',
        ...campos
    };

    return new Response(JSON.stringify(resposta), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function credencial(campos) {
    return `teste.${Buffer.from(JSON.stringify(campos)).toString('base64url')}.assinatura`;
}

function novaIdentidade() {
    contador += 1;
    return {
        sub: `sub-${PREFIXO}${contador}`,
        email: `${PREFIXO}google_${contador}@local.test`,
        name: `Pessoa Google ${contador}`
    };
}

function iniciar() {
    return new Promise((resolve) => {
        servidor = http.createServer(app);
        servidor.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${servidor.address().port}`;
            resolve();
        });
    });
}

async function pedir(metodo, caminho, { corpo = null, sessao = null } = {}) {
    const cabecalhos = { 'Content-Type': 'application/json' };

    if (sessao) {
        cabecalhos.Cookie = `access_token=${sessao.access_token}; csrf_token=${sessao.csrf_token}`;
        cabecalhos['X-CSRF-Token'] = sessao.csrf_token;
    }

    const resposta = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: cabecalhos,
        body: corpo ? JSON.stringify(corpo) : undefined
    });

    const sessaoNova = {};
    for (const bruto of resposta.headers.getSetCookie()) {
        const [par] = bruto.split(';');
        const igual = par.indexOf('=');
        sessaoNova[par.slice(0, igual)] = par.slice(igual + 1);
    }

    const texto = await resposta.text();
    let dados = {};
    if (texto) {
        try { dados = JSON.parse(texto); } catch (erro) { dados = { mensagem: texto }; }
    }

    return { status: resposta.status, dados, sessao: sessaoNova.access_token ? sessaoNova : null };
}

function entrarComGoogle(campos) {
    return pedir('POST', '/auth/google', { corpo: { credential: credencial(campos) } });
}

async function lerConta(id) {
    const resultado = await pool.query('SELECT senha, admin, google_id, email_verificado FROM usuarios WHERE id = $1', [id]);
    return resultado.rows[0];
}

test('login com Google', async (t) => {
    t.before(async () => {
        await limpar();
        await iniciar();
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        globalThis.fetch = fetchOriginal;
        await limpar();
        await pool.end();
    });

    await t.test('/config entrega o Client ID, que não é segredo', async () => {
        const { dados } = await pedir('GET', '/config');
        assert.equal(dados.googleClientId, CLIENT_ID);
    });

    await t.test('cria conta nova sem senha e sem admin, e já abre a sessão', async () => {
        const identidade = novaIdentidade();
        const { status, dados, sessao } = await entrarComGoogle(identidade);

        assert.equal(status, 201);
        assert.equal(dados.usuario.email, identidade.email);
        assert.equal(dados.usuario.nome, identidade.name);
        assert.ok(sessao, 'a sessão vem em cookies, como no login com senha');
        assert.equal(tokensConsultados.at(-1), credencial(identidade), 'a credencial foi conferida na Google');

        const conta = await lerConta(dados.usuario.id);
        assert.equal(conta.senha, null);
        assert.equal(conta.admin, false, 'ninguém vira admin sozinho');
        assert.equal(conta.google_id, identidade.sub);
        assert.equal(conta.email_verificado, true, 'a Google já confirmou o e-mail');
    });

    await t.test('vincular conta de e-mail nunca confirmado desativa a senha e derruba as sessões', async () => {
        // O cenário do pré-sequestro: alguém cadastrou o e-mail de outra pessoa
        // com uma senha que só ele sabe, e deixou uma sessão aberta.
        const intrusa = await criarUsuario({ emailVerificado: false });
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [await bcrypt.hash('SenhaDoIntruso123', 10), intrusa.id]);
        await pool.query(
            `INSERT INTO refresh_tokens (usuario_id, token_hash, expira_em)
             VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
            [intrusa.id, `hash-de-sessao-do-intruso-${contador}`]
        );

        // A dona do e-mail entra com o Google.
        const { status } = await entrarComGoogle({ ...novaIdentidade(), email: intrusa.email });
        assert.equal(status, 200);

        const conta = await lerConta(intrusa.id);
        assert.equal(conta.senha, null, 'a senha de quem não provou ser dono do e-mail não vale mais');
        assert.equal(conta.email_verificado, true);

        const sessoesAntigas = await pool.query(
            'SELECT count(*)::int AS n FROM refresh_tokens WHERE usuario_id = $1 AND token_hash LIKE $2 AND revogado_em IS NULL',
            [intrusa.id, 'hash-de-sessao-do-intruso-%']
        );
        assert.equal(sessoesAntigas.rows[0].n, 0, 'a sessão aberta antes do vínculo cai');

        const comSenhaAntiga = await pedir('POST', '/auth/login', {
            corpo: { email: intrusa.email, senha: 'SenhaDoIntruso123' }
        });
        assert.notEqual(comSenhaAntiga.status, 200);
    });

    await t.test('vincula a conta existente com o mesmo e-mail verificado', async () => {
        const existente = await criarUsuario();
        const identidade = { ...novaIdentidade(), email: existente.email.toUpperCase() };

        const { status, dados } = await entrarComGoogle(identidade);

        assert.equal(status, 200);
        assert.equal(dados.usuario.id, existente.id, 'não pode duplicar o cadastro');
        assert.equal((await lerConta(existente.id)).google_id, identidade.sub);
        assert.equal((await lerConta(existente.id)).senha, 'hash-irrelevante', 'conta já confirmada mantém a senha');

        const contas = await pool.query('SELECT count(*)::int AS n FROM usuarios WHERE lower(email) = lower($1)', [existente.email]);
        assert.equal(contas.rows[0].n, 1);
    });

    await t.test('as entradas seguintes reconhecem a pessoa pelo google_id, não pelo e-mail', async () => {
        const identidade = novaIdentidade();
        const primeira = await entrarComGoogle(identidade);

        // A pessoa trocou o e-mail na conta Google; o sub continua o mesmo.
        const segunda = await entrarComGoogle({ ...identidade, email: `${PREFIXO}trocou_${contador}@local.test` });

        assert.equal(segunda.status, 200);
        assert.equal(segunda.dados.usuario.id, primeira.dados.usuario.id);
    });

    await t.test('recusa credencial emitida para outro aplicativo', async () => {
        const { status, dados } = await entrarComGoogle({ ...novaIdentidade(), aud: 'outro-site.apps.googleusercontent.com' });
        assert.equal(status, 401);
        assert.match(dados.mensagem, /outro aplicativo/);
    });

    await t.test('recusa e-mail que a Google não verificou', async () => {
        const identidade = novaIdentidade();
        const { status } = await entrarComGoogle({ ...identidade, email_verified: 'false' });

        assert.equal(status, 401);
        const criada = await pool.query('SELECT 1 FROM usuarios WHERE email = $1', [identidade.email]);
        assert.equal(criada.rowCount, 0, 'nenhuma conta nasce de e-mail não verificado');
    });

    await t.test('recusa credencial que a própria Google rejeita', async () => {
        const { status } = await entrarComGoogle({ recusadoPeloGoogle: true });
        assert.equal(status, 401);
    });

    await t.test('não troca em silêncio o vínculo de um e-mail já ligado a outra conta Google', async () => {
        const identidade = novaIdentidade();
        await entrarComGoogle(identidade);

        const intrusa = await entrarComGoogle({ ...identidade, sub: `outro-sub-${contador}` });
        assert.equal(intrusa.status, 409);

        const conta = await pool.query('SELECT google_id FROM usuarios WHERE email = $1', [identidade.email]);
        assert.equal(conta.rows[0].google_id, identidade.sub, 'o vínculo original continua');
    });

    await t.test('login com senha numa conta só-Google explica o caminho, sem 500', async () => {
        const identidade = novaIdentidade();
        await entrarComGoogle(identidade);

        const { status, dados } = await pedir('POST', '/auth/login', {
            corpo: { email: identidade.email, senha: 'QualquerSenha123' }
        });

        assert.equal(status, 401);
        assert.match(dados.mensagem, /entra com o Google/);
    });

    await t.test('/auth/me diz se há Google e senha, sem expor o google_id', async () => {
        const { sessao } = await entrarComGoogle(novaIdentidade());
        const { dados } = await pedir('GET', '/auth/me', { sessao });

        assert.equal(dados.usuario.googleConectado, true);
        assert.equal(dados.usuario.temSenha, false);
        assert.equal('google_id' in dados.usuario, false);
        assert.equal('senha' in dados.usuario, false);
    });

    await t.test('desconectar sem senha definida é recusado', async () => {
        const { sessao, dados } = await entrarComGoogle(novaIdentidade());

        const { status, dados: resposta } = await pedir('POST', '/auth/google/desconectar', { sessao });
        assert.equal(status, 400);
        assert.match(resposta.mensagem, /Defina uma senha/);
        assert.ok((await lerConta(dados.usuario.id)).google_id, 'o vínculo continua');
    });

    await t.test('conta sem senha define a primeira sem pedir a atual, e aí pode desconectar', async () => {
        const { sessao, dados } = await entrarComGoogle(novaIdentidade());

        const definicao = await pedir('POST', '/auth/alterar-senha', { sessao, corpo: { novaSenha: 'PrimeiraSenha123' } });
        assert.equal(definicao.status, 200);
        assert.match(definicao.dados.mensagem, /definida/);
        assert.ok(await bcrypt.compare('PrimeiraSenha123', (await lerConta(dados.usuario.id)).senha));

        // A troca abre sessão nova (e derruba as outras): segue com a nova.
        const saida = await pedir('POST', '/auth/google/desconectar', { sessao: definicao.sessao });
        assert.equal(saida.status, 200);
        assert.equal((await lerConta(dados.usuario.id)).google_id, null);
    });

    await t.test('conta com senha continua exigindo a senha atual para trocar', async () => {
        const { sessao, dados } = await entrarComGoogle(novaIdentidade());
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [await bcrypt.hash('SenhaAtual123', 10), dados.usuario.id]);

        const semAtual = await pedir('POST', '/auth/alterar-senha', { sessao, corpo: { novaSenha: 'OutraSenha456' } });
        assert.equal(semAtual.status, 400, 'a guarda nova não pode afrouxar o caso normal');

        const atualErrada = await pedir('POST', '/auth/alterar-senha', {
            sessao,
            corpo: { senhaAtual: 'Chute999999', novaSenha: 'OutraSenha456' }
        });
        assert.equal(atualErrada.status, 403);
    });

    await t.test('cadastro com senha num e-mail de conta só-Google continua bloqueado', async () => {
        // Provedor da lista, para o cadastro chegar à checagem de duplicidade
        // (a de provedor vem antes). Recusado com 409, nenhum e-mail sai.
        const identidade = { ...novaIdentidade(), email: `${PREFIXO}google_${contador}@gmail.com` };
        await entrarComGoogle(identidade);

        const { status } = await pedir('POST', '/auth/cadastro', {
            corpo: { nome: 'Outra Pessoa', email: identidade.email, senha: 'SenhaQualquer123' }
        });
        assert.equal(status, 409);
    });
});
