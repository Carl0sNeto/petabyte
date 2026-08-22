const STORAGE_KEY = 'petabyte-cart';
const AUTH_KEY = 'petabyte-user';
function resolverApiBaseUrl() {
    if (window.__PETABYTE_API_BASE_URL) {
        return window.__PETABYTE_API_BASE_URL;
    }

    // Aberto direto do disco (file://) não há origem: assume o padrão local.
    if (window.location.protocol === 'file:') {
        return 'http://localhost:3000';
    }

    // Servido por HTTP, a API é sempre a mesma origem da página. Fixar :3000
    // aqui quebrava qualquer porta alternativa (testes, staging, container).
    return window.location.origin || 'http://localhost:3000';
}

const API_BASE_URL = resolverApiBaseUrl().replace(/\/$/, '');

function apiUrl(path) {
    return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function lerResposta(response) {
    const texto = await response.text();

    if (!texto) {
        return {};
    }

    try {
        return JSON.parse(texto);
    } catch (error) {
        return { mensagem: texto };
    }
}

function getLoggedUser() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    } catch (error) {
        console.error('Erro ao ler usuário:', error);
        localStorage.removeItem(AUTH_KEY);
        return null;
    }
}

function hasValidSession() {
    return Boolean(localStorage.getItem('petabyte-token')) && Boolean(getLoggedUser());
}

function requireAuthenticatedCheckout() {
    if (hasValidSession()) {
        return true;
    }

    alert('Faça login para finalizar a compra.');
    window.location.href = 'auth.html';
    return false;
}

