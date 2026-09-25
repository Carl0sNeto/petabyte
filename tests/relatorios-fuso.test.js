// Relatórios com o banco em UTC, como o Neon do deploy.
//
// Arquivo à parte porque o fuso da sessão é escolhido quando o pool conecta: o
// PGOPTIONS abaixo precisa valer antes de o server.js ser carregado, e cada
// arquivo de teste roda em processo próprio. Num Postgres local em -03:00 a
// conversão de fuso não muda nada — é aqui que ela prova seu valor: sem ela,
// um pedido das 22h30 de São Paulo cairia no dia seguinte do relatório.

process.env.PGOPTIONS = '-c TimeZone=UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, pool, registrarPedidoPendente } = require('../server.js');
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

// Horário de parede de São Paulo, gravado no relógio da sessão (UTC aqui).
async function pedidoPagoEm(usuario, produto, quando, subtotal) {
    const item = { produtoId: produto.id, title: produto.nome, unit_price: subtotal, quantity: 1 };
    const { pedidoId } = await registrarPedidoPendente(usuario, [item], subtotal, 19.9, subtotal + 19.9);
    await pool.query(
        `UPDATE pedidos
            SET status = 'Pago',
                criado_em = ($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE current_setting('TimeZone')
          WHERE id = $2`,
        [quando, pedidoId]
    );
}

test('relatórios com o banco em UTC', async (t) => {
    let token;

    t.before(async () => {
        await limpar();
        await iniciar();

        const sessao = await pool.query('SHOW TimeZone');
        assert.equal(sessao.rows[0].TimeZone, 'UTC', 'o teste só vale com a sessão do banco em UTC');

        const admin = await criarUsuario({ admin: true });
        token = emitirToken(admin);
        const cliente = await criarUsuario();
        const produto = await criarProduto({ preco: 100, estoque: 5 });

        // 22h30 de 10/03 em São Paulo são 01h30 de 11/03 em UTC.
        await pedidoPagoEm(cliente, produto, '2001-03-10 22:30', 100);
        // 00h30 de 11/03 em São Paulo: já é o dia seguinte para a loja.
        await pedidoPagoEm(cliente, produto, '2001-03-11 00:30', 40);
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    await t.test('o pedido da noite conta no dia da loja, não no dia UTC', async () => {
        const resposta = await fetch(`${base}/admin/relatorios/vendas?inicio=2001-03-10&fim=2001-03-11`, {
            headers: cabecalhosDeSessao(token)
        });
        const dados = await resposta.json();

        assert.equal(resposta.status, 200);
        assert.deepEqual(dados.serie, [
            { periodo: '2001-03-10', receita: 100, pedidos: 1 },
            { periodo: '2001-03-11', receita: 40, pedidos: 1 }
        ]);
    });
});
