// Catálogo completo: busca, categoria, faixa de preço, ordenação e paginação.
//
// Carrega depois de script.js, de quem usa buscarProdutos, renderCartaoProduto,
// escapeHtml e categoriasCache (que dá o rótulo da categoria no cartão). O
// "Adicionar ao carrinho" já é ligado por script.js, por delegação no
// #productGrid.
//
// A URL é a fonte do estado: cada filtro aplicado vira uma entrada no
// histórico (pushState), e é dela que a página se remonta — no carregamento,
// no Voltar do navegador e num link compartilhado.

const ORDENACOES = ['recentes', 'menor-preco', 'maior-preco', 'az', 'za'];
const ESTADO_PADRAO = { busca: '', categoria: '', precoMin: '', precoMax: '', ordenar: 'recentes', pagina: 1 };
const ESPERA_DIGITACAO_MS = 400;

let estado = { ...ESTADO_PADRAO };

// Cada carga ganha um número. Resposta de uma carga antiga que chegue depois
// de uma nova (rede lenta, clique rápido) é descartada em vez de sobrescrever
// o resultado certo.
let rodada = 0;

function precoDaUrl(valor) {
    if (valor === null || valor === '') return '';
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0 ? String(numero) : '';
}

// Lê a URL com tolerância: um link velho ou editado à mão com valor absurdo
// cai no padrão daquele filtro, em vez de travar a página num erro.
function lerEstadoDaUrl() {
    const query = new URLSearchParams(window.location.search);
    const pagina = Number(query.get('pagina'));
    const ordenar = query.get('ordenar');

    return {
        busca: (query.get('busca') || '').slice(0, 100),
        categoria: query.get('categoria') || '',
        precoMin: precoDaUrl(query.get('precoMin')),
        precoMax: precoDaUrl(query.get('precoMax')),
        ordenar: ORDENACOES.includes(ordenar) ? ordenar : 'recentes',
        pagina: Number.isInteger(pagina) && pagina > 0 ? pagina : 1
    };
}

// Só o que difere do padrão vai para a URL: "catalogo.html?busca=rtx" em vez
// de uma fileira de parâmetros vazios.
function montarQuery(alvo) {
    const query = new URLSearchParams();
    const campos = [
        ['busca', alvo.busca.trim()],
        ['categoria', alvo.categoria],
        ['precoMin', alvo.precoMin],
        ['precoMax', alvo.precoMax],
        ['ordenar', alvo.ordenar === 'recentes' ? '' : alvo.ordenar],
        ['pagina', alvo.pagina > 1 ? String(alvo.pagina) : '']
    ];

    for (const [nome, valor] of campos) {
        if (valor) query.set(nome, valor);
    }

    return query.toString();
}

function enderecoDoEstado(alvo) {
    const query = montarQuery(alvo);
    return query ? `catalogo.html?${query}` : 'catalogo.html';
}

// --------------------------------------------------------------------------
// Controles
// --------------------------------------------------------------------------

function preencherControles() {
    document.getElementById('campoBusca').value = estado.busca;
    document.getElementById('campoPrecoMin').value = estado.precoMin;
    document.getElementById('campoPrecoMax').value = estado.precoMax;
    document.getElementById('campoOrdenar').value = estado.ordenar;
}

// As categorias vêm do catálogo ativo inteiro (a API não as encolhe com os
// outros filtros), então os botões ficam estáveis enquanto a pessoa busca.
function renderCategorias(categorias) {
    const caixa = document.getElementById('filtrosCategoria');
    const botoes = [{ slug: '', rotulo: 'Todas' }, ...categorias];

    caixa.innerHTML = botoes.map((categoria) => {
        const ativa = categoria.slug === estado.categoria;
        return `
            <button class="filtro-btn${ativa ? ' active' : ''}" type="button"
                    data-categoria="${escapeHtml(categoria.slug)}" aria-pressed="${ativa}">
                ${escapeHtml(categoria.rotulo)}
            </button>`;
    }).join('');
}

// Números das páginas com reticências: primeira, última e a vizinhança da
// atual. Com 40 páginas, 40 botões não caberiam numa linha de celular.
function paginasVisiveis(atual, total) {
    const paginas = new Set([1, total, atual - 1, atual, atual + 1]);
    const ordenadas = [...paginas].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);

    const saida = [];
    ordenadas.forEach((numero, indice) => {
        if (indice > 0 && numero - ordenadas[indice - 1] > 1) saida.push(null);
        saida.push(numero);
    });
    return saida;
}

