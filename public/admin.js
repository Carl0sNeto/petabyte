// Painel administrativo.
//
// Reaproveita a sessão do login normal, em cookies. A interface só aparece se
// GET /auth/me devolver admin true — mas isso é conveniência de UX, não
// segurança: quem protege são os middlewares autenticarToken + exigirAdmin no
// servidor, que conferem a flag no banco a cada requisição.
//
// Carrega depois de sessao.js, de quem usa chamarApi, hasValidSession,
// encerrarSessaoLocal e logoutUser — a mesma chamada autenticada da loja.

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

// Substituído pela lista real assim que GET /admin/produtos responde.
let categorias = [];

async function carregarProdutos() {
    const corpo = document.getElementById('listaProdutos');

    try {
        const dados = await chamarApi('/admin/produtos');
        categorias = dados.categorias || categorias;

        if (dados.produtos.length === 0) {
            corpo.innerHTML = '<tr><td colspan="9" class="muted">Nenhum produto cadastrado.</td></tr>';
            return;
        }

        corpo.innerHTML = dados.produtos.map((produto) => {
            const semEstoque = produto.estoque === 0;
            const estoquePill = semEstoque
                ? '<span class="pill pill-danger">esgotado</span>'
                : (produto.estoque <= 5 ? `<span class="pill pill-warn">${produto.estoque}</span>` : produto.estoque);

            // Sem onerror inline: a CSP define script-src-attr 'none', então
            // handlers em atributo são bloqueados. O listener é ligado depois,
            // em ligarFallbackDasMiniaturas().
            const foto = produto.imagemUrl
                ? `<img class="thumb" src="${escapeHtml(produto.imagemUrl)}" alt="" data-thumb>`
                : '<div class="thumb-vazia">sem foto</div>';

            return `
                <tr>
                    <td class="muted">${produto.id}</td>
                    <td>${foto}</td>
                    <td><strong>${escapeHtml(produto.nome)}</strong></td>
                    <td class="muted">${escapeHtml(rotuloCategoria(produto.categoria))}</td>
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

        ligarFallbackDasMiniaturas(corpo);
        window.__produtos = dados.produtos;
    } catch (erro) {
        corpo.innerHTML = `<tr><td colspan="9" class="muted">${escapeHtml(erro.message)}</td></tr>`;
    }
}

// Troca a miniatura por um marcador quando a URL não carrega — link quebrado,
// domínio fora do ar ou arquivo que não é imagem.
function ligarFallbackDasMiniaturas(container) {
    container.querySelectorAll('img[data-thumb]').forEach((img) => {
        img.addEventListener('error', () => {
            const marcador = document.createElement('div');
            marcador.className = 'thumb-vazia';
            marcador.textContent = 'falhou';
            marcador.title = 'Não foi possível carregar esta imagem.';
            img.replaceWith(marcador);
        }, { once: true });
    });
}

// A API devolve { slug, rotulo }: o slug vai para o banco, o rótulo para a tela.
function preencherCategorias(selecionada) {
    const campo = document.getElementById('campoCategoria');
    campo.innerHTML = categorias
        .map((c) => `<option value="${escapeHtml(c.slug)}"${c.slug === selecionada ? ' selected' : ''}>${escapeHtml(c.rotulo)}</option>`)
        .join('');
}

function rotuloCategoria(slug) {
    const encontrada = categorias.find((c) => c.slug === slug);
    return encontrada ? encontrada.rotulo : slug;
}

let produtoEmEdicao = null;

// Atualiza a prévia conforme a URL é digitada ou colada, para o resultado
// aparecer aqui em vez de só na loja.
function atualizarPrevia() {
    const url = document.getElementById('campoImagem').value.trim();
    const img = document.getElementById('previaImagem');
    const status = document.getElementById('previaStatus');

    status.classList.remove('erro');

    if (!url) {
        img.classList.remove('visivel');
        img.removeAttribute('src');
        status.textContent = 'Cole uma URL para ver a prévia.';
        return;
    }

    if (!/^https:\/\//i.test(url)) {
        img.classList.remove('visivel');
        img.removeAttribute('src');
        status.textContent = 'A URL precisa começar com https://';
        status.classList.add('erro');
        return;
    }

    status.textContent = 'Carregando...';
    img.classList.remove('visivel');
    img.src = url;
}

function configurarPrevia() {
    const img = document.getElementById('previaImagem');
    const status = document.getElementById('previaStatus');

    img.addEventListener('load', () => {
        img.classList.add('visivel');
        status.classList.remove('erro');
        status.textContent = `Imagem carregada (${img.naturalWidth}×${img.naturalHeight}).`;
    });

    img.addEventListener('error', () => {
        img.classList.remove('visivel');
        status.classList.add('erro');
        status.textContent = 'Não foi possível carregar. Confira se o link aponta para o arquivo da imagem.';
    });

    const campo = document.getElementById('campoImagem');
    campo.addEventListener('input', atualizarPrevia);
    campo.addEventListener('change', atualizarPrevia);
}

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
    document.getElementById('campoTags').value = produto && produto.tags ? produto.tags.join(', ') : '';
    document.getElementById('campoPrecoOriginal').value = produto && produto.precoOriginal ? produto.precoOriginal : '';
    // O servidor aceita e devolve pares; na tela editamos como texto por linha.
    document.getElementById('campoEspecificacoes').value = produto && Array.isArray(produto.especificacoes)
        ? produto.especificacoes.map((e) => `${e.rotulo}: ${e.valor}`).join('\n')
        : '';
    document.getElementById('campoGaleria').value = produto && Array.isArray(produto.imagens)
        ? produto.imagens.join('\n')
        : '';
    preencherCategorias(produto ? produto.categoria : (categorias[0] && categorias[0].slug));
    atualizarPrevia();

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
        ativo: document.getElementById('campoAtivo').value === 'true',
        // O servidor aceita string separada por vírgula e normaliza.
        tags: document.getElementById('campoTags').value,
        // Vazio limpa o desconto; o servidor trata '' como null.
        precoOriginal: document.getElementById('campoPrecoOriginal').value,
        // Texto "Rótulo: valor" por linha e URLs por linha: o servidor converte.
        especificacoes: document.getElementById('campoEspecificacoes').value,
        imagens: document.getElementById('campoGaleria').value
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

// Confirmação dentro da página, em vez de window.confirm().
//
// O navegador pode suprimir diálogos nativos — o Chrome oferece "Impedir que
// esta página crie diálogos adicionais" depois de alguns seguidos. Suprimido,
// confirm() devolve false imediatamente e a ação era cancelada sem aviso: o
// botão Excluir simplesmente não fazia nada.
function confirmar({ titulo, texto, detalhe = '', rotuloConfirmar = 'Excluir' }) {
    return new Promise((resolve) => {
        const dialogo = document.getElementById('dialogConfirmar');
        const sim = document.getElementById('confirmarSim');
        const nao = document.getElementById('confirmarNao');

        document.getElementById('confirmarTitulo').textContent = titulo;
        document.getElementById('confirmarTexto').textContent = texto;
        document.getElementById('confirmarDetalhe').textContent = detalhe;
        sim.textContent = rotuloConfirmar;

        const encerrar = (resposta) => {
            sim.removeEventListener('click', aoConfirmar);
            nao.removeEventListener('click', aoCancelar);
            dialogo.removeEventListener('close', aoFechar);
            if (dialogo.open) dialogo.close();
            resolve(resposta);
        };

        const aoConfirmar = () => encerrar(true);
        const aoCancelar = () => encerrar(false);
        // Cobre o Esc, que fecha o dialog sem passar pelos botões.
        const aoFechar = () => encerrar(false);

        sim.addEventListener('click', aoConfirmar);
        nao.addEventListener('click', aoCancelar);
        dialogo.addEventListener('close', aoFechar);

        dialogo.showModal();
        nao.focus();
    });
}

async function excluirProduto(id) {
    const produto = (window.__produtos || []).find((p) => p.id === id);
    const nome = produto ? produto.nome : `#${id}`;

    const confirmado = await confirmar({
        titulo: 'Excluir produto',
        texto: `Excluir "${nome}" definitivamente?`,
        detalhe: 'Pedidos antigos mantêm o nome e o preço da época, mas perdem o vínculo com o produto. '
            + 'Para apenas tirar da loja, use Editar e escolha "Fora do catálogo".'
    });

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
                ${pedido.desconto > 0
                    ? linha(`Desconto${pedido.cupom ? ` (cupom ${escapeHtml(pedido.cupom)})` : ''}`, `− ${formatarMoeda(pedido.desconto)}`)
                    : ''}
                ${linha('Frete', formatarMoeda(pedido.frete))}
                ${linha('Total', formatarMoeda(pedido.total))}
            </div>`;
    } catch (erro) {
        corpo.innerHTML = `<div class="aviso aviso-erro">${escapeHtml(erro.message)}</div>`;
    }
}

// --------------------------------------------------------------------------
// Cupons
// --------------------------------------------------------------------------

let cupons = [];
let cupomEmEdicao = null;

// O campo datetime-local fala em horário deste computador, sem fuso; o banco
// guarda o instante (TIMESTAMPTZ). A conversão acontece aqui, nas duas mãos,
// para "vale até 23:59" significar 23:59 de quem cadastrou.
function paraCampoDataHora(iso) {
    if (!iso) return '';
    const data = new Date(iso);
    const dois = (n) => String(n).padStart(2, '0');
    return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}T${dois(data.getHours())}:${dois(data.getMinutes())}`;
}

function doCampoDataHora(valor) {
    return valor ? new Date(valor).toISOString() : null;
}

function descreverDesconto(cupom) {
    return cupom.tipo === 'percentual'
        ? `${String(cupom.valor).replace('.', ',')}%`
        : formatarMoeda(cupom.valor);
}

function descreverValidade(cupom) {
    if (!cupom.validoDe && !cupom.validoAte) return '<span class="muted">sem limite</span>';
    const de = cupom.validoDe ? formatarData(cupom.validoDe) : 'agora';
    const ate = cupom.validoAte ? formatarData(cupom.validoAte) : 'sem fim';
    return `${de} → ${ate}`;
}

function pillDeCupom(cupom) {
    if (!cupom.ativo) return '<span class="pill pill-off">Desativado</span>';
    if (cupom.validoAte && new Date(cupom.validoAte) < new Date()) return '<span class="pill pill-off">Expirado</span>';
    if (cupom.usoMaximo !== null && cupom.usos >= cupom.usoMaximo) return '<span class="pill pill-warn">Esgotado</span>';
    if (cupom.validoDe && new Date(cupom.validoDe) > new Date()) return '<span class="pill pill-warn">Agendado</span>';
    return '<span class="pill pill-ok">Ativo</span>';
}

async function carregarCupons() {
    const corpo = document.getElementById('listaCupons');

    try {
        const dados = await chamarApi('/admin/cupons');
        cupons = dados.cupons;

        if (cupons.length === 0) {
            corpo.innerHTML = '<tr><td colspan="8" class="muted">Nenhum cupom cadastrado.</td></tr>';
            return;
        }

        corpo.innerHTML = cupons.map((cupom) => `
            <tr>
                <td><strong>${escapeHtml(cupom.codigo)}</strong></td>
                <td class="num">${descreverDesconto(cupom)}</td>
                <td class="num">${cupom.valorMinimoPedido > 0 ? formatarMoeda(cupom.valorMinimoPedido) : '<span class="muted">—</span>'}</td>
                <td>${descreverValidade(cupom)}</td>
                <td class="num">${cupom.usos} / ${cupom.usoMaximo === null ? '—' : cupom.usoMaximo}</td>
                <td class="num">${cupom.usoMaximoPorUsuario}</td>
                <td>${pillDeCupom(cupom)}</td>
                <td>
                    <div class="acoes">
                        <button class="btn btn-secondary btn-sm" type="button" data-editar-cupom="${cupom.id}">Editar</button>
                        <button class="btn btn-secondary btn-sm" type="button" data-alternar-cupom="${cupom.id}">
                            ${cupom.ativo ? 'Desativar' : 'Ativar'}
                        </button>
                    </div>
                </td>
            </tr>`).join('');
    } catch (erro) {
        corpo.innerHTML = `<tr><td colspan="8" class="muted">${escapeHtml(erro.message)}</td></tr>`;
    }
}

function abrirDialogCupom(cupom) {
    cupomEmEdicao = cupom ? cupom.id : null;

    document.getElementById('dialogCupomTitulo').textContent = cupom ? `Editar cupom ${cupom.codigo}` : 'Novo cupom';
    document.getElementById('erroCupom').classList.add('hidden');
    document.getElementById('campoCodigoCupom').value = cupom ? cupom.codigo : '';
    document.getElementById('campoTipoCupom').value = cupom ? cupom.tipo : 'percentual';
    document.getElementById('campoValorCupom').value = cupom ? cupom.valor : '';
    document.getElementById('campoMinimoCupom').value = cupom && cupom.valorMinimoPedido > 0 ? cupom.valorMinimoPedido : '';
    document.getElementById('campoAtivoCupom').value = cupom ? String(cupom.ativo) : 'true';
    document.getElementById('campoUsoMaximo').value = cupom && cupom.usoMaximo !== null ? cupom.usoMaximo : '';
    document.getElementById('campoUsoPorCliente').value = cupom ? cupom.usoMaximoPorUsuario : 1;
    document.getElementById('campoValidoDe').value = cupom ? paraCampoDataHora(cupom.validoDe) : '';
    document.getElementById('campoValidoAte').value = cupom ? paraCampoDataHora(cupom.validoAte) : '';

    document.getElementById('dialogCupom').showModal();
}

async function salvarCupom(evento) {
    evento.preventDefault();

    const erroBox = document.getElementById('erroCupom');
    const botao = document.getElementById('salvarCupomBtn');

    // Vazio segue vazio: o servidor lê como "sem limite" / "sem data".
    const corpo = {
        codigo: document.getElementById('campoCodigoCupom').value,
        tipo: document.getElementById('campoTipoCupom').value,
        valor: document.getElementById('campoValorCupom').value,
        valorMinimoPedido: document.getElementById('campoMinimoCupom').value,
        ativo: document.getElementById('campoAtivoCupom').value === 'true',
        usoMaximo: document.getElementById('campoUsoMaximo').value,
        usoMaximoPorUsuario: document.getElementById('campoUsoPorCliente').value,
        validoDe: doCampoDataHora(document.getElementById('campoValidoDe').value),
        validoAte: doCampoDataHora(document.getElementById('campoValidoAte').value)
    };

    botao.disabled = true;

    try {
        if (cupomEmEdicao) {
            await chamarApi(`/admin/cupons/${cupomEmEdicao}`, { method: 'PUT', body: JSON.stringify(corpo) });
            avisar('Cupom atualizado.');
        } else {
            await chamarApi('/admin/cupons', { method: 'POST', body: JSON.stringify(corpo) });
            avisar('Cupom criado.');
        }

        document.getElementById('dialogCupom').close();
        await carregarCupons();
    } catch (erro) {
        erroBox.textContent = erro.message;
        erroBox.classList.remove('hidden');
    } finally {
        botao.disabled = false;
    }
}

// Ativar/desativar sem confirmação: é reversível com o mesmo botão, e
// desativar não apaga nada — pedidos antigos seguem apontando para o cupom.
async function alternarCupom(id) {
    const cupom = cupons.find((c) => c.id === id);
    if (!cupom) return;

    try {
        await chamarApi(`/admin/cupons/${id}`, { method: 'PUT', body: JSON.stringify({ ativo: !cupom.ativo }) });
        avisar(cupom.ativo ? `Cupom ${cupom.codigo} desativado.` : `Cupom ${cupom.codigo} ativado.`);
        await carregarCupons();
    } catch (erro) {
        avisar(erro.message, 'erro');
    }
}

// --------------------------------------------------------------------------
// Inicialização
// --------------------------------------------------------------------------

async function iniciar() {
    if (!hasValidSession()) {
        bloquear('Você não está autenticado', 'Entre com uma conta de administrador para acessar o painel.', true);
        return;
    }

    let dados;

    try {
        // Sem redirecionar: o painel tem a própria tela de bloqueio.
        dados = await chamarApi('/auth/me', { redirecionarSeDeslogado: false });
    } catch (erro) {
        encerrarSessaoLocal();
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
    await carregarCupons();
}

document.addEventListener('DOMContentLoaded', () => {
    iniciar();

    document.querySelectorAll('.aba').forEach((aba) => {
        aba.addEventListener('click', () => {
            document.querySelectorAll('.aba').forEach((outra) => outra.classList.remove('active'));
            aba.classList.add('active');

            const alvo = aba.dataset.aba;
            document.getElementById('abaProdutos').classList.toggle('hidden', alvo !== 'produtos');
            document.getElementById('abaPedidos').classList.toggle('hidden', alvo !== 'pedidos');
            document.getElementById('abaCupons').classList.toggle('hidden', alvo !== 'cupons');
        });
    });

    document.getElementById('novoProdutoBtn').addEventListener('click', () => abrirDialogProduto(null));
    document.getElementById('formProduto').addEventListener('submit', salvarProduto);
    document.getElementById('novoCupomBtn').addEventListener('click', () => abrirDialogCupom(null));
    document.getElementById('formCupomAdmin').addEventListener('submit', salvarCupom);
    configurarPrevia();

    document.getElementById('sairBtn').addEventListener('click', logoutUser);

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
        const editarCupom = evento.target.closest('[data-editar-cupom]');
        if (editarCupom) {
            const cupom = cupons.find((c) => c.id === Number(editarCupom.dataset.editarCupom));
            if (cupom) abrirDialogCupom(cupom);
            return;
        }

        const alternar = evento.target.closest('[data-alternar-cupom]');
        if (alternar) {
            alternarCupom(Number(alternar.dataset.alternarCupom));
            return;
        }

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
