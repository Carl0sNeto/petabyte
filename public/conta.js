// Central da conta: compras, avaliações e configurações.
//
// Carrega depois de script.js, de quem reaproveita apiUrl, lerResposta,
// escapeHtml, iniciaisDoNome, hasValidSession e logoutUser.

const SECOES = {
    compras: 'secaoCompras',
    avaliacoes: 'secaoAvaliacoes',
    dados: 'secaoDados'
};

let usuarioAtual = null;

// --------------------------------------------------------------------------
// Avisos
// --------------------------------------------------------------------------

let timerAvisoConta = null;

function avisarConta(texto, tipo = 'ok') {
    const caixa = document.getElementById('avisoConta');
    caixa.textContent = texto;
    caixa.className = `aviso-conta ${tipo === 'erro' ? 'aviso-conta-erro' : 'aviso-conta-ok'}`;

    clearTimeout(timerAvisoConta);
    timerAvisoConta = setTimeout(() => caixa.classList.add('hidden'), 6000);
}

async function chamarConta(caminho, opcoes = {}) {
    const token = localStorage.getItem('petabyte-token');

    const resposta = await fetch(apiUrl(caminho), {
        ...opcoes,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(opcoes.headers || {})
        }
    });

    const dados = await lerResposta(resposta);

    if (!resposta.ok) {
        const falha = new Error(dados.mensagem || `Falha na requisição (${resposta.status}).`);
        falha.status = resposta.status;
        throw falha;
    }

    return dados;
}

// --------------------------------------------------------------------------
// Navegação entre seções
// --------------------------------------------------------------------------

function mostrarSecao(nome) {
    const alvo = SECOES[nome] ? nome : 'compras';

    Object.entries(SECOES).forEach(([chave, id]) => {
        document.getElementById(id).classList.toggle('hidden', chave !== alvo);
    });

    document.querySelectorAll('#abasConta .aba').forEach((aba) => {
        aba.classList.toggle('active', aba.dataset.secao === alvo);
    });

    // Mantém a âncora na URL para o menu do cabeçalho poder apontar direto,
    // sem recarregar a página quando já se está aqui.
    if (window.location.hash !== `#${alvo}`) {
        history.replaceState(null, '', `#${alvo}`);
    }
}

// --------------------------------------------------------------------------
// Seções
// --------------------------------------------------------------------------

function renderCabecalho(usuario) {
    document.getElementById('avatarGrande').textContent = iniciaisDoNome(usuario.nome);
    document.getElementById('contaNome').textContent = `Bem-vindo, ${usuario.nome}`;
    document.getElementById('contaEmail').textContent = usuario.email;

    if (usuario.criado_em) {
        const desde = new Date(usuario.criado_em).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        document.getElementById('contaDesde').textContent = `Cliente desde ${desde}`;
    }

    document.getElementById('cabecalhoConta').classList.remove('hidden');
}

function renderCompras(compras) {
    const lista = document.getElementById('ordersList');
    document.getElementById('resumoCompras').textContent =
        compras.length === 0 ? 'Nenhuma ainda' : `${compras.length} no histórico`;

    if (compras.length === 0) {
        lista.innerHTML = '<div class="estado-vazio">Você ainda não fez nenhuma compra.</div>';
        return;
    }

    lista.innerHTML = compras.map((item) => `
        <div class="pedido">
            <strong>${escapeHtml(item.pedido)}</strong>
            <span class="muted">Status: ${escapeHtml(item.status)}</span>
        </div>`).join('');
}

async function carregarMinhasAvaliacoes() {
    const caixa = document.getElementById('minhasAvaliacoes');

    try {
        const dados = await chamarConta('/auth/me/avaliacoes');
        const itens = dados.avaliacoes;

        document.getElementById('resumoMinhasAvaliacoes').textContent =
            itens.length === 0 ? 'Nenhuma ainda' : `${itens.length} no total`;

        if (itens.length === 0) {
            caixa.innerHTML = '<div class="estado-vazio">'
                + 'Você ainda não avaliou nenhum produto. Só é possível avaliar o que você comprou.'
                + '</div>';
            return;
        }

        caixa.innerHTML = `<div class="lista-minhas-avaliacoes">${itens.map((a) => {
            const foto = a.produto.imagemUrl
                ? `<img src="${escapeHtml(a.produto.imagemUrl)}" alt="">`
                : '<span class="sem-foto-mini">—</span>';

            // Produto fora do catálogo continua listado, mas sem link: a página
            // pública responderia 404.
            const nome = a.produto.ativo
                ? `<a href="produto.html?id=${a.produto.id}">${escapeHtml(a.produto.nome)}</a>`
                : `${escapeHtml(a.produto.nome)} <span class="muted">(fora do catálogo)</span>`;

            return `
                <article class="minha-avaliacao">
                    <div class="minha-avaliacao-foto">${foto}</div>
                    <div>
                        <div class="minha-avaliacao-produto">${nome}</div>
                        <div class="avaliacao-cabecalho">
                            ${estrelasSimples(a.nota)}
                            <span class="data">${new Date(a.criadoEm).toLocaleDateString('pt-BR')}</span>
                        </div>
                        ${a.titulo ? `<h3>${escapeHtml(a.titulo)}</h3>` : ''}
                        ${a.comentario ? `<p>${escapeHtml(a.comentario)}</p>` : ''}
                    </div>
                </article>`;
        }).join('')}</div>`;
    } catch (erro) {
        caixa.innerHTML = `<div class="estado-vazio">${escapeHtml(erro.message)}</div>`;
    }
}

