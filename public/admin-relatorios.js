// Painel: seção Relatórios.
//
// Arquivo próprio porque admin.js já cobre produtos, pedidos e cupons. Carrega
// depois dele, de quem usa escapeHtml, formatarMoeda e avisar; e de sessao.js,
// de quem usa chamarApi e apiUrl.
//
// Os números vêm prontos do servidor — período, granularidade, variações. Este
// arquivo só desenha: nenhuma conta de receita acontece aqui.

const estadoRelatorio = {
    preset: '30',
    inicio: null,
    fim: null,
    carregadoUmaVez: false,
    serie: [],
    granularidade: 'day'
};

let rodadaRelatorio = 0;

// --------------------------------------------------------------------------
// Datas
// --------------------------------------------------------------------------

function dataIso(data) {
    const dois = (n) => String(n).padStart(2, '0');
    return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;
}

// "Últimos 7 dias" inclui hoje: de hoje-6 a hoje.
function periodoDoPreset(dias) {
    const fim = new Date();
    const inicio = new Date();
    inicio.setDate(fim.getDate() - (dias - 1));
    return { inicio: dataIso(inicio), fim: dataIso(fim) };
}

// AAAA-MM-DD como data de calendário, sem passar por fuso: new Date('2026-09-01')
// seria meia-noite UTC, que no Brasil ainda é 31/08.
function formatarDia(iso, opcoes = { day: '2-digit', month: '2-digit' }) {
    const [ano, mes, dia] = iso.split('-').map(Number);
    return new Date(ano, mes - 1, dia).toLocaleDateString('pt-BR', opcoes);
}

function rotuloDoBalde(iso, granularidade) {
    return granularidade === 'week'
        ? `Semana de ${formatarDia(iso)}`
        : formatarDia(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });
}

// --------------------------------------------------------------------------
// Cards de resumo
// --------------------------------------------------------------------------

