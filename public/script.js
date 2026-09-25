// Base da API, sessão e chamadas autenticadas (apiUrl, lerResposta,
// getLoggedUser, hasValidSession, chamarApi, requisitar, logoutUser) vêm de
// sessao.js, que carrega antes deste arquivo.

const STORAGE_KEY = 'petabyte-cart';

function requireAuthenticatedCheckout() {
    if (hasValidSession()) {
        return true;
    }

    alert('Faça login para finalizar a compra.');
    window.location.href = 'auth.html';
    return false;
}

function formatCurrency(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const QUANTIDADE_MAXIMA_POR_ITEM = 10;

function escapeHtml(valor) {
    return String(valor === null || valor === undefined ? '' : valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let categoriasCache = [];
let configCache = null;

// Estado da instalação: hoje só diz se o checkout está ligado. Serve para a
// interface se adaptar — a recusa de verdade acontece no servidor.
async function carregarConfig() {
    if (configCache) {
        return configCache;
    }

    try {
        const response = await fetch(apiUrl('/config'));
        configCache = await lerResposta(response);
    } catch (error) {
        console.error('Não foi possível ler a configuração:', error);
        // Na dúvida, assume habilitado: o servidor recusa se não estiver.
        configCache = { checkoutHabilitado: true };
    }

    return configCache;
}

// GET de uma rota pública de produtos, que devolve JSON ou uma mensagem de erro.
async function buscarProdutos(caminho) {
    const response = await fetch(apiUrl(caminho));
    const data = await lerResposta(response);

    if (!response.ok) {
        throw new Error(data.mensagem || 'Não foi possível carregar os produtos.');
    }

    return data;
}

// Os produtos do carrinho, pedidos pelo id. O catálogo agora é paginado, e um
// item fora da primeira página sumiria do carrinho se ele fosse montado a
// partir da listagem comum.
async function carregarProdutosDoCarrinho(ids) {
    const data = await buscarProdutos(`/produtos?ids=${ids.join(',')}`);
    return Array.isArray(data.produtos) ? data.produtos : [];
}

// O carrinho guarda apenas { id, quantidade }. Preço e nome nunca são
// persistidos no navegador: quem decide isso é o servidor, no checkout.
function getCart() {
    try {
        const bruto = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];

        if (!Array.isArray(bruto)) {
            return [];
        }

        // Carrinhos do formato antigo guardavam { name, price, quantity } e não
        // têm id. Não há como convertê-los com segurança, então são descartados.
        const validos = bruto.filter((item) => item && Number.isInteger(Number(item.id)) && Number(item.id) > 0);

        if (validos.length !== bruto.length) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(validos));
        }

        return validos.map((item) => ({
            id: Number(item.id),
            quantidade: Math.min(QUANTIDADE_MAXIMA_POR_ITEM, Math.max(1, Number(item.quantidade) || 1))
        }));
    } catch (error) {
        console.error('Erro ao ler carrinho:', error);
        localStorage.removeItem(STORAGE_KEY);
        return [];
    }
}

function saveCart(cart) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
}

function updateCartBadge() {
    const badge = document.getElementById('cartCount');
    if (!badge) return;

    const cart = getCart();
    const totalItems = cart.reduce((sum, item) => sum + item.quantidade, 0);
    badge.textContent = totalItems;
}

function addToCart(produtoId) {
    const id = Number(produtoId);
    if (!Number.isInteger(id) || id <= 0) return;

    const cart = getCart();
    const existente = cart.find((item) => item.id === id);

    if (existente) {
        if (existente.quantidade >= QUANTIDADE_MAXIMA_POR_ITEM) {
            alert(`Máximo de ${QUANTIDADE_MAXIMA_POR_ITEM} unidades por produto.`);
            return;
        }
        existente.quantidade += 1;
    } else {
        cart.push({ id, quantidade: 1 });
    }

    saveCart(cart);
    updateCartBadge();
}

function removeFromCart(produtoId) {
    const id = Number(produtoId);
    const cart = getCart().filter((item) => item.id !== id);
    saveCart(cart);
    updateCartBadge();
    return cart;
}

function updateQuantity(produtoId, delta) {
    const id = Number(produtoId);
    const cart = getCart();
    const item = cart.find((entry) => entry.id === id);

    if (!item) return cart;

    item.quantidade = Math.min(QUANTIDADE_MAXIMA_POR_ITEM, Math.max(1, item.quantidade + delta));
    saveCart(cart);
    updateCartBadge();
    return cart;
}

// Espelha calcularFrete() do servidor: frete fixo, sem faixa de frete grátis.
// Serve só para exibição; o valor que vale é o recalculado no backend.
function getShipping() {
    return 19.9;
}

