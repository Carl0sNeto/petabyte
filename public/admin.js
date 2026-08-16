// Painel administrativo.
//
// Reaproveita o token do login normal (chave petabyte-token). A interface só
// aparece se GET /auth/me devolver admin true — mas isso é conveniência de UX,
// não segurança: quem protege são os middlewares autenticarToken + exigirAdmin
// no servidor, que conferem a flag no banco a cada requisição.

const AUTH_KEY = 'petabyte-user';
const TOKEN_KEY = 'petabyte-token';

function resolverApiBaseUrl() {
    if (window.__PETABYTE_API_BASE_URL) {
        return window.__PETABYTE_API_BASE_URL;
    }

    if (window.location.protocol === 'file:') {
        return 'http://localhost:3000';
    }

    return window.location.origin || 'http://localhost:3000';
}

const API_BASE_URL = resolverApiBaseUrl().replace(/\/$/, '');

function apiUrl(caminho) {
    return `${API_BASE_URL}${caminho.startsWith('/') ? caminho : `/${caminho}`}`;
}

function escapeHtml(valor) {
    return String(valor === null || valor === undefined ? '' : valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatarMoeda(valor) {
    return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

async function chamarApi(caminho, opcoes = {}) {
    const token = localStorage.getItem(TOKEN_KEY);

    const resposta = await fetch(apiUrl(caminho), {
        ...opcoes,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(opcoes.headers || {})
        }
    });

    const texto = await resposta.text();
    let dados = {};

    if (texto) {
        try {
            dados = JSON.parse(texto);
        } catch (erro) {
            dados = { mensagem: texto };
        }
    }

    if (!resposta.ok) {
        const falha = new Error(dados.mensagem || `Falha na requisição (${resposta.status}).`);
        falha.status = resposta.status;
        throw falha;
    }

    return dados;
}

// --------------------------------------------------------------------------
// Avisos
// --------------------------------------------------------------------------

let timerAviso = null;

function avisar(texto, tipo = 'ok') {
    const caixa = document.getElementById('aviso');
    caixa.textContent = texto;
    caixa.className = `aviso ${tipo === 'erro' ? 'aviso-erro' : 'aviso-ok'}`;

    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => caixa.classList.add('hidden'), 5000);
}

function bloquear(titulo, texto, mostrarLogin) {
    document.getElementById('painel').classList.add('hidden');
    document.getElementById('bloqueio').classList.remove('hidden');
    document.getElementById('bloqueioTitulo').textContent = titulo;
    document.getElementById('bloqueioTexto').textContent = texto;
    document.getElementById('bloqueioAcao').classList.toggle('hidden', !mostrarLogin);
}

// --------------------------------------------------------------------------
// Produtos
// --------------------------------------------------------------------------

let categorias = ['tecnologia', 'acessorios', 'casa'];

async function carregarProdutos() {
    const corpo = document.getElementById('listaProdutos');

    try {
        const dados = await chamarApi('/admin/produtos');
        categorias = dados.categorias || categorias;

        if (dados.produtos.length === 0) {
            corpo.innerHTML = '<tr><td colspan="8" class="muted">Nenhum produto cadastrado.</td></tr>';
            return;
        }

        corpo.innerHTML = dados.produtos.map((produto) => {
            const semEstoque = produto.estoque === 0;
            const estoquePill = semEstoque
                ? '<span class="pill pill-danger">esgotado</span>'
                : (produto.estoque <= 5 ? `<span class="pill pill-warn">${produto.estoque}</span>` : produto.estoque);

            return `
                <tr>
                    <td class="muted">${produto.id}</td>
                    <td><strong>${escapeHtml(produto.nome)}</strong></td>
                    <td class="muted">${escapeHtml(produto.categoria)}</td>
                    <td class="num">${formatarMoeda(produto.preco)}</td>
                    <td class="num">${estoquePill}</td>
                    <td class="num muted">${produto.vendidos}</td>
                    <td>${produto.ativo
                        ? '<span class="pill pill-ok">à venda</span>'
                        : '<span class="pill pill-off">fora do catálogo</span>'}</td>
                    <td>
                        <div class="acoes">
                            <button class="btn btn-secondary btn-sm" type="button" data-editar="${produto.id}">Editar</button>
                            <button class="btn btn-danger btn-sm" type="button" data-excluir="${produto.id}">Excluir</button>
                        </div>
                    </td>
                </tr>`;
        }).join('');

        window.__produtos = dados.produtos;
    } catch (erro) {
        corpo.innerHTML = `<tr><td colspan="8" class="muted">${escapeHtml(erro.message)}</td></tr>`;
    }
}

function preencherCategorias(selecionada) {
    const campo = document.getElementById('campoCategoria');
    campo.innerHTML = categorias
        .map((c) => `<option value="${escapeHtml(c)}"${c === selecionada ? ' selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');
}

let produtoEmEdicao = null;

function abrirDialogProduto(produto) {
    produtoEmEdicao = produto ? produto.id : null;

    document.getElementById('dialogProdutoTitulo').textContent = produto ? `Editar "${produto.nome}"` : 'Novo produto';
    document.getElementById('erroProduto').classList.add('hidden');
    document.getElementById('campoNome').value = produto ? produto.nome : '';
    document.getElementById('campoPreco').value = produto ? produto.preco : '';
    document.getElementById('campoEstoque').value = produto ? produto.estoque : 0;
    document.getElementById('campoImagem').value = produto ? produto.imagemUrl : '';
    document.getElementById('campoDescricao').value = produto ? produto.descricao : '';
    document.getElementById('campoAtivo').value = produto ? String(produto.ativo) : 'true';
    preencherCategorias(produto ? produto.categoria : categorias[0]);

    document.getElementById('dialogProduto').showModal();
}

async function salvarProduto(evento) {
    evento.preventDefault();

    const erroBox = document.getElementById('erroProduto');
    const botao = document.getElementById('salvarProdutoBtn');

    const corpo = {
        nome: document.getElementById('campoNome').value,
        preco: Number(document.getElementById('campoPreco').value),
        estoque: Number(document.getElementById('campoEstoque').value),
        categoria: document.getElementById('campoCategoria').value,
        imagemUrl: document.getElementById('campoImagem').value,
        descricao: document.getElementById('campoDescricao').value,
        ativo: document.getElementById('campoAtivo').value === 'true'
    };

    botao.disabled = true;

    try {
        if (produtoEmEdicao) {
            await chamarApi(`/admin/produtos/${produtoEmEdicao}`, { method: 'PUT', body: JSON.stringify(corpo) });
            avisar('Produto atualizado.');
        } else {
            await chamarApi('/admin/produtos', { method: 'POST', body: JSON.stringify(corpo) });
            avisar('Produto criado.');
        }

        document.getElementById('dialogProduto').close();
        await carregarProdutos();
    } catch (erro) {
        erroBox.textContent = erro.message;
        erroBox.classList.remove('hidden');
    } finally {
        botao.disabled = false;
    }
}

async function excluirProduto(id) {
    const produto = (window.__produtos || []).find((p) => p.id === id);
    const nome = produto ? produto.nome : `#${id}`;

    const confirmado = window.confirm(
        `Excluir "${nome}" definitivamente?\n\n` +
        'Pedidos antigos mantêm o nome e o preço da época, mas perdem o vínculo com o produto.\n' +
        'Para apenas tirar da loja, use Editar e escolha "Fora do catálogo".'
    );

    if (!confirmado) return;

    try {
        const resposta = await chamarApi(`/admin/produtos/${id}`, { method: 'DELETE' });
        const extra = resposta.itensDePedidoAfetados > 0
            ? ` ${resposta.itensDePedidoAfetados} item(ns) de pedido perderam o vínculo.`
            : '';
        avisar(`Produto excluído.${extra}`);
        await carregarProdutos();
    } catch (erro) {
        avisar(erro.message, 'erro');
    }
}

// --------------------------------------------------------------------------
// Pedidos
// --------------------------------------------------------------------------

const estadoPedidos = { pagina: 1, porPagina: 25, status: 'todos', totalPaginas: 1 };

function pillDeStatus(status) {
    const mapa = {
        'Pago': 'pill-ok',
        'Aguardando pagamento': 'pill-warn',
        'Em análise': 'pill-warn',
        'Recusado': 'pill-danger',
        'Cancelado': 'pill-danger',
        'Chargeback': 'pill-danger',
        'Expirado': 'pill-off',
        'Reembolsado': 'pill-off'
    };

    return `<span class="pill ${mapa[status] || 'pill-off'}">${escapeHtml(status)}</span>`;
}

async function carregarPedidos() {
    const corpo = document.getElementById('listaPedidos');

    try {
        const parametros = new URLSearchParams({
            pagina: estadoPedidos.pagina,
            porPagina: estadoPedidos.porPagina,
            status: estadoPedidos.status
        });

        const dados = await chamarApi(`/admin/pedidos?${parametros}`);
        estadoPedidos.totalPaginas = dados.paginacao.totalPaginas;

        // Reconstruído a cada carga: os status existentes mudam conforme os
        // pedidos avançam. Preenchendo só uma vez, uma base sem pedidos deixaria
        // o filtro vazio para sempre.
        const filtro = document.getElementById('filtroStatus');
        const selecionado = estadoPedidos.status;

        filtro.innerHTML = '<option value="todos">Todos os status</option>';
        dados.statusDisponiveis.forEach((status) => {
            const opcao = document.createElement('option');
            opcao.value = status;
            opcao.textContent = status;
            filtro.appendChild(opcao);
        });

        // O status filtrado pode ter deixado de existir entre uma carga e outra.
        filtro.value = Array.from(filtro.options).some((o) => o.value === selecionado) ? selecionado : 'todos';

        if (dados.pedidos.length === 0) {
            corpo.innerHTML = '<tr><td colspan="7" class="muted">Nenhum pedido encontrado.</td></tr>';
        } else {
            corpo.innerHTML = dados.pedidos.map((pedido) => `
                <tr>
                    <td class="muted">${pedido.id}</td>
                    <td>${formatarData(pedido.criadoEm)}</td>
                    <td>
                        ${escapeHtml(pedido.cliente.nome)}<br>
                        <span class="muted" style="font-size:.8rem">${escapeHtml(pedido.cliente.email)}</span>
                    </td>
                    <td>${pillDeStatus(pedido.status)}</td>
                    <td class="num muted">${pedido.totalItens}</td>
                    <td class="num"><strong>${formatarMoeda(pedido.total)}</strong></td>
                    <td>
                        <div class="acoes">
                            <button class="btn btn-secondary btn-sm" type="button" data-pedido="${pedido.id}">Detalhes</button>
                        </div>
                    </td>
                </tr>`).join('');
        }

        const { pagina, totalPaginas, total } = dados.paginacao;
        document.getElementById('resumoPaginacao').textContent =
            `${total} pedido(s) · página ${pagina} de ${totalPaginas}`;
        document.getElementById('paginaAnterior').disabled = pagina <= 1;
        document.getElementById('paginaProxima').disabled = pagina >= totalPaginas;
    } catch (erro) {
        corpo.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(erro.message)}</td></tr>`;
    }
}

async function abrirPedido(id) {
    const corpo = document.getElementById('dialogPedidoCorpo');
    document.getElementById('dialogPedidoTitulo').textContent = `Pedido #${id}`;
    corpo.innerHTML = '<p class="muted">Carregando...</p>';
    document.getElementById('dialogPedido').showModal();

    try {
        const { pedido, itens } = await chamarApi(`/admin/pedidos/${id}`);

        const linha = (rotulo, valor) => `<div class="detalhe-linha"><span class="muted">${rotulo}</span><b>${valor}</b></div>`;

        corpo.innerHTML = `
            ${linha('Cliente', escapeHtml(pedido.cliente.nome))}
            ${linha('E-mail', escapeHtml(pedido.cliente.email))}
            ${linha('Status', pillDeStatus(pedido.status))}
            ${linha('Status no gateway', escapeHtml(pedido.statusPagamento || '—'))}
            ${linha('Referência', escapeHtml(pedido.referencia))}
            ${linha('ID do pagamento', escapeHtml(pedido.paymentId || '—'))}
            ${linha('Estoque debitado', pedido.estoqueBaixado ? 'sim' : 'não')}
            ${linha('Criado em', formatarData(pedido.criadoEm))}

            <h3 style="margin:1.2rem 0 .5rem;font-size:1rem">Itens</h3>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Produto</th><th class="num">Qtd.</th><th class="num">Unitário</th><th class="num">Total</th></tr></thead>
                    <tbody>
                        ${itens.map((item) => `
                            <tr>
                                <td>${escapeHtml(item.nome)}${item.produtoRemovido
                                    ? ' <span class="pill pill-off">fora do catálogo</span>'
                                    : ''}</td>
                                <td class="num">${item.quantidade}</td>
                                <td class="num">${formatarMoeda(item.precoUnitario)}</td>
                                <td class="num">${formatarMoeda(item.total)}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>

            <div style="margin-top:1rem">
                ${linha('Subtotal', formatarMoeda(pedido.subtotal))}
                ${linha('Frete', formatarMoeda(pedido.frete))}
                ${linha('Total', formatarMoeda(pedido.total))}
            </div>`;
    } catch (erro) {
        corpo.innerHTML = `<div class="aviso aviso-erro">${escapeHtml(erro.message)}</div>`;
    }
}

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------

async function iniciar() {
    if (!localStorage.getItem(TOKEN_KEY)) {
        bloquear('Você não está autenticado', 'Entre com uma conta de administrador para acessar o painel.', true);
        return;
    }

    let dados;

    try {
        dados = await chamarApi('/auth/me');
    } catch (erro) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_KEY);
        bloquear('Sessão expirada', 'Entre novamente para continuar.', true);
        return;
    }

    if (!dados.usuario || dados.usuario.admin !== true) {
        bloquear(
            'Acesso restrito',
            'Você não tem permissão de administrador.',
            false
        );
        return;
    }

    document.getElementById('bloqueio').classList.add('hidden');
    document.getElementById('painel').classList.remove('hidden');
    document.getElementById('whoami').textContent = dados.usuario.email;

    await carregarProdutos();
    await carregarPedidos();
}

document.addEventListener('DOMContentLoaded', () => {
    iniciar();

    document.querySelectorAll('.tab').forEach((aba) => {
        aba.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((outra) => outra.classList.remove('active'));
            aba.classList.add('active');

            const alvo = aba.dataset.aba;
            document.getElementById('abaProdutos').classList.toggle('hidden', alvo !== 'produtos');
            document.getElementById('abaPedidos').classList.toggle('hidden', alvo !== 'pedidos');
        });
    });

    document.getElementById('novoProdutoBtn').addEventListener('click', () => abrirDialogProduto(null));
    document.getElementById('formProduto').addEventListener('submit', salvarProduto);

    document.getElementById('sairBtn').addEventListener('click', () => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(AUTH_KEY);
        window.location.href = 'auth.html';
    });

    document.getElementById('filtroStatus').addEventListener('change', (evento) => {
        estadoPedidos.status = evento.target.value;
        estadoPedidos.pagina = 1;
        carregarPedidos();
    });

    document.getElementById('paginaAnterior').addEventListener('click', () => {
        if (estadoPedidos.pagina > 1) {
            estadoPedidos.pagina -= 1;
            carregarPedidos();
        }
    });

    document.getElementById('paginaProxima').addEventListener('click', () => {
        if (estadoPedidos.pagina < estadoPedidos.totalPaginas) {
            estadoPedidos.pagina += 1;
            carregarPedidos();
        }
    });

    document.querySelectorAll('[data-fechar]').forEach((botao) => {
        botao.addEventListener('click', () => botao.closest('dialog').close());
    });

    // Delegação: as linhas das tabelas são criadas dinamicamente.
    document.addEventListener('click', (evento) => {
        const editar = evento.target.closest('[data-editar]');
        if (editar) {
            const produto = (window.__produtos || []).find((p) => p.id === Number(editar.dataset.editar));
            if (produto) abrirDialogProduto(produto);
            return;
        }

        const excluir = evento.target.closest('[data-excluir]');
        if (excluir) {
            excluirProduto(Number(excluir.dataset.excluir));
            return;
        }

        const detalhes = evento.target.closest('[data-pedido]');
        if (detalhes) {
            abrirPedido(Number(detalhes.dataset.pedido));
        }
    });
});
