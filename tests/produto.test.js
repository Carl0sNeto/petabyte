// Página de produto: detalhe público e avaliações.
//
// O ponto que mais importa aqui é a verificação de compra. A regra "só quem
// comprou avalia" só vale se o servidor conferir — um cliente adulterado que
// poste direto no endpoint precisa esbarrar nela.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, pool, resolverItensCarrinho, registrarPedidoPendente } = require('../server.js');
const { criarProduto, criarUsuario, emitirToken, cabecalhosDeSessao, limpar, PREFIXO } = require('./ajuda.js');

// Palavra que não existe no catálogo real, para cada caso de busca enxergar
// só os produtos que ele mesmo criou.
function palavraUnica() {
    return `zq${Math.random().toString(36).slice(2, 10).replace(/\d/g, 'x')}`;
}

function ids(lista) {
    return lista.map((produto) => produto.id);
}

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
        // O catálogo agora é paginado: a busca pelo prefixo garante que o
        // produto do teste esteja na página, qualquer que seja o catálogo real.
        const { dados } = await pedir('GET', `/produtos?busca=${encodeURIComponent(PREFIXO)}`);
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

    // ------------------------------------------------------------------
    // Destaques da home e catálogo com busca
    // ------------------------------------------------------------------

    await t.test('destaques: só destaque E ativo, na ordem de ordem_destaque', async () => {
        const segundo = await criarProduto({ preco: 10, estoque: 1, destaque: true, ordemDestaque: 2 });
        const primeiro = await criarProduto({ preco: 10, estoque: 1, destaque: true, ordemDestaque: 1 });
        const semPosicao = await criarProduto({ preco: 10, estoque: 1, destaque: true, ordemDestaque: null });
        const comum = await criarProduto({ preco: 10, estoque: 1 });

        const { status, dados } = await pedir('GET', '/produtos/destaques');
        assert.equal(status, 200);

        const meus = ids(dados.produtos).filter((id) => [segundo.id, primeiro.id, semPosicao.id, comum.id].includes(id));
        // Sem posição vai para o fim (NULLS LAST).
        assert.deepEqual(meus, [primeiro.id, segundo.id, semPosicao.id]);
    });

    await t.test('destaques: produto em destaque fora de circulação não aparece', async () => {
        const inativo = await criarProduto({ preco: 10, estoque: 1, destaque: true, ordemDestaque: 0, ativo: false });

        const { dados } = await pedir('GET', '/produtos/destaques');
        assert.ok(!ids(dados.produtos).includes(inativo.id));
    });

    await t.test('busca encontra pelo nome, pela descrição e pela tag, cada uma sozinha', async () => {
        const palavra = palavraUnica();
        const peloNome = await criarProduto({ preco: 10, estoque: 1, nome: `teclado ${palavra}nome` });
        const pelaDescricao = await criarProduto({ preco: 10, estoque: 1, descricao: `Acompanha ${palavra}desc na caixa.` });
        const pelaTag = await criarProduto({ preco: 10, estoque: 1, tags: ['gamer', `${palavra}tag`] });

        const buscar = async (termo) => ids((await pedir('GET', `/produtos?busca=${encodeURIComponent(termo)}`)).dados.produtos);

        assert.deepEqual(await buscar(`${palavra}nome`), [peloNome.id]);
        assert.deepEqual(await buscar(`${palavra}DESC`), [pelaDescricao.id], 'sem diferenciar maiúsculas');
        assert.deepEqual(await buscar(`${palavra}tag`), [pelaTag.id]);
        // Pedaço de tag também vale, como em nome e descrição.
        assert.deepEqual(await buscar(`${palavra}ta`), [pelaTag.id]);
        assert.deepEqual(new Set(await buscar(palavra)), new Set([peloNome.id, pelaDescricao.id, pelaTag.id]));
    });

    await t.test('busca trata % e _ como texto, não como curinga', async () => {
        const palavra = palavraUnica();
        await criarProduto({ preco: 10, estoque: 1, tags: [`${palavra}abc`] });

        const { dados } = await pedir('GET', `/produtos?busca=${encodeURIComponent(`${palavra}_bc`)}`);
        assert.equal(dados.produtos.length, 0, '"_" não pode bater com qualquer caractere');

        const porcento = await pedir('GET', `/produtos?busca=${encodeURIComponent(`${palavra}%`)}`);
        assert.equal(porcento.status, 200);
        assert.equal(porcento.dados.paginacao.totalProdutos, 0, '"%" não pode bater com qualquer sequência');

        const literal = await pedir('GET', `/produtos?busca=${encodeURIComponent(`${palavra}abc`)}`);
        assert.equal(literal.dados.paginacao.totalProdutos, 1, 'o controle: o termo exato continua achando');
    });

    await t.test('categoria e faixa de preço combinam com AND', async () => {
        const palavra = palavraUnica();
        const criar = (categoria, preco) => criarProduto({ preco, estoque: 1, categoria, tags: [palavra] });

        await criar('hardware', 100);            // abaixo do mínimo
        await criar('hardware', 300);            // acima do máximo
        await criar('perifericos', 150);         // na faixa, outra categoria
        const certo = await criar('hardware', 150);

        const { status, dados } = await pedir('GET', `/produtos?busca=${palavra}&categoria=hardware&precoMin=120&precoMax=200`);
        assert.equal(status, 200);
        assert.deepEqual(ids(dados.produtos), [certo.id]);

        // Cada limite funciona sozinho.
        const soMinimo = await pedir('GET', `/produtos?busca=${palavra}&precoMin=150`);
        assert.equal(soMinimo.dados.paginacao.totalProdutos, 3);
        const soMaximo = await pedir('GET', `/produtos?busca=${palavra}&precoMax=150`);
        assert.equal(soMaximo.dados.paginacao.totalProdutos, 3);
    });

    await t.test('ordena de A a Z e do maior preço para o menor', async () => {
        const palavra = palavraUnica();
        const banana = await criarProduto({ preco: 50, estoque: 1, nome: `banana ${palavra}`, tags: [palavra] });
        const abacaxi = await criarProduto({ preco: 20, estoque: 1, nome: `abacaxi ${palavra}`, tags: [palavra] });
        const caju = await criarProduto({ preco: 90, estoque: 1, nome: `caju ${palavra}`, tags: [palavra] });

        const az = await pedir('GET', `/produtos?busca=${palavra}&ordenar=az`);
        assert.deepEqual(ids(az.dados.produtos), [abacaxi.id, banana.id, caju.id]);

        const za = await pedir('GET', `/produtos?busca=${palavra}&ordenar=za`);
        assert.deepEqual(ids(za.dados.produtos), [caju.id, banana.id, abacaxi.id]);

        const maiorPreco = await pedir('GET', `/produtos?busca=${palavra}&ordenar=maior-preco`);
        assert.deepEqual(ids(maiorPreco.dados.produtos), [caju.id, banana.id, abacaxi.id]);

        const menorPreco = await pedir('GET', `/produtos?busca=${palavra}&ordenar=menor-preco`);
        assert.deepEqual(ids(menorPreco.dados.produtos), [abacaxi.id, banana.id, caju.id]);

        // Sem escolha, os mais recentes primeiro.
        const padrao = await pedir('GET', `/produtos?busca=${palavra}`);
        assert.deepEqual(ids(padrao.dados.produtos), [caju.id, abacaxi.id, banana.id]);
    });

    await t.test('paginação: a página 2 não repete nem pula item da página 1', async () => {
        const palavra = palavraUnica();
        const criados = [];

        // Mesmo preço em todos: força empate na ordenação, que é onde uma
        // paginação sem desempate repete ou pula item.
        for (let i = 0; i < 25; i += 1) {
            criados.push((await criarProduto({ preco: 99, estoque: 1, tags: [palavra] })).id);
        }
        const inativo = await criarProduto({ preco: 99, estoque: 1, tags: [palavra], ativo: false });

        for (const ordenar of ['recentes', 'menor-preco']) {
            const pagina1 = await pedir('GET', `/produtos?busca=${palavra}&ordenar=${ordenar}`);
            const pagina2 = await pedir('GET', `/produtos?busca=${palavra}&ordenar=${ordenar}&pagina=2`);

            assert.deepEqual(pagina1.dados.paginacao, {
                paginaAtual: 1, totalPaginas: 2, totalProdutos: 25, itensPorPagina: 20
            });
            assert.equal(pagina1.dados.produtos.length, 20);
            assert.equal(pagina2.dados.produtos.length, 5);
            assert.equal(pagina2.dados.paginacao.paginaAtual, 2);

            const vistos = [...ids(pagina1.dados.produtos), ...ids(pagina2.dados.produtos)];
            assert.equal(new Set(vistos).size, 25, `${ordenar}: nenhum item repetido`);
            assert.deepEqual([...vistos].sort((a, b) => a - b), [...criados].sort((a, b) => a - b), `${ordenar}: nenhum item pulado`);
            assert.ok(!vistos.includes(inativo.id), 'produto inativo nunca aparece');
        }

        const limitado = await pedir('GET', `/produtos?busca=${palavra}&limite=500`);
        assert.equal(limitado.dados.paginacao.itensPorPagina, 60, 'o limite tem teto');
    });

    await t.test('produto inativo não aparece em filtro nenhum', async () => {
        const palavra = palavraUnica();
        const inativo = await criarProduto({
            preco: 10, estoque: 1, ativo: false, nome: `mouse ${palavra}`, tags: [palavra], categoria: 'perifericos'
        });

        const consultas = [
            `/produtos?busca=${palavra}`,
            `/produtos?busca=${palavra}&categoria=perifericos&precoMin=0&precoMax=100&ordenar=az`,
            `/produtos?ids=${inativo.id}`
        ];

        for (const caminho of consultas) {
            const { dados } = await pedir('GET', caminho);
            assert.ok(!ids(dados.produtos).includes(inativo.id), `inativo apareceu em ${caminho}`);
        }
    });

    await t.test('as categorias do filtro não encolhem com os outros filtros', async () => {
        const semFiltro = await pedir('GET', '/produtos');
        const filtrado = await pedir('GET', `/produtos?busca=${palavraUnica()}`);

        assert.equal(filtrado.dados.produtos.length, 0);
        assert.ok(semFiltro.dados.categoriasDisponiveis.length > 0);
        assert.deepEqual(filtrado.dados.categoriasDisponiveis, semFiltro.dados.categoriasDisponiveis);
    });

    await t.test('ids devolve os produtos do carrinho, estejam em que página estiverem', async () => {
        const a = await criarProduto({ preco: 10, estoque: 1 });
        const b = await criarProduto({ preco: 10, estoque: 1 });

        const { status, dados } = await pedir('GET', `/produtos?ids=${a.id},${b.id}`);
        assert.equal(status, 200);
        assert.deepEqual(new Set(ids(dados.produtos)), new Set([a.id, b.id]));

        const excesso = Array.from({ length: 21 }, (_, i) => i + 1).join(',');
        assert.equal((await pedir('GET', `/produtos?ids=${excesso}`)).status, 400);
    });

    await t.test('filtro malformado responde 400 em vez de ser ignorado', async () => {
        for (const consulta of ['ordenar=aleatorio', 'precoMin=barato', 'precoMax=-5', 'categoria=casa', 'ids=1,abc']) {
            const { status } = await pedir('GET', `/produtos?${consulta}`);
            assert.equal(status, 400, `deveria recusar ${consulta}`);
        }
    });
});
