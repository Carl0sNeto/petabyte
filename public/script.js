const STORAGE_KEY = 'petabyte-cart';
const AUTH_KEY = 'petabyte-user';
function resolverApiBaseUrl() {
    if (window.__PETABYTE_API_BASE_URL) {
        return window.__PETABYTE_API_BASE_URL;
    }

    if (window.location.protocol === 'file:') {
        return 'http://localhost:3000';
    }

    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${window.location.protocol}//${hostname}:3000`;
    }

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

function getCart() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
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
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    badge.textContent = totalItems;
}

function addToCart(name, price) {
    const cart = getCart();
    const existingItem = cart.find((item) => item.name === name);

    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({ name, price, quantity: 1 });
    }

    saveCart(cart);
    updateCartBadge();
}

function removeFromCart(name) {
    const cart = getCart().filter((item) => item.name !== name);
    saveCart(cart);
    updateCartBadge();
    return cart;
}

function updateQuantity(name, delta) {
    const cart = getCart();
    const item = cart.find((entry) => entry.name === name);

    if (!item) return cart;

    item.quantity = Math.max(1, item.quantity + delta);
    saveCart(cart);
    updateCartBadge();
    return cart;
}

function getShipping(total) {
    return total > 199 ? 0 : 19.9;
}

function createCartSummary(cart) {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = getShipping(subtotal);
    return {
        subtotal,
        shipping,
        total: subtotal + shipping
    };
}

async function iniciarPagamento() {
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
            body: JSON.stringify({ itens: cart })
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

function renderCartPage() {
    const cartItems = document.getElementById('cartItems');
    const cartTotal = document.getElementById('cartTotal');
    const shippingValue = document.getElementById('shippingValue');
    const finalTotal = document.getElementById('finalTotal');

    if (!cartItems || !cartTotal || !shippingValue || !finalTotal) return;

    const cart = getCart();

    if (cart.length === 0) {
        cartItems.innerHTML = '<p>Seu carrinho está vazio.</p>';
        cartTotal.textContent = formatCurrency(0);
        shippingValue.textContent = formatCurrency(0);
        finalTotal.textContent = formatCurrency(0);
        return;
    }

    const resumo = createCartSummary(cart);

    cartItems.innerHTML = cart.map((item) => `
        <div class="cart-item">
            <div>
                <strong>${item.name}</strong>
                <div>${formatCurrency(item.price)} cada</div>
            </div>
            <div class="cart-actions">
                <button class="btn btn-secondary quantity-btn" data-name="${item.name}" data-delta="-1">-</button>
                <span>${item.quantity}</span>
                <button class="btn btn-secondary quantity-btn" data-name="${item.name}" data-delta="1">+</button>
                <span>${formatCurrency(item.price * item.quantity)}</span>
                <button class="btn btn-secondary remove-item" data-name="${item.name}">Apagar</button>
            </div>
        </div>
    `).join('');

    cartTotal.textContent = formatCurrency(resumo.subtotal);
    shippingValue.textContent = formatCurrency(resumo.shipping);
    finalTotal.textContent = formatCurrency(resumo.total);
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
        ordersList.innerHTML = '<div class="empty-state">Você precisa entrar na sua conta para visualizar suas compras.</div>';
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
                <div class="order-item">
                    <strong>${item.pedido}</strong>
                    <p class="muted">Status: ${item.status}</p>
                </div>
            `).join('');
        } else {
            ordersList.innerHTML = '<div class="empty-state">Ainda não há compras registradas para este usuário.</div>';
        }
    } catch (error) {
        console.error(error);
        localStorage.removeItem(AUTH_KEY);
        localStorage.removeItem('petabyte-token');
        profileName.textContent = 'Sessão expirada.';
        profileEmail.textContent = 'Faça login novamente para acessar o perfil.';
        logoutBtn.style.display = 'none';
        ordersList.innerHTML = '<div class="empty-state">Sua sessão expirou. Entre novamente para continuar.</div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    renderWelcomeMessage();
    renderProfilePage();

    const buttons = document.querySelectorAll('.add-to-cart');
    const filterButtons = document.querySelectorAll('.filter-btn');
    const cards = document.querySelectorAll('.card[data-category]');
    const newsletterForm = document.getElementById('newsletterForm');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const recoverForm = document.getElementById('recoverForm');
    const tabs = document.querySelectorAll('.tab');
    const toggleRecover = document.getElementById('toggleRecover');

    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            const card = button.closest('.card');
            const name = card.querySelector('h3').textContent;
            const priceText = card.querySelector('.price').textContent.replace('R$ ', '').replace('.', '').replace(',', '.');
            const price = Number(priceText);

            addToCart(name, price);
            button.textContent = 'Adicionado';
            button.disabled = true;

            setTimeout(() => {
                button.textContent = 'Adicionar';
                button.disabled = false;
            }, 800);
        });
    });

    filterButtons.forEach((button) => {
        button.addEventListener('click', () => {
            filterButtons.forEach((btn) => btn.classList.remove('active'));
            button.classList.add('active');

            const filter = button.dataset.filter;
            cards.forEach((card) => {
                const category = card.dataset.category;
                card.style.display = filter === 'todos' || filter === category ? 'block' : 'none';
            });
        });
    });

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

    if (document.body.dataset.page === 'cart') {
        renderCartPage();
        tratarRetornoPagamento();
    }

    document.addEventListener('click', (event) => {
        const removeButton = event.target.closest('.remove-item');
        if (removeButton) {
            removeFromCart(removeButton.dataset.name);
            renderCartPage();
            return;
        }

        const quantityButton = event.target.closest('.quantity-btn');
        if (quantityButton) {
            updateQuantity(quantityButton.dataset.name, Number(quantityButton.dataset.delta));
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