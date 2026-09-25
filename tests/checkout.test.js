// Regressão da falha que permitia pagar qualquer valor: o checkout aceitava o
// preço enviado pelo cliente. O carrinho vive no localStorage, então bastava
// editá-lo no DevTools para comprar um notebook por R$ 0,01.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolverItensCarrinho,
    validarFormatoCarrinho,
    calcularFrete,
    validarCupom,
    prepararCheckout,
    montarItensMercadoPago,
    registrarPedidoPendente,
    sincronizarPagamentoNoBanco
} = require('../server.js');
const { criarProduto, criarUsuario, criarCupom, lerEstoque, limpar, pool } = require('./ajuda.js');

// Cria e aprova um pedido com cupom, pelo mesmo caminho do checkout real.
async function pagarComCupom(usuario, produtoId, codigo, paymentId) {
    const resumo = await prepararCheckout({ itens: [{ id: produtoId, quantidade: 1 }], cupom: codigo }, usuario);
    assert.equal(resumo.ok, true, `o pedido de apoio deveria aceitar o cupom: ${resumo.mensagem}`);

    const pedido = await registrarPedidoPendente(usuario, resumo.itens, resumo.subtotal, resumo.frete, resumo.total, {
        cupomId: resumo.cupom.id,
        desconto: resumo.desconto
    });

    await sincronizarPagamentoNoBanco({ id: paymentId, status: 'approved', external_reference: pedido.externalReference });
    return pedido;
}

async function contarUsos(cupomId) {
    const resultado = await pool.query('SELECT count(*)::int AS n FROM cupom_usos WHERE cupom_id = $1', [cupomId]);
    return resultado.rows[0].n;
}

