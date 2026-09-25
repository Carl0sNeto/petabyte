// Relatórios do painel: receita sem frete, só pedido pago, variação contra o
// período anterior, granularidade do gráfico, produtos parados e o CSV.
//
// As somas são do banco inteiro, não só das fixtures. Para o catálogo e os
// pedidos reais não entrarem na conta, os pedidos de teste ficam em 2001 — um
// período em que a loja não existia. Só os casos de "parados", que por regra
// olham até hoje, usam datas recentes, e conferem apenas os próprios produtos.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, pool, registrarPedidoPendente } = require('../server.js');
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

async function pedir(caminho, token) {
    const resposta = await fetch(`${base}${caminho}`, {
        headers: token ? cabecalhosDeSessao(token) : {}
    });

    const texto = await resposta.text();
    let dados = {};
    try { dados = JSON.parse(texto); } catch (erro) { dados = { texto }; }

    return { status: resposta.status, dados, cabecalhos: resposta.headers, texto };
}

// Grava um pedido com status e data escolhidos. `quando` é o horário de
// parede da loja (São Paulo), convertido para o relógio da sessão do banco —
// o mesmo que o DEFAULT CURRENT_TIMESTAMP usaria. Assim o teste vale com o
// banco em UTC (Neon) ou em -03:00 (local).
async function pedido(usuario, { status = 'Pago', quando, subtotal, frete = 19.9, desconto = 0, itens }) {
    const total = subtotal - desconto + frete;
    const { pedidoId } = await registrarPedidoPendente(usuario, itens, subtotal, frete, total, { desconto });

    const data = quando.startsWith('agora')
        ? `NOW() - INTERVAL '${quando.slice('agora'.length).trim() || '0 days'}'`
        : `(('${quando}'::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE current_setting('TimeZone'))`;

    await pool.query(`UPDATE pedidos SET status = $1, criado_em = ${data} WHERE id = $2`, [status, pedidoId]);
    return pedidoId;
}

function item(produto, quantidade = 1, preco = Number(produto.preco)) {
    return { produtoId: produto.id, title: produto.nome, unit_price: preco, quantity: quantidade };
}