// Links de verdade, com href: abrir uma página em outra aba funciona, e o
// clique comum é interceptado para não recarregar a página inteira.
function renderPaginacao({ paginaAtual, totalPaginas }) {
    const caixa = document.getElementById('paginacaoCatalogo');

    if (totalPaginas <= 1) {
        caixa.innerHTML = '';
        return;
    }

    const link = (pagina, rotulo, extras = '') =>
        `<a href="${escapeHtml(enderecoDoEstado({ ...estado, pagina }))}" data-pagina="${pagina}"${extras}>${rotulo}</a>`;

    const anterior = paginaAtual > 1
        ? link(paginaAtual - 1, '‹ Anterior', ' class="pagina-passo" rel="prev"')
        : '<span class="pagina-passo desabilitado" aria-hidden="true">‹ Anterior</span>';

    const proxima = paginaAtual < totalPaginas
        ? link(paginaAtual + 1, 'Próxima ›', ' class="pagina-passo" rel="next"')
        : '<span class="pagina-passo desabilitado" aria-hidden="true">Próxima ›</span>';

    const numeros = paginasVisiveis(paginaAtual, totalPaginas).map((pagina) => {
        if (pagina === null) return '<span class="pagina-reticencias" aria-hidden="true">…</span>';
        if (pagina === paginaAtual) return `<span class="pagina-numero atual" aria-current="page">${pagina}</span>`;
        return link(pagina, String(pagina), ` class="pagina-numero" aria-label="Página ${pagina}"`);
    }).join('');

    caixa.innerHTML = `${anterior}<span class="paginas">${numeros}</span>${proxima}`;
}

function descreverResultado(total) {
    if (total === 0) return 'Nenhum produto encontrado';
    return total === 1 ? '1 produto encontrado' : `${total.toLocaleString('pt-BR')} produtos encontrados`;
}

function filtrosAtivos() {
    return montarQuery({ ...estado, pagina: 1 }) !== '';
}

// --------------------------------------------------------------------------
// Carga
// --------------------------------------------------------------------------

async function carregar() {
    const minhaRodada = ++rodada;
    const grid = document.getElementById('productGrid');
    grid.setAttribute('aria-busy', 'true');

    const query = montarQuery(estado);

    try {
        const dados = await buscarProdutos(query ? `/produtos?${query}` : '/produtos');
        if (minhaRodada !== rodada) return;

        categoriasCache = dados.categoriasDisponiveis || [];
        renderCategorias(categoriasCache);

        const { paginacao } = dados;

        // Página além do fim — um link antigo, ou um filtro que encolheu o
        // resultado: vai para a última que existe, sem criar entrada nova no
        // histórico.
        if (dados.produtos.length === 0 && paginacao.totalProdutos > 0 && estado.pagina > paginacao.totalPaginas) {
            estado = { ...estado, pagina: paginacao.totalPaginas };
            history.replaceState(null, '', enderecoDoEstado(estado));
            carregar();
            return;
        }

        document.getElementById('resumoCatalogo').textContent = descreverResultado(paginacao.totalProdutos);

        if (dados.produtos.length === 0) {
            grid.innerHTML = `
                <div class="vitrine-vazia">
                    <p>Nenhum produto com esses filtros.</p>
                    ${filtrosAtivos() ? '<button class="btn btn-primary" type="button" data-limpar>Limpar filtros</button>' : ''}
                </div>`;
        } else {
            grid.innerHTML = dados.produtos
                .map((produto) => renderCartaoProduto(produto, { adiarImagem: true }))
                .join('');
        }

        renderPaginacao(paginacao);
    } catch (erro) {
        if (minhaRodada !== rodada) return;
        console.error(erro);

        document.getElementById('resumoCatalogo').textContent = '';
        document.getElementById('paginacaoCatalogo').innerHTML = '';
        grid.innerHTML = `
            <div class="vitrine-vazia">
                <p>${escapeHtml(erro.message || 'Não foi possível carregar os produtos.')}</p>
                <button class="btn btn-primary" type="button" data-limpar>Limpar filtros</button>
            </div>`;
    } finally {
        if (minhaRodada === rodada) grid.setAttribute('aria-busy', 'false');
    }
}