function preencherFormularioDados(usuario) {
    document.getElementById('campoNomeConta').value = usuario.nome;
    document.getElementById('campoEmailConta').value = usuario.email;
}

// --------------------------------------------------------------------------
// Formulários
// --------------------------------------------------------------------------

async function salvarDados(evento) {
    evento.preventDefault();

    const botao = evento.target.querySelector('button[type="submit"]');
    const nome = document.getElementById('campoNomeConta').value.trim();

    botao.disabled = true;

    try {
        const dados = await chamarConta('/auth/me', { method: 'PUT', body: JSON.stringify({ nome }) });

        usuarioAtual = dados.usuario;

        // O menu do cabeçalho lê do localStorage; sem atualizar, o avatar
        // continuaria mostrando as iniciais antigas até o próximo login.
        localStorage.setItem('petabyte-user', JSON.stringify(dados.usuario));

        renderCabecalho(dados.usuario);
        renderMenuConta();
        avisarConta('Dados atualizados.');
    } catch (erro) {
        avisarConta(erro.message, 'erro');
    } finally {
        botao.disabled = false;
    }
}

async function trocarSenha(evento) {
    evento.preventDefault();

    const botao = evento.target.querySelector('button[type="submit"]');
    const senhaAtual = document.getElementById('campoSenhaAtual').value;
    const novaSenha = document.getElementById('campoSenhaNova').value;
    const confirmacao = document.getElementById('campoSenhaConfirma').value;

    if (novaSenha !== confirmacao) {
        avisarConta('A confirmação não confere com a nova senha.', 'erro');
        return;
    }

    botao.disabled = true;

    try {
        const dados = await chamarConta('/auth/alterar-senha', {
            method: 'POST',
            body: JSON.stringify({ senhaAtual, novaSenha })
        });

        evento.target.reset();
        avisarConta(`${dados.mensagem} ${dados.aviso || ''}`.trim());
    } catch (erro) {
        avisarConta(erro.message, 'erro');
    } finally {
        botao.disabled = false;
    }
}

// --------------------------------------------------------------------------
// Início
// --------------------------------------------------------------------------

async function iniciarConta() {
    if (!hasValidSession()) {
        document.getElementById('semSessao').classList.remove('hidden');
        return;
    }

    try {
        const dados = await chamarConta('/auth/me');
        usuarioAtual = dados.usuario;

        renderCabecalho(dados.usuario);
        preencherFormularioDados(dados.usuario);
        renderCompras(dados.compras || []);

        document.getElementById('conteudoConta').classList.remove('hidden');

        // A âncora vem do menu do cabeçalho (#compras, #avaliacoes, #dados).
        mostrarSecao((window.location.hash || '#compras').slice(1));

        await carregarMinhasAvaliacoes();
    } catch (erro) {
        console.error(erro);
        localStorage.removeItem('petabyte-token');
        localStorage.removeItem('petabyte-user');
        document.getElementById('semSessao').classList.remove('hidden');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    iniciarConta();

    document.querySelectorAll('#abasConta .aba').forEach((aba) => {
        aba.addEventListener('click', () => mostrarSecao(aba.dataset.secao));
    });

    document.getElementById('irParaDados').addEventListener('click', () => mostrarSecao('dados'));
    document.getElementById('formDados').addEventListener('submit', salvarDados);
    document.getElementById('formSenha').addEventListener('submit', trocarSenha);
    document.getElementById('logoutBtn').addEventListener('click', logoutUser);

    // Voltar/avançar do navegador troca a seção sem recarregar.
    window.addEventListener('hashchange', () => mostrarSecao((window.location.hash || '#compras').slice(1)));
});