function createCartSummary(itensDetalhados) {
    const subtotal = itensDetalhados.reduce((sum, item) => sum + item.produto.preco * item.quantidade, 0);
    const shipping = getShipping();
    return {
        subtotal,
        shipping,
        total: subtotal + shipping
    };
}

// --------------------------------------------------------------------------
// Avisos da tela de login
// --------------------------------------------------------------------------

// Guarda o e-mail e a senha do último login recusado por falta de
// confirmação: o reenvio do link exige os dois, para só quem criou a conta
// poder pedir. Fica só na memória da página, nunca em storage.
let credencialParaReenvio = null;

function avisarAuth(texto, tipo = 'ok', reenvio = null) {
    const caixa = document.getElementById('avisoAuth');
    if (!caixa) return;

    credencialParaReenvio = reenvio;
    document.getElementById('avisoAuthTexto').textContent = texto;
    document.getElementById('reenviarVerificacaoBtn').classList.toggle('hidden', !reenvio);
    caixa.className = `aviso-conta ${tipo === 'erro' ? 'aviso-conta-erro' : 'aviso-conta-ok'}`;
}

async function reenviarVerificacao() {
    if (!credencialParaReenvio) return;

    const botao = document.getElementById('reenviarVerificacaoBtn');
    botao.disabled = true;

    try {
        const resposta = await requisitar('/auth/reenviar-verificacao', {
            method: 'POST',
            body: JSON.stringify(credencialParaReenvio)
        });
        const dados = await lerResposta(resposta);
        avisarAuth(dados.mensagem || 'Não foi possível reenviar agora.', resposta.ok ? 'ok' : 'erro');
    } catch (error) {
        console.error(error);
        avisarAuth('Não foi possível conectar ao servidor.', 'erro');
    } finally {
        botao.disabled = false;
    }
}

// --------------------------------------------------------------------------
// Login com Google
// --------------------------------------------------------------------------
//
// O botão é o da própria Google (Google Identity Services), que devolve uma
// credencial assinada direto no navegador. Ela vai para POST /auth/google, que
// a confere na Google antes de abrir a sessão — a mesma sessão em cookies do
// login com senha.

const URL_SCRIPT_GOOGLE = 'https://accounts.google.com/gsi/client';

function avisarLoginGoogle(texto) {
    const caixa = document.getElementById('avisoGoogle');
    if (!caixa) return;
    caixa.textContent = texto;
    caixa.classList.remove('hidden');
}

function carregarScriptGoogle() {
    return new Promise((resolve, reject) => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = URL_SCRIPT_GOOGLE;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Não foi possível carregar o login do Google.'));
        document.head.appendChild(script);
    });
}

async function entrarComGoogle(respostaGoogle) {
    try {
        // requisitar, não chamarApi: um 401 aqui é credencial recusada, não
        // sessão vencida para renovar.
        const resposta = await requisitar('/auth/google', {
            method: 'POST',
            body: JSON.stringify({ credential: respostaGoogle.credential })
        });
        const dados = await lerResposta(resposta);

        if (!resposta.ok) {
            avisarLoginGoogle(dados.mensagem || 'Não foi possível entrar com o Google.');
            return;
        }

        salvarUsuarioLocal(dados.usuario);
        window.location.href = 'E-Commerce.html';
    } catch (error) {
        console.error(error);
        avisarLoginGoogle('Não foi possível conectar ao servidor.');
    }
}

// Sem Client ID configurado no servidor, o bloco continua escondido: melhor
// não mostrar o botão do que mostrar um botão que não funciona.
async function iniciarLoginGoogle() {
    const bloco = document.getElementById('blocoGoogle');
    const alvo = document.getElementById('botaoGoogle');
    const config = await carregarConfig();

    if (!config.googleClientId) return;

    try {
        await carregarScriptGoogle();

        window.google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: entrarComGoogle
        });

        bloco.classList.remove('hidden');

        window.google.accounts.id.renderButton(alvo, {
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            shape: 'pill',
            locale: 'pt-BR',
            width: Math.min(alvo.offsetWidth || 320, 400)
        });
    } catch (error) {
        // Bloqueio de CSP, extensão ou rede: o formulário de senha segue funcionando.
        console.warn('Login com Google indisponível:', error);
        bloco.classList.add('hidden');
    }
}

// --------------------------------------------------------------------------
// Cupom no carrinho
// --------------------------------------------------------------------------
//
// Só o código fica guardado, na sessão da aba. O desconto exibido é sempre o
// que o servidor devolveu na última validação, e o checkout recalcula tudo de
// novo: o carrinho nunca manda valor de desconto, só o código.

