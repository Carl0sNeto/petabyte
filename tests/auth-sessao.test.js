// Sessão em cookies httpOnly: access token curto, refresh token rotativo e
// CSRF por double-submit.
//
// Cada "navegador" abaixo é um pote de cookies que respeita Path e expiração,
// como um navegador de verdade: é isso que prova, por exemplo, que o refresh
// token (Path=/auth) chega ao /auth/logout.
//
// Requisições por limitador: login não conta (skipSuccessfulRequests e todos
// dão certo); cadastro, 1 de 20; limitadorSenha, 2 de 5.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { app, pool, criarTokenRecuperacao } = require('../server.js');
const { criarUsuario, limpar } = require('./ajuda.js');

const SENHA = 'SenhaDeTeste123';

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

function sha256(valor) {
    return crypto.createHash('sha256').update(valor).digest('hex');
}

// Interpreta um Set-Cookie no nível que interessa aqui: nome, valor, Path,
// HttpOnly, SameSite e se ele apaga o cookie (Expires no passado).
function lerSetCookie(bruto) {
    const [par, ...atributos] = bruto.split(';').map((parte) => parte.trim());
    const igual = par.indexOf('=');
    const cookie = {
        nome: par.slice(0, igual),
        valor: decodeURIComponent(par.slice(igual + 1)),
        path: '/',
        httpOnly: false,
        sameSite: null,
        apaga: false
    };

    for (const atributo of atributos) {
        const [chave, ...resto] = atributo.split('=');
        const valor = resto.join('=');
        const nome = chave.toLowerCase();

        if (nome === 'path') cookie.path = valor;
        if (nome === 'httponly') cookie.httpOnly = true;
        if (nome === 'samesite') cookie.sameSite = valor;
        if (nome === 'expires' && new Date(valor) <= new Date()) cookie.apaga = true;
        if (nome === 'max-age' && Number(valor) <= 0) cookie.apaga = true;
    }

    return cookie;
}

class Navegador {
    constructor() {
        this.cookies = new Map();
        this.ultimosSetCookie = [];
    }

    valor(nome) {
        const cookie = this.cookies.get(nome);
        return cookie ? cookie.valor : undefined;
    }

    // Troca o valor de um cookie mantendo o resto, para simular um token
    // vencido ou uma cópia antiga guardada por um atacante.
    forcar(nome, valor, path = '/') {
        this.cookies.set(nome, { ...(this.cookies.get(nome) || { path }), nome, valor });
    }

    // Um atacante com um refresh token roubado controla o próprio cliente: o
    // CSRF não o detém (ele inventa cookie e header iguais). O que tem de
    // detê-lo é a rotação com detecção de reuso — é isso que se testa aqui.
    static comRefreshRoubado(refreshToken) {
        const atacante = new Navegador();
        atacante.forcar('refresh_token', refreshToken, '/auth');
        atacante.forcar('csrf_token', 'csrf-inventado-pelo-atacante');
        return atacante;
    }

    cabecalhoCookie(caminho) {
        const semQuery = caminho.split('?')[0];

        return [...this.cookies.values()]
            .filter((c) => c.path === '/' || semQuery === c.path || semQuery.startsWith(`${c.path}/`))
            .map((c) => `${c.nome}=${encodeURIComponent(c.valor)}`)
            .join('; ');
    }

    async pedir(metodo, caminho, { corpo = null, csrf = 'do-cookie' } = {}) {
        const cabecalhos = { 'Content-Type': 'application/json' };
        const cookie = this.cabecalhoCookie(caminho);
        if (cookie) cabecalhos.Cookie = cookie;

        // 'do-cookie' faz o que o front faz; null omite; outra string forja.
        if (csrf === 'do-cookie' && this.valor('csrf_token')) {
            cabecalhos['X-CSRF-Token'] = this.valor('csrf_token');
        } else if (csrf && csrf !== 'do-cookie') {
            cabecalhos['X-CSRF-Token'] = csrf;
        }

        const resposta = await fetch(`${base}${caminho}`, {
            method: metodo,
            headers: cabecalhos,
            body: corpo ? JSON.stringify(corpo) : undefined
        });

        this.ultimosSetCookie = resposta.headers.getSetCookie().map(lerSetCookie);
        for (const recebido of this.ultimosSetCookie) {
            if (recebido.apaga) this.cookies.delete(recebido.nome);
            else this.cookies.set(recebido.nome, recebido);
        }

        const texto = await resposta.text();
        let dados = {};
        if (texto) {
            try { dados = JSON.parse(texto); } catch (erro) { dados = { mensagem: texto }; }
        }

        return { status: resposta.status, dados };
    }
}