test('relatórios do painel', async (t) => {
    let admin;
    let tokenAdmin;
    let tokenComum;
    let cliente;
    let placa;
    let mouse;

    t.before(async () => {
        await limpar();
        await iniciar();

        admin = await criarUsuario({ admin: true });
        tokenAdmin = emitirToken(admin);
        tokenComum = emitirToken(await criarUsuario());
        cliente = await criarUsuario();

        placa = await criarProduto({ preco: 100, estoque: 10, nome: 'placa' });
        mouse = await criarProduto({ preco: 50, estoque: 10, nome: 'mouse' });

        // Período de referência: 01/03/2001 a 10/03/2001 (10 dias).
        await pedido(cliente, { quando: '2001-03-02 12:00', subtotal: 100, itens: [item(placa)] });
        // Com cupom: a receita é o que entrou pelos produtos, 200 - 20.
        await pedido(cliente, { quando: '2001-03-05 12:00', subtotal: 200, desconto: 20, itens: [item(mouse, 4)] });
        // Último minuto do último dia entra; o primeiro do dia seguinte, não.
        await pedido(cliente, { quando: '2001-03-10 23:59', subtotal: 50, itens: [item(mouse)] });
        await pedido(cliente, { quando: '2001-03-11 00:01', subtotal: 5000, itens: [item(placa, 50)] });

        // Não pagos, no meio do período: não podem entrar em conta nenhuma.
        for (const status of ['Aguardando pagamento', 'Cancelado', 'Reembolsado', 'Recusado']) {
            await pedido(cliente, { status, quando: '2001-03-06 12:00', subtotal: 1000, itens: [item(placa, 10)] });
        }
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    const PERIODO = 'inicio=2001-03-01&fim=2001-03-10';

    await t.test('as três rotas recusam quem não é administrador', async () => {
        for (const rota of ['vendas', 'parados', 'exportar']) {
            assert.equal((await pedir(`/admin/relatorios/${rota}`)).status, 401, `${rota} sem sessão`);
            assert.equal((await pedir(`/admin/relatorios/${rota}`, tokenComum)).status, 403, `${rota} com conta comum`);
        }
    });

    await t.test('receita soma o subtotal menos o cupom, nunca o total com frete', async () => {
        const { status, dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);

        assert.equal(status, 200);
        // 100 + 180 + 50. Com o total, seriam 3 fretes de 19,90 a mais.
        assert.equal(dados.resumo.receita, 330);
        assert.equal(dados.resumo.pedidos, 3);
        assert.equal(dados.resumo.ticketMedio, 110);
    });

    await t.test('pedido não pago não entra em agregado nenhum', async () => {
        const { dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);

        const dia6 = dados.serie.find((ponto) => ponto.periodo === '2001-03-06');
        assert.deepEqual(dia6, { periodo: '2001-03-06', receita: 0, pedidos: 0 });

        const placaNoRanking = dados.maisVendidos.find((linha) => linha.produtoId === placa.id);
        assert.equal(placaNoRanking.qtd, 1, 'as 10 placas dos pedidos não pagos não contam');
    });

    await t.test('a série tem um ponto por dia, inclusive os sem venda, e fecha com o resumo', async () => {
        const { dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);

        assert.equal(dados.periodo.granularidade, 'day');
        assert.equal(dados.serie.length, 10);
        assert.equal(dados.serie[0].periodo, '2001-03-01');
        assert.equal(dados.serie[9].periodo, '2001-03-10');
        assert.equal(dados.serie[9].receita, 50, 'o pedido das 23:59 do último dia entra');

        const soma = dados.serie.reduce((total, ponto) => total + ponto.receita, 0);
        assert.equal(soma, dados.resumo.receita);
    });

    await t.test('mais vendidos ordena por quantidade, com o nome atual do produto', async () => {
        await pool.query('UPDATE produtos SET nome = $1 WHERE id = $2', [`${PREFIXO}mouse renomeado`, mouse.id]);

        const { dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);
        const meus = dados.maisVendidos.filter((linha) => [placa.id, mouse.id].includes(linha.produtoId));

        assert.deepEqual(meus.map((linha) => linha.produtoId), [mouse.id, placa.id]);
        assert.equal(meus[0].qtd, 5);
        assert.equal(meus[0].receita, 250, 'soma dos itens, antes do cupom do pedido');
        assert.equal(meus[0].nome, `${PREFIXO}mouse renomeado`, 'renomear não divide o produto em duas linhas');
    });

    await t.test('variação sem vendas no período anterior vem nula, sem dividir por zero', async () => {
        const { dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);

        assert.deepEqual(dados.periodoAnterior, { inicio: '2001-02-19', fim: '2001-02-28' });
        assert.equal(dados.resumo.receitaDeltaPct, null);
        assert.equal(dados.resumo.pedidosDeltaPct, null);
        assert.equal(dados.resumo.ticketMedioDeltaPct, null);
    });

    await t.test('variação contra o intervalo anterior do mesmo tamanho', async () => {
        const id = await pedido(cliente, { quando: '2001-02-25 12:00', subtotal: 110, itens: [item(placa)] });

        const { dados } = await pedir(`/admin/relatorios/vendas?${PERIODO}`, tokenAdmin);

        // 330 contra 110 = +200%; 3 pedidos contra 1 = +200%; ticket 110 contra 110 = 0%.
        assert.equal(dados.resumo.receitaDeltaPct, 200);
        assert.equal(dados.resumo.pedidosDeltaPct, 200);
        assert.equal(dados.resumo.ticketMedioDeltaPct, 0);

        await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
    });

    await t.test('acima de 60 dias o gráfico passa a ser semanal', async () => {
        const sessenta = await pedir('/admin/relatorios/vendas?inicio=2001-01-10&fim=2001-03-10', tokenAdmin);
        assert.equal(sessenta.dados.periodo.dias, 60);
        assert.equal(sessenta.dados.periodo.granularidade, 'day');
        assert.equal(sessenta.dados.serie.length, 60);

        const sessentaEUm = await pedir('/admin/relatorios/vendas?inicio=2001-01-09&fim=2001-03-10', tokenAdmin);
        assert.equal(sessentaEUm.dados.periodo.granularidade, 'week');

        const noventa = await pedir('/admin/relatorios/vendas?inicio=2000-12-11&fim=2001-03-10', tokenAdmin);
        assert.equal(noventa.dados.periodo.granularidade, 'week');

        // O primeiro balde leva a data de início (11/12/2000 é segunda, mas o
        // de 90 dias abaixo começa numa quinta); os demais, segundas-feiras. A
        // soma não muda com o agrupamento.
        const quinta = await pedir('/admin/relatorios/vendas?inicio=2000-12-14&fim=2001-03-13', tokenAdmin);
        assert.equal(quinta.dados.serie[0].periodo, '2000-12-14', 'a primeira semana começa onde o período começa');
        for (const ponto of quinta.dados.serie.slice(1)) {
            assert.equal(new Date(`${ponto.periodo}T00:00:00Z`).getUTCDay(), 1, `${ponto.periodo} não é segunda`);
        }
        const soma = noventa.dados.serie.reduce((total, ponto) => total + ponto.receita, 0);
        assert.equal(soma, 330);
    });

    await t.test('sem datas, assume os últimos 30 dias', async () => {
        const { status, dados } = await pedir('/admin/relatorios/vendas', tokenAdmin);

        assert.equal(status, 200);
        assert.equal(dados.periodo.dias, 30);
        assert.equal(dados.serie.length, 30);
    });

    await t.test('recusa período malformado', async () => {
        const ruins = [
            'inicio=2001-03-01',                          // só uma das datas
            'inicio=01/03/2001&fim=10/03/2001',           // formato
            'inicio=2001-02-30&fim=2001-03-10',           // dia que não existe
            'inicio=2001-03-10&fim=2001-03-01',           // invertido
            'inicio=1990-01-01&fim=2001-03-10'            // longo demais
        ];

        for (const consulta of ruins) {
            assert.equal((await pedir(`/admin/relatorios/vendas?${consulta}`, tokenAdmin)).status, 400, consulta);
            assert.equal((await pedir(`/admin/relatorios/exportar?${consulta}`, tokenAdmin)).status, 400, consulta);
        }
    });

    await t.test('parados: nunca vendido primeiro; vendido há 10 dias e esgotado ficam de fora', async () => {
        const nunca = await criarProduto({ preco: 10, estoque: 3, nome: 'nunca vendido' });
        const soNaoPago = await criarProduto({ preco: 10, estoque: 3, nome: 'so pedido nao pago' });
        const antigo = await criarProduto({ preco: 10, estoque: 3, nome: 'vendido ha 20 dias' });
        const limite = await criarProduto({ preco: 10, estoque: 3, nome: 'vendido ha 15 dias' });
        const recente = await criarProduto({ preco: 10, estoque: 3, nome: 'vendido ha 10 dias' });
        const esgotado = await criarProduto({ preco: 10, estoque: 0, nome: 'esgotado' });
        const inativo = await criarProduto({ preco: 10, estoque: 3, nome: 'inativo', ativo: false });

        await pedido(cliente, { quando: 'agora 20 days', subtotal: 10, itens: [item(antigo)] });
        await pedido(cliente, { quando: 'agora 15 days 1 minute', subtotal: 10, itens: [item(limite)] });
        await pedido(cliente, { quando: 'agora 10 days', subtotal: 10, itens: [item(recente)] });
        await pedido(cliente, { status: 'Cancelado', quando: 'agora 3 days', subtotal: 10, itens: [item(soNaoPago)] });

        const { status, dados } = await pedir('/admin/relatorios/parados', tokenAdmin);
        assert.equal(status, 200);

        const lista = dados.produtos;
        const listados = new Set(lista.map((p) => p.id));

        assert.ok(listados.has(nunca.id));
        assert.ok(listados.has(soNaoPago.id), 'pedido não pago não conta como venda');
        assert.ok(listados.has(antigo.id));
        assert.ok(listados.has(limite.id), '15 dias ou mais já é parado');
        assert.ok(!listados.has(recente.id), 'vendido há 10 dias ainda gira');
        assert.ok(!listados.has(esgotado.id), 'sem estoque não há o que girar');
        assert.ok(!listados.has(inativo.id));

        const linhaNunca = lista.find((p) => p.id === nunca.id);
        assert.equal(linhaNunca.ultimaVenda, null);
        assert.equal(lista.find((p) => p.id === antigo.id).diasSemVenda, 20);

        // NULLS FIRST: nenhum produto com venda aparece antes de um nunca vendido,
        // e entre os vendidos a venda mais antiga vem primeiro.
        const primeiroComVenda = lista.findIndex((p) => p.ultimaVenda !== null);
        assert.ok(lista.slice(primeiroComVenda).every((p) => p.ultimaVenda !== null));
        assert.ok(lista.findIndex((p) => p.id === nunca.id) < primeiroComVenda);
        assert.ok(lista.findIndex((p) => p.id === antigo.id) < lista.findIndex((p) => p.id === limite.id));
    });

    await t.test('o CSV traz os três blocos, com o nome de arquivo do período', async () => {
        // Item de produto já excluído, com vírgula e cara de fórmula no nome.
        const perigoso = `=HYPERLINK("x"), ${PREFIXO}`;
        await pedido(cliente, {
            quando: '2001-03-03 12:00',
            subtotal: 1,
            itens: [{ produtoId: null, title: perigoso, unit_price: 1, quantity: 1 }]
        });

        const { status, cabecalhos, texto } = await pedir(`/admin/relatorios/exportar?${PERIODO}`, tokenAdmin);

        assert.equal(status, 200);
        assert.match(cabecalhos.get('content-type'), /^text\/csv/);
        assert.equal(
            cabecalhos.get('content-disposition'),
            'attachment; filename="relatorio-petabyte-2001-03-01-a-2001-03-10.csv"'
        );

        for (const titulo of ['Receita e pedidos por período', 'Produtos mais vendidos', 'Produtos parados no estoque']) {
            assert.ok(texto.includes(titulo), `falta o bloco "${titulo}"`);
        }

        assert.ok(texto.includes('Data,Receita,Pedidos'));
        assert.ok(texto.includes('2001-03-02,100.00,1'), 'receita com ponto decimal e duas casas');
        assert.ok(texto.includes(`"'=HYPERLINK(""x""), ${PREFIXO}"`), 'fórmula neutralizada e vírgula entre aspas');
        assert.ok(/nunca vendido/.test(texto));
    });
});