const CUPOM_KEY = 'petabyte-cupom';

// Cada redesenho do carrinho revalida o cupom. Com cliques rápidos em +/−, uma
// resposta antiga pode chegar depois da nova; só a rodada mais recente escreve.
let rodadaCupom = 0;

function lerCupomSalvo() {
    try { return sessionStorage.getItem(CUPOM_KEY) || ''; } catch (error) { return ''; }
}

function guardarCupom(codigo) {
    try { sessionStorage.setItem(CUPOM_KEY, codigo); } catch (error) { /* sem storage, vale só nesta tela */ }
}

function esquecerCupom() {
    try { sessionStorage.removeItem(CUPOM_KEY); } catch (error) { /* nada a limpar */ }
}

// Aviso na própria página, nunca alert(): é a pendência que este projeto não
// quer aumentar.
function avisarCupom(texto, tipo = 'ok') {
    const caixa = document.getElementById('avisoCupom');
    if (!caixa) return;

    if (!texto) {
        caixa.classList.add('hidden');
        return;
    }

    caixa.textContent = texto;
    caixa.className = `aviso-conta ${tipo === 'erro' ? 'aviso-conta-erro' : 'aviso-conta-ok'}`;
}

// Valida o cupom guardado contra o carrinho de agora. Devolve a conta feita
// pelo servidor, ou null se não há cupom aplicável.
async function validarCupomDoCarrinho(itens) {
    const codigo = lerCupomSalvo();
    if (!codigo) return null;

    if (!hasValidSession()) {
        esquecerCupom();
        avisarCupom('Entre na sua conta para usar um cupom.', 'erro');
        return null;
    }

    try {
        const resultado = await chamarApi('/cupons/validar', {
            method: 'POST',
            redirecionarSeDeslogado: false,
            body: JSON.stringify({
                codigo,
                itens: itens.map((item) => ({ id: item.id, quantidade: item.quantidade }))
            })
        });

        if (!resultado.valido) {
            // O código continua no campo: se a recusa foi o pedido mínimo, a
            // pessoa aumenta o carrinho e aplica de novo com um clique.
            esquecerCupom();
            avisarCupom(resultado.motivo, 'erro');
            return null;
        }

        return resultado;
    } catch (error) {
        esquecerCupom();
        avisarCupom(error.message || 'Não foi possível validar o cupom.', 'erro');
        return null;
    }
}

function ligarFormularioCupom() {
    const formulario = document.getElementById('formCupom');
    if (!formulario) return;

    const campo = document.getElementById('campoCupom');
    const botao = document.getElementById('aplicarCupomBtn');

    // Um código aplicado antes (nesta aba) volta para o campo.
    campo.value = lerCupomSalvo();

    formulario.addEventListener('submit', async (evento) => {
        evento.preventDefault();
        const codigo = campo.value.trim().toUpperCase();

        if (!codigo) {
            avisarCupom('Digite o código do cupom.', 'erro');
            return;
        }

        if (!hasValidSession()) {
            avisarCupom('Entre na sua conta para usar um cupom.', 'erro');
            return;
        }

        campo.value = codigo;
        guardarCupom(codigo);
        avisarCupom('');
        botao.disabled = true;

        try {
            await renderCartPage();
        } finally {
            botao.disabled = false;
        }

        // Recusado, validarCupomDoCarrinho já esqueceu o código e deu o motivo.
        if (lerCupomSalvo()) {
            avisarCupom(`Cupom ${codigo} aplicado.`);
        }
    });

    document.getElementById('removerCupomBtn').addEventListener('click', () => {
        esquecerCupom();
        campo.value = '';
        avisarCupom('');
        renderCartPage();
    });
}

// Junta o carrinho (ids) com o catálogo vindo da API, descartando produtos
// que saíram do ar desde a última visita.
async function detalharCarrinho() {
    const cart = getCart();

    if (cart.length === 0) {
        return [];
    }

    const produtos = await carregarProdutosDoCarrinho(cart.map((item) => item.id));
    const produtosPorId = new Map(produtos.map((produto) => [produto.id, produto]));

    const detalhados = cart
        .map((item) => ({ ...item, produto: produtosPorId.get(item.id) }))
        .filter((item) => Boolean(item.produto));

    if (detalhados.length !== cart.length) {
        saveCart(detalhados.map((item) => ({ id: item.id, quantidade: item.quantidade })));
        updateCartBadge();
    }

    return detalhados;
}

