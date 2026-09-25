// Autorização e validações do painel administrativo.
//
// O que importa aqui é que nenhuma rota /admin responda a quem não é
// administrador, e que a revogação tenha efeito imediato — sem esperar o token
// expirar. As requisições passam pelo app Express real, sem abrir porta.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../server.js');
const {
    criarProduto,
    criarUsuario,
    codigoDeCupom,
    emitirToken,
    cabecalhosDeSessao,
    definirAdmin,
    limpar,
    pool
} = require('./ajuda.js');

let servidor;
let base;

// Sobe o app numa porta efêmera só durante a suíte.
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

test('painel administrativo', async (t) => {
    let comum;
    let admin;
    let tokenComum;
    let tokenAdmin;
    let produto;

    t.before(async () => {
        await limpar();
        await iniciar();

        comum = await criarUsuario({ admin: false });
        admin = await criarUsuario({ admin: true });
        tokenComum = emitirToken(comum);
        tokenAdmin = emitirToken(admin);
        produto = await criarProduto({ preco: 100, estoque: 5 });
    });

    t.after(async () => {
        await new Promise((resolve) => servidor.close(resolve));
        await limpar();
        await pool.end();
    });

    const rotas = [
        ['GET', '/admin/produtos'],
        ['POST', '/admin/produtos'],
        ['PUT', '/admin/produtos/1'],
        ['DELETE', '/admin/produtos/1'],
        ['GET', '/admin/pedidos'],
        ['GET', '/admin/pedidos/1'],
        ['GET', '/admin/cupons'],
        ['POST', '/admin/cupons'],
        ['PUT', '/admin/cupons/1']
    ];

    await t.test('nenhuma rota /admin responde sem token', async () => {
        for (const [metodo, caminho] of rotas) {
            const { status } = await pedir(metodo, caminho);
            assert.equal(status, 401, `${metodo} ${caminho} deveria exigir token`);
        }
    });

    await t.test('nenhuma rota /admin responde com token inválido', async () => {
        for (const [metodo, caminho] of rotas) {
            const { status } = await pedir(metodo, caminho, { token: 'token.claramente.invalido' });
            assert.equal(status, 401, `${metodo} ${caminho} deveria recusar token inválido`);
        }
    });

    await t.test('nenhuma rota /admin responde a usuário comum', async () => {
        for (const [metodo, caminho] of rotas) {
            const { status } = await pedir(metodo, caminho, { token: tokenComum });
            assert.equal(status, 403, `${metodo} ${caminho} deveria recusar usuário comum`);
        }
    });

    await t.test('administrador acessa a listagem', async () => {
        const { status, dados } = await pedir('GET', '/admin/produtos', { token: tokenAdmin });
        assert.equal(status, 200);
        assert.ok(Array.isArray(dados.produtos));
        assert.ok(dados.produtos.some((p) => p.id === produto.id));
    });

    await t.test('a listagem do painel inclui produtos inativos', async () => {
        const inativo = await criarProduto({ preco: 50, estoque: 1, ativo: false });

        const painel = await pedir('GET', '/admin/produtos', { token: tokenAdmin });
        const publico = await pedir('GET', '/produtos');

        assert.ok(painel.dados.produtos.some((p) => p.id === inativo.id), 'o painel deve ver o inativo');
        assert.ok(!publico.dados.produtos.some((p) => p.id === inativo.id), 'a loja não deve ver o inativo');
    });

    await t.test('revogar a permissão tem efeito imediato, com o mesmo token', async () => {
        const antes = await pedir('GET', '/admin/produtos', { token: tokenAdmin });
        assert.equal(antes.status, 200);

        await definirAdmin(admin.id, false);
        const durante = await pedir('GET', '/admin/produtos', { token: tokenAdmin });
        assert.equal(durante.status, 403, 'o token antigo não pode continuar valendo');

        await definirAdmin(admin.id, true);
        const depois = await pedir('GET', '/admin/produtos', { token: tokenAdmin });
        assert.equal(depois.status, 200);
    });

    await t.test('recusa dados inválidos ao criar produto', async () => {
        const casos = [
            [{ nome: 'A', preco: 10, categoria: 'hardware' }, 'nome curto demais'],
            [{ nome: 'Valido', preco: 0, categoria: 'hardware' }, 'preço zero'],
            [{ nome: 'Valido', preco: -1, categoria: 'hardware' }, 'preço negativo'],
            [{ nome: 'Valido', preco: 10, categoria: 'nao-existe' }, 'categoria fora da lista'],
            [{ nome: 'Valido', preco: 10, categoria: 'hardware', estoque: -5 }, 'estoque negativo'],
            [{ nome: 'Valido', preco: 10, categoria: 'hardware', estoque: 1.5 }, 'estoque fracionado'],
            [{ nome: 'Valido', preco: 10, categoria: 'hardware', imagemUrl: 'http://sem-tls.test/a.jpg' }, 'imagem sem https'],
            [{ preco: 10, categoria: 'hardware' }, 'sem nome'],
            [{ nome: 'Valido', categoria: 'hardware' }, 'sem preço']
        ];

        for (const [corpo, motivo] of casos) {
            const { status } = await pedir('POST', '/admin/produtos', { token: tokenAdmin, corpo });
            assert.equal(status, 400, `deveria recusar: ${motivo}`);
        }
    });

    await t.test('recusa nome duplicado com 409', async () => {
        const { status } = await pedir('POST', '/admin/produtos', {
            token: tokenAdmin,
            corpo: { nome: produto.nome, preco: 10, categoria: 'hardware' }
        });

        assert.equal(status, 409);
    });

    await t.test('cria, edita parcialmente e exclui', async () => {
        const nome = `${produto.nome}_ciclo`;

        const criado = await pedir('POST', '/admin/produtos', {
            token: tokenAdmin,
            corpo: { nome, preco: 250.5, categoria: 'perifericos', estoque: 4, imagemUrl: 'https://exemplo.test/a.jpg' }
        });

        assert.equal(criado.status, 201);
        assert.equal(criado.dados.produto.preco, 250.5);
        assert.equal(criado.dados.produto.ativo, true);

        const id = criado.dados.produto.id;

        const editado = await pedir('PUT', `/admin/produtos/${id}`, { token: tokenAdmin, corpo: { preco: 199.9 } });
        assert.equal(editado.status, 200);
        assert.equal(editado.dados.produto.preco, 199.9);
        assert.equal(editado.dados.produto.nome, nome, 'campos não enviados não podem mudar');
        assert.equal(editado.dados.produto.estoque, 4);

        const excluido = await pedir('DELETE', `/admin/produtos/${id}`, { token: tokenAdmin });
        assert.equal(excluido.status, 200);
        assert.equal(excluido.dados.itensDePedidoAfetados, 0);

        const denovo = await pedir('DELETE', `/admin/produtos/${id}`, { token: tokenAdmin });
        assert.equal(denovo.status, 404);
    });

    await t.test('normaliza as tags recebidas', async () => {
        const nome = `${produto.nome}_tags`;

        const criado = await pedir('POST', '/admin/produtos', {
            token: tokenAdmin,
            corpo: {
                nome,
                preco: 100,
                categoria: 'hardware',
                // Maiúsculas, espaços sobrando, vazias e repetidas.
                tags: '  RTX , gigabyte,, GPU ,rtx,  '
            }
        });

        assert.equal(criado.status, 201);
        assert.deepEqual(criado.dados.produto.tags, ['rtx', 'gigabyte', 'gpu']);

        // Também aceita array, que é como o painel poderia enviar.
        const editado = await pedir('PUT', `/admin/produtos/${criado.dados.produto.id}`, {
            token: tokenAdmin,
            corpo: { tags: ['AMD', 'ryzen'] }
        });

        assert.deepEqual(editado.dados.produto.tags, ['amd', 'ryzen']);

        await pedir('DELETE', `/admin/produtos/${criado.dados.produto.id}`, { token: tokenAdmin });
    });

    await t.test('recusa tags acima dos limites', async () => {
        const demais = Array.from({ length: 13 }, (_, i) => `tag${i}`);
        const longa = 'x'.repeat(31);

        for (const [tags, motivo] of [[demais, 'mais de 12 tags'], [[longa], 'tag com mais de 30 caracteres']]) {
            const { status } = await pedir('POST', '/admin/produtos', {
                token: tokenAdmin,
                corpo: { nome: `${produto.nome}_${motivo}`, preco: 10, categoria: 'hardware', tags }
            });

            assert.equal(status, 400, `deveria recusar: ${motivo}`);
        }
    });

    await t.test('as categorias vêm com slug e rótulo', async () => {
        const { dados } = await pedir('GET', '/admin/produtos', { token: tokenAdmin });

        assert.ok(Array.isArray(dados.categorias));
        assert.ok(dados.categorias.every((c) => typeof c.slug === 'string' && typeof c.rotulo === 'string'));
        assert.ok(dados.categorias.some((c) => c.slug === 'hardware'));
        assert.ok(!dados.categorias.some((c) => c.slug === 'casa'), 'a taxonomia antiga não deve sobreviver');
    });

    await t.test('recusa edição sem nenhum campo', async () => {
        const { status } = await pedir('PUT', `/admin/produtos/${produto.id}`, { token: tokenAdmin, corpo: {} });
        assert.equal(status, 400);
    });

    await t.test('responde 404 para produto e pedido inexistentes', async () => {
        assert.equal((await pedir('PUT', '/admin/produtos/999999', { token: tokenAdmin, corpo: { preco: 5 } })).status, 404);
        assert.equal((await pedir('DELETE', '/admin/produtos/999999', { token: tokenAdmin })).status, 404);
        assert.equal((await pedir('GET', '/admin/pedidos/999999', { token: tokenAdmin })).status, 404);
    });

    await t.test('responde 400 para identificador não numérico', async () => {
        assert.equal((await pedir('GET', '/admin/pedidos/abc', { token: tokenAdmin })).status, 400);
        assert.equal((await pedir('PUT', '/admin/produtos/abc', { token: tokenAdmin, corpo: { preco: 5 } })).status, 400);
    });

    await t.test('a listagem de pedidos vem paginada', async () => {
        const { status, dados } = await pedir('GET', '/admin/pedidos?porPagina=5&pagina=1', { token: tokenAdmin });

        assert.equal(status, 200);
        assert.equal(dados.paginacao.porPagina, 5);
        assert.equal(dados.paginacao.pagina, 1);
        assert.ok(Array.isArray(dados.pedidos));
        assert.ok(Array.isArray(dados.statusDisponiveis));
    });

    await t.test('limita porPagina para não permitir varredura', async () => {
        const { dados } = await pedir('GET', '/admin/pedidos?porPagina=100000', { token: tokenAdmin });
        assert.equal(dados.paginacao.porPagina, 100, 'o teto é 100 por página');
    });

    await t.test('/auth/me expõe a flag admin', async () => {
        const doAdmin = await pedir('GET', '/auth/me', { token: tokenAdmin });
        const doComum = await pedir('GET', '/auth/me', { token: tokenComum });

        assert.equal(doAdmin.dados.usuario.admin, true);
        assert.equal(doComum.dados.usuario.admin, false);
    });

    // ------------------------------------------------------------------
    // Cupons
    // ------------------------------------------------------------------

    const cupomValido = (extras = {}) => ({
        codigo: codigoDeCupom(`p_${Math.random().toString(36).slice(2, 7)}`).toLowerCase(),
        tipo: 'percentual',
        valor: 10,
        ...extras
    });

    await t.test('cupons: criar grava o código em maiúsculas e começa com zero usos', async () => {
        const corpo = cupomValido();
        const { status, dados } = await pedir('POST', '/admin/cupons', { token: tokenAdmin, corpo });

        assert.equal(status, 201);
        assert.equal(dados.cupom.codigo, corpo.codigo.toUpperCase());
        assert.equal(dados.cupom.usos, 0);
        assert.equal(dados.cupom.usoMaximoPorUsuario, 1, 'padrão: uma vez por cliente');
        assert.equal(dados.cupom.usoMaximo, null, 'vazio é ilimitado');

        const lista = await pedir('GET', '/admin/cupons', { token: tokenAdmin });
        assert.ok(lista.dados.cupons.some((c) => c.id === dados.cupom.id));
    });

    await t.test('cupons: recusa dados inválidos', async () => {
        const invalidos = [
            cupomValido({ valor: 150 }),
            cupomValido({ valor: 0 }),
            cupomValido({ tipo: 'brinde' }),
            cupomValido({ codigo: 'com espaco' }),
            cupomValido({ codigo: 'AB' }),
            cupomValido({ usoMaximo: 0 }),
            cupomValido({ usoMaximoPorUsuario: 1.5 }),
            cupomValido({ valorMinimoPedido: -1 }),
            cupomValido({ validoDe: '2026-10-10T00:00:00Z', validoAte: '2026-10-01T00:00:00Z' }),
            cupomValido({ validoAte: 'não é data' })
        ];

        for (const corpo of invalidos) {
            const { status } = await pedir('POST', '/admin/cupons', { token: tokenAdmin, corpo });
            assert.equal(status, 400, `deveria recusar ${JSON.stringify(corpo)}`);
        }
    });

    await t.test('cupons: código repetido responde 409, sem diferenciar maiúsculas', async () => {
        const corpo = cupomValido();
        await pedir('POST', '/admin/cupons', { token: tokenAdmin, corpo });

        const repetido = await pedir('POST', '/admin/cupons', {
            token: tokenAdmin,
            corpo: { ...corpo, codigo: corpo.codigo.toUpperCase() }
        });
        assert.equal(repetido.status, 409);
    });

    await t.test('cupons: a edição parcial é validada sobre o resultado final', async () => {
        const criado = await pedir('POST', '/admin/cupons', { token: tokenAdmin, corpo: cupomValido({ valor: 10 }) });
        const id = criado.dados.cupom.id;

        // 150 sozinho é um valor válido, mas não para um cupom percentual.
        const percentualDemais = await pedir('PUT', `/admin/cupons/${id}`, { token: tokenAdmin, corpo: { valor: 150 } });
        assert.equal(percentualDemais.status, 400);

        const virouFixo = await pedir('PUT', `/admin/cupons/${id}`, { token: tokenAdmin, corpo: { tipo: 'fixo', valor: 150 } });
        assert.equal(virouFixo.status, 200);
        assert.equal(virouFixo.dados.cupom.tipo, 'fixo');
        assert.equal(virouFixo.dados.cupom.valor, 150);
    });

    await t.test('cupons: desativa pelo PUT, e não existe rota para apagar', async () => {
        const criado = await pedir('POST', '/admin/cupons', { token: tokenAdmin, corpo: cupomValido() });
        const id = criado.dados.cupom.id;

        const desativado = await pedir('PUT', `/admin/cupons/${id}`, { token: tokenAdmin, corpo: { ativo: false } });
        assert.equal(desativado.dados.cupom.ativo, false);

        const apagar = await pedir('DELETE', `/admin/cupons/${id}`, { token: tokenAdmin });
        assert.equal(apagar.status, 404, 'cupom não se apaga, se desativa');

        const ainda = await pool.query('SELECT 1 FROM cupons WHERE id = $1', [id]);
        assert.equal(ainda.rowCount, 1);
    });

    await t.test('/cupons/validar exige login e devolve a conta feita no servidor', async () => {
        const criado = await pedir('POST', '/admin/cupons', {
            token: tokenAdmin,
            corpo: cupomValido({ tipo: 'fixo', valor: 25 })
        });
        const corpo = { codigo: criado.dados.cupom.codigo, itens: [{ id: produto.id, quantidade: 1 }] };

        assert.equal((await pedir('POST', '/cupons/validar', { corpo })).status, 401, 'o limite por cliente precisa saber quem é o cliente');

        const { status, dados } = await pedir('POST', '/cupons/validar', { token: tokenComum, corpo });
        assert.equal(status, 200);
        assert.equal(dados.valido, true);
        assert.equal(dados.desconto, 25);
        assert.equal(dados.subtotal, 100);
        assert.equal(dados.frete, 19.9);
        assert.equal(dados.total, 94.9);

        const invalido = await pedir('POST', '/cupons/validar', {
            token: tokenComum,
            corpo: { codigo: 'NAO-EXISTE-MESMO', itens: corpo.itens }
        });
        assert.equal(invalido.dados.valido, false);
        assert.match(invalido.dados.motivo, /não encontrado/);
    });
});