// Aplica uma mudança de filtro: nova entrada no histórico e nova carga. Mudar
// qualquer filtro volta para a página 1 — a página 7 de outra busca não quer
// dizer nada nesta.
function aplicar(mudancas, { manterPagina = false } = {}) {
    const proximo = { ...estado, ...mudancas };
    if (!manterPagina) proximo.pagina = 1;

    const endereco = enderecoDoEstado(proximo);
    const atual = enderecoDoEstado(estado);
    estado = proximo;

    if (endereco !== atual) {
        history.pushState(null, '', endereco);
    }

    carregar();
}

function limparFiltros() {
    estado = { ...ESTADO_PADRAO };
    preencherControles();
    history.pushState(null, '', enderecoDoEstado(estado));
    carregar();
}

// --------------------------------------------------------------------------
// Eventos
// --------------------------------------------------------------------------

function comEspera(funcao) {
    let timer = null;
    const esperando = (...argumentos) => {
        clearTimeout(timer);
        timer = setTimeout(() => funcao(...argumentos), ESPERA_DIGITACAO_MS);
    };
    esperando.cancelar = () => clearTimeout(timer);
    return esperando;
}

document.addEventListener('DOMContentLoaded', () => {
    estado = lerEstadoDaUrl();
    preencherControles();
    carregar();

    const campoBusca = document.getElementById('campoBusca');
    const campoMin = document.getElementById('campoPrecoMin');
    const campoMax = document.getElementById('campoPrecoMax');

    // Espera a pessoa parar de digitar antes de ir à API: sem isso, "notebook"
    // seriam oito consultas e oito entradas no histórico.
    const buscarDepois = comEspera(() => aplicar({ busca: campoBusca.value }));
    campoBusca.addEventListener('input', buscarDepois);

    // O campo number devolve '' enquanto o valor digitado é inválido ("1,,2"),
    // então o filtro só muda quando há um número de verdade ou o campo vazio.
    const precoDepois = comEspera(() => aplicar({
        precoMin: precoDaUrl(campoMin.value),
        precoMax: precoDaUrl(campoMax.value)
    }));
    campoMin.addEventListener('input', precoDepois);
    campoMax.addEventListener('input', precoDepois);

    // Enter aplica na hora, sem esperar o debounce.
    document.getElementById('formCatalogo').addEventListener('submit', (evento) => {
        evento.preventDefault();
        buscarDepois.cancelar();
        precoDepois.cancelar();
        aplicar({
            busca: campoBusca.value,
            precoMin: precoDaUrl(campoMin.value),
            precoMax: precoDaUrl(campoMax.value)
        });
    });

    document.getElementById('campoOrdenar').addEventListener('change', (evento) => {
        aplicar({ ordenar: evento.target.value });
    });

    document.getElementById('filtrosCategoria').addEventListener('click', (evento) => {
        const botao = evento.target.closest('[data-categoria]');
        if (botao) aplicar({ categoria: botao.dataset.categoria });
    });

    document.getElementById('limparFiltros').addEventListener('click', limparFiltros);

    document.getElementById('productGrid').addEventListener('click', (evento) => {
        if (evento.target.closest('[data-limpar]')) limparFiltros();
    });

    document.getElementById('paginacaoCatalogo').addEventListener('click', (evento) => {
        const link = evento.target.closest('a[data-pagina]');
        // Ctrl/Cmd/Shift + clique abre em outra aba ou janela, como link comum.
        if (!link || evento.ctrlKey || evento.metaKey || evento.shiftKey || evento.button !== 0) return;

        evento.preventDefault();
        aplicar({ pagina: Number(link.dataset.pagina) }, { manterPagina: true });

        // Volta ao topo da lista e leva o foco junto, para o leitor de tela
        // não continuar lá embaixo, na paginação que acabou de ser trocada.
        const titulo = document.querySelector('.catalogo-titulo');
        titulo.setAttribute('tabindex', '-1');
        titulo.focus({ preventScroll: true });
        titulo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Voltar e Avançar do navegador: a URL já mudou; a página só se remonta.
    window.addEventListener('popstate', () => {
        buscarDepois.cancelar();
        precoDepois.cancelar();
        estado = lerEstadoDaUrl();
        preencherControles();
        carregar();
    });
});
