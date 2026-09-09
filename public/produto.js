// Página de produto.
//
// Reaproveita de script.js: apiUrl, lerResposta, escapeHtml, formatCurrency,
// addToCart, updateCartBadge e hasValidSession. Este arquivo carrega depois.

const parametros = new URLSearchParams(window.location.search);
const PRODUTO_ID = Number(parametros.get('id'));

let produtoAtual = null;

// --------------------------------------------------------------------------
// Estrelas
// --------------------------------------------------------------------------

// SVG inline em vez de caractere: o glifo ★ muda de desenho conforme a fonte
// do sistema, e meia estrela não existe em texto.
function estrelas(nota, rotulo) {
    const cheias = Math.round(Number(nota) || 0);
    const partes = [];

    for (let i = 1; i <= 5; i += 1) {
        partes.push(
            `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="${i <= cheias ? 'cheia' : 'vazia'}"`
            + ' d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>'
        );
    }

    const acessivel = rotulo || `Nota ${Number(nota).toFixed(1)} de 5`;
    return `<span class="estrelas" role="img" aria-label="${escapeHtml(acessivel)}">${partes.join('')}</span>`;
}

function formatarData(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// --------------------------------------------------------------------------
// Renderização
// --------------------------------------------------------------------------

function renderTrilha(produto) {
    document.getElementById('trilha').innerHTML = `
        <a href="E-Commerce.html">Início</a>
        <span aria-hidden="true">›</span>
        <a href="E-Commerce.html#promocoes">${escapeHtml(produto.categoriaRotulo)}</a>
        <span aria-hidden="true">›</span>
        <span class="atual">${escapeHtml(produto.nome)}</span>`;
}

function renderGaleria(produto) {
    if (produto.galeria.length === 0) {
        return '<div class="galeria"><div class="galeria-principal"><span class="muted">Sem foto</span></div></div>';
    }

    const miniaturas = produto.galeria.length > 1
        ? `<div class="galeria-miniaturas" role="group" aria-label="Outras fotos do produto">
            ${produto.galeria.map((img, i) => `
                <button type="button" class="${i === 0 ? 'ativa' : ''}" data-foto="${i}"
                        aria-label="Ver foto ${i + 1} de ${produto.galeria.length}">
                    <img src="${escapeHtml(img.url)}" alt="">
                </button>`).join('')}
           </div>`
        : '';

    return `
        <div class="galeria">
            <div class="galeria-principal">
                <img id="fotoPrincipal" src="${escapeHtml(produto.galeria[0].url)}"
                     alt="${escapeHtml(produto.galeria[0].descricao || produto.nome)}">
            </div>
            ${miniaturas}
        </div>`;
}

function renderCaixaCompra(produto, resumo, checkoutHabilitado) {
    const temDesconto = produto.descontoPercentual && produto.precoOriginal;
    const parcela = produto.preco / 12;

    let estoque = '<span class="estoque estoque-fora">Indisponível no momento</span>';
    if (produto.disponivel) {
        estoque = produto.estoqueBaixo
            ? '<span class="estoque estoque-baixo">Últimas unidades</span>'
            : '<span class="estoque estoque-ok">Em estoque</span>';
    }

    const botao = !produto.disponivel
        ? '<button class="btn btn-comprar btn-bloco" type="button" disabled>Indisponível</button>'
        : `<button class="btn btn-comprar btn-bloco" type="button" id="btnAdicionar" data-id="${produto.id}">
               Adicionar ao carrinho
           </button>
           <a class="btn btn-secondary btn-bloco" href="cart.html">Ir para o carrinho</a>`;

    return `
        <aside class="caixa-compra">
            ${temDesconto ? `<div class="preco-antigo">De ${formatCurrency(produto.precoOriginal)}</div>` : ''}
            <span class="preco-atual">${formatCurrency(produto.preco)}${
                temDesconto ? `<span class="selo-desconto">-${produto.descontoPercentual}%</span>` : ''
            }</span>
            <p class="parcelamento">ou 12x de ${formatCurrency(parcela)} sem juros</p>
            ${estoque}
            ${botao}
            <p class="selo-seguranca">
                🔒 Compra segura · 🚚 Frete grátis acima de R$ 199<br>
                ${checkoutHabilitado ? '' : 'Vitrine de demonstração: a compra não é finalizada.'}
            </p>
        </aside>`;
}

function renderDetalhe(dados) {
    const { produto, avaliacoes, checkoutHabilitado } = dados;

    const especificacoes = produto.especificacoes.length > 0
        ? `<div class="bloco-detalhe">
             <h2>Especificações técnicas</h2>
             <dl class="especificacoes">
               ${produto.especificacoes.map((e) => `
                 <div><dt>${escapeHtml(e.rotulo)}</dt><dd>${escapeHtml(e.valor)}</dd></div>`).join('')}
             </dl>
           </div>`
        : '';

    const tags = produto.tags.length > 0
        ? `<div class="bloco-detalhe">
             <h2>Marcadores</h2>
             <div class="lista-tags">${produto.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>
           </div>`
        : '';

    const nota = avaliacoes.resumo.total > 0
        ? `<div class="nota-linha">
             ${estrelas(avaliacoes.resumo.media)}
             <span class="valor">${avaliacoes.resumo.media.toFixed(1)}</span>
             <a href="#secaoAvaliacoes">(${avaliacoes.resumo.total} ${avaliacoes.resumo.total === 1 ? 'avaliação' : 'avaliações'})</a>
           </div>`
        : '<div class="nota-linha vazia">Ainda sem avaliações</div>';

    document.getElementById('detalhe').innerHTML = `
        <div class="produto-detalhe">
            ${renderGaleria(produto)}
            <div>
                <div class="detalhe-topo">
                    <span class="detalhe-marca">${escapeHtml(produto.categoriaRotulo)}</span>
                    <h1>${escapeHtml(produto.nome)}</h1>
                    ${nota}
                </div>
                ${produto.descricao ? `<div class="bloco-detalhe"><h2>Sobre o produto</h2><p>${escapeHtml(produto.descricao)}</p></div>` : ''}
                ${especificacoes}
                ${tags}
            </div>
            ${renderCaixaCompra(produto, avaliacoes.resumo, checkoutHabilitado)}
        </div>`;

    document.getElementById('detalhe').classList.remove('hidden');
}

function renderAvaliacoes(dados) {
    const { resumo, itens } = dados.avaliacoes;
    const secao = document.getElementById('secaoAvaliacoes');
    const conteudo = document.getElementById('conteudoAvaliacoes');

    document.getElementById('apoioAvaliacoes').textContent =
        resumo.total === 0 ? 'Nenhuma ainda' : `${resumo.total} no total`;

    // Sem compra possível, ninguém consegue avaliar — vale explicar em vez de
    // deixar a seção vazia sem motivo aparente.
    const avisoDemo = dados.checkoutHabilitado === false
        ? '<p class="aviso-demo-avaliacoes">Esta é uma vitrine de demonstração: como a compra não é '
          + 'finalizada, novas avaliações não podem ser enviadas. As exibidas são de exemplo.</p>'
        : '';

    if (resumo.total === 0) {
        conteudo.innerHTML = `${avisoDemo}<div class="estado-vazio">Este produto ainda não recebeu avaliações.</div>`;
        secao.classList.remove('hidden');
        return;
    }

    const maior = Math.max(...Object.values(resumo.distribuicao), 1);

    const barras = [5, 4, 3, 2, 1].map((n) => {
        const qtd = resumo.distribuicao[n] || 0;
        return `<div class="barra-nota">
                  <span>${n} ★</span>
                  <span class="trilho"><span class="preenchido" style="width:${(qtd / maior) * 100}%"></span></span>
                  <span class="contagem">${qtd}</span>
                </div>`;
    }).join('');

    conteudo.innerHTML = `
        ${avisoDemo}
        <div class="resumo-notas">
            <div class="media">
                <strong>${resumo.media.toFixed(1)}</strong>
                ${estrelas(resumo.media)}
                <span>${resumo.total} ${resumo.total === 1 ? 'avaliação' : 'avaliações'}</span>
            </div>
            <div class="barras-nota">${barras}</div>
        </div>
        <div class="card">
            ${itens.map((a) => `
                <article class="avaliacao">
                    <div class="avaliacao-cabecalho">
                        ${estrelas(a.nota, `${a.nota} de 5`)}
                        <span class="autor">${escapeHtml(a.autor)}</span>
                        <span class="selo-verificada">Compra verificada</span>
                        <span class="data">${formatarData(a.criadoEm)}${a.editada ? ' · editada' : ''}</span>
                    </div>
                    ${a.titulo ? `<h3>${escapeHtml(a.titulo)}</h3>` : ''}
                    ${a.comentario ? `<p>${escapeHtml(a.comentario)}</p>` : ''}
                </article>`).join('')}
        </div>`;

    secao.classList.remove('hidden');
}

// --------------------------------------------------------------------------
// Interações
// --------------------------------------------------------------------------

function ligarGaleria() {
    const principal = document.getElementById('fotoPrincipal');
    if (!principal || !produtoAtual) return;

    document.querySelectorAll('[data-foto]').forEach((botao) => {
        botao.addEventListener('click', () => {
            const indice = Number(botao.dataset.foto);
            const foto = produtoAtual.galeria[indice];
            if (!foto) return;

            principal.src = foto.url;
            principal.alt = foto.descricao || produtoAtual.nome;

            document.querySelectorAll('[data-foto]').forEach((outro) => outro.classList.remove('ativa'));
            botao.classList.add('ativa');
        });
    });
}

function ligarBotaoAdicionar() {
    const botao = document.getElementById('btnAdicionar');
    if (!botao) return;

    botao.addEventListener('click', () => {
        addToCart(botao.dataset.id);

        const rotulo = botao.textContent;
        botao.textContent = 'Adicionado ao carrinho';
        botao.disabled = true;

        setTimeout(() => {
            botao.textContent = rotulo;
            botao.disabled = false;
        }, 1200);
    });
}

// --------------------------------------------------------------------------
// Início
// --------------------------------------------------------------------------

async function carregarProduto() {
    const carregando = document.getElementById('carregando');

    if (!Number.isInteger(PRODUTO_ID) || PRODUTO_ID <= 0) {
        carregando.classList.add('hidden');
        document.getElementById('naoEncontrado').classList.remove('hidden');
        return;
    }

    try {
        const resposta = await fetch(apiUrl(`/produtos/${PRODUTO_ID}`));
        const dados = await lerResposta(resposta);

        if (!resposta.ok) {
            throw new Error(dados.mensagem || 'Produto não encontrado.');
        }

        produtoAtual = dados.produto;
        document.title = `${dados.produto.nome} | Petabyte`;

        renderTrilha(dados.produto);
        renderDetalhe(dados);
        renderAvaliacoes(dados);

        ligarGaleria();
        ligarBotaoAdicionar();

        carregando.classList.add('hidden');
    } catch (erro) {
        console.error(erro);
        carregando.classList.add('hidden');
        document.getElementById('naoEncontrado').classList.remove('hidden');
    }
}

document.addEventListener('DOMContentLoaded', carregarProduto);
