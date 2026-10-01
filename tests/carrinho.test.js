// Carrinho salvo na conta: gravar, ler, juntar com o do navegador no login e
// esvaziar o que foi comprado quando o pagamento é aprovado.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, pool, registrarPedidoPendente, sincronizarPagamentoNoBanco } = require('../server.js');
const { criarProduto, criarUsuario, emitirToken, cabecalhosDeSessao, limpar } = require('./ajuda.js');

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

const item = (produto, quantidade) => ({ id: produto.id, quantidade });

test('carrinho salvo na conta', async (t) => {
    let token;
    let outroToken;
    let usuario;
    let a;
    let b;
    let c;

    t.before(async () => {
        await limpar();
        await iniciar();

        usuario = await criarUsuario();
        token = emitirToken(usuario);
        outroToken = emitirToken(await criarUsuario());

        a = await criarProduto({ preco: 10, estoque: 20 });
        b = await criarProduto({ preco: 20, estoque: 20 });
        c = await criarProduto({ preco: 30, estoque: 20 });
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    await t.test('exige sessão nas três rotas', async () => {
        assert.equal((await pedir('GET', '/carrinho')).status, 401);
        assert.equal((await pedir('PUT', '/carrinho', { corpo: { itens: [] } })).status, 401);
        assert.equal((await pedir('POST', '/carrinho/mesclar', { corpo: { itens: [] } })).status, 401);
    });

    await t.test('grava o carrinho inteiro e devolve na mesma ordem', async () => {
        const gravado = await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(b, 2), item(a, 1)] } });
        assert.equal(gravado.status, 200);
        assert.deepEqual(gravado.dados.itens, [item(b, 2), item(a, 1)]);

        // Outro "computador": só o token, nada do navegador anterior.
        const lido = await pedir('GET', '/carrinho', { token });
        assert.deepEqual(lido.dados.itens, [item(b, 2), item(a, 1)]);
    });

    await t.test('gravar de novo substitui, e o vazio esvazia', async () => {
        await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(c, 3)] } });
        assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, [item(c, 3)]);

        const vazio = await pedir('PUT', '/carrinho', { token, corpo: { itens: [] } });
        assert.equal(vazio.status, 200);
        assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, []);
    });

    await t.test('cada conta vê só o próprio carrinho', async () => {
        await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(a, 4)] } });

        const doOutro = await pedir('GET', '/carrinho', { token: outroToken });
        assert.deepEqual(doOutro.dados.itens, []);
    });

    await t.test('recusa o formato que o checkout recusaria', async () => {
        const ruins = [
            { itens: [item(a, 0)] },
            { itens: [item(a, 11)] },
            { itens: [item(a, 1), item(a, 2)] },
            { itens: [{ id: 'abc', quantidade: 1 }] },
            { itens: Array.from({ length: 21 }, (_, i) => ({ id: i + 1, quantidade: 1 })) },
            { itens: 'tudo' },
            {}
        ];

        for (const corpo of ruins) {
            assert.equal((await pedir('PUT', '/carrinho', { token, corpo })).status, 400, JSON.stringify(corpo).slice(0, 60));
        }

        assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, [item(a, 4)], 'a recusa não mexe no que estava gravado');
    });

    await t.test('produto inexistente ou fora do catálogo não entra', async () => {
        const inativo = await criarProduto({ preco: 5, estoque: 5, ativo: false });

        const { dados } = await pedir('PUT', '/carrinho', {
            token,
            corpo: { itens: [item(a, 1), { id: 999999999, quantidade: 1 }, item(inativo, 1)] }
        });

        assert.deepEqual(dados.itens, [item(a, 1)]);

        // Na tabela, não só na leitura (que já esconde inativo): gravado, ele
        // voltaria sozinho ao carrinho no dia em que voltasse à venda.
        const gravados = await pool.query('SELECT produto_id FROM carrinho_itens WHERE usuario_id = $1', [usuario.id]);
        assert.deepEqual(gravados.rows.map((linha) => linha.produto_id), [a.id]);
    });

    await t.test('produto que sai do catálogo some da leitura', async () => {
        await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(a, 1), item(b, 1)] } });
        await pool.query('UPDATE produtos SET ativo = FALSE WHERE id = $1', [b.id]);

        try {
            assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, [item(a, 1)]);
        } finally {
            await pool.query('UPDATE produtos SET ativo = TRUE WHERE id = $1', [b.id]);
        }
    });

    await t.test('no login, junta pela maior quantidade, sem somar', async () => {
        await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(a, 2), item(b, 5)] } });

        // O navegador tinha a: 3 (mais que a conta), b: 1 (menos) e c (novo).
        const { status, dados } = await pedir('POST', '/carrinho/mesclar', {
            token,
            corpo: { itens: [item(a, 3), item(b, 1), item(c, 1)] }
        });

        assert.equal(status, 200);
        assert.deepEqual(dados.itens, [item(a, 3), item(b, 5), item(c, 1)], 'os da conta primeiro, depois os novos');
        assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, dados.itens);
    });

    await t.test('juntar o mesmo carrinho de novo não dobra nada', async () => {
        const atual = (await pedir('GET', '/carrinho', { token })).dados.itens;

        // Sessão que venceu sem logout: o navegador ainda tem a cópia do
        // carrinho da conta, e o próximo login manda exatamente ela.
        const { dados } = await pedir('POST', '/carrinho/mesclar', { token, corpo: { itens: atual } });
        assert.deepEqual(dados.itens, atual);
    });

    await t.test('navegador vazio no login devolve o carrinho da conta', async () => {
        const atual = (await pedir('GET', '/carrinho', { token })).dados.itens;
        const { dados } = await pedir('POST', '/carrinho/mesclar', { token, corpo: { itens: [] } });
        assert.deepEqual(dados.itens, atual);
    });

    await t.test('pagamento aprovado tira do carrinho da conta o que foi comprado', async () => {
        await pedir('PUT', '/carrinho', { token, corpo: { itens: [item(a, 2), item(c, 1)] } });

        // Compra só de "a"; "c" ficou no carrinho e precisa continuar lá.
        const linha = { produtoId: a.id, title: a.nome, unit_price: 10, quantity: 2 };
        const pedido = await registrarPedidoPendente(usuario, [linha], 20, 19.9, 39.9);
        await sincronizarPagamentoNoBanco({ id: 777001, status: 'approved', external_reference: pedido.externalReference });

        assert.deepEqual((await pedir('GET', '/carrinho', { token })).dados.itens, [item(c, 1)]);
    });
});