function logoutUser() {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem('petabyte-token');
    window.location.href = 'auth.html';
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

let catalogoCache = null;
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

async function carregarCatalogo() {
    if (catalogoCache) {
        return catalogoCache;
    }

    const response = await fetch(apiUrl('/produtos'));
    const data = await lerResposta(response);

    if (!response.ok) {
        throw new Error(data.mensagem || 'Não foi possível carregar os produtos.');
    }

    catalogoCache = Array.isArray(data.produtos) ? data.produtos : [];
    categoriasCache = Array.isArray(data.categorias) ? data.categorias : [];
    return catalogoCache;
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

// Espelha calcularFrete() do servidor. Serve só para exibição: o valor que
// vale é o recalculado no backend ao criar a preferência de pagamento.
function getShipping(total) {
    return total > 199 ? 0 : 19.9;
}

function createCartSummary(itensDetalhados) {
    const subtotal = itensDetalhados.reduce((sum, item) => sum + item.produto.preco * item.quantidade, 0);
    const shipping = getShipping(subtotal);
    return {
        subtotal,
        shipping,
        total: subtotal + shipping
    };
}

// Junta o carrinho (ids) com o catálogo vindo da API, descartando produtos
// que saíram do ar desde a última visita.
async function detalharCarrinho() {
    const cart = getCart();

    if (cart.length === 0) {
        return [];
    }

    const produtos = await carregarCatalogo();
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

    const token = localStorage.getItem('petabyte-token');

    try {
        const response = await fetch(apiUrl('/pagamentos/criar'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            // Só id e quantidade. O servidor resolve nome e preço no banco.
            body: JSON.stringify({
                itens: cart.map((item) => ({ id: item.id, quantidade: item.quantidade }))
            })
        });

        const data = await lerResposta(response);
        if (!response.ok) throw new Error(data.mensagem || 'Falha ao iniciar pagamento.');

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

    const token = localStorage.getItem('petabyte-token');
    if (!token) {
        return;
    }

    if (paymentId) {
        try {
            const response = await fetch(apiUrl('/pagamentos/confirmar'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ paymentId })
            });

            const data = await lerResposta(response);
            if (!response.ok) throw new Error(data.mensagem || 'Não foi possível confirmar o pagamento.');

            if (data.status === 'approved') {
                localStorage.removeItem(STORAGE_KEY);
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

    const zerarResumo = () => {
        cartTotal.textContent = formatCurrency(0);
        shippingValue.textContent = formatCurrency(0);
        finalTotal.textContent = formatCurrency(0);
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

    cartTotal.textContent = formatCurrency(resumo.subtotal);
    shippingValue.textContent = formatCurrency(resumo.shipping);
    finalTotal.textContent = formatCurrency(resumo.total);

    // Faltando pouco para o frete grátis, vale avisar.
    const avisoFrete = document.getElementById('avisoFrete');
    if (avisoFrete) {
        const faltam = 199 - resumo.subtotal;
        if (resumo.shipping === 0) {
            avisoFrete.textContent = '🚚 Você ganhou frete grátis neste pedido!';
            avisoFrete.classList.remove('hidden');
        } else if (faltam > 0) {
            avisoFrete.textContent = `Faltam ${formatCurrency(faltam)} para o frete grátis.`;
            avisoFrete.classList.remove('hidden');
        } else {
            avisoFrete.classList.add('hidden');
        }
    }
}

// O banco guarda o slug ("perifericos"); quem aparece na tela é o rótulo
// ("Periféricos"), que vem junto da API.
function rotuloCategoria(slug) {
    const encontrada = categoriasCache.find((categoria) => categoria.slug === slug);
    return encontrada ? encontrada.rotulo : slug;
}

// Os botões de filtro vêm da API, e não fixos no HTML: assim uma categoria
// nova aparece sozinha, e uma que ficou sem produto não vira filtro vazio.
function renderFiltros() {
    const caixa = document.getElementById('filtrosCategoria');
    if (!caixa) return;

    if (categoriasCache.length === 0) {
        caixa.innerHTML = '';
        return;
    }

    const botoes = [{ slug: 'todos', rotulo: 'Todos' }, ...categoriasCache];

    caixa.innerHTML = botoes.map((categoria, indice) => `
        <button class="filtro-btn${indice === 0 ? ' active' : ''}" type="button" data-filter="${escapeHtml(categoria.slug)}">
            ${escapeHtml(categoria.rotulo)}
        </button>`).join('');

    caixa.querySelectorAll('.filtro-btn').forEach((botao) => {
        botao.addEventListener('click', () => {
            caixa.querySelectorAll('.filtro-btn').forEach((outro) => outro.classList.remove('active'));
            botao.classList.add('active');

            const filtro = botao.dataset.filter;
            document.querySelectorAll('.produto[data-category]').forEach((card) => {
                card.style.display = filtro === 'todos' || filtro === card.dataset.category ? 'flex' : 'none';
            });
        });
    });
}

// Monta a vitrine a partir de GET /produtos. Antes os 6 produtos eram HTML
// fixo e o preço era lido do texto da página.
async function renderProductGrid() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    try {
        const produtos = await carregarCatalogo();
        renderFiltros();

        if (produtos.length === 0) {
            grid.innerHTML = '<p>Nenhum produto disponível no momento.</p>';
            return;
        }

        grid.innerHTML = produtos.map((produto) => {
            // Sem loading="lazy": a vitrine é a primeira coisa que o visitante
            // vê, e adiar essas imagens só atrasaria o que importa na tela.
            const foto = produto.imagemUrl
                ? `<img src="${escapeHtml(produto.imagemUrl)}" alt="${escapeHtml(produto.nome)}">`
                : '<span class="sem-foto">Sem foto</span>';

            let estoque = '<span class="estoque estoque-fora">Indisponível</span>';
            if (produto.disponivel) {
                estoque = produto.estoqueBaixo
                    ? '<span class="estoque estoque-baixo">Últimas unidades</span>'
                    : '<span class="estoque estoque-ok">Em estoque</span>';
            }

            return `
                <article class="produto" data-category="${escapeHtml(produto.categoria)}">
                    <div class="produto-foto">
                        <span class="produto-chip">${escapeHtml(rotuloCategoria(produto.categoria))}</span>
                        ${foto}
                    </div>
                    <div class="produto-corpo">
                        <h3 class="produto-nome">${escapeHtml(produto.nome)}</h3>
                        <p class="produto-desc">${escapeHtml(produto.descricao)}</p>
                        ${estoque}
                        <div class="produto-preco">
                            <span class="valor">${formatCurrency(produto.preco)}</span>
                            <span class="parcelas">ou 12x de ${formatCurrency(produto.preco / 12)} sem juros</span>
                        </div>
                        <button class="btn btn-comprar add-to-cart" type="button" data-id="${produto.id}"${produto.disponivel ? '' : ' disabled'}>
                            ${produto.disponivel ? 'Adicionar ao carrinho' : 'Indisponível'}
                        </button>
                    </div>
                </article>`;
        }).join('');
    } catch (error) {
        console.error(error);
        grid.innerHTML = '<p class="muted">Não foi possível carregar os produtos. Verifique sua conexão e recarregue a página.</p>';
    }
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

async function renderProfilePage() {
    const profileName = document.getElementById('profileName');
    const profileEmail = document.getElementById('profileEmail');
    const logoutBtn = document.getElementById('logoutBtn');
    const profileSection = document.getElementById('profileSection');
    const ordersSection = document.getElementById('ordersSection');
    const ordersList = document.getElementById('ordersList');

    if (!profileName || !profileEmail || !logoutBtn || !profileSection || !ordersSection || !ordersList) return;

    const user = getLoggedUser();
    if (!hasValidSession() || !user) {
        profileName.textContent = 'Você ainda não fez login.';
        profileEmail.textContent = 'Acesse sua conta para ver o perfil e os pedidos.';
        logoutBtn.style.display = 'none';
        ordersList.innerHTML = '<div class="estado-vazio">Você precisa entrar na sua conta para visualizar suas compras.</div>';
        return;
    }

    try {
        const token = localStorage.getItem('petabyte-token');
        const response = await fetch(apiUrl('/auth/me'), {
            headers: { Authorization: `Bearer ${token}` }
        });

        const data = await lerResposta(response);
        if (!response.ok) throw new Error(data.mensagem || 'Sessão inválida.');

        profileName.textContent = `Nome: ${data.usuario.nome}`;
        profileEmail.textContent = `E-mail: ${data.usuario.email}`;
        logoutBtn.style.display = 'inline-block';
        logoutBtn.onclick = logoutUser;

        if (data.compras && data.compras.length > 0) {
            ordersList.innerHTML = data.compras.map((item) => `
                <div class="pedido">
                    <strong>${escapeHtml(item.pedido)}</strong>
                    <span class="muted" style="font-size:.85rem">Status: ${escapeHtml(item.status)}</span>
                </div>
            `).join('');
        } else {
            ordersList.innerHTML = '<div class="estado-vazio">Ainda não há compras registradas para este usuário.</div>';
        }
    } catch (error) {
        console.error(error);
        localStorage.removeItem(AUTH_KEY);
        localStorage.removeItem('petabyte-token');
        profileName.textContent = 'Sessão expirada.';
        profileEmail.textContent = 'Faça login novamente para acessar o perfil.';
        logoutBtn.style.display = 'none';
        ordersList.innerHTML = '<div class="estado-vazio">Sua sessão expirou. Entre novamente para continuar.</div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    renderWelcomeMessage();
    renderProfilePage();

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

    // Os filtros são criados e ligados por renderFiltros(), depois que a API
    // responde — não há botões no HTML para escutar neste ponto.

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
                const response = await fetch(apiUrl('/auth/login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, senha })
                });

                const data = await lerResposta(response);
                if (!response.ok) throw new Error(data.mensagem || 'Erro ao entrar.');

                localStorage.setItem(AUTH_KEY, JSON.stringify(data.usuario));
                localStorage.setItem('petabyte-token', data.token);
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
                const response = await fetch(apiUrl('/auth/cadastro'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nome, email, senha })
                });

                const data = await lerResposta(response);
                if (!response.ok) throw new Error(data.mensagem || 'Erro ao criar conta.');

                alert(data.mensagem || 'Conta criada com sucesso!');
                registerForm.reset();
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