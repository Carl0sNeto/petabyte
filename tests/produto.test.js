// Página de produto: detalhe público e avaliações.
//
// O ponto que mais importa aqui é a verificação de compra. A regra "só quem
// comprou avalia" só vale se o servidor conferir — um cliente adulterado que
// poste direto no endpoint precisa esbarrar nela.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, pool, resolverItensCarrinho, registrarPedidoPendente } = require('../server.js');
const { criarProduto, criarUsuario, emitirToken, limpar } = require('./ajuda.js');

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
    if (token) cabecalhos.Authorization = `Bearer ${token}`;

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

// Deixa o usuário com um pedido PAGO contendo o produto, que é o que libera
// a avaliação.
async function registrarCompraPaga(usuario, produtoId) {
    const resolucao = await resolverItensCarrinho([{ id: produtoId, quantidade: 1 }]);
    const pedido = await registrarPedidoPendente(usuario, resolucao.itens, 100, 0, 100);
    await pool.query("UPDATE pedidos SET status = 'Pago', payment_status = 'approved' WHERE id = $1", [pedido.pedidoId]);
    return pedido;
}

test('página de produto', async (t) => {
    let produto;
    let comprador;
    let curioso;
    let tokenComprador;
    let tokenCurioso;

    t.before(async () => {
        await limpar();
        await iniciar();

        produto = await criarProduto({ preco: 100, estoque: 10 });
        comprador = await criarUsuario();
        curioso = await criarUsuario();
        tokenComprador = emitirToken(comprador);
        tokenCurioso = emitirToken(curioso);

        await registrarCompraPaga(comprador, produto.id);
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    await t.test('detalhe traz galeria, especificações e resumo', async () => {
        const { status, dados } = await pedir('GET', `/produtos/${produto.id}`);

        assert.equal(status, 200);
        assert.equal(dados.produto.id, produto.id);
        assert.ok(Array.isArray(dados.produto.galeria));
        assert.ok(Array.isArray(dados.produto.especificacoes));
        assert.equal(dados.avaliacoes.resumo.total, 0);
        assert.equal(dados.avaliacoes.resumo.media, 0);
    });

    await t.test('responde 404 e 400 para identificadores ruins', async () => {
        assert.equal((await pedir('GET', '/produtos/999999')).status, 404);
        assert.equal((await pedir('GET', '/produtos/abc')).status, 400);
    });

    await t.test('produto inativo não aparece no detalhe público', async () => {
        const inativo = await criarProduto({ preco: 50, estoque: 1, ativo: false });
        assert.equal((await pedir('GET', `/produtos/${inativo.id}`)).status, 404);
    });

    await t.test('quem não comprou não pode avaliar', async () => {
        const permissao = await pedir('GET', `/produtos/${produto.id}/avaliacoes/minha`, { token: tokenCurioso });
        assert.equal(permissao.dados.podeAvaliar, false);

        const tentativa = await pedir('POST', `/produtos/${produto.id}/avaliacoes`, {
            token: tokenCurioso,
            corpo: { nota: 5, comentario: 'nunca comprei' }
        });

        assert.equal(tentativa.status, 403, 'o servidor precisa recusar mesmo com POST direto');
    });

    await t.test('avaliar exige autenticação', async () => {
        const { status } = await pedir('POST', `/produtos/${produto.id}/avaliacoes`, { corpo: { nota: 5 } });
        assert.equal(status, 401);
    });

    await t.test('quem comprou avalia', async () => {
        const permissao = await pedir('GET', `/produtos/${produto.id}/avaliacoes/minha`, { token: tokenComprador });
        assert.equal(permissao.dados.podeAvaliar, true);
        assert.equal(permissao.dados.avaliacao, null);

        const criada = await pedir('POST', `/produtos/${produto.id}/avaliacoes`, {
            token: tokenComprador,
            corpo: { nota: 5, titulo: 'Muito bom', comentario: 'Chegou rápido.' }
        });

        assert.equal(criada.status, 201);
        assert.equal(criada.dados.avaliacao.nota, 5);
        assert.equal(criada.dados.resumo.total, 1);
    });

    await t.test('o autor aparece abreviado, sem e-mail nem nome completo', async () => {
        const { dados } = await pedir('GET', `/produtos/${produto.id}`);
        const autor = dados.avaliacoes.itens[0].autor;

        assert.ok(!autor.includes('@'), 'e-mail não pode vazar na página pública');
        assert.match(autor, /^\S+ \S\.$/, 'esperado "Primeiro I."');
    });

    await t.test('reenviar substitui em vez de duplicar', async () => {
        await pedir('POST', `/produtos/${produto.id}/avaliacoes`, {
            token: tokenComprador,
            corpo: { nota: 3, titulo: 'Mudei de ideia', comentario: 'Depois de um mês, nem tanto.' }
        });

        const { dados } = await pedir('GET', `/produtos/${produto.id}`);

        assert.equal(dados.avaliacoes.resumo.total, 1, 'continua sendo uma avaliação');
        assert.equal(dados.avaliacoes.resumo.media, 3);
        assert.equal(dados.avaliacoes.itens[0].nota, 3);
    });

    await t.test('recusa notas fora de 1 a 5', async () => {
        for (const nota of [0, 6, -1, 3.5, 'cinco', null]) {
            const { status } = await pedir('POST', `/produtos/${produto.id}/avaliacoes`, {
                token: tokenComprador,
                corpo: { nota }
            });

            assert.equal(status, 400, `deveria recusar nota ${JSON.stringify(nota)}`);
        }
    });

    await t.test('a média entra na listagem da vitrine', async () => {
        const { dados } = await pedir('GET', '/produtos');
        const naVitrine = dados.produtos.find((p) => p.id === produto.id);

        assert.equal(naVitrine.notaMedia, 3);
        assert.equal(naVitrine.totalAvaliacoes, 1);
    });

    await t.test('a distribuição por nota bate com o total', async () => {
        const { dados } = await pedir('GET', `/produtos/${produto.id}/avaliacoes`);
        const soma = Object.values(dados.resumo.distribuicao).reduce((a, b) => a + b, 0);

        assert.equal(soma, dados.resumo.total);
        assert.equal(dados.resumo.distribuicao[3], 1);
    });

    await t.test('remover a própria avaliação zera o resumo', async () => {
        const remocao = await pedir('DELETE', `/produtos/${produto.id}/avaliacoes/minha`, { token: tokenComprador });

        assert.equal(remocao.status, 200);
        assert.equal(remocao.dados.resumo.total, 0);

        const denovo = await pedir('DELETE', `/produtos/${produto.id}/avaliacoes/minha`, { token: tokenComprador });
        assert.equal(denovo.status, 404);
    });

    await t.test('pedido não pago não libera avaliação', async () => {
        const outroProduto = await criarProduto({ preco: 80, estoque: 5 });
        const resolucao = await resolverItensCarrinho([{ id: outroProduto.id, quantidade: 1 }]);
        // Fica em "Aguardando pagamento", que é como registrarPedidoPendente cria.
        await registrarPedidoPendente(comprador, resolucao.itens, 80, 0, 80);

        const permissao = await pedir('GET', `/produtos/${outroProduto.id}/avaliacoes/minha`, { token: tokenComprador });
        assert.equal(permissao.dados.podeAvaliar, false, 'só pedido pago conta');
    });
});
