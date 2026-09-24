// Central da conta: editar dados, trocar senha e listar as próprias avaliações.
// Também cobre o cadastro de newsletter (POST /usuarios), que cria contas.
//
// O ponto sensível é a troca de senha. Ela exige a senha atual — sem isso um
// token vazado bastaria para tomar a conta, já que o JWT sozinho autoriza tudo.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');

const { app, pool, resolverItensCarrinho, registrarPedidoPendente } = require('../server.js');
const { criarProduto, criarUsuario, emitirToken, cabecalhosDeSessao, limpar, PREFIXO } = require('./ajuda.js');

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

async function pedir(metodo, caminho, { token = null, corpo = null } = {}) {
    const cabecalhos = { 'Content-Type': 'application/json' };
    if (token) Object.assign(cabecalhos, cabecalhosDeSessao(token));

    const resposta = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: cabecalhos,
        body: corpo ? JSON.stringify(corpo) : undefined
    });

    const texto = await resposta.text();
    let dados = {};
    if (texto) {
        try { dados = JSON.parse(texto); } catch (erro) { dados = { mensagem: texto }; }
    }

    return { status: resposta.status, dados };
}

test('central da conta', async (t) => {
    let usuario;
    let token;
    let produto;

    const SENHA_INICIAL = 'SenhaInicial123';

    t.before(async () => {
        await limpar();
        await iniciar();

        usuario = await criarUsuario();
        // criarUsuario grava um hash inutilizável; aqui a senha precisa ser real.
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [
            await bcrypt.hash(SENHA_INICIAL, 10),
            usuario.id
        ]);

        token = emitirToken(usuario);
        produto = await criarProduto({ preco: 100, estoque: 5 });
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    await t.test('as rotas da conta exigem autenticação', async () => {
        // GET não aceita corpo: o fetch recusa antes mesmo de sair da máquina.
        const rotas = [
            ['PUT', '/auth/me', { nome: 'Alguem Qualquer' }],
            ['POST', '/auth/alterar-senha', { senhaAtual: 'a', novaSenha: 'bbbbbbbb' }],
            ['GET', '/auth/me/avaliacoes', null],
            ['GET', '/auth/me', null]
        ];

        for (const [metodo, caminho, corpo] of rotas) {
            const { status } = await pedir(metodo, caminho, corpo ? { corpo } : {});
            assert.equal(status, 401, `${metodo} ${caminho} deveria exigir token`);
        }
    });

    await t.test('/auth/me devolve a data de cadastro', async () => {
        const { status, dados } = await pedir('GET', '/auth/me', { token });

        assert.equal(status, 200);
        assert.ok(dados.usuario.criado_em, 'o cabeçalho da conta mostra "cliente desde"');
    });

    await t.test('atualiza o nome', async () => {
        const { status, dados } = await pedir('PUT', '/auth/me', {
            token,
            corpo: { nome: 'Maria Aparecida Souza' }
        });

        assert.equal(status, 200);
        assert.equal(dados.usuario.nome, 'Maria Aparecida Souza');
    });

    await t.test('recusa nome vazio ou curto demais', async () => {
        for (const nome of ['', ' ', 'A', '   A   ']) {
            const { status } = await pedir('PUT', '/auth/me', { token, corpo: { nome } });
            assert.equal(status, 400, `deveria recusar ${JSON.stringify(nome)}`);
        }
    });

    await t.test('trocar senha exige a senha atual correta', async () => {
        const { status, dados } = await pedir('POST', '/auth/alterar-senha', {
            token,
            corpo: { senhaAtual: 'ChutePuro123', novaSenha: 'OutraSenha456' }
        });

        assert.equal(status, 403);
        assert.match(dados.mensagem, /senha atual/i);
    });

    await t.test('recusa nova senha curta ou igual à atual', async () => {
        const curta = await pedir('POST', '/auth/alterar-senha', {
            token,
            corpo: { senhaAtual: SENHA_INICIAL, novaSenha: 'curta' }
        });
        assert.equal(curta.status, 400);

        const igual = await pedir('POST', '/auth/alterar-senha', {
            token,
            corpo: { senhaAtual: SENHA_INICIAL, novaSenha: SENHA_INICIAL }
        });
        assert.equal(igual.status, 400);
    });

    await t.test('troca a senha e o login passa a exigir a nova', async () => {
        const NOVA = 'SenhaTrocada789';

        const troca = await pedir('POST', '/auth/alterar-senha', {
            token,
            corpo: { senhaAtual: SENHA_INICIAL, novaSenha: NOVA }
        });

        assert.equal(troca.status, 200);

        const comNova = await pedir('POST', '/auth/login', {
            corpo: { email: usuario.email, senha: NOVA }
        });
        assert.equal(comNova.status, 200);

        const comAntiga = await pedir('POST', '/auth/login', {
            corpo: { email: usuario.email, senha: SENHA_INICIAL }
        });
        assert.equal(comAntiga.status, 401, 'a senha antiga precisa parar de funcionar');
    });

    await t.test('lista as avaliações da própria pessoa, com o produto junto', async () => {
        const vazio = await pedir('GET', '/auth/me/avaliacoes', { token });
        assert.deepEqual(vazio.dados.avaliacoes, []);

        // Avaliar exige compra paga.
        const resolucao = await resolverItensCarrinho([{ id: produto.id, quantidade: 1 }]);
        const pedido = await registrarPedidoPendente(usuario, resolucao.itens, 100, 0, 100);
        await pool.query("UPDATE pedidos SET status = 'Pago' WHERE id = $1", [pedido.pedidoId]);

        await pedir('POST', `/produtos/${produto.id}/avaliacoes`, {
            token,
            corpo: { nota: 4, titulo: 'Bom', comentario: 'Atendeu.' }
        });

        const { dados } = await pedir('GET', '/auth/me/avaliacoes', { token });

        assert.equal(dados.avaliacoes.length, 1);
        assert.equal(dados.avaliacoes[0].nota, 4);
        assert.equal(dados.avaliacoes[0].produto.id, produto.id);
        assert.equal(dados.avaliacoes[0].produto.ativo, true);
    });

    await t.test('não vaza avaliação de outra pessoa', async () => {
        const outra = await criarUsuario();
        const tokenOutra = emitirToken(outra);

        const { dados } = await pedir('GET', '/auth/me/avaliacoes', { token: tokenOutra });
        assert.deepEqual(dados.avaliacoes, [], 'cada um vê só as suas');
    });

    await t.test('produto desativado continua listado, marcado como inativo', async () => {
        await pool.query('UPDATE produtos SET ativo = FALSE WHERE id = $1', [produto.id]);

        const { dados } = await pedir('GET', '/auth/me/avaliacoes', { token });

        assert.equal(dados.avaliacoes.length, 1, 'a avaliação não some junto com o produto');
        assert.equal(dados.avaliacoes[0].produto.ativo, false, 'a interface usa isto para não criar link quebrado');

        await pool.query('UPDATE produtos SET ativo = TRUE WHERE id = $1', [produto.id]);
    });

    await t.test('newsletter com e-mail já cadastrado responde 200 sem tocar na conta', async () => {
        const existente = await criarUsuario();
        const antes = await pool.query('SELECT nome, senha FROM usuarios WHERE id = $1', [existente.id]);

        // A senha no corpo é o caso perigoso: se este caminho virasse upsert,
        // o formulário de newsletter redefiniria a senha de qualquer conta.
        const { status, dados } = await pedir('POST', '/usuarios', {
            corpo: { nome: 'Outro Nome', email: existente.email, senha: 'TentativaDeTroca123' }
        });

        assert.equal(status, 200, 'e-mail repetido não é falha do servidor');
        assert.equal(dados.mensagem, 'Usuário salvo com sucesso!');

        const depois = await pool.query('SELECT nome, senha FROM usuarios WHERE email = $1', [existente.email]);
        assert.equal(depois.rowCount, 1, 'não pode duplicar a conta');
        assert.equal(depois.rows[0].nome, antes.rows[0].nome, 'o nome não pode ser sobrescrito');
        assert.equal(depois.rows[0].senha, antes.rows[0].senha, 'a senha não pode ser sobrescrita');
    });

    await t.test('newsletter com e-mail novo continua criando a conta', async () => {
        // Prefixo do limpar(), para a conta criada pela rota sair no after.
        const email = `${PREFIXO}newsletter_${Date.now()}@local.test`;

        const { status } = await pedir('POST', '/usuarios', { corpo: { nome: 'Assinante Novo', email } });

        assert.equal(status, 201);

        const criada = await pool.query('SELECT count(*)::int AS n FROM usuarios WHERE email = $1', [email]);
        assert.equal(criada.rows[0].n, 1);
    });
});
