// Regressão da falha que permitia pagar qualquer valor: o checkout aceitava o
// preço enviado pelo cliente. O carrinho vive no localStorage, então bastava
// editá-lo no DevTools para comprar um notebook por R$ 0,01.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolverItensCarrinho, validarFormatoCarrinho, calcularFrete } = require('../server.js');
const { criarProduto, lerEstoque, limpar, pool } = require('./ajuda.js');

test('checkout', async (t) => {
    let produto;
    let produtoInativo;

    t.before(async () => {
        await limpar();
        produto = await criarProduto({ preco: 1500.00, estoque: 5 });
        produtoInativo = await criarProduto({ preco: 99.00, estoque: 10, ativo: false });
    });

    t.after(async () => {
        await limpar();
        await pool.end();
    });

    await t.test('ignora o preço enviado pelo cliente e usa o do banco', async () => {
        const resultado = await resolverItensCarrinho([
            { id: produto.id, quantidade: 1, price: 0.01, unit_price: 0.01, name: 'Nome forjado' }
        ]);

        assert.equal(resultado.ok, true);
        assert.equal(resultado.itens[0].unit_price, 1500.00, 'o preço tem de vir da tabela produtos');
        assert.equal(resultado.itens[0].title, produto.nome, 'o nome tem de vir da tabela produtos');
    });

    await t.test('calcula o subtotal com os preços do banco', async () => {
        const resultado = await resolverItensCarrinho([
            { id: produto.id, quantidade: 3, price: 0.01 }
        ]);

        const subtotal = resultado.itens.reduce((soma, item) => soma + item.unit_price * item.quantity, 0);
        assert.equal(subtotal, 4500.00);
    });

    await t.test('recusa produto inexistente', async () => {
        const resultado = await resolverItensCarrinho([{ id: 999999999, quantidade: 1 }]);
        assert.equal(resultado.ok, false);
        assert.match(resultado.mensagem, /indispon/i);
    });

    await t.test('recusa produto inativo', async () => {
        const resultado = await resolverItensCarrinho([{ id: produtoInativo.id, quantidade: 1 }]);
        assert.equal(resultado.ok, false);
    });

    await t.test('recusa quantidade acima do estoque', async () => {
        const resultado = await resolverItensCarrinho([{ id: produto.id, quantidade: 6 }]);
        assert.equal(resultado.ok, false);
        assert.match(resultado.mensagem, /Estoque insuficiente/);
    });

    await t.test('aceita quantidade exatamente igual ao estoque', async () => {
        const resultado = await resolverItensCarrinho([{ id: produto.id, quantidade: 5 }]);
        assert.equal(resultado.ok, true);
    });

    await t.test('não altera o estoque ao apenas resolver o carrinho', async () => {
        await resolverItensCarrinho([{ id: produto.id, quantidade: 2 }]);
        assert.equal(await lerEstoque(produto.id), 5, 'a baixa só acontece na aprovação do pagamento');
    });

    await t.test('recusa o mesmo produto repetido', async () => {
        const resultado = await resolverItensCarrinho([
            { id: produto.id, quantidade: 1 },
            { id: produto.id, quantidade: 1 }
        ]);

        assert.equal(resultado.ok, false);
        assert.match(resultado.mensagem, /mais de uma vez/);
    });

    await t.test('recusa carrinho vazio ou com formato inválido', () => {
        assert.equal(validarFormatoCarrinho([]).valido, false);
        assert.equal(validarFormatoCarrinho(null).valido, false);
        assert.equal(validarFormatoCarrinho('nao-e-array').valido, false);
        assert.equal(validarFormatoCarrinho([{ quantidade: 1 }]).valido, false, 'sem id');
        assert.equal(validarFormatoCarrinho([{ id: 'abc', quantidade: 1 }]).valido, false);
        assert.equal(validarFormatoCarrinho([{ id: 1.5, quantidade: 1 }]).valido, false);
        assert.equal(validarFormatoCarrinho([{ id: -1, quantidade: 1 }]).valido, false);
    });

    await t.test('recusa quantidades inválidas', () => {
        assert.equal(validarFormatoCarrinho([{ id: 1, quantidade: 0 }]).valido, false);
        assert.equal(validarFormatoCarrinho([{ id: 1, quantidade: -5 }]).valido, false);
        assert.equal(validarFormatoCarrinho([{ id: 1, quantidade: 1.5 }]).valido, false);
        assert.equal(validarFormatoCarrinho([{ id: 1, quantidade: 11 }]).valido, false, 'acima do teto por item');
        assert.equal(validarFormatoCarrinho([{ id: 1, quantidade: 10 }]).valido, true, 'o teto em si é válido');
    });

    await t.test('recusa carrinho com produtos distintos demais', () => {
        const grande = Array.from({ length: 21 }, (_, indice) => ({ id: indice + 1, quantidade: 1 }));
        assert.equal(validarFormatoCarrinho(grande).valido, false);
    });

    await t.test('frete é gratuito acima de R$ 199', () => {
        assert.equal(calcularFrete(200), 0);
        assert.equal(calcularFrete(199.01), 0);
        assert.equal(calcularFrete(199), 19.9, 'exatamente 199 ainda paga frete');
        assert.equal(calcularFrete(50), 19.9);
    });
});