async function iniciarPagamento() {
    const config = await carregarConfig();

    if (config.checkoutHabilitado === false) {
        aplicarModoDemonstracao(config);
        return;
    }

    if (!requireAuthenticatedCheckout()) {
        return;
    }

    const cart = getCart();
    if (cart.length === 0) {
        alert('Seu carrinho está vazio.');
        return;
    }

    try {
        const data = await chamarApi('/pagamentos/criar', {
            method: 'POST',
            // Só id e quantidade, e o código do cupom. O servidor resolve nome,
            // preço e desconto no banco.
            body: JSON.stringify({
                itens: cart.map((item) => ({ id: item.id, quantidade: item.quantidade })),
                cupom: lerCupomSalvo() || undefined
            })
        });

        const urlCheckout = data.checkoutUrl || data.checkoutSandboxUrl;
        if (!urlCheckout) {
            throw new Error('Checkout indisponível no momento.');
        }

        window.location.href = urlCheckout;
    } catch (error) {
        console.error(error);
        alert(error.message || 'Não foi possível iniciar o pagamento.');
    }
}

async function tratarRetornoPagamento() {
    const query = new URLSearchParams(window.location.search);
    const paymentId = query.get('payment_id');
    const status = query.get('status');
    const resultado = query.get('pagamento');

    if (!paymentId && !status && !resultado) {
        return;
    }

    if (!hasValidSession()) {
        return;
    }

    if (paymentId) {
        try {
            // Na volta do Mercado Pago o access token pode ter vencido durante o
            // pagamento; chamarApi renova a sessão sozinha antes de confirmar.
            const data = await chamarApi('/pagamentos/confirmar', {
                method: 'POST',
                body: JSON.stringify({ paymentId })
            });

            if (data.status === 'approved') {
                localStorage.removeItem(STORAGE_KEY);
                esquecerCupom();
                updateCartBadge();
                renderCartPage();
                alert('Pagamento aprovado! Pedido confirmado com sucesso.');
            } else {
                alert(`Pagamento recebido com status: ${data.statusPedido}.`);
            }
        } catch (error) {
            console.error(error);
            alert(error.message || 'Falha ao confirmar pagamento.');
        }
    } else if (resultado === 'falha') {
        alert('Pagamento não concluído. Você pode tentar novamente.');
    } else if (resultado === 'pendente') {
        alert('Pagamento pendente. Vamos atualizar seu pedido após a confirmação do gateway.');
    }

    query.delete('payment_id');
    query.delete('status');
    query.delete('pagamento');
    query.delete('collection_id');
    query.delete('collection_status');
    query.delete('merchant_order_id');
    query.delete('preference_id');
    query.delete('site_id');
    query.delete('processing_mode');
    query.delete('merchant_account_id');
    const novaUrl = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ''}`;
    window.history.replaceState({}, document.title, novaUrl);
}

// Mostra o aviso na própria página e desabilita o botão. Nada de alert(), que
// o navegador pode suprimir — o mesmo problema que já quebrou o painel.
function aplicarModoDemonstracao(config) {
    const aviso = document.getElementById('avisoDemonstracao');
    const botao = document.querySelector('.checkout-btn');

    if (aviso) {
        aviso.textContent = config.mensagemCheckoutDesativado
            || 'A finalização de compra está desativada nesta instalação de demonstração.';
        aviso.classList.remove('hidden');
    }

    if (botao) {
        botao.disabled = true;
        botao.textContent = 'Compra desativada (demonstração)';
    }
}

async function renderCartPage() {
    const config = await carregarConfig();

    if (config.checkoutHabilitado === false) {
        aplicarModoDemonstracao(config);
    }

    const cartItems = document.getElementById('cartItems');
    const cartTotal = document.getElementById('cartTotal');
    const shippingValue = document.getElementById('shippingValue');
    const finalTotal = document.getElementById('finalTotal');

    if (!cartItems || !cartTotal || !shippingValue || !finalTotal) return;

    const linhaDesconto = document.getElementById('linhaDesconto');
    const removerCupomBtn = document.getElementById('removerCupomBtn');

    const mostrarDesconto = (cupom) => {
        if (!linhaDesconto) return;
        linhaDesconto.classList.toggle('hidden', !cupom);
        if (removerCupomBtn) removerCupomBtn.classList.toggle('hidden', !cupom);
        if (!cupom) return;

        document.getElementById('codigoCupomAplicado').textContent = `(${cupom.codigo})`;
        document.getElementById('valorDesconto').textContent = `− ${formatCurrency(cupom.desconto)}`;
    };

    const zerarResumo = () => {
        cartTotal.textContent = formatCurrency(0);
        shippingValue.textContent = formatCurrency(0);
        finalTotal.textContent = formatCurrency(0);
        mostrarDesconto(null);
    };

    let itens;

    try {
        itens = await detalharCarrinho();
    } catch (error) {
        console.error(error);
        cartItems.innerHTML = '<p>Não foi possível carregar seu carrinho. Verifique sua conexão e recarregue a página.</p>';
        zerarResumo();
        return;
    }

    if (itens.length === 0) {
        cartItems.innerHTML = '<p>Seu carrinho está vazio.</p>';
        zerarResumo();
        return;
    }

    const resumo = createCartSummary(itens);

    cartItems.innerHTML = itens.map((item) => `
        <div class="item-carrinho">
            <div>
                <div class="nome">${escapeHtml(item.produto.nome)}</div>
                <div class="unitario">${formatCurrency(item.produto.preco)} cada</div>
            </div>
            <div class="acoes-item">
                <div class="contador">
                    <button type="button" class="quantity-btn" data-id="${item.id}" data-delta="-1" aria-label="Diminuir quantidade">−</button>
                    <span class="qtd">${item.quantidade}</span>
                    <button type="button" class="quantity-btn" data-id="${item.id}" data-delta="1" aria-label="Aumentar quantidade">+</button>
                </div>
                <span class="item-total">${formatCurrency(item.produto.preco * item.quantidade)}</span>
                <button type="button" class="btn-remover remove-item" data-id="${item.id}">Remover</button>
            </div>
        </div>
    `).join('');

    const minhaRodada = ++rodadaCupom;
    const cupom = await validarCupomDoCarrinho(itens);

    // Um clique mais novo já redesenhou o carrinho; esta resposta está velha.
    if (minhaRodada !== rodadaCupom) return;

    // Com cupom, os três valores vêm do servidor, que é quem vai cobrar. Sem
    // cupom, a conta local espelha a do servidor só para exibição.
    cartTotal.textContent = formatCurrency(cupom ? cupom.subtotal : resumo.subtotal);
    shippingValue.textContent = formatCurrency(cupom ? cupom.frete : resumo.shipping);
    finalTotal.textContent = formatCurrency(cupom ? cupom.total : resumo.total);
    mostrarDesconto(cupom);
}

// Estrelas do cartão da vitrine. SVG em vez do caractere ★, que muda de
// desenho conforme a fonte instalada. A página de produto tem sua própria
// versão, com rótulo acessível mais detalhado.
function estrelasSimples(nota) {
    const cheias = Math.round(Number(nota) || 0);
    let saida = `<span class="estrelas" role="img" aria-label="Nota ${Number(nota).toFixed(1)} de 5">`;

    for (let i = 1; i <= 5; i += 1) {
        saida += `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="${i <= cheias ? 'cheia' : 'vazia'}"`
            + ' d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';
    }

    return `${saida}</span>`;
}

// Percentual anunciado no selo. Arredonda para BAIXO: um desconto real de
// 14,6% vira "-14%", nunca "-15%" — anunciar mais do que o real é propaganda
// enganosa, então a conta erra sempre a favor de subestimar.
//
// Em centavos inteiros de propósito: em ponto flutuante, (1 - 80 / 100) * 100
// dá 19.999999999999996, e o floor transformaria 20% reais em "-19%".
function calcularDescontoPercentual(preco, precoOriginal) {
    const atual = Math.round(Number(preco) * 100);
    const original = Math.round(Number(precoOriginal) * 100);

    if (!(original > atual) || atual <= 0) return null;

    return Math.floor(((original - atual) * 100) / original);
}

// Preço riscado e selo de desconto, compartilhados pelo card da vitrine e pela
// página de produto. A regra mora só aqui para os lugares não divergirem.
// Devolve os dois pedaços separados porque cada layout os posiciona de um jeito.
//
// O rótulo para leitor de tela vai como texto oculto, não como aria-label: a
// especificação ARIA proíbe nome acessível em <del> e em <span>, e os leitores
// de tela ignoram o atributo nesses elementos.
function renderDesconto(produto) {
    const original = Number(produto.precoOriginal);

    // Sem original, ou com original que não supera o preço (inclusive o campo
    // zerado quando a promoção acaba), mostra só o preço normal.
    if (!produto.precoOriginal || !(original > Number(produto.preco))) {
        return { precoAntigo: '', selo: '' };
    }

    const percentual = calcularDescontoPercentual(produto.preco, original);

    return {
        precoAntigo: `<del class="preco-antigo"><span class="so-leitor">Preço original: </span>${formatCurrency(original)}</del>`,
        // Abaixo de 1% o floor dá zero, e "-0%" não é selo que se mostre.
        // O "-21%" visual fica escondido do leitor de tela: colado no preço,
        // seria lido como subtração ("1.499,00 menos 21 por cento").
        selo: percentual >= 1
            ? `<span class="selo-desconto"><span aria-hidden="true">-${percentual}%</span><span class="so-leitor"> ${percentual}% de desconto</span></span>`
            : ''
    };
}

// O banco guarda o slug ("perifericos"); quem aparece na tela é o rótulo
// ("Periféricos"), que vem junto da API.
function rotuloCategoria(slug) {
    const encontrada = categoriasCache.find((categoria) => categoria.slug === slug);
    return encontrada ? encontrada.rotulo : slug;
}

// O cartão de produto da home e do catálogo. Um lugar só, para as duas
// vitrines não divergirem no preço, no selo ou no botão de compra.
//
// Sem loading="lazy" por padrão: na home, os destaques são a primeira coisa
// que o visitante vê, e adiar essas imagens só atrasaria o que importa. O
// catálogo, que tem página de 20 e rola, pede o lazy.
function renderCartaoProduto(produto, { adiarImagem = false } = {}) {
    const foto = produto.imagemUrl
        ? `<img src="${escapeHtml(produto.imagemUrl)}" alt="${escapeHtml(produto.nome)}"${adiarImagem ? ' loading="lazy"' : ''}>`
        : '<span class="sem-foto">Sem foto</span>';

    let estoque = '<span class="estoque estoque-fora">Indisponível</span>';
    if (produto.disponivel) {
        estoque = produto.estoqueBaixo
            ? '<span class="estoque estoque-baixo">Últimas unidades</span>'
            : '<span class="estoque estoque-ok">Em estoque</span>';
    }

    const nota = produto.totalAvaliacoes > 0
        ? `<div class="nota-linha">${estrelasSimples(produto.notaMedia)}
             <span class="valor">${produto.notaMedia.toFixed(1)}</span>
             <span>(${produto.totalAvaliacoes})</span></div>`
        : '<div class="nota-linha vazia">Sem avaliações</div>';

    const desconto = renderDesconto(produto);

    const enderecoProduto = `produto.html?id=${produto.id}`;

    return `
        <article class="produto" data-category="${escapeHtml(produto.categoria)}">
            <a class="produto-foto" href="${enderecoProduto}" aria-label="Ver ${escapeHtml(produto.nome)}">
                <span class="produto-chip">${escapeHtml(rotuloCategoria(produto.categoria))}</span>
                ${foto}
            </a>
            <div class="produto-corpo">
                <h3 class="produto-nome">
                    <a href="${enderecoProduto}">${escapeHtml(produto.nome)}</a>
                </h3>
                <p class="produto-desc">${escapeHtml(produto.descricao)}</p>
                ${nota}
                ${estoque}
                <div class="produto-preco">
                    ${desconto.precoAntigo}
                    <span class="valor">${formatCurrency(produto.preco)}${desconto.selo}</span>
                    <span class="parcelas">ou 12x de ${formatCurrency(produto.preco / 12)} sem juros</span>
                </div>
                <button class="btn btn-comprar add-to-cart" type="button" data-id="${produto.id}"${produto.disponivel ? '' : ' disabled'}>
                    ${produto.disponivel ? 'Adicionar ao carrinho' : 'Indisponível'}
                </button>
            </div>
        </article>`;
}

// A home mostra só os destaques, curados no painel. A navegação completa, com
// busca e filtros, fica em catalogo.html.
async function renderProductGrid() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    try {
        const data = await buscarProdutos('/produtos/destaques');
        const produtos = Array.isArray(data.produtos) ? data.produtos : [];
        categoriasCache = Array.isArray(data.categorias) ? data.categorias : [];

        // Sem destaque marcado a home não fica em branco: aponta o catálogo.
        if (produtos.length === 0) {
            grid.innerHTML = `
                <div class="vitrine-vazia">
                    <p>Nenhum destaque no momento.</p>
                    <a class="btn btn-primary" href="catalogo.html">Ver o catálogo completo</a>
                </div>`;
            return;
        }

        grid.innerHTML = produtos.map((produto) => renderCartaoProduto(produto)).join('');
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<p class="muted">Não foi possível carregar os produtos. Verifique sua conexão e recarregue a página.</p>';
    }
}

// --------------------------------------------------------------------------
// Menu da conta no cabeçalho
//
// Renderizado por JavaScript porque o conteúdo depende da sessão, e o
// cabeçalho se repete em quatro páginas. Cada uma só declara o ponto de
// inserção <div id="menuConta">.
// --------------------------------------------------------------------------

function iniciaisDoNome(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);

    if (partes.length === 0) return '?';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();

    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function primeiroNome(nome) {
    return String(nome || '').trim().split(/\s+/)[0] || 'Conta';
}

function renderMenuConta() {
    const alvo = document.getElementById('menuConta');
    if (!alvo) return;

    const usuario = getLoggedUser();

    // Sem sessão o menu vira um link de entrada: um avatar que só leva ao
    // login promete uma conta que ainda não existe.
    if (!hasValidSession() || !usuario) {
        alvo.innerHTML = '<a class="entrar-link" href="auth.html">Entrar</a>';
        return;
    }

    alvo.innerHTML = `
        <button class="avatar-botao" type="button" id="avatarBotao"
                aria-haspopup="true" aria-expanded="false" aria-controls="menuContaPainel">
            <span class="avatar-circulo" aria-hidden="true">${escapeHtml(iniciaisDoNome(usuario.nome))}</span>
            <span class="avatar-nome">${escapeHtml(primeiroNome(usuario.nome))}</span>
            <span class="avatar-seta" aria-hidden="true">▼</span>
        </button>
        <div class="menu-conta-painel" id="menuContaPainel" role="menu" hidden>
            <div class="menu-conta-topo">
                <strong>${escapeHtml(usuario.nome)}</strong>
                <span>${escapeHtml(usuario.email)}</span>
            </div>
            <a href="perfil.html#compras" role="menuitem"><span class="icone" aria-hidden="true">🧾</span> Minhas compras</a>
            <a href="perfil.html#avaliacoes" role="menuitem"><span class="icone" aria-hidden="true">⭐</span> Minhas avaliações</a>
            <a href="perfil.html#dados" role="menuitem"><span class="icone" aria-hidden="true">⚙️</span> Configurações</a>
            <div class="menu-conta-separador"></div>
            <button class="sair" type="button" id="sairMenu" role="menuitem">
                <span class="icone" aria-hidden="true">🚪</span> Sair da conta
            </button>
        </div>`;

    const botao = document.getElementById('avatarBotao');
    const painel = document.getElementById('menuContaPainel');

    const fechar = () => {
        painel.hidden = true;
        botao.setAttribute('aria-expanded', 'false');
    };

    botao.addEventListener('click', (evento) => {
        evento.stopPropagation();
        const aberto = !painel.hidden;
        painel.hidden = aberto;
        botao.setAttribute('aria-expanded', String(!aberto));
    });

    // Clique fora e Esc fecham. Sem isso o painel fica preso aberto e cobre
    // o conteúdo da página.
    document.addEventListener('click', (evento) => {
        if (!painel.hidden && !evento.target.closest('#menuConta')) fechar();
    });

    document.addEventListener('keydown', (evento) => {
        if (evento.key === 'Escape' && !painel.hidden) {
            fechar();
            botao.focus();
        }
    });

    document.getElementById('sairMenu').addEventListener('click', logoutUser);
}

function renderWelcomeMessage() {
    const banner = document.getElementById('welcomeBanner');
    if (!banner) return;

    const user = getLoggedUser();
    if (user && user.nome) {
        banner.style.display = 'block';
        banner.textContent = `Olá, ${user.nome}! Bem-vindo(a) de volta à Petabyte.`;
    } else {
        banner.style.display = 'none';
    }
}


document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    renderMenuConta();
    renderWelcomeMessage();

    const productGrid = document.getElementById('productGrid');
    const newsletterForm = document.getElementById('newsletterForm');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const recoverForm = document.getElementById('recoverForm');
    const tabs = document.querySelectorAll('.aba');
    const toggleRecover = document.getElementById('toggleRecover');

    // Delegação: os cards são criados por renderProductGrid() depois deste
    // handler, então não dá para escutar em cada botão individualmente.
    if (productGrid) {
        productGrid.addEventListener('click', (event) => {
            const button = event.target.closest('.add-to-cart');
            if (!button || button.disabled) return;

            addToCart(button.dataset.id);

            const rotuloOriginal = button.textContent;
            button.textContent = 'Adicionado';
            button.disabled = true;

            setTimeout(() => {
                button.textContent = rotuloOriginal;
                button.disabled = false;
            }, 800);
        });
    }

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((item) => item.classList.remove('active'));
            tab.classList.add('active');

            const target = tab.dataset.target;
            if (target === 'register') {
                document.getElementById('loginForm').classList.add('hidden');
                document.getElementById('registerForm').classList.remove('hidden');
                if (recoverForm) recoverForm.classList.add('hidden');
            } else {
                document.getElementById('registerForm').classList.add('hidden');
                document.getElementById('loginForm').classList.remove('hidden');
                if (recoverForm) recoverForm.classList.add('hidden');
            }
        });
    });

    if (toggleRecover) {
        toggleRecover.addEventListener('click', (event) => {
            event.preventDefault();
            loginForm.classList.add('hidden');
            registerForm.classList.add('hidden');
            recoverForm.classList.remove('hidden');
            tabs.forEach((item) => item.classList.remove('active'));
        });
    }

    if (recoverForm) {
        recoverForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const email = document.getElementById('recoverEmail').value.trim();

            try {
                const response = await fetch(apiUrl('/auth/recuperar-senha'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await lerResposta(response);
                if (!response.ok) throw new Error(data.mensagem || 'Erro ao enviar o link.');
                alert(data.mensagem || 'Link enviado com sucesso!');
                recoverForm.reset();
            } catch (error) {
                console.error(error);
                alert(error.message || 'Não foi possível enviar o link.');
            }
        });
    }

    if (newsletterForm) {
        newsletterForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const nomeInput = document.getElementById('nome');
            const emailInput = document.getElementById('email');
            const nome = nomeInput?.value.trim() || '';
            const email = emailInput?.value.trim() || '';

            if (!nome || !email) {
                alert('Preencha nome e e-mail para continuar.');
                return;
            }

            try {
                const response = await fetch(apiUrl('/usuarios'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, email })
                });

                const data = await lerResposta(response);
                if (!response.ok) throw new Error(data.mensagem || 'Erro ao cadastrar.');

                alert(data.mensagem || 'Cadastro realizado com sucesso!');
                newsletterForm.reset();
            } catch (error) {
                console.error(error);
                alert(error.message || 'Não foi possível conectar ao servidor.');
            }
        });
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const email = document.getElementById('loginEmail').value.trim();
            const senha = document.getElementById('loginSenha').value;

            try {
                // requisitar, não chamarApi: aqui 401 é senha errada, não
                // sessão vencida. A sessão chega em cookies httpOnly.
                const response = await requisitar('/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({ email, senha })
                });

                const data = await lerResposta(response);

                // Senha certa, e-mail ainda não confirmado: aviso na página,
                // com o botão de reenviar o link.
                if (response.status === 403 && data.codigo === 'email_nao_verificado') {
                    avisarAuth(data.mensagem, 'erro', { email, senha });
                    return;
                }

                if (!response.ok) throw new Error(data.mensagem || 'Erro ao entrar.');

                salvarUsuarioLocal(data.usuario);
                alert(data.mensagem || 'Login realizado com sucesso!');
                window.location.href = 'E-Commerce.html';
            } catch (error) {
                console.error(error);
                alert(error.message || 'Não foi possível entrar.');
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const nome = document.getElementById('registerNome').value.trim();
            const email = document.getElementById('registerEmail').value.trim();
            const senha = document.getElementById('registerSenha').value;
            const confirmarSenha = document.getElementById('confirmarSenha').value;

            if (senha !== confirmarSenha) {
                alert('As senhas não coincidem.');
                return;
            }

            try {
                const response = await requisitar('/auth/cadastro', {
                    method: 'POST',
                    body: JSON.stringify({ nome, email, senha })
                });

                const data = await lerResposta(response);
                if (!response.ok) throw new Error(data.mensagem || 'Erro ao criar conta.');

                // A conta nasce sem sessão: só entra depois de confirmar o
                // e-mail. O aviso fica na página, com o endereço usado, e a
                // tela volta para "Entrar", que é o próximo passo.
                registerForm.reset();
                document.querySelector('.aba[data-target="login"]').click();
                document.getElementById('loginEmail').value = data.email || email;
                avisarAuth(data.mensagem, 'ok');
            } catch (error) {
                console.error(error);
                alert(error.message || 'Não foi possível criar a conta.');
            }
        });
    }

    if (document.body.dataset.page === 'home') {
        renderProductGrid();
    }

    if (document.body.dataset.page === 'cart') {
        renderCartPage();
        tratarRetornoPagamento();
        ligarFormularioCupom();
    }

    if (document.getElementById('botaoGoogle')) {
        iniciarLoginGoogle();
    }

    const botaoReenvio = document.getElementById('reenviarVerificacaoBtn');
    if (botaoReenvio) {
        botaoReenvio.addEventListener('click', reenviarVerificacao);
    }

    document.addEventListener('click', (event) => {
        const removeButton = event.target.closest('.remove-item');
        if (removeButton) {
            removeFromCart(removeButton.dataset.id);
            renderCartPage();
            return;
        }

        const quantityButton = event.target.closest('.quantity-btn');
        if (quantityButton) {
            updateQuantity(quantityButton.dataset.id, Number(quantityButton.dataset.delta));
            renderCartPage();
            return;
        }

        const checkoutButton = event.target.closest('.checkout-btn');
        if (checkoutButton) {
            iniciarPagamento();
        }

        const logoutButton = event.target.closest('#logoutBtn');
        if (logoutButton) {
            logoutUser();
        }
    });
});