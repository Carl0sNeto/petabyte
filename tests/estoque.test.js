// A baixa de estoque acontece na aprovação do pagamento, e tanto
// /pagamentos/confirmar quanto o webhook do Mercado Pago podem processar a
// mesma notificação. Estes testes garantem que isso debita uma vez só.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolverItensCarrinho,
    registrarPedidoPendente,
    sincronizarPagamentoNoBanco
} = require('../server.js');

const { criarProduto, criarUsuario, lerEstoque, limpar, pool } = require('./ajuda.js');

// Cria um pedido pendente pronto para ser aprovado.
async function prepararPedido({ estoqueInicial, quantidade }) {
    const produto = await criarProduto({ preco: 100.00, estoque: estoqueInicial });
    const usuario = await criarUsuario();

    const resolucao = await resolverItensCarrinho([{ id: produto.id, quantidade }]);
    assert.equal(resolucao.ok, true, 'o carrinho de apoio deveria ser válido');

    const subtotal = 100.00 * quantidade;
    const pedido = await registrarPedidoPendente(usuario, resolucao.itens, subtotal, 0, subtotal);

    return { produto, usuario, pedido };
}

test('baixa de estoque', async (t) => {
    t.before(limpar);

    t.after(async () => {
        await limpar();
        await pool.end();
    });

    await t.test('debita na primeira aprovação', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 3 });

        await sincronizarPagamentoNoBanco({
            id: 1001,
            status: 'approved',
            external_reference: pedido.externalReference
        });

        assert.equal(await lerEstoque(produto.id), 7);
    });

    await t.test('não debita de novo quando o webhook reenvia a notificação', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 3 });
        const pagamento = { id: 1002, status: 'approved', external_reference: pedido.externalReference };

        await sincronizarPagamentoNoBanco(pagamento);
        const depoisDaPrimeira = await lerEstoque(produto.id);

        await sincronizarPagamentoNoBanco(pagamento);
        await sincronizarPagamentoNoBanco(pagamento);

        assert.equal(depoisDaPrimeira, 7);
        assert.equal(await lerEstoque(produto.id), 7, 'reenvios não podem debitar de novo');
    });

    await t.test('devolve ao catálogo em caso de reembolso', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 4 });
        const base = { id: 1003, external_reference: pedido.externalReference };

        await sincronizarPagamentoNoBanco({ ...base, status: 'approved' });
        assert.equal(await lerEstoque(produto.id), 6);

        await sincronizarPagamentoNoBanco({ ...base, status: 'refunded' });
        assert.equal(await lerEstoque(produto.id), 10, 'o reembolso devolve as unidades');
    });

    await t.test('reembolso repetido não devolve duas vezes', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 4 });
        const base = { id: 1004, external_reference: pedido.externalReference };

        await sincronizarPagamentoNoBanco({ ...base, status: 'approved' });
        await sincronizarPagamentoNoBanco({ ...base, status: 'refunded' });
        await sincronizarPagamentoNoBanco({ ...base, status: 'refunded' });

        assert.equal(await lerEstoque(produto.id), 10);
    });

    await t.test('pagamento pendente não mexe no estoque', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 2 });

        await sincronizarPagamentoNoBanco({
            id: 1005,
            status: 'pending',
            external_reference: pedido.externalReference
        });

        assert.equal(await lerEstoque(produto.id), 10);
    });

    await t.test('pagamento recusado não mexe no estoque', async () => {
        const { produto, pedido } = await prepararPedido({ estoqueInicial: 10, quantidade: 2 });

        await sincronizarPagamentoNoBanco({
            id: 1006,
            status: 'rejected',
            external_reference: pedido.externalReference
        });

        assert.equal(await lerEstoque(produto.id), 10);
    });

    await t.test('recusa pagamento sem referência de pedido válida', async () => {
        await assert.rejects(
            () => sincronizarPagamentoNoBanco({ id: 1007, status: 'approved', external_reference: 'lixo' }),
            /referência de pedido válida/
        );
    });

    await t.test('recusa pagamento cujo pedido não existe', async () => {
        await assert.rejects(
            () => sincronizarPagamentoNoBanco({ id: 1008, status: 'approved', external_reference: 'hc_999999999' }),
            /não encontrado/
        );
    });
});