async function criarUsuarioComSenha() {
    const usuario = await criarUsuario();
    await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [await bcrypt.hash(SENHA, 10), usuario.id]);
    return usuario;
}

async function entrar(usuario) {
    const navegador = new Navegador();
    const { status } = await navegador.pedir('POST', '/auth/login', { corpo: { email: usuario.email, senha: SENHA } });
    assert.equal(status, 200, 'o login de preparação precisa funcionar');
    return navegador;
}

test('sessão por cookies', async (t) => {
    t.before(async () => {
        await limpar();
        await iniciar();
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        // refresh_tokens sai junto com o usuário, pelo ON DELETE CASCADE.
        await limpar();
        await pool.end();
    });

    await t.test('login entrega a sessão em cookies httpOnly e não põe token no corpo', async () => {
        const usuario = await criarUsuarioComSenha();
        const navegador = new Navegador();

        const { status, dados } = await navegador.pedir('POST', '/auth/login', {
            corpo: { email: usuario.email, senha: SENHA }
        });

        assert.equal(status, 200);
        assert.equal(dados.usuario.id, usuario.id);
        assert.equal('token' in dados, false, 'o token não pode mais vir no corpo');

        const porNome = Object.fromEntries(navegador.ultimosSetCookie.map((c) => [c.nome, c]));

        assert.equal(porNome.access_token.httpOnly, true);
        assert.equal(porNome.access_token.path, '/');
        assert.equal(porNome.refresh_token.httpOnly, true);
        assert.equal(porNome.refresh_token.path, '/auth');
        assert.equal(porNome.csrf_token.httpOnly, false, 'o front precisa ler o csrf_token');
        for (const cookie of Object.values(porNome)) {
            assert.equal(cookie.sameSite, 'Lax', `${cookie.nome} precisa de SameSite=Lax`);
        }

        const gravado = await pool.query('SELECT token_hash FROM refresh_tokens WHERE usuario_id = $1', [usuario.id]);
        assert.equal(gravado.rowCount, 1);
        assert.equal(gravado.rows[0].token_hash, sha256(navegador.valor('refresh_token')), 'o banco guarda só o hash');
    });

    // O cadastro não abre sessão: a conta só entra depois de confirmar o
    // e-mail. Isso é coberto em verificacao-email.test.js, que simula o SMTP —
    // aqui um cadastro válido mandaria e-mail de verdade pelo .env local.

    await t.test('rota protegida aceita o cookie e recusa sem ele', async () => {
        const navegador = await entrar(await criarUsuarioComSenha());

        assert.equal((await navegador.pedir('GET', '/auth/me')).status, 200);
        assert.equal((await new Navegador().pedir('GET', '/auth/me')).status, 401);
    });

    await t.test('o header Authorization não autentica mais', async () => {
        const usuario = await criarUsuarioComSenha();
        const token = jwt.sign({ id: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '15m' });

        const resposta = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(resposta.status, 401, 'o token que ficava no localStorage não pode abrir a sessão');
    });

    await t.test('access token vencido: o refresh renova e a chamada passa', async () => {
        const usuario = await criarUsuarioComSenha();
        const navegador = await entrar(usuario);

        const vencido = jwt.sign(
            { id: usuario.id, email: usuario.email, exp: Math.floor(Date.now() / 1000) - 10 },
            process.env.JWT_SECRET
        );
        navegador.forcar('access_token', vencido);

        assert.equal((await navegador.pedir('GET', '/auth/me')).status, 401, 'vencido precisa dar 401, que é o que dispara a renovação');

        const renovacao = await navegador.pedir('POST', '/auth/refresh');
        assert.equal(renovacao.status, 200);
        assert.equal(renovacao.dados.usuario.id, usuario.id);

        assert.equal((await navegador.pedir('GET', '/auth/me')).status, 200, 'a chamada original completa depois da renovação');
    });

    await t.test('o refresh rotaciona: o token antigo para de valer, o novo segue valendo', async () => {
        const navegador = await entrar(await criarUsuarioComSenha());
        const antigo = navegador.valor('refresh_token');

        assert.equal((await navegador.pedir('POST', '/auth/refresh')).status, 200);
        const novo = navegador.valor('refresh_token');
        assert.notEqual(novo, antigo);

        const copia = Navegador.comRefreshRoubado(antigo);
        assert.equal((await copia.pedir('POST', '/auth/refresh')).status, 401, 'o token já trocado não renova mais');

        // Dentro da janela de corrida, a cópia antiga não derruba nada.
        assert.equal((await navegador.pedir('POST', '/auth/refresh')).status, 200, 'o token novo continua valendo');
    });

    await t.test('reuso de token trocado, fora da janela de corrida, derruba todas as sessões', async () => {
        const usuario = await criarUsuarioComSenha();
        const notebook = await entrar(usuario);
        const celular = await entrar(usuario);

        const roubado = notebook.valor('refresh_token');
        assert.equal((await notebook.pedir('POST', '/auth/refresh')).status, 200);

        // Leva a troca para 2 minutos atrás, além da janela de 60 segundos.
        await pool.query(
            "UPDATE refresh_tokens SET revogado_em = NOW() - INTERVAL '2 minutes' WHERE token_hash = $1",
            [sha256(roubado)]
        );

        const atacante = Navegador.comRefreshRoubado(roubado);
        assert.equal((await atacante.pedir('POST', '/auth/refresh')).status, 401);

        assert.equal((await notebook.pedir('POST', '/auth/refresh')).status, 401, 'o notebook precisa entrar de novo');
        assert.equal((await celular.pedir('POST', '/auth/refresh')).status, 401, 'o outro dispositivo também cai');

        const ativos = await pool.query(
            'SELECT count(*)::int AS n FROM refresh_tokens WHERE usuario_id = $1 AND revogado_em IS NULL',
            [usuario.id]
        );
        assert.equal(ativos.rows[0].n, 0);
    });

    await t.test('logout revoga o refresh token no servidor', async () => {
        const navegador = await entrar(await criarUsuarioComSenha());
        const refresh = navegador.valor('refresh_token');

        const saida = await navegador.pedir('POST', '/auth/logout');
        assert.equal(saida.status, 200);
        assert.equal(navegador.valor('access_token'), undefined, 'os cookies saem do navegador');
        assert.equal(navegador.valor('refresh_token'), undefined);

        const copia = Navegador.comRefreshRoubado(refresh);
        assert.equal((await copia.pedir('POST', '/auth/refresh')).status, 401, 'o token revogado não renova mais');
    });

    await t.test('escrita com cookie de sessão exige X-CSRF-Token igual ao cookie', async () => {
        const navegador = await entrar(await criarUsuarioComSenha());
        const corpo = { nome: 'Nome Atualizado' };

        assert.equal((await navegador.pedir('PUT', '/auth/me', { corpo, csrf: null })).status, 403, 'sem o header');
        assert.equal((await navegador.pedir('PUT', '/auth/me', { corpo, csrf: 'valor-forjado' })).status, 403, 'com valor que não bate');
        assert.equal((await navegador.pedir('PUT', '/auth/me', { corpo })).status, 200, 'com o valor do cookie');
    });

    await t.test('GET não exige X-CSRF-Token', async () => {
        const navegador = await entrar(await criarUsuarioComSenha());
        assert.equal((await navegador.pedir('GET', '/auth/me', { csrf: null })).status, 200);
    });

    await t.test('sem cookie de sessão, a escrita cai no 401, não no 403', async () => {
        // O 401 é o que faz o front tentar renovar; um 403 de CSRF sem sessão
        // mostraria erro sem sentido para quem só está com a sessão vencida.
        const { status } = await new Navegador().pedir('PUT', '/auth/me', { corpo: { nome: 'Qualquer Um' } });
        assert.equal(status, 401);
    });

    await t.test('trocar a senha derruba as outras sessões e mantém esta', async () => {
        const usuario = await criarUsuarioComSenha();
        const aqui = await entrar(usuario);
        const outro = await entrar(usuario);

        const troca = await aqui.pedir('POST', '/auth/alterar-senha', {
            corpo: { senhaAtual: SENHA, novaSenha: 'SenhaNova456789' }
        });
        assert.equal(troca.status, 200);

        // A ordem importa: o outro dispositivo tenta renovar ANTES. Um token
        // revogado pela troca de senha não é sinal de roubo; se fosse tratado
        // como reuso, derrubaria também a sessão nova de quem trocou a senha.
        assert.equal((await outro.pedir('POST', '/auth/refresh')).status, 401, 'o outro dispositivo não renova mais');
        assert.equal((await aqui.pedir('POST', '/auth/refresh')).status, 200, 'quem trocou continua logado');
    });

    await t.test('redefinir a senha pelo e-mail derruba todas as sessões', async () => {
        const usuario = await criarUsuarioComSenha();
        const navegador = await entrar(usuario);
        const token = await criarTokenRecuperacao(usuario.id);

        const redefinicao = await new Navegador().pedir('POST', '/auth/redefinir-senha', {
            corpo: { token, senha: 'SenhaRedefinida789' }
        });
        assert.equal(redefinicao.status, 200);

        assert.equal((await navegador.pedir('POST', '/auth/refresh')).status, 401, 'quem tomou a sessão perde o acesso');
    });
});
