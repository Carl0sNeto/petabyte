// Sessão e chamadas à API, compartilhadas pela loja (script.js, conta.js,
// produto.js) e pelo painel (admin.js). Carrega ANTES deles em toda página.
//
// Arquivo próprio, e não dentro de script.js, porque o painel não carrega
// script.js — e é justamente a lógica de renovar sessão que não pode existir
// em três cópias que divergem com o tempo.
//
// A sessão vive em cookies httpOnly que este código não lê. O que fica no
// localStorage (petabyte-user) é só cache de exibição — nome e e-mail para o
// cabeçalho —; a autorização de verdade é sempre conferida no servidor.

const AUTH_KEY = 'petabyte-user';

// Resquício do login antigo, em que o JWT ficava no localStorage ao alcance de
// qualquer script da página. O servidor não aceita mais esse token; apagá-lo
// só tira do navegador uma credencial que não tem mais uso.
localStorage.removeItem('petabyte-token');

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

// --------------------------------------------------------------------------
// Cache local do usuário
// --------------------------------------------------------------------------

function getLoggedUser() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    } catch (error) {
        console.error('Erro ao ler usuário:', error);
        localStorage.removeItem(AUTH_KEY);
        return null;
    }
}

function salvarUsuarioLocal(usuario) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(usuario));
}

function encerrarSessaoLocal() {
    localStorage.removeItem(AUTH_KEY);
}

// Otimista: o token é httpOnly e não dá para conferi-lo daqui. Serve para o
// cabeçalho aparecer logado sem esperar a rede; a confirmação real acontece
// quando a página chama uma rota autenticada.
function hasValidSession() {
    return Boolean(getLoggedUser());
}

// --------------------------------------------------------------------------
// Chamadas à API
// --------------------------------------------------------------------------

const METODOS_SEM_CSRF = ['GET', 'HEAD', 'OPTIONS'];

function lerCookie(nome) {
    const par = document.cookie.split('; ').find((item) => item.startsWith(`${nome}=`));
    return par ? decodeURIComponent(par.slice(nome.length + 1)) : '';
}

// Uma requisição, sem retry. Manda os cookies e, em escrita, o header de CSRF
// com o valor do cookie csrf_token — o servidor confere que os dois batem.
// Login e cadastro usam esta direto: ali, 401 é senha errada, não sessão
// vencida, e tentar renovar não faria sentido.
function requisitar(caminho, opcoes = {}) {
    const metodo = (opcoes.method || 'GET').toUpperCase();
    const cabecalhos = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };

    if (!METODOS_SEM_CSRF.includes(metodo)) {
        const csrf = lerCookie('csrf_token');
        if (csrf) cabecalhos['X-CSRF-Token'] = csrf;
    }

    return fetch(apiUrl(caminho), {
        ...opcoes,
        method: metodo,
        headers: cabecalhos,
        credentials: 'include'
    });
}

// Quando o access token expira, várias chamadas podem receber 401 juntas.
// Todas esperam a MESMA renovação: duas renovações paralelas mandariam o mesmo
// refresh token, e o servidor leria a segunda como reuso e derrubaria a sessão.
let renovacaoEmAndamento = null;

function renovarSessao() {
    if (!renovacaoEmAndamento) {
        renovacaoEmAndamento = requisitar('/auth/refresh', { method: 'POST' })
            .then(async (resposta) => {
                if (!resposta.ok) return false;

                const dados = await lerResposta(resposta);
                if (dados.usuario) salvarUsuarioLocal(dados.usuario);
                return true;
            })
            .catch(() => false)
            .finally(() => {
                renovacaoEmAndamento = null;
            });
    }

    return renovacaoEmAndamento;
}

// A chamada autenticada de toda a aplicação. Em 401, renova a sessão uma vez
// e repete a chamada uma vez. Se ainda der 401, a sessão acabou: limpa o
// cache local e, por padrão, leva para o login. Páginas que têm tela própria
// de "sem sessão" (conta, painel) passam redirecionarSeDeslogado: false.
async function chamarApi(caminho, opcoes = {}) {
    const { redirecionarSeDeslogado = true, ...opcoesFetch } = opcoes;

    let resposta = await requisitar(caminho, opcoesFetch);

    if (resposta.status === 401) {
        await renovarSessao();

        // Repete mesmo se a renovação falhou: outra aba pode ter renovado no
        // mesmo instante, e os cookies novos dela já valem para esta. Repetir
        // um POST é seguro aqui porque o 401 veio antes de a rota agir.
        resposta = await requisitar(caminho, opcoesFetch);

        if (resposta.status === 401) {
            encerrarSessaoLocal();

            const falha = new Error('Sua sessão expirou. Entre novamente.');
            falha.status = 401;
            falha.sessaoEncerrada = true;

            if (redirecionarSeDeslogado) {
                window.location.href = 'auth.html';
            }

            throw falha;
        }
    }

    const dados = await lerResposta(resposta);

    if (!resposta.ok) {
        const falha = new Error(dados.mensagem || `Falha na requisição (${resposta.status}).`);
        falha.status = resposta.status;
        throw falha;
    }

    return dados;
}

// Revoga a sessão no servidor antes de limpar o navegador. Antes, sair só
// apagava o localStorage e o token seguia válido até expirar sozinho.
async function logoutUser() {
    try {
        await requisitar('/auth/logout', { method: 'POST' });
    } catch (erro) {
        // Sem rede, sai do mesmo jeito: o navegador fica deslogado e o token
        // que sobrou no servidor expira sozinho.
        console.error('Não foi possível encerrar a sessão no servidor:', erro);
    }

    encerrarSessaoLocal();
    window.location.href = 'auth.html';
}