function formatarPercentual(valor) {
    return `${Math.abs(valor).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

// Seta e texto, não só cor: a direção precisa ser legível sem distinguir
// verde de vermelho.
function descreverVariacao(delta, periodoAnterior) {
    const referencia = `vs. ${formatarDia(periodoAnterior.inicio)} a ${formatarDia(periodoAnterior.fim)}`;

    if (delta === null) {
        return `<span class="variacao neutra">Período anterior sem vendas</span>`;
    }

    if (delta === 0) {
        return `<span class="variacao neutra">= igual ao período anterior</span>`;
    }

    const sobe = delta > 0;
    return `
        <span class="variacao ${sobe ? 'sobe' : 'desce'}">
            <span aria-hidden="true">${sobe ? '▲' : '▼'}</span>
            <span class="so-leitor">${sobe ? 'Alta de' : 'Queda de'}</span>
            ${formatarPercentual(delta)}
        </span>
        <span class="variacao-referencia">${referencia}</span>`;
}

function renderResumo({ resumo, periodoAnterior }) {
    const cartao = (rotulo, valor, delta) => `
        <div class="cartao-resumo">
            <span class="cartao-rotulo">${rotulo}</span>
            <strong class="cartao-valor">${valor}</strong>
            <span class="cartao-variacao">${descreverVariacao(delta, periodoAnterior)}</span>
        </div>`;

    document.getElementById('cardsResumo').innerHTML = [
        cartao('Receita', formatarMoeda(resumo.receita), resumo.receitaDeltaPct),
        cartao('Pedidos pagos', resumo.pedidos.toLocaleString('pt-BR'), resumo.pedidosDeltaPct),
        cartao('Ticket médio', formatarMoeda(resumo.ticketMedio), resumo.ticketMedioDeltaPct)
    ].join('');
}

// --------------------------------------------------------------------------
// Gráfico
//
// SVG à mão, sem biblioteca: o projeto não tem etapa de build, e colunas com
// eixo e dica de valor não justificam uma dependência. Uma série só (receita),
// em colunas: cada dia (ou semana) é uma quantidade separada, e os dias sem
// venda aparecem como vazio de verdade, não como uma linha que passa por eles.
// --------------------------------------------------------------------------

const ALTURA_GRAFICO = 240;
const MARGEM = { topo: 12, direita: 8, base: 28, esquerda: 68 };
const LARGURA_MAXIMA_COLUNA = 24;
const RAIO_COLUNA = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

const moedaCompacta = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1
});

// Topo do eixo num número redondo (0, 500, 1.000, 1.500...), com 4 divisões.
function escalaRedonda(maximo) {
    if (!(maximo > 0)) return { topo: 100, passo: 25 };

    const bruto = maximo / 4;
    const potencia = 10 ** Math.floor(Math.log10(bruto));
    const fracao = bruto / potencia;
    const redondo = fracao <= 1 ? 1 : fracao <= 2 ? 2 : fracao <= 2.5 ? 2.5 : fracao <= 5 ? 5 : 10;
    const passo = redondo * potencia;

    return { topo: Math.ceil(maximo / passo) * passo, passo };
}

function elementoSvg(nome, atributos = {}) {
    const elemento = document.createElementNS(SVG_NS, nome);
    for (const [chave, valor] of Object.entries(atributos)) {
        elemento.setAttribute(chave, valor);
    }
    return elemento;
}

// Coluna com a ponta arredondada e a base reta, apoiada na linha do zero.
function caminhoColuna(x, y, largura, altura) {
    const raio = Math.min(RAIO_COLUNA, largura / 2, altura);
    const base = y + altura;
    return `M${x},${base} V${y + raio} Q${x},${y} ${x + raio},${y} `
        + `H${x + largura - raio} Q${x + largura},${y} ${x + largura},${y + raio} V${base} Z`;
}

let indiceEmFoco = -1;

function desenharGrafico() {
    const caixa = document.getElementById('graficoVendas');
    const serie = estadoRelatorio.serie;
    const granularidade = estadoRelatorio.granularidade;

    caixa.innerHTML = '';
    indiceEmFoco = -1;

    const largura = Math.max(caixa.clientWidth, 280);
    const larguraUtil = largura - MARGEM.esquerda - MARGEM.direita;
    const alturaUtil = ALTURA_GRAFICO - MARGEM.topo - MARGEM.base;

    const maximo = Math.max(0, ...serie.map((ponto) => ponto.receita));
    const { topo, passo } = escalaRedonda(maximo);
    const yDoValor = (valor) => MARGEM.topo + alturaUtil - (valor / topo) * alturaUtil;

    const svg = elementoSvg('svg', {
        width: largura,
        height: ALTURA_GRAFICO,
        viewBox: `0 0 ${largura} ${ALTURA_GRAFICO}`,
        'aria-hidden': 'true'
    });

    // Grade e rótulos do eixo: fio fino e cinza, atrás das colunas.
    for (let valor = 0; valor <= topo + passo / 2; valor += passo) {
        const y = yDoValor(valor);
        svg.appendChild(elementoSvg('line', {
            x1: MARGEM.esquerda, x2: largura - MARGEM.direita, y1: y, y2: y,
            class: valor === 0 ? 'eixo-base' : 'eixo-grade'
        }));
        const rotulo = elementoSvg('text', { x: MARGEM.esquerda - 8, y: y + 4, class: 'eixo-rotulo', 'text-anchor': 'end' });
        rotulo.textContent = moedaCompacta.format(valor);
        svg.appendChild(rotulo);
    }

    const faixa = larguraUtil / Math.max(serie.length, 1);
    // A coluna nunca ocupa a faixa inteira: 2px de respiro de cada lado, no
    // mínimo, e no máximo 24px de largura — o que sobra é ar entre elas.
    const larguraColuna = Math.max(1, Math.min(LARGURA_MAXIMA_COLUNA, faixa - 4));

    // Rótulos do eixo X espaçados para caber: ~70px por rótulo.
    const saltoRotulo = Math.max(1, Math.ceil(serie.length / Math.max(1, Math.floor(larguraUtil / 70))));

    const colunas = [];

    serie.forEach((ponto, indice) => {
        const centro = MARGEM.esquerda + faixa * indice + faixa / 2;

        if (ponto.receita > 0) {
            const y = yDoValor(ponto.receita);
            const coluna = elementoSvg('path', {
                d: caminhoColuna(centro - larguraColuna / 2, y, larguraColuna, MARGEM.topo + alturaUtil - y),
                class: 'coluna'
            });
            svg.appendChild(coluna);
            colunas[indice] = coluna;
        }

        if (indice % saltoRotulo === 0) {
            const rotulo = elementoSvg('text', {
                x: centro, y: ALTURA_GRAFICO - 8, class: 'eixo-rotulo', 'text-anchor': 'middle'
            });
            rotulo.textContent = formatarDia(ponto.periodo);
            svg.appendChild(rotulo);
        }
    });

    // Alvos de toque: a faixa inteira de cada dia, da base ao topo — não só
    // os pixels pintados. Um dia sem venda também mostra "R$ 0,00".
    serie.forEach((ponto, indice) => {
        const alvo = elementoSvg('rect', {
            x: MARGEM.esquerda + faixa * indice,
            y: MARGEM.topo,
            width: faixa,
            height: alturaUtil,
            class: 'coluna-alvo'
        });
        alvo.addEventListener('pointerenter', () => destacar(indice));
        alvo.addEventListener('pointerleave', () => destacar(-1));
        svg.appendChild(alvo);
    });

    caixa.appendChild(svg);

    const dica = document.createElement('div');
    dica.className = 'grafico-dica';
    dica.hidden = true;
    caixa.appendChild(dica);

    if (maximo === 0) {
        const vazio = document.createElement('p');
        vazio.className = 'grafico-vazio';
        vazio.textContent = 'Nenhuma venda paga neste período.';
        caixa.appendChild(vazio);
    }

    function destacar(indice) {
        indiceEmFoco = indice;
        colunas.forEach((coluna, i) => coluna && coluna.classList.toggle('ativa', i === indice));

        if (indice < 0 || !serie[indice]) {
            dica.hidden = true;
            return;
        }

        const ponto = serie[indice];

        // textContent, não innerHTML: nada daqui vira marcação.
        dica.replaceChildren();
        const valor = document.createElement('strong');
        valor.textContent = formatarMoeda(ponto.receita);
        const detalhe = document.createElement('span');
        detalhe.textContent = `${ponto.pedidos} ${ponto.pedidos === 1 ? 'pedido' : 'pedidos'} · ${rotuloDoBalde(ponto.periodo, granularidade)}`;
        dica.append(valor, detalhe);
        dica.hidden = false;

        // A dica acompanha a coluna e não vaza pelas bordas do gráfico.
        const centro = MARGEM.esquerda + faixa * indice + faixa / 2;
        const larguraDica = dica.offsetWidth;
        const esquerda = Math.min(Math.max(centro - larguraDica / 2, 0), largura - larguraDica);
        const topoDica = Math.max(0, Math.min(yDoValor(ponto.receita), MARGEM.topo + alturaUtil) - dica.offsetHeight - 8);
        dica.style.left = `${esquerda}px`;
        dica.style.top = `${topoDica}px`;
    }

    caixa.destacar = destacar;
}

// Teclado: o gráfico recebe foco e as setas percorrem os dias, com a mesma
// dica do mouse. A tabela logo abaixo dá o mesmo dado sem precisar de nada disso.
function ligarTecladoDoGrafico() {
    const caixa = document.getElementById('graficoVendas');

    caixa.addEventListener('keydown', (evento) => {
        const total = estadoRelatorio.serie.length;
        if (!total || !caixa.destacar) return;

        const mapa = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
        if (evento.key === 'Escape') {
            caixa.destacar(-1);
            return;
        }
        if (!(evento.key in mapa)) return;

        evento.preventDefault();
        const passo = mapa[evento.key];
        let proximo;
        if (passo === -Infinity) proximo = 0;
        else if (passo === Infinity) proximo = total - 1;
        else proximo = indiceEmFoco < 0 ? 0 : Math.min(total - 1, Math.max(0, indiceEmFoco + passo));

        caixa.destacar(proximo);
    });

    caixa.addEventListener('blur', () => caixa.destacar && caixa.destacar(-1));

    // Redesenha quando o espaço muda (janela, menu, rotação do celular).
    let ultimaLargura = 0;
    new ResizeObserver(([entrada]) => {
        const largura = Math.round(entrada.contentRect.width);
        if (largura !== ultimaLargura && estadoRelatorio.serie.length) {
            ultimaLargura = largura;
            desenharGrafico();
        }
    }).observe(caixa);
}

function renderTabelaSerie() {
    const semanal = estadoRelatorio.granularidade === 'week';
    document.getElementById('colunaPeriodo').textContent = semanal ? 'Semana' : 'Dia';
    document.getElementById('graficoTitulo').textContent = semanal ? 'Receita por semana' : 'Receita por dia';

    document.getElementById('tabelaSerie').innerHTML = estadoRelatorio.serie.map((ponto) => `
        <tr>
            <td>${escapeHtml(rotuloDoBalde(ponto.periodo, estadoRelatorio.granularidade))}</td>
            <td class="num">${formatarMoeda(ponto.receita)}</td>
            <td class="num">${ponto.pedidos}</td>
        </tr>`).join('');
}

// --------------------------------------------------------------------------
// Tabelas
// --------------------------------------------------------------------------

function renderMaisVendidos(lista) {
    const corpo = document.getElementById('listaMaisVendidos');

    if (lista.length === 0) {
        corpo.innerHTML = '<tr><td colspan="3" class="muted">Nenhuma venda paga no período.</td></tr>';
        return;
    }

    corpo.innerHTML = lista.map((item) => `
        <tr>
            <td>${escapeHtml(item.nome)}${item.produtoId === null
                ? ' <span class="pill pill-off">fora do catálogo</span>'
                : ''}</td>
            <td class="num">${item.qtd}</td>
            <td class="num">${formatarMoeda(item.receita)}</td>
        </tr>`).join('');
}

function renderParados({ produtos, diasParaParado }) {
    const corpo = document.getElementById('listaParados');

    document.getElementById('notaParados').textContent =
        `À venda, com estoque, sem venda paga há ${diasParaParado} dias ou mais. `
        + 'Considera todo o histórico de vendas, não o período selecionado acima.';

    if (produtos.length === 0) {
        corpo.innerHTML = '<tr><td colspan="3" class="muted">Nenhum produto parado. Todo o estoque girou nos últimos dias.</td></tr>';
        return;
    }

    corpo.innerHTML = produtos.map((item) => {
        const ultima = item.ultimaVenda === null
            ? '<span class="pill pill-warn">nunca vendido</span>'
            : `${new Date(item.ultimaVenda).toLocaleDateString('pt-BR')} <span class="muted">· há ${item.diasSemVenda} dias</span>`;

        return `
            <tr>
                <td>${escapeHtml(item.nome)}</td>
                <td class="num">${item.estoque}</td>
                <td>${ultima}</td>
            </tr>`;
    }).join('');
}

// --------------------------------------------------------------------------
// Carga
// --------------------------------------------------------------------------

function periodoAtivo() {
    if (estadoRelatorio.preset === 'personalizado') {
        return { inicio: estadoRelatorio.inicio, fim: estadoRelatorio.fim };
    }
    return periodoDoPreset(Number(estadoRelatorio.preset));
}

function atualizarLinkExportar({ inicio, fim }) {
    const query = new URLSearchParams({ inicio, fim });
    document.getElementById('exportarCsv').href = apiUrl(`/admin/relatorios/exportar?${query}`);
}

async function carregarVendas() {
    const minhaRodada = ++rodadaRelatorio;
    const periodo = periodoAtivo();
    const conteudo = document.getElementById('relatorioVendas');
    const erro = document.getElementById('relatorioErro');

    atualizarLinkExportar(periodo);

    // Recarga mantém o desenho anterior, esmaecido, em vez de piscar vazio.
    conteudo.classList.add('recarregando');
    conteudo.setAttribute('aria-busy', 'true');

    try {
        const query = new URLSearchParams(periodo);
        const dados = await chamarApi(`/admin/relatorios/vendas?${query}`, { redirecionarSeDeslogado: false });
        if (minhaRodada !== rodadaRelatorio) return;

        erro.classList.add('hidden');

        document.getElementById('rotuloPeriodo').textContent =
            `${formatarDia(dados.periodo.inicio, { day: '2-digit', month: '2-digit', year: 'numeric' })} a `
            + `${formatarDia(dados.periodo.fim, { day: '2-digit', month: '2-digit', year: 'numeric' })}`
            + ` · ${dados.periodo.dias} dias`
            + (dados.periodo.granularidade === 'week' ? ' · agrupado por semana' : '');

        estadoRelatorio.serie = dados.serie;
        estadoRelatorio.granularidade = dados.periodo.granularidade;

        renderResumo(dados);
        desenharGrafico();
        renderTabelaSerie();
        renderMaisVendidos(dados.maisVendidos);
    } catch (falha) {
        if (minhaRodada !== rodadaRelatorio) return;
        erro.textContent = falha.message;
        erro.classList.remove('hidden');
    } finally {
        if (minhaRodada === rodadaRelatorio) {
            conteudo.classList.remove('recarregando');
            conteudo.setAttribute('aria-busy', 'false');
        }
    }
}

async function carregarParados() {
    try {
        renderParados(await chamarApi('/admin/relatorios/parados', { redirecionarSeDeslogado: false }));
    } catch (falha) {
        document.getElementById('listaParados').innerHTML =
            `<tr><td colspan="3" class="muted">${escapeHtml(falha.message)}</td></tr>`;
    }
}

function escolherPreset(preset) {
    estadoRelatorio.preset = preset;

    document.querySelectorAll('[data-periodo]').forEach((botao) => {
        const ativo = botao.dataset.periodo === preset;
        botao.classList.toggle('active', ativo);
        botao.setAttribute('aria-pressed', String(ativo));
    });

    const personalizado = document.getElementById('periodoPersonalizado');
    personalizado.classList.toggle('hidden', preset !== 'personalizado');

    if (preset === 'personalizado') {
        // Abre preenchido com o período que estava na tela, para ajustar a
        // partir dele em vez de começar do zero.
        const atual = periodoDoPreset(30);
        document.getElementById('campoInicio').value = estadoRelatorio.inicio || atual.inicio;
        document.getElementById('campoFim').value = estadoRelatorio.fim || atual.fim;
        document.getElementById('campoInicio').focus();
        return;
    }

    carregarVendas();
}

// Primeira abertura da seção: carrega tudo. As seguintes só atualizam os
// parados, que mudam com vendas novas mas não com o período.
document.addEventListener('painel:secao', (evento) => {
    if (evento.detail !== 'relatorios') return;

    if (!estadoRelatorio.carregadoUmaVez) {
        estadoRelatorio.carregadoUmaVez = true;
        carregarVendas();
    } else if (estadoRelatorio.serie.length) {
        // A seção estava escondida: o gráfico foi desenhado com largura zero
        // ou numa largura antiga.
        desenharGrafico();
    }
    carregarParados();
});

document.addEventListener('DOMContentLoaded', () => {
    const hoje = dataIso(new Date());
    document.getElementById('campoInicio').max = hoje;
    document.getElementById('campoFim').max = hoje;

    document.querySelectorAll('[data-periodo]').forEach((botao) => {
        botao.addEventListener('click', () => escolherPreset(botao.dataset.periodo));
    });

    document.getElementById('periodoPersonalizado').addEventListener('submit', (evento) => {
        evento.preventDefault();

        const inicio = document.getElementById('campoInicio').value;
        const fim = document.getElementById('campoFim').value;
        const erro = document.getElementById('relatorioErro');

        if (!inicio || !fim || inicio > fim) {
            erro.textContent = 'Escolha a data inicial e a final, com a inicial antes da final.';
            erro.classList.remove('hidden');
            return;
        }

        estadoRelatorio.inicio = inicio;
        estadoRelatorio.fim = fim;
        carregarVendas();
    });

    // O CSV é um link comum, mas o access token dura 15 minutos: quem ficou
    // olhando o gráfico mais que isso baixaria um "sessão expirada" no lugar
    // da planilha. Uma chamada autenticada antes renova a sessão se preciso.
    document.getElementById('exportarCsv').addEventListener('click', async (evento) => {
        if (evento.ctrlKey || evento.metaKey || evento.shiftKey || evento.button !== 0) return;
        evento.preventDefault();

        // Lido antes do await: depois dele, evento.currentTarget já é null.
        const endereco = evento.currentTarget.href;

        try {
            await chamarApi('/auth/me', { redirecionarSeDeslogado: false });
            window.location.href = endereco;
        } catch (falha) {
            avisar(falha.message, 'erro');
        }
    });

    const grafico = document.getElementById('graficoVendas');
    grafico.tabIndex = 0;
    grafico.setAttribute('role', 'group');
    grafico.setAttribute('aria-label', 'Gráfico de receita. Use as setas para percorrer os dias; os mesmos dados estão na tabela logo abaixo.');
    ligarTecladoDoGrafico();
});