function somaDosItens(itens) {
    return itens.reduce((soma, item) => soma + Math.round(item.unit_price * 100) * item.quantity, 0) / 100;
}

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

    await t.test('frete é fixo, sem faixa de frete grátis', async () => {
        assert.equal(calcularFrete(), 19.9);

        // O valor do pedido não muda o frete: a loja trocou o frete grátis por cupons.
        const usuario = await criarUsuario();
        for (const preco of [50, 199.01, 5000]) {
            const item = await criarProduto({ preco, estoque: 5 });
            const resumo = await prepararCheckout({ itens: [{ id: item.id, quantidade: 1 }] }, usuario);
            assert.equal(resumo.frete, 19.9, `pedido de R$ ${preco} paga frete`);
        }
    });

    // ------------------------------------------------------------------
    // Cupons
    // ------------------------------------------------------------------

    await t.test('cupom: o desconto incide só sobre o subtotal, nunca sobre o frete', async () => {
        const usuario = await criarUsuario();
        const barato = await criarProduto({ preco: 100, estoque: 50 });
        const cupom = await criarCupom({ tipo: 'percentual', valor: 10 });

        const resumo = await prepararCheckout({ itens: [{ id: barato.id, quantidade: 1 }], cupom: cupom.codigo }, usuario);

        assert.equal(resumo.subtotal, 100);
        assert.equal(resumo.desconto, 10, '10% de 100');
        assert.equal(resumo.frete, 19.9, 'o frete não leva desconto');
        assert.equal(resumo.total, 109.9);

        // Metade de desconto é metade dos produtos, não do pedido com frete.
        const caro = await criarProduto({ preco: 250, estoque: 50 });
        const metade = await criarCupom({ tipo: 'percentual', valor: 50 });
        const comMetade = await prepararCheckout({ itens: [{ id: caro.id, quantidade: 1 }], cupom: metade.codigo }, usuario);

        assert.equal(comMetade.desconto, 125);
        assert.equal(comMetade.frete, 19.9);
        assert.equal(comMetade.total, 144.9);
    });

    await t.test('cupom: fixo maior que o subtotal não deixa o total negativo', async () => {
        const usuario = await criarUsuario();
        const produto = await criarProduto({ preco: 30, estoque: 50 });
        const cupom = await criarCupom({ tipo: 'fixo', valor: 50 });

        const resumo = await prepararCheckout({ itens: [{ id: produto.id, quantidade: 1 }], cupom: cupom.codigo }, usuario);

        assert.equal(resumo.ok, true);
        assert.equal(resumo.desconto, 30, 'o desconto fixo para no valor do subtotal');
        assert.equal(resumo.total, 19.9, 'sobra só o frete');
    });

    await t.test('cupom: que zera os produtos deixa só o frete a pagar', async () => {
        const usuario = await criarUsuario();
        const produto = await criarProduto({ preco: 250, estoque: 50 });
        const cupom = await criarCupom({ tipo: 'fixo', valor: 1000 });

        const resumo = await prepararCheckout({ itens: [{ id: produto.id, quantidade: 1 }], cupom: cupom.codigo }, usuario);

        assert.equal(resumo.ok, true);
        assert.equal(resumo.desconto, 250);
        assert.equal(resumo.total, 19.9, 'o frete não leva desconto');

        // O Mercado Pago não aceita item de valor zero: vai só a linha do frete.
        const linhas = montarItensMercadoPago(resumo);
        assert.deepEqual(linhas.map((linha) => linha.title), ['Frete']);
        assert.equal(somaDosItens(linhas), resumo.total);
    });

    await t.test('cupom: cada recusa vem com o motivo certo', async () => {
        const usuario = await criarUsuario();
        const outro = await criarUsuario();
        const produto = await criarProduto({ preco: 100, estoque: 50 });
        const ontem = new Date(Date.now() - 24 * 3600 * 1000);
        const amanha = new Date(Date.now() + 24 * 3600 * 1000);

        const casos = [
            [await criarCupom({ validoAte: ontem }), /expirou/],
            [await criarCupom({ validoDe: amanha }), /ainda não começou/],
            [await criarCupom({ valorMinimoPedido: 500 }), /a partir de R\$\s500,00/],
            [await criarCupom({ ativo: false }), /não está mais ativo/]
        ];

        for (const [cupom, motivo] of casos) {
            const validacao = await validarCupom(cupom.codigo, usuario.id, 100);
            assert.equal(validacao.valido, false, `${cupom.codigo} deveria ser recusado`);
            assert.match(validacao.motivo, motivo);
        }

        const inexistente = await validarCupom('NAO-EXISTE-MESMO', usuario.id, 100);
        assert.match(inexistente.motivo, /não encontrado/);
        assert.equal(inexistente.encontrado, false, 'só código inexistente conta tentativa no rate limit');

        // Limite geral: esgotado por outro cliente.
        const limitado = await criarCupom({ usoMaximo: 1 });
        await pagarComCupom(outro, produto.id, limitado.codigo, 5001);
        const esgotado = await validarCupom(limitado.codigo, usuario.id, 100);
        assert.match(esgotado.motivo, /limite de usos/);
    });

    await t.test('cupom: o mesmo cliente não passa de uso_maximo_por_usuario', async () => {
        const usuario = await criarUsuario();
        const outro = await criarUsuario();
        const produto = await criarProduto({ preco: 100, estoque: 50 });
        const cupom = await criarCupom({ usoMaximoPorUsuario: 1 });

        await pagarComCupom(usuario, produto.id, cupom.codigo, 5002);

        const deNovo = await validarCupom(cupom.codigo, usuario.id, 100);
        assert.equal(deNovo.valido, false);
        assert.match(deNovo.motivo, /máximo de vezes/);

        assert.equal((await validarCupom(cupom.codigo, outro.id, 100)).valido, true, 'outro cliente ainda pode usar');
    });

    await t.test('cupom: desconto mandado no corpo é ignorado, o servidor recalcula do zero', async () => {
        const usuario = await criarUsuario();
        const produto = await criarProduto({ preco: 200, estoque: 50 });
        const cupom = await criarCupom({ tipo: 'percentual', valor: 10 });
        const itens = [{ id: produto.id, quantidade: 1, unit_price: 0.01 }];

        const forjado = await prepararCheckout({
            itens,
            cupom: cupom.codigo,
            desconto: 9999,
            total: 0.01,
            subtotal: 1
        }, usuario);

        assert.equal(forjado.desconto, 20, 'o desconto vem do cupom, não do corpo');
        assert.equal(forjado.subtotal, 200);
        assert.equal(forjado.total, 199.9, '200 - 20 + 19,90 de frete');

        const semCupom = await prepararCheckout({ itens, desconto: 150 }, usuario);
        assert.equal(semCupom.desconto, 0, 'sem cupom não há desconto, mande o corpo o que mandar');
        assert.equal(semCupom.total, 219.9);
    });

    await t.test('cupom: a soma dos itens enviados ao Mercado Pago é o total do pedido', async () => {
        const usuario = await criarUsuario();
        const a = await criarProduto({ preco: 33.33, estoque: 50 });
        const b = await criarProduto({ preco: 19.99, estoque: 50 });
        const cupom = await criarCupom({ tipo: 'percentual', valor: 12.5 });
        const itens = [{ id: a.id, quantidade: 3 }, { id: b.id, quantidade: 2 }];

        for (const corpo of [{ itens }, { itens, cupom: cupom.codigo }]) {
            const resumo = await prepararCheckout(corpo, usuario);
            const linhas = montarItensMercadoPago(resumo);

            assert.equal(somaDosItens(linhas), resumo.total, `soma dos itens ${corpo.cupom ? 'com' : 'sem'} cupom`);
            assert.ok(linhas.every((linha) => linha.unit_price > 0), 'o Mercado Pago não aceita item de valor zero ou negativo');
        }
    });

    await t.test('cupom: o uso só conta na aprovação, uma vez, e o estorno devolve a vaga', async () => {
        const usuario = await criarUsuario();
        const produto = await criarProduto({ preco: 100, estoque: 50 });
        const cupom = await criarCupom({ usoMaximo: 5 });

        const resumo = await prepararCheckout({ itens: [{ id: produto.id, quantidade: 1 }], cupom: cupom.codigo }, usuario);
        const pedido = await registrarPedidoPendente(usuario, resumo.itens, resumo.subtotal, resumo.frete, resumo.total, {
            cupomId: resumo.cupom.id,
            desconto: resumo.desconto
        });

        assert.equal(await contarUsos(cupom.id), 0, 'pedido criado e não pago não consome vaga');

        const pagamento = { id: 5003, external_reference: pedido.externalReference };
        await sincronizarPagamentoNoBanco({ ...pagamento, status: 'approved' });
        await sincronizarPagamentoNoBanco({ ...pagamento, status: 'approved' });
        assert.equal(await contarUsos(cupom.id), 1, 'o reenvio do webhook não conta de novo');

        await sincronizarPagamentoNoBanco({ ...pagamento, status: 'refunded' });
        assert.equal(await contarUsos(cupom.id), 0, 'o estorno devolve a vaga');
    });

    await t.test('cupom: o código é comparado sem diferenciar maiúsculas', async () => {
        const usuario = await criarUsuario();
        const cupom = await criarCupom();
        assert.equal((await validarCupom(`  ${cupom.codigo.toLowerCase()}  `, usuario.id, 100)).valido, true);
    });
});
