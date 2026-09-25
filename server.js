require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Pool } = require('pg');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Atrás de proxy (Render, Nginx), o IP real vem em X-Forwarded-For. Sem isto,
// o rate limit enxerga todos os visitantes como um único IP e bloqueia geral.
// Localmente fica 0, porque confiar no header sem proxy permitiria forjá-lo.
const CONFIANCA_PROXY = Number(process.env.TRUST_PROXY || 0);

if (CONFIANCA_PROXY > 0) {
    app.set('trust proxy', CONFIANCA_PROXY);
}

// Desliga o fluxo de pagamento sem tirar o resto do ar. Usado no deploy de
// demonstração, onde não há credenciais reais do Mercado Pago.
const CHECKOUT_HABILITADO = process.env.CHECKOUT_HABILITADO !== 'false';

function normalizarListaOrigensCors(valor) {
    if (!valor) return [];
    return valor
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

const corsOrigins = normalizarListaOrigensCors(process.env.CORS_ORIGINS);

function origemEhLoopback(origem) {
    if (!origem) return false;

    try {
        const url = new URL(origem);
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch (erro) {
        return false;
    }
}

function resolverCorsOrigin(origem, callback) {
    if (!origem) {
        return callback(null, true);
    }

    if (corsOrigins.length === 0) {
        return callback(null, true);
    }

    if (corsOrigins.includes(origem) || origemEhLoopback(origem)) {
        return callback(null, true);
    }

    return callback(new Error(`Origem não permitida por CORS: ${origem}`));
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // As páginas usam <script> e style= inline, por isso o 'unsafe-inline'.
            //
            // As entradas accounts.google.com/gsi são do botão "Entrar com
            // Google", conforme a documentação do Google Identity Services. Sem
            // qualquer uma delas o botão simplesmente não aparece, sem erro
            // visível — só no console do navegador. São quatro, não duas:
            // script, frame, connect (endpoints do GIS) e style (folha do botão).
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/client'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
            frameSrc: ['https://accounts.google.com/gsi/'],
            // Qualquer origem https. O catálogo é editável pelo painel, então
            // fixar uma lista de domínios faria as imagens de fornecedores novos
            // serem bloqueadas sem aviso. Só entram URLs cadastradas por um
            // administrador, e imagem não executa código.
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"]
        }
    },
    // O checkout do Mercado Pago acontece por redirecionamento para outro domínio.
    // Também é o que o popup do login com Google exige.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // O padrão do helmet é no-referrer, e o botão do Google precisa saber de
    // qual origem está sendo usado. Valores da documentação do Google Identity
    // Services: strict-origin-when-cross-origin em produção (HTTPS) e
    // no-referrer-when-downgrade para testar em http://localhost.
    referrerPolicy: {
        policy: process.env.NODE_ENV === 'production' ? 'strict-origin-when-cross-origin' : 'no-referrer-when-downgrade'
    }
}));

app.use(cors({
    origin: resolverCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // A sessão vive em cookies. Sem credentials, o navegador descarta os
    // cookies de respostas cross-origin (o front numa porta, a API em outra).
    credentials: true,
    // X-CSRF-Token precisa constar aqui, ou o preflight cross-origin barra
    // toda escrita. Authorization saiu: nenhuma rota lê mais esse header.
    allowedHeaders: ['Content-Type', 'X-CSRF-Token']
}));
app.use(express.json());
app.use(cookieParser());
app.use(exigirCsrf);
app.use((req, res, next) => {
    const inicio = Date.now();
    console.log(`[REQ] ${req.method} ${req.path}`);
    res.on('finish', () => {
        console.log(`[RES] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - inicio}ms)`);
    });
    next();
});
// Serve apenas o front-end. Manter __dirname aqui exporia server.js,
// package.json, o schema SQL e todo o node_modules por HTTP.
// index aponta para a home porque o projeto não tem index.html: sem isso a
// raiz "/" respondia 404.
app.use(express.static(path.join(__dirname, 'public'), { index: 'E-Commerce.html' }));

app.use((erro, req, res, next) => {
    if (erro instanceof SyntaxError && erro.status === 400 && 'body' in erro) {
        return res.status(400).json({ mensagem: 'JSON inválido no corpo da requisição.' });
    }

    return next(erro);
});

// Hospedagens gerenciadas (Render, Railway, Neon) entregam o banco como uma
// única DATABASE_URL. Localmente continuam valendo as variáveis PG* separadas.
function configuracaoDoBanco() {
    if (process.env.DATABASE_URL) {
        return {
            connectionString: process.env.DATABASE_URL,
            // Só vale para URL SEM sslmode. O Neon manda ?sslmode=... na string,
            // e aí o pg ignora esta opção: o sslmode da URL tem precedência.
            // Para desligar TLS de verdade, tire o sslmode da URL também.
            ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
        };
    }

    return {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'postgres',
        password: process.env.PGPASSWORD || '',
        port: Number(process.env.PGPORT || 5432)
    };
}

const pool = new Pool(configuracaoDoBanco());

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error(
        'JWT_SECRET ausente ou muito curto (mínimo de 32 caracteres).\n' +
        'Gere um segredo forte com:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
        'Defina-o no .env (ambiente local) ou nas variáveis de ambiente do serviço\n' +
        '(hospedagem: no Render, em Environment do serviço web).'
    );
    process.exit(1);
}

// Limita tentativas de login por IP para dificultar ataques de força bruta.
const limitadorLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { mensagem: 'Muitas tentativas de login. Tente novamente em alguns minutos.' }
});

// Endpoints de recuperação de senha disparam e-mails: limite mais restrito.
const limitadorSenha = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { mensagem: 'Muitas solicitações. Tente novamente mais tarde.' }
});

// O Mercado Pago reenvia notificações em rajada quando não recebe 200.
// O teto é alto para não descartar retentativas legítimas.
const limitadorWebhook = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { recebido: false, motivo: 'muitas notificações' }
});

let avisouWebhookSemSegredo = false;

function avisarWebhookSemSegredo() {
    if (avisouWebhookSemSegredo) return;
    avisouWebhookSemSegredo = true;
    console.warn(
        '[WEBHOOK] MP_WEBHOOK_SECRET não configurado: as notificações do Mercado Pago ' +
        'estão sendo aceitas sem verificação de assinatura. Defina o segredo no .env.'
    );
}

// Painel administrativo. O teto é generoso porque uma sessão de trabalho faz
// muitas requisições legítimas, mas ainda limita varredura automatizada.
const limitadorAdmin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 400,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { mensagem: 'Muitas requisições ao painel. Aguarde alguns minutos.' }
});

// Cadastro público (newsletter e criação de conta).
const limitadorCadastro = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { mensagem: 'Muitas solicitações. Tente novamente mais tarde.' }
});

// Validação de cupom. Só conta tentativa com código que não existe — é assim
// que se descobre cupom no chute. O carrinho revalida o cupom a cada mudança
// de quantidade, e isso, com um código real, não gasta nada do limite.
const limitadorCupom = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.locals.cupomEncontrado === true,
    message: { mensagem: 'Muitas tentativas de cupom. Tente novamente em alguns minutos.' }
});

function getBaseUrl(req) {
    if (process.env.APP_BASE_URL) {
        return process.env.APP_BASE_URL;
    }

    return `${req.protocol}://${req.get('host')}`;
}

function getMercadoPagoClient() {
    const accessToken = process.env.MP_ACCESS_TOKEN;

    if (!accessToken) {
        throw new Error('MP_ACCESS_TOKEN não configurado.');
    }

    return new MercadoPagoConfig({ accessToken });
}

function mapearStatusPagamento(status) {
    const mapa = {
        approved: 'Pago',
        pending: 'Aguardando pagamento',
        in_process: 'Em análise',
        rejected: 'Recusado',
        cancelled: 'Cancelado',
        refunded: 'Reembolsado',
        charged_back: 'Chargeback'
    };

    return mapa[status] || 'Em processamento';
}

function extrairHistoricoId(externalReference) {
    if (!externalReference || typeof externalReference !== 'string') {
        return null;
    }

    const correspondencia = externalReference.match(/^hc_(\d+)$/);
    if (!correspondencia) {
        return null;
    }

    return Number(correspondencia[1]);
}

const LIMITE_ITENS_CARRINHO = 20;
const LIMITE_QUANTIDADE_ITEM = 10;

function validarFormatoCarrinho(itens) {
    if (!Array.isArray(itens) || itens.length === 0) {
        return { valido: false, mensagem: 'O carrinho está vazio.' };
    }

    if (itens.length > LIMITE_ITENS_CARRINHO) {
        return { valido: false, mensagem: `O carrinho aceita no máximo ${LIMITE_ITENS_CARRINHO} produtos distintos.` };
    }

    const idsVistos = new Set();

    for (const item of itens) {
        const id = Number(item && item.id);
        const quantidade = Number(item && item.quantidade);

        if (!Number.isInteger(id) || id <= 0) {
            return { valido: false, mensagem: 'Há itens com identificador inválido no carrinho.' };
        }

        if (idsVistos.has(id)) {
            return { valido: false, mensagem: 'O mesmo produto aparece mais de uma vez no carrinho.' };
        }

        idsVistos.add(id);

        if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > LIMITE_QUANTIDADE_ITEM) {
            return { valido: false, mensagem: `Quantidade inválida. Máximo de ${LIMITE_QUANTIDADE_ITEM} unidades por produto.` };
        }
    }

    return { valido: true };
}

// Monta os itens do checkout lendo nome e preço SEMPRE do banco.
// O cliente envia apenas { id, quantidade }; qualquer preço que ele mande é
// ignorado. Sem isto, era possível pagar R$ 0,01 em qualquer produto.
async function resolverItensCarrinho(itens, executor = pool) {
    const formato = validarFormatoCarrinho(itens);

    if (!formato.valido) {
        return { ok: false, mensagem: formato.mensagem };
    }

    const ids = itens.map((item) => Number(item.id));
    const resultado = await executor.query(
        'SELECT id, nome, preco, estoque FROM produtos WHERE id = ANY($1::int[]) AND ativo = TRUE',
        [ids]
    );

    const produtosPorId = new Map(resultado.rows.map((linha) => [linha.id, linha]));
    const resolvidos = [];

    for (const item of itens) {
        const id = Number(item.id);
        const quantidade = Number(item.quantidade);
        const produto = produtosPorId.get(id);

        if (!produto) {
            return { ok: false, mensagem: 'Há produtos indisponíveis no carrinho. Atualize a página e tente novamente.' };
        }

        if (produto.estoque < quantidade) {
            return { ok: false, mensagem: `Estoque insuficiente para "${produto.nome}". Disponível: ${produto.estoque}.` };
        }

        resolvidos.push({
            produtoId: produto.id,
            title: produto.nome,
            quantity: quantidade,
            currency_id: 'BRL',
            unit_price: Number(Number(produto.preco).toFixed(2))
        });
    }

    return { ok: true, itens: resolvidos };
}

// Frete fixo, sem faixa de frete grátis: a loja passou a dar desconto por
// cupom, e o cupom mexe só nos produtos. public/script.js espelha este valor
// para exibição (getShipping); mudou aqui, muda lá.
const VALOR_FRETE = 19.9;

function calcularFrete() {
    return VALOR_FRETE;
}

// ---------------------------------------------------------------------------
// Cupons de desconto
// ---------------------------------------------------------------------------
//
// Mesma regra do preço: o carrinho manda só o código, e o desconto é
// recalculado do zero no servidor em toda etapa. Nada que uma validação
// anterior devolveu ao navegador é reaproveitado.
//
// Dinheiro em centavos inteiros: em ponto flutuante, somas e percentuais de
// valores como 0,1 e 0,2 deixam resíduos que viram um centavo a mais ou a menos.

function paraCentavos(valor) {
    return Math.round(Number(valor) * 100);
}

function deCentavos(centavos) {
    return centavos / 100;
}

function formatarReais(valor) {
    return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizarCodigoCupom(codigo) {
    return String(codigo === undefined || codigo === null ? '' : codigo).trim().toUpperCase();
}

// Checa na ordem da spec, com motivo específico em cada recusa: o carrinho
// mostra a mensagem, e "cupom inválido" não diz à pessoa o que fazer.
// `encontrado` alimenta o rate limit: só código inexistente conta tentativa.
async function validarCupom(codigo, usuarioId, subtotal, executor = pool) {
    const normalizado = normalizarCodigoCupom(codigo);

    if (!normalizado) {
        return { valido: false, encontrado: false, motivo: 'Informe o código do cupom.' };
    }

    // Validade comparada no banco: valido_de/valido_ate são TIMESTAMPTZ e NOW()
    // é o mesmo relógio, sem depender do fuso do processo.
    const resultado = await executor.query(
        `SELECT c.id, c.codigo, c.tipo, c.valor, c.ativo, c.valor_minimo_pedido,
                c.uso_maximo, c.uso_maximo_por_usuario,
                c.valido_de IS NOT NULL AND c.valido_de > NOW() AS ainda_nao_vale,
                c.valido_ate IS NOT NULL AND c.valido_ate < NOW() AS expirado,
                (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = c.id)::int AS usos,
                (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = c.id AND u.usuario_id = $2)::int AS usos_do_usuario
           FROM cupons c
          WHERE c.codigo = $1`,
        [normalizado, usuarioId]
    );

    if (resultado.rowCount === 0) {
        return { valido: false, encontrado: false, motivo: 'Cupom não encontrado.' };
    }

    const cupom = resultado.rows[0];
    const recusa = (motivo) => ({ valido: false, encontrado: true, motivo });

    if (!cupom.ativo) return recusa('Este cupom não está mais ativo.');
    if (cupom.ainda_nao_vale) return recusa('Este cupom ainda não começou a valer.');
    if (cupom.expirado) return recusa('Este cupom expirou.');

    const subtotalCentavos = paraCentavos(subtotal);

    if (subtotalCentavos < paraCentavos(cupom.valor_minimo_pedido)) {
        return recusa(`Este cupom vale para pedidos a partir de ${formatarReais(cupom.valor_minimo_pedido)}.`);
    }

    if (cupom.uso_maximo !== null && cupom.usos >= cupom.uso_maximo) {
        return recusa('Este cupom atingiu o limite de usos.');
    }

    if (cupom.usos_do_usuario >= cupom.uso_maximo_por_usuario) {
        return recusa('Você já usou este cupom o número máximo de vezes.');
    }

    // Percentual sobre o subtotal; fixo limitado ao subtotal, para o total
    // dos produtos nunca ficar negativo. O frete fica de fora dos dois.
    const descontoCentavos = cupom.tipo === 'percentual'
        ? Math.round((subtotalCentavos * Number(cupom.valor)) / 100)
        : Math.min(paraCentavos(cupom.valor), subtotalCentavos);

    return {
        valido: true,
        encontrado: true,
        cupom: { id: cupom.id, codigo: cupom.codigo, tipo: cupom.tipo, valor: Number(cupom.valor) },
        desconto: deCentavos(descontoCentavos)
    };
}

// Monta o pedido a partir do corpo da requisição, do zero: itens e preços do
// banco, desconto do cupom recalculado. /cupons/validar e /pagamentos/criar
// passam os dois por aqui, então a prévia do carrinho e o valor cobrado são a
// mesma conta. Desconto, total ou preço que venham no corpo nem são lidos.
async function prepararCheckout(corpo, usuario) {
    const resolucao = await resolverItensCarrinho(corpo && corpo.itens);

    if (!resolucao.ok) {
        return { ok: false, origem: 'carrinho', mensagem: resolucao.mensagem };
    }

    const subtotalCentavos = resolucao.itens.reduce(
        (soma, item) => soma + paraCentavos(item.unit_price) * item.quantity,
        0
    );
    const subtotal = deCentavos(subtotalCentavos);

    let desconto = 0;
    let cupom = null;
    let cupomEncontrado = false;
    const codigo = normalizarCodigoCupom(corpo && corpo.cupom);

    if (codigo) {
        const validacao = await validarCupom(codigo, usuario.id, subtotal);
        cupomEncontrado = validacao.encontrado;

        if (!validacao.valido) {
            return { ok: false, origem: 'cupom', mensagem: validacao.motivo, cupomEncontrado };
        }

        desconto = validacao.desconto;
        cupom = validacao.cupom;
    }

    // O cupom mexe só nos produtos, nunca no frete: um cupom de 100% ainda
    // deixa o frete a pagar.
    const frete = calcularFrete();
    const total = deCentavos(subtotalCentavos - paraCentavos(desconto) + paraCentavos(frete));

    // Com frete fixo o total nunca chega a zero; a guarda fica para o dia em
    // que o frete puder ser zero de novo. O Mercado Pago não cobra zero.
    if (total <= 0) {
        return {
            ok: false,
            origem: 'cupom',
            mensagem: 'Este cupom cobre o pedido inteiro, e o Mercado Pago não processa pagamento de valor zero.',
            cupomEncontrado
        };
    }

    return { ok: true, itens: resolucao.itens, subtotal, desconto, frete, total, cupom, cupomEncontrado };
}

// O Mercado Pago não aceita item de preço negativo, então o desconto não entra
// como linha própria. Com cupom, os produtos seguem num item só, já com o
// desconto; sem cupom, um item por produto, como sempre foi. Nos dois casos a
// soma dos itens é exatamente o total gravado no pedido.
function montarItensMercadoPago({ itens, subtotal, desconto, frete, cupom }) {
    let linhas;

    if (desconto > 0) {
        const unidades = itens.reduce((soma, item) => soma + item.quantity, 0);
        const produtosComDesconto = deCentavos(paraCentavos(subtotal) - paraCentavos(desconto));

        linhas = produtosComDesconto > 0
            ? [{
                title: `Pedido Petabyte: ${unidades} item(ns), cupom ${cupom.codigo}`,
                quantity: 1,
                currency_id: 'BRL',
                unit_price: produtosComDesconto
            }]
            : [];
    } else {
        // produtoId é de uso interno; a API do Mercado Pago não o conhece.
        linhas = itens.map(({ produtoId, ...item }) => item);
    }

    if (frete > 0) {
        linhas.push({ title: 'Frete', quantity: 1, currency_id: 'BRL', unit_price: Number(frete.toFixed(2)) });
    }

    return linhas;
}

// Conta o uso na aprovação do pagamento, dentro da transação que já protege a
// baixa de estoque. O limite foi conferido na criação do pedido, mas dois
// pedidos abertos podem disputar a última vaga; o pagamento já foi aprovado
// aqui, então o uso é gravado e o excesso vai para o log, como o estoque.
async function contabilizarUsoCupom(cliente, pedido) {
    await cliente.query(
        'INSERT INTO cupom_usos (cupom_id, usuario_id, pedido_id) VALUES ($1, $2, $3) ON CONFLICT (pedido_id) DO NOTHING',
        [pedido.cupom_id, pedido.usuario_id, pedido.id]
    );
    await cliente.query('UPDATE pedidos SET cupom_contabilizado = TRUE WHERE id = $1', [pedido.id]);

    const situacao = await cliente.query(
        `SELECT c.codigo, c.uso_maximo, c.uso_maximo_por_usuario,
                (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = c.id)::int AS usos,
                (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = c.id AND u.usuario_id = $2)::int AS usos_do_usuario
           FROM cupons c WHERE c.id = $1`,
        [pedido.cupom_id, pedido.usuario_id]
    );

    const cupom = situacao.rows[0];
    if (cupom && ((cupom.uso_maximo !== null && cupom.usos > cupom.uso_maximo)
        || cupom.usos_do_usuario > cupom.uso_maximo_por_usuario)) {
        console.warn(
            `[CUPOM] Pedido ${pedido.id}: o cupom ${cupom.codigo} passou do limite de uso ` +
            `(${cupom.usos} no total, ${cupom.usos_do_usuario} deste cliente). O pagamento já foi aprovado; revisar manualmente.`
        );
    }
}

async function expirarPedidosPendentes(usuarioId = null) {
    const parametros = [];
    const filtroUsuario = usuarioId ? 'AND usuario_id = $1' : '';

    if (usuarioId) {
        parametros.push(usuarioId);
    }

    const resultado = await pool.query(
        `UPDATE pedidos
         SET status = 'Expirado',
             payment_status = 'expired',
             atualizado_em = CURRENT_TIMESTAMP
         WHERE expira_em IS NOT NULL
           AND expira_em < CURRENT_TIMESTAMP
           AND payment_status IN ('pending', 'in_process')
           ${filtroUsuario}
         RETURNING historico_id`,
        parametros
    );

    if (resultado.rowCount > 0) {
        const historicoIds = resultado.rows.map((row) => row.historico_id);
        await pool.query(
            `UPDATE historico_compras
             SET status = 'Expirado'
             WHERE id = ANY($1::int[])`,
            [historicoIds]
        );
    }

    return resultado.rowCount;
}

// Valida o header x-signature do Mercado Pago.
//
// O manifest tem o formato "id:<data.id>;request-id:<x-request-id>;ts:<ts>;",
// omitindo os trechos cujo valor não veio, e é assinado em HMAC-SHA256 com o
// segredo do painel do Mercado Pago.
//
// Sem MP_WEBHOOK_SECRET configurado a verificação é pulada: o handler refaz o
// payment.get() na API do Mercado Pago e nunca confia no corpo recebido, então
// forjar uma notificação não cria pagamento. Ainda assim, configure o segredo.
function validarAssinaturaWebhook(req) {
    const segredo = process.env.MP_WEBHOOK_SECRET;

    if (!segredo) {
        return { valido: true, verificado: false };
    }

    const assinatura = req.get('x-signature');

    if (!assinatura) {
        return { valido: false, verificado: true, motivo: 'header x-signature ausente' };
    }

    const partes = assinatura.split(',').reduce((acumulador, trecho) => {
        const separador = trecho.indexOf('=');
        if (separador > 0) {
            acumulador[trecho.slice(0, separador).trim()] = trecho.slice(separador + 1).trim();
        }
        return acumulador;
    }, {});

    if (!partes.ts || !partes.v1) {
        return { valido: false, verificado: true, motivo: 'header x-signature malformado' };
    }

    const dataId = req.query['data.id'] || (req.body && req.body.data && req.body.data.id);
    const requestId = req.get('x-request-id');

    let manifest = '';
    if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
    if (requestId) manifest += `request-id:${requestId};`;
    manifest += `ts:${partes.ts};`;

    const esperado = Buffer.from(crypto.createHmac('sha256', segredo).update(manifest).digest('hex'), 'hex');
    const recebido = Buffer.from(partes.v1, 'hex');

    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
        return { valido: false, verificado: true, motivo: 'assinatura não confere' };
    }

    return { valido: true, verificado: true };
}

function obterPaymentIdDaRequisicao(req) {
    const candidatos = [
        req.body && req.body.data && req.body.data.id,
        req.body && req.body.id,
        req.query && req.query['data.id'],
        req.query && req.query.id,
        req.body && req.body.resource
    ];

    for (const candidato of candidatos) {
        if (typeof candidato === 'string' && candidato.includes('/')) {
            const ultimoSegmento = candidato.split('/').pop();
            const numeroSegmento = Number(ultimoSegmento);
            if (Number.isInteger(numeroSegmento) && numeroSegmento > 0) {
                return numeroSegmento;
            }
        }

        const numero = Number(candidato);
        if (Number.isInteger(numero) && numero > 0) {
            return numero;
        }
    }

    return null;
}

async function registrarPedidoPendente(usuario, itens, subtotal, frete, total, { cupomId = null, desconto = 0 } = {}) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const pedidoDescricao = `Pedido Petabyte - ${itens.length} item(ns) - R$ ${total.toFixed(2)}`;
        const historicoResult = await client.query(
            'INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3) RETURNING id',
            [usuario.id, pedidoDescricao, 'Aguardando pagamento']
        );

        const historicoId = historicoResult.rows[0].id;
        const externalReference = `hc_${historicoId}`;

        const pedidoResult = await client.query(
            `INSERT INTO pedidos (
                usuario_id,
                historico_id,
                external_reference,
                preference_id,
                status,
                payment_status,
                expira_em,
                subtotal,
                frete,
                total,
                moeda,
                cupom_id,
                desconto
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '1 minute', $7, $8, $9, $10, $11, $12) RETURNING id`,
            [usuario.id, historicoId, externalReference, null, 'Aguardando pagamento', 'pending', subtotal, frete, total, 'BRL', cupomId, desconto]
        );

        const pedidoId = pedidoResult.rows[0].id;

        for (const item of itens) {
            const itemTotal = Number((item.unit_price * item.quantity).toFixed(2));
            await client.query(
                `INSERT INTO pedido_itens (pedido_id, produto_id, nome, preco_unitario, quantidade, total) VALUES ($1, $2, $3, $4, $5, $6)`,
                [pedidoId, item.produtoId || null, item.title, item.unit_price, item.quantity, itemTotal]
            );
        }

        await client.query('COMMIT');

        return { historicoId, pedidoId, externalReference };
    } catch (erro) {
        await client.query('ROLLBACK');
        throw erro;
    } finally {
        client.release();
    }
}

async function sincronizarPagamentoNoBanco(pagamento) {
    const referenciaPagamento = pagamento.external_reference || (pagamento.metadata && pagamento.metadata.historico_id ? `hc_${pagamento.metadata.historico_id}` : null);
    const historicoId = extrairHistoricoId(referenciaPagamento);

    if (!historicoId) {
        throw new Error('Pagamento sem referência de pedido válida.');
    }

    const STATUS_QUE_DEVOLVEM_ESTOQUE = ['refunded', 'cancelled', 'charged_back'];

    const client = await pool.connect();
    let pedidoExpirado = false;
    let resultado = null;

    try {
        await client.query('BEGIN');

        // FOR UPDATE serializa /pagamentos/confirmar e o webhook, que podem
        // processar o mesmo pagamento simultaneamente.
        const pedidoResult = await client.query(
            'SELECT id, usuario_id, expira_em, estoque_baixado, cupom_id, cupom_contabilizado FROM pedidos WHERE historico_id = $1 LIMIT 1 FOR UPDATE',
            [historicoId]
        );

        if (pedidoResult.rowCount === 0) {
            throw new Error('Pedido não encontrado para este pagamento.');
        }

        const pedido = pedidoResult.rows[0];

        if (pedido.expira_em && new Date(pedido.expira_em) < new Date()) {
            await client.query(
                `UPDATE pedidos
                 SET status = 'Expirado',
                     payment_status = 'expired',
                     atualizado_em = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [pedido.id]
            );
            await client.query('UPDATE historico_compras SET status = $1 WHERE id = $2', ['Expirado', historicoId]);
            await client.query('COMMIT');
            pedidoExpirado = true;
        } else {
            const statusPedido = mapearStatusPagamento(pagamento.status);
            const aprovado = pagamento.status === 'approved';
            const devolveEstoque = STATUS_QUE_DEVOLVEM_ESTOQUE.includes(pagamento.status);

            const itensDoPedido = await client.query(
                'SELECT produto_id, quantidade FROM pedido_itens WHERE pedido_id = $1 AND produto_id IS NOT NULL',
                [pedido.id]
            );

            // Debita uma única vez, na primeira aprovação. A flag no pedido é o
            // que impede o webhook de debitar de novo a cada reenvio.
            if (aprovado && !pedido.estoque_baixado) {
                for (const item of itensDoPedido.rows) {
                    const baixa = await client.query(
                        `UPDATE produtos
                         SET estoque = estoque - $1, atualizado_em = CURRENT_TIMESTAMP
                         WHERE id = $2 AND estoque >= $1`,
                        [item.quantidade, item.produto_id]
                    );

                    if (baixa.rowCount === 0) {
                        console.warn(
                            `[ESTOQUE] Pedido ${pedido.id}: estoque insuficiente para o produto ${item.produto_id} ` +
                            `(${item.quantidade} un.). O pagamento já foi aprovado; revisar manualmente.`
                        );
                    }
                }

                await client.query('UPDATE pedidos SET estoque_baixado = TRUE WHERE id = $1', [pedido.id]);
            }

            // Estorno ou cancelamento depois da baixa: devolve ao catálogo.
            if (devolveEstoque && pedido.estoque_baixado) {
                for (const item of itensDoPedido.rows) {
                    await client.query(
                        `UPDATE produtos
                         SET estoque = estoque + $1, atualizado_em = CURRENT_TIMESTAMP
                         WHERE id = $2`,
                        [item.quantidade, item.produto_id]
                    );
                }

                await client.query('UPDATE pedidos SET estoque_baixado = FALSE WHERE id = $1', [pedido.id]);
                console.log(`[ESTOQUE] Pedido ${pedido.id}: estoque devolvido após status "${pagamento.status}".`);
            }

            // O cupom segue a mesma trava do estoque: conta uma vez, na primeira
            // aprovação, e devolve a vaga no estorno. Carrinho abandonado com
            // cupom aplicado nunca chega aqui, então não consome uso.
            if (aprovado && pedido.cupom_id && !pedido.cupom_contabilizado) {
                await contabilizarUsoCupom(client, pedido);
            }

            if (devolveEstoque && pedido.cupom_contabilizado) {
                await client.query('DELETE FROM cupom_usos WHERE pedido_id = $1', [pedido.id]);
                await client.query('UPDATE pedidos SET cupom_contabilizado = FALSE WHERE id = $1', [pedido.id]);
                console.log(`[CUPOM] Pedido ${pedido.id}: vaga de uso devolvida após status "${pagamento.status}".`);
            }

            await client.query(
                `UPDATE pedidos
                 SET payment_id = $1,
                     payment_status = $2,
                     status = $3,
                     atualizado_em = CURRENT_TIMESTAMP
                 WHERE id = $4`,
                [String(pagamento.id), pagamento.status, statusPedido, pedido.id]
            );

            await client.query('UPDATE historico_compras SET status = $1 WHERE id = $2', [statusPedido, historicoId]);
            await client.query('COMMIT');

            resultado = { historicoId, pedidoId: pedido.id, status: pagamento.status, statusPedido };
        }
    } catch (erro) {
        await client.query('ROLLBACK').catch(() => {});
        throw erro;
    } finally {
        client.release();
    }

    if (pedidoExpirado) {
        throw new Error('Este pedido expirou após 1 minuto e não pode mais ser confirmado.');
    }

    return resultado;
}

// ---------------------------------------------------------------------------
// Sessão: access token + refresh token em cookies httpOnly
// ---------------------------------------------------------------------------
//
// O access token é um JWT curto que autentica cada requisição sem ir ao banco
// e, por isso, não se revoga — o que limita o estrago de um vazado é durar só
// 15 minutos. O refresh token é aleatório, dura 30 dias, fica com hash no banco
// e é o que se revoga de verdade (logout, troca de senha, reuso).
//
// Os dois ficam em cookies httpOnly: o JavaScript da página não os lê, então
// um script injetado (XSS) não consegue levá-los embora.

const PRODUCAO = process.env.NODE_ENV === 'production';

const COOKIE_ACCESS = 'access_token';
const COOKIE_REFRESH = 'refresh_token';
const COOKIE_CSRF = 'csrf_token';

const DURACAO_ACCESS_SEGUNDOS = 15 * 60;
const DURACAO_REFRESH_SEGUNDOS = 30 * 24 * 60 * 60;

// /auth, e não /auth/refresh: o logout também precisa ler este cookie para
// revogar a sessão, e com Path=/auth/refresh o navegador nunca o mandaria para
// /auth/logout. Continua fora de todo o resto da API.
const CAMINHO_COOKIE_REFRESH = '/auth';

// Duas abas com o access token vencido podem mandar o MESMO refresh token no
// mesmo instante. A primeira rotaciona; a segunda chega com um token recém-
// revogado. Dentro desta janela isso é corrida, não ataque: responde 401 sem
// derrubar todas as sessões, e a segunda aba usa os cookies que a primeira já
// renovou. Nenhum token novo sai daqui, então um atacante não ganha nada.
const JANELA_CORRIDA_SEGUNDOS = 60;

// SameSite=Lax, e não Strict: a volta do checkout do Mercado Pago é navegação
// vinda de outro domínio, e com Strict a pessoa chegaria deslogada justamente
// ao voltar de pagar. A defesa contra CSRF vem do token dedicado, não daqui.
// Secure só em produção: localmente não há HTTPS, e ele travaria todo login.
function opcoesDeCookie(extras) {
    return { httpOnly: true, secure: PRODUCAO, sameSite: 'lax', ...extras };
}

function definirCookiesDeSessao(res, accessToken, refreshToken, csrfToken) {
    res.cookie(COOKIE_ACCESS, accessToken, opcoesDeCookie({
        path: '/',
        maxAge: DURACAO_ACCESS_SEGUNDOS * 1000
    }));
    res.cookie(COOKIE_REFRESH, refreshToken, opcoesDeCookie({
        path: CAMINHO_COOKIE_REFRESH,
        maxAge: DURACAO_REFRESH_SEGUNDOS * 1000
    }));
    // O único que NÃO é httpOnly: o front precisa lê-lo para devolvê-lo no
    // header X-CSRF-Token. Não é segredo — a proteção vem de um site de outra
    // origem não conseguir ler o cookie para montar o header que bate.
    res.cookie(COOKIE_CSRF, csrfToken, {
        ...opcoesDeCookie({ path: '/', maxAge: DURACAO_REFRESH_SEGUNDOS * 1000 }),
        httpOnly: false
    });
}

function limparCookiesDeSessao(res) {
    res.clearCookie(COOKIE_ACCESS, opcoesDeCookie({ path: '/' }));
    res.clearCookie(COOKIE_REFRESH, opcoesDeCookie({ path: CAMINHO_COOKIE_REFRESH }));
    res.clearCookie(COOKIE_CSRF, { ...opcoesDeCookie({ path: '/' }), httpOnly: false });
}

function emitirAccessToken(usuario) {
    return jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: DURACAO_ACCESS_SEGUNDOS });
}

// Grava o refresh token e devolve o valor bruto, que só segue para o cookie.
// Os prazos são calculados no banco (NOW()), nunca em JS: revogado_em também
// vem de NOW(), e misturar relógios com TIMESTAMP sem fuso daria horas de
// diferença quando o processo e o banco estão em fusos distintos.
async function gravarRefreshToken(cliente, usuarioId) {
    const token = crypto.randomBytes(32).toString('hex');

    const resultado = await cliente.query(
        `INSERT INTO refresh_tokens (usuario_id, token_hash, expira_em)
         VALUES ($1, $2, NOW() + make_interval(secs => $3))
         RETURNING id`,
        [usuarioId, hashToken(token), DURACAO_REFRESH_SEGUNDOS]
    );

    return { token, id: resultado.rows[0].id };
}

// Abre uma sessão nova: access + refresh + CSRF. Login, cadastro e troca de
// senha passam por aqui. O CSRF é sempre novo, para uma sessão nova não
// herdar o token de outra.
async function iniciarSessao(res, usuario) {
    const { token: refreshToken } = await gravarRefreshToken(pool, usuario.id);
    const csrfToken = crypto.randomBytes(32).toString('hex');

    definirCookiesDeSessao(res, emitirAccessToken(usuario), refreshToken, csrfToken);
}

async function revogarSessoesDoUsuario(cliente, usuarioId) {
    await cliente.query(
        'UPDATE refresh_tokens SET revogado_em = NOW() WHERE usuario_id = $1 AND revogado_em IS NULL',
        [usuarioId]
    );
}

// ---------------------------------------------------------------------------
// CSRF — double-submit cookie
// ---------------------------------------------------------------------------

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Rotas de entrada, que não agem em nome de sessão nenhuma. Além disso, o
// cookie csrf_token nasce no login: exigi-lo no próprio login impediria o
// primeiro acesso de qualquer pessoa. O webhook é chamado pelo Mercado Pago,
// que nunca teve cookie.
const ROTAS_SEM_CSRF = new Set([
    '/auth/login',
    '/auth/google',
    '/auth/cadastro',
    '/usuarios',
    '/auth/recuperar-senha',
    '/auth/redefinir-senha',
    '/auth/verificar-email',
    '/auth/reenviar-verificacao',
    '/pagamentos/webhook'
]);

function tokensIguais(a, b) {
    const bufferA = Buffer.from(String(a));
    const bufferB = Buffer.from(String(b));
    return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

// Só exige o token quando a requisição carrega cookie de sessão. CSRF é o
// abuso de credencial que o navegador anexa sozinho; sem cookie de sessão não
// há credencial a abusar, e a rota protegida responde 401 por conta própria —
// o que deixa o front renovar a sessão em vez de mostrar um 403 sem sentido.
function exigirCsrf(req, res, next) {
    if (METODOS_SEGUROS.has(req.method) || ROTAS_SEM_CSRF.has(req.path)) {
        return next();
    }

    const cookies = req.cookies || {};
    if (!cookies[COOKIE_ACCESS] && !cookies[COOKIE_REFRESH]) {
        return next();
    }

    const doCookie = cookies[COOKIE_CSRF];
    const doCabecalho = req.get('X-CSRF-Token');

    if (!doCookie || !doCabecalho || !tokensIguais(doCookie, doCabecalho)) {
        return res.status(403).json({ mensagem: 'Requisição recusada: token de segurança ausente ou inválido.' });
    }

    return next();
}

// A fonte do token mudou (cookie, não header); a lógica, não. Toda rota que
// usa req.usuario continua igual.
function autenticarToken(req, res, next) {
    const token = req.cookies && req.cookies[COOKIE_ACCESS];

    if (!token) {
        return res.status(401).json({ mensagem: 'Sessão ausente ou expirada.' });
    }

    try {
        req.usuario = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (erro) {
        // 401, e não 403: é o status que faz o front tentar renovar a sessão.
        return res.status(401).json({ mensagem: 'Sessão ausente ou expirada.' });
    }
}

// Confere a flag no banco a cada requisição, em vez de ler do JWT. Assim,
// revogar o acesso tem efeito imediato: um token emitido antes da revogação
// deixa de valer sem precisar esperar os 15 minutos de expiração.
async function exigirAdmin(req, res, next) {
    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    try {
        const resultado = await pool.query('SELECT admin FROM usuarios WHERE id = $1', [req.usuario.id]);

        if (resultado.rowCount === 0 || resultado.rows[0].admin !== true) {
            return res.status(403).json({ mensagem: 'Acesso restrito a administradores.' });
        }

        return next();
    } catch (erro) {
        console.error('Erro ao verificar permissão de administrador:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível verificar a permissão.' });
    }
}

// Slug em minúsculas sem acento para o banco e as URLs; rótulo para exibição.
// Manter os dois juntos evita que a loja e o painel inventem traduções próprias.
const CATEGORIAS = [
    { slug: 'hardware', rotulo: 'Hardware' },
    { slug: 'perifericos', rotulo: 'Periféricos' },
    { slug: 'audio', rotulo: 'Áudio' },
    { slug: 'monitores', rotulo: 'Monitores' },
    { slug: 'computadores', rotulo: 'Computadores' },
    { slug: 'mobile', rotulo: 'Celulares e wearables' }
];

const CATEGORIAS_VALIDAS = CATEGORIAS.map((categoria) => categoria.slug);

const LIMITE_TAGS = 12;

// Normaliza para minúsculas sem espaços nas pontas, descarta vazias e
// repetidas. As tags existem para busca, então convém que sejam previsíveis.
function normalizarTags(valor) {
    if (valor === undefined || valor === null) {
        return { valido: true, tags: undefined };
    }

    const bruto = Array.isArray(valor)
        ? valor
        : String(valor).split(',');

    const tags = [];

    for (const item of bruto) {
        const tag = String(item).trim().toLowerCase();

        if (!tag) continue;

        if (tag.length > 30) {
            return { valido: false, mensagem: 'Cada tag pode ter no máximo 30 caracteres.' };
        }

        if (!tags.includes(tag)) {
            tags.push(tag);
        }
    }

    if (tags.length > LIMITE_TAGS) {
        return { valido: false, mensagem: `Máximo de ${LIMITE_TAGS} tags por produto.` };
    }

    return { valido: true, tags };
}

// Valida e normaliza o corpo enviado pelo painel. Em criação todos os campos
// obrigatórios precisam vir; em edição, apenas os enviados são conferidos.
function validarDadosProduto(corpo, { parcial = false } = {}) {
    const erros = [];
    const dados = {};

    const definido = (campo) => corpo[campo] !== undefined && corpo[campo] !== null;

    if (definido('nome')) {
        const nome = String(corpo.nome).trim();
        if (nome.length < 2 || nome.length > 150) {
            erros.push('O nome precisa ter entre 2 e 150 caracteres.');
        } else {
            dados.nome = nome;
        }
    } else if (!parcial) {
        erros.push('O nome é obrigatório.');
    }

    if (definido('preco')) {
        const preco = Number(corpo.preco);
        if (!Number.isFinite(preco) || preco <= 0) {
            erros.push('O preço precisa ser um número maior que zero.');
        } else if (preco > 9999999.99) {
            erros.push('O preço excede o limite da coluna.');
        } else {
            dados.preco = Number(preco.toFixed(2));
        }
    } else if (!parcial) {
        erros.push('O preço é obrigatório.');
    }

    if (definido('estoque')) {
        const estoque = Number(corpo.estoque);
        if (!Number.isInteger(estoque) || estoque < 0) {
            erros.push('O estoque precisa ser um número inteiro igual ou maior que zero.');
        } else {
            dados.estoque = estoque;
        }
    } else if (!parcial) {
        dados.estoque = 0;
    }

    if (definido('categoria')) {
        const categoria = String(corpo.categoria).trim().toLowerCase();
        if (!CATEGORIAS_VALIDAS.includes(categoria)) {
            erros.push(`A categoria precisa ser uma destas: ${CATEGORIAS_VALIDAS.join(', ')}.`);
        } else {
            dados.categoria = categoria;
        }
    } else if (!parcial) {
        erros.push('A categoria é obrigatória.');
    }

    if (definido('tags')) {
        const resultado = normalizarTags(corpo.tags);
        if (!resultado.valido) {
            erros.push(resultado.mensagem);
        } else {
            dados.tags = resultado.tags;
        }
    } else if (!parcial) {
        dados.tags = [];
    }

    // Preço original: campo do "de/por". String vazia limpa o valor, porque é
    // o que um input de formulário envia quando o operador apaga o conteúdo.
    if (definido('precoOriginal')) {
        const bruto = corpo.precoOriginal;

        if (bruto === '' || bruto === null) {
            dados.precoOriginal = null;
        } else {
            const valor = Number(bruto);

            if (!Number.isFinite(valor) || valor <= 0) {
                erros.push('O preço original precisa ser um número maior que zero, ou ficar vazio.');
            } else if (valor > 9999999.99) {
                erros.push('O preço original excede o limite da coluna.');
            } else {
                dados.precoOriginal = Number(valor.toFixed(2));
            }
        }
    } else if (!parcial) {
        dados.precoOriginal = null;
    }

    if (definido('especificacoes')) {
        const resultado = normalizarEspecificacoes(corpo.especificacoes);
        if (!resultado.valido) {
            erros.push(resultado.mensagem);
        } else {
            dados.especificacoes = resultado.especificacoes;
        }
    } else if (!parcial) {
        dados.especificacoes = [];
    }

    if (definido('imagens')) {
        const resultado = normalizarImagens(corpo.imagens);
        if (!resultado.valido) {
            erros.push(resultado.mensagem);
        } else {
            dados.imagens = resultado.imagens;
        }
    }

    if (definido('descricao')) {
        dados.descricao = String(corpo.descricao).trim().slice(0, 2000);
    } else if (!parcial) {
        dados.descricao = '';
    }

    if (definido('imagemUrl')) {
        const url = String(corpo.imagemUrl).trim();
        if (url && !/^https:\/\//i.test(url)) {
            erros.push('A URL da imagem precisa começar com https://.');
        } else {
            dados.imagemUrl = url;
        }
    } else if (!parcial) {
        dados.imagemUrl = '';
    }

    if (definido('ativo')) {
        dados.ativo = corpo.ativo === true || corpo.ativo === 'true';
    } else if (!parcial) {
        dados.ativo = true;
    }

    // Anunciar desconto sobre um preço menor que o atual seria propaganda
    // enganosa. Só dá para conferir quando os dois valores estão à mão.
    const precoFinal = dados.preco !== undefined ? dados.preco : null;
    if (dados.precoOriginal && precoFinal !== null && dados.precoOriginal <= precoFinal) {
        erros.push('O preço original precisa ser maior que o preço atual para valer como desconto.');
    }

    return { valido: erros.length === 0, erros, dados };
}

const LIMITE_ESPECIFICACOES = 30;

// Lista de pares rótulo/valor. Aceita array de objetos (painel) ou texto no
// formato "Rótulo: valor" por linha, que é como se cola de uma ficha técnica.
function normalizarEspecificacoes(valor) {
    let bruto;

    if (Array.isArray(valor)) {
        bruto = valor;
    } else if (typeof valor === 'string') {
        bruto = valor.split(/\r?\n/).map((linha) => {
            const separador = linha.indexOf(':');
            if (separador < 0) return null;
            return { rotulo: linha.slice(0, separador), valor: linha.slice(separador + 1) };
        }).filter(Boolean);
    } else if (valor === null || valor === undefined) {
        return { valido: true, especificacoes: [] };
    } else {
        return { valido: false, mensagem: 'Especificações em formato inválido.' };
    }

    const especificacoes = [];

    for (const item of bruto) {
        const rotulo = String((item && item.rotulo) || '').trim().slice(0, 60);
        const conteudo = String((item && item.valor) || '').trim().slice(0, 200);

        if (!rotulo || !conteudo) continue;

        especificacoes.push({ rotulo, valor: conteudo });
    }

    if (especificacoes.length > LIMITE_ESPECIFICACOES) {
        return { valido: false, mensagem: `Máximo de ${LIMITE_ESPECIFICACOES} especificações por produto.` };
    }

    return { valido: true, especificacoes };
}

const LIMITE_IMAGENS = 8;

// Galeria: aceita array de URLs ou texto com uma URL por linha.
function normalizarImagens(valor) {
    let bruto;

    if (Array.isArray(valor)) {
        bruto = valor;
    } else if (typeof valor === 'string') {
        bruto = valor.split(/\r?\n/);
    } else if (valor === null || valor === undefined) {
        return { valido: true, imagens: [] };
    } else {
        return { valido: false, mensagem: 'Galeria em formato inválido.' };
    }

    const imagens = [];

    for (const item of bruto) {
        const url = String(typeof item === 'string' ? item : (item && item.url) || '').trim();

        if (!url) continue;

        if (!/^https:\/\//i.test(url)) {
            return { valido: false, mensagem: 'Cada imagem da galeria precisa começar com https://.' };
        }

        if (!imagens.includes(url)) {
            imagens.push(url);
        }
    }

    if (imagens.length > LIMITE_IMAGENS) {
        return { valido: false, mensagem: `Máximo de ${LIMITE_IMAGENS} imagens por produto.` };
    }

    return { valido: true, imagens };
}

async function popularHistoricoPadrao() {
    const usuarios = await pool.query('SELECT id FROM usuarios');

    for (const usuario of usuarios.rows) {
        const existe = await pool.query('SELECT 1 FROM historico_compras WHERE usuario_id = $1 LIMIT 1', [usuario.id]);
        if (existe.rowCount === 0) {
            await pool.query(
                'INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3)',
                [usuario.id, 'Pedido inicial', 'Entregue']
            );
        }
    }
}

function criarTransportadoresFallbackEmail() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const timeout = Number(process.env.SMTP_TIMEOUT_MS || 10000);

    if (!host || !user || !pass) {
        return [];
    }

    const base = {
        host,
        port,
        secure: port === 465,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        requireTLS: port !== 465,
        tls: {
            minVersion: 'TLSv1.2'
        },
        auth: { user, pass }
    };

    const configuracoes = [base];

    if (host === 'smtp.gmail.com' && port !== 465) {
        configuracoes.push({
            ...base,
            port: 465,
            secure: true,
            requireTLS: false
        });
    }

    return configuracoes.map((configuracao) => nodemailer.createTransport(configuracao));
}

// Hash dos tokens que dão acesso à conta: o de recuperação de senha (vai em
// claro no e-mail) e o refresh token (vai em claro no cookie). O banco só vê o
// hash, então um dump de password_resets ou de refresh_tokens não abre conta
// nenhuma. SHA-256 sem sal basta — os tokens têm 256 bits aleatórios, não há
// dicionário a atacar como numa senha escolhida por gente. E bcrypt não
// serviria: com sal, não dá para buscar por WHERE token.
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Devolve o token bruto, que só deve seguir para o e-mail.
async function criarTokenRecuperacao(usuarioId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000);

    await pool.query(
        'INSERT INTO password_resets (usuario_id, token, expira_em) VALUES ($1, $2, $3)',
        [usuarioId, hashToken(token), expiraEm]
    );

    return token;
}

// Envia um e-mail pelas configurações SMTP disponíveis, tentando a próxima se
// uma falhar. Nunca lança: devolve { ok, motivo } para quem chamou decidir. O
// destinatário não vai para o log — em recuperação e confirmação, a simples
// presença dele revelaria quais e-mails têm cadastro.
async function enviarEmail({ para, assunto, html, rotulo }) {
    try {
        const transportadores = criarTransportadoresFallbackEmail();

        if (transportadores.length === 0) {
            console.log(`[${rotulo}] SMTP não configurado; e-mail não enviado.`);
            return { ok: false, motivo: 'SMTP não configurado' };
        }

        const mensagem = {
            from: process.env.SMTP_FROM || 'petabyte@local.dev',
            to: para,
            subject: assunto,
            html
        };

        let ultimoErro = null;

        for (const [indice, transportador] of transportadores.entries()) {
            try {
                await transportador.verify();
                await transportador.sendMail(mensagem);
                console.log(`[${rotulo}] E-mail enviado usando a configuração SMTP #${indice + 1}`);
                return { ok: true };
            } catch (erro) {
                ultimoErro = erro;
                console.error(
                    `[${rotulo}] Falha na configuração SMTP #${indice + 1}:`,
                    erro && erro.message ? erro.message : String(erro)
                );
            }
        }

        return { ok: false, motivo: ultimoErro && ultimoErro.message ? ultimoErro.message : 'Falha desconhecida no SMTP' };
    } catch (erro) {
        const mensagemErro = erro && erro.message ? erro.message : String(erro);
        console.error(`[${rotulo}] Falha ao enviar e-mail:`, mensagemErro);
        return { ok: false, motivo: mensagemErro };
    }
}

function urlDoSite(caminho) {
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
    return `${baseUrl}${caminho}`;
}

function enviarEmailRecuperacao(email, token) {
    const link = urlDoSite(`/redefinir-senha.html?token=${token}`);

    return enviarEmail({
        para: email,
        assunto: 'Redefinição de senha Petabyte',
        html: `<p>Olá!</p><p>Use o link abaixo para redefinir sua senha:</p><p><a href="${link}">${link}</a></p>`,
        rotulo: 'RESET'
    });
}

function enviarEmailVerificacao(email, token) {
    const link = urlDoSite(`/verificar-email.html?token=${token}`);

    return enviarEmail({
        para: email,
        assunto: 'Confirme seu e-mail na Petabyte',
        html: `<p>Olá!</p>
            <p>Para ativar sua conta na Petabyte, confirme seu e-mail pelo link abaixo. Ele vale por 24 horas.</p>
            <p><a href="${link}">${link}</a></p>
            <p>Se não foi você que criou esta conta, ignore este e-mail: sem a confirmação, ninguém entra nela.</p>`,
        rotulo: 'VERIFICACAO'
    });
}

// Gera o token de confirmação e grava só o hash, como a recuperação de senha.
// Invalida os pendentes da pessoa antes: só o link mais recente vale, para um
// e-mail antigo esquecido na caixa não continuar servindo.
async function criarTokenVerificacao(cliente, usuarioId) {
    const token = crypto.randomBytes(32).toString('hex');

    await cliente.query(
        'UPDATE verificacoes_email SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL',
        [usuarioId]
    );
    await cliente.query(
        `INSERT INTO verificacoes_email (usuario_id, token_hash, expira_em)
         VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
        [usuarioId, hashToken(token)]
    );

    return token;
}

async function inicializarBanco() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL,
            senha TEXT NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS historico_compras (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL,
            pedido VARCHAR(100) NOT NULL,
            status VARCHAR(50) NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expira_em TIMESTAMP NOT NULL,
            usado BOOLEAN DEFAULT FALSE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_reset_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER NOT NULL,
            historico_id INTEGER NOT NULL UNIQUE,
            external_reference TEXT NOT NULL UNIQUE,
            preference_id TEXT UNIQUE,
            payment_id TEXT UNIQUE,
            status VARCHAR(50) NOT NULL,
            payment_status VARCHAR(50) NOT NULL,
            subtotal NUMERIC(10,2) NOT NULL,
            frete NUMERIC(10,2) NOT NULL,
            total NUMERIC(10,2) NOT NULL,
            moeda VARCHAR(10) NOT NULL DEFAULT 'BRL',
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_pedido_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
            CONSTRAINT fk_pedido_historico FOREIGN KEY (historico_id) REFERENCES historico_compras(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        ALTER TABLE pedidos
        ADD COLUMN IF NOT EXISTS expira_em TIMESTAMP
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pedido_itens (
            id SERIAL PRIMARY KEY,
            pedido_id INTEGER NOT NULL,
            nome VARCHAR(150) NOT NULL,
            preco_unitario NUMERIC(10,2) NOT NULL,
            quantidade INTEGER NOT NULL,
            total NUMERIC(10,2) NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_item_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
        )
    `);

    await popularHistoricoPadrao();
}

let servidorIniciado = false;
let bancoDisponivel = true;

process.on('uncaughtException', (erro) => {
    console.error('Exceção não tratada:', erro);
});

process.on('unhandledRejection', (erro) => {
    console.error('Promise rejeitada sem tratamento:', erro);
});

async function iniciarServidor() {
    if (servidorIniciado) return;

    try {
        await inicializarBanco();
        bancoDisponivel = true;
    } catch (erro) {
        bancoDisponivel = false;
        console.error('Erro ao inicializar o banco. O servidor continuará rodando, mas as rotas dependentes do banco responderão com erro amigável.', erro);
    }

    await new Promise((resolve, reject) => {
        const listener = app.listen(PORT, () => {
            servidorIniciado = true;
            console.log(`Servidor rodando na porta ${PORT}`);
            resolve();
        });
        listener.on('error', reject);
    });

    // resolverCorsOrigin aceita qualquer origem quando a lista está vazia. Não
    // trava a subida por uma variável opcional, mas também não falha aberto em
    // silêncio: no Render ela é preenchida à mão e é fácil esquecer. Com a
    // sessão em cookie (credentials: true), a origem aceita passa a poder
    // fazer requisições com credencial — o SameSite=Lax dos cookies segura o
    // envio a partir de outro site, mas a lista explícita é a defesa certa.
    if (corsOrigins.length === 0) {
        console.warn(
            '[CORS] CORS_ORIGINS não configurado: aceitando requisições com credenciais de qualquer origem. ' +
            'Defina a variável para restringir em produção.'
        );
    }
}

// Só sobe o servidor quando executado direto (npm start). Ao ser importado
// por um teste, apenas expõe as funções abaixo sem abrir porta nem tocar no banco.
if (require.main === module) {
    iniciarServidor().catch((erro) => {
        console.error('Falha ao iniciar servidor:', erro);
        process.exit(1);
    });
}

module.exports = {
    app,
    pool,
    calcularFrete,
    validarFormatoCarrinho,
    resolverItensCarrinho,
    mapearStatusPagamento,
    registrarPedidoPendente,
    sincronizarPagamentoNoBanco,
    criarTokenRecuperacao,
    validarCupom,
    prepararCheckout,
    montarItensMercadoPago
};

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Estado da instalação, para a interface se adaptar. O cliente usa isto só
// para exibição: quem realmente recusa o pagamento é /pagamentos/criar.
app.get('/config', (req, res) => {
    res.json({
        checkoutHabilitado: CHECKOUT_HABILITADO,
        mensagemCheckoutDesativado: 'Esta é uma vitrine de demonstração. '
            + 'Você pode navegar, montar o carrinho e explorar o catálogo, mas a finalização de compra está desativada.',
        // O Client ID do Google não é segredo: vai para o navegador de qualquer
        // jeito, no próprio botão. Nulo esconde o botão na tela de login.
        googleClientId: process.env.GOOGLE_CLIENT_ID || null
    });
});

if (process.env.NODE_ENV !== 'production') {
    app.post('/debug/teste', (req, res) => {
        console.log('[DEBUG] rota de teste chamada');
        res.json({ ok: true, recebida: req.body });
    });
}

// ---------------------------------------------------------------------------
// Cadastro: e-mail e senha
// ---------------------------------------------------------------------------

// Só provedores de e-mail conhecidos. Serviços de e-mail temporário criam
// endereços descartáveis aos milhares, e com eles uma pessoa abriria contas
// novas sem fim — para repetir cupom de "uma vez por cliente", por exemplo.
// Uma lista do que é aceito é mais segura que uma lista do que é proibido: os
// descartáveis surgem todo dia, os provedores grandes não. Para aceitar mais
// um, é só acrescentar aqui. Não vale para o login com Google: o e-mail já foi
// confirmado pela própria Google, e serviço temporário não cria conta Google.
const DOMINIOS_EMAIL_PERMITIDOS = new Set([
    // Google
    'gmail.com', 'googlemail.com',
    // Microsoft
    'outlook.com', 'outlook.com.br', 'hotmail.com', 'hotmail.com.br', 'live.com', 'msn.com',
    // Yahoo
    'yahoo.com', 'yahoo.com.br', 'ymail.com', 'rocketmail.com',
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Outros internacionais
    'aol.com', 'proton.me', 'protonmail.com',
    // Brasileiros
    'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br'
]);

// E-mail é gravado em minúsculas; o login compara ignorando maiúsculas, porque
// contas antigas foram gravadas como a pessoa digitou.
function normalizarEmail(email) {
    return String(email === undefined || email === null ? '' : email).trim().toLowerCase();
}

function validarEmailDeCadastro(email) {
    const normalizado = normalizarEmail(email);

    if (normalizado.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizado)) {
        return { ok: false, mensagem: 'Informe um e-mail válido.' };
    }

    const dominio = normalizado.split('@')[1];

    if (!DOMINIOS_EMAIL_PERMITIDOS.has(dominio)) {
        return {
            ok: false,
            mensagem: 'Use um e-mail de um provedor conhecido, como Gmail, Outlook, Hotmail, Yahoo, iCloud, '
                + 'UOL, BOL ou Terra. Endereços temporários não são aceitos.'
        };
    }

    return { ok: true, email: normalizado };
}

// Senhas que aparecem no topo de todo vazamento. Lista curta de propósito: o
// que protege de verdade é o comprimento; isto só barra o óbvio.
const SENHAS_COMUNS = new Set([
    '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000',
    'senha123', 'senha1234', 'senha12345', 'mudar123', 'password1', 'password123',
    'qwerty123', 'abc12345', 'abcd1234', 'a1b2c3d4', 'iloveyou1', 'admin123',
    'petabyte1', 'petabyte123', 'brasil123', 'teste123'
]);

// A mesma regra no cadastro, na troca e na redefinição de senha: uma regra só,
// para ninguém criar pela porta dos fundos a senha que a da frente recusa.
// Devolve a mensagem do problema, ou null se a senha serve.
function validarForcaSenha(senha, email) {
    const texto = String(senha === undefined || senha === null ? '' : senha);

    if (texto.length < 8) {
        return 'A senha precisa ter pelo menos 8 caracteres.';
    }

    // O bcrypt ignora tudo depois de 72 bytes: acima disso, o final da senha
    // não protegeria nada.
    if (Buffer.byteLength(texto, 'utf8') > 72) {
        return 'A senha pode ter no máximo 72 caracteres.';
    }

    if (!/\p{L}/u.test(texto) || !/\d/.test(texto)) {
        return 'A senha precisa ter letras e números.';
    }

    if (SENHAS_COMUNS.has(texto.toLowerCase())) {
        return 'Esta senha é comum demais. Escolha outra.';
    }

    const usuarioDoEmail = normalizarEmail(email).split('@')[0];
    if (usuarioDoEmail.length >= 4 && texto.toLowerCase().includes(usuarioDoEmail)) {
        return 'A senha não pode conter o seu e-mail.';
    }

    return null;
}

app.post('/usuarios', limitadorCadastro, async (req, res) => {
    const { nome, senha } = req.body;
    const email = normalizarEmail(req.body.email);

    if (!nome || !email) {
        return res.status(400).json({ mensagem: 'Nome e e-mail são obrigatórios.' });
    }

    try {
        // E-mail já cadastrado responde sucesso sem tocar na conta. Para quem
        // assina a newsletter, o que importa (estar na lista) já é verdade —
        // diferente de /auth/cadastro, que devolve 409 porque ali a pessoa
        // precisa saber que deve entrar em vez de cadastrar. Sem esta checagem
        // o INSERT batia na UNIQUE e caía no 500 genérico abaixo.
        const existente = await pool.query('SELECT id FROM usuarios WHERE lower(email) = $1', [email]);

        if (existente.rowCount > 0) {
            return res.status(200).json({ mensagem: 'Usuário salvo com sucesso!' });
        }

        // Daqui para baixo nasce uma conta: vale a mesma lista de provedores
        // do cadastro. (Quem já tem conta passou acima, sem essa checagem.)
        const validacaoEmail = validarEmailDeCadastro(email);
        if (!validacaoEmail.ok) {
            return res.status(400).json({ mensagem: validacaoEmail.mensagem });
        }

        // Sem senha, um valor aleatório descartado: a conta existe para a
        // newsletter e não abre por login. Com senha (só pela API), vale a
        // mesma regra do cadastro — sem isto, esta rota seria um jeito de
        // criar conta com senha fraca.
        if (senha) {
            const problema = validarForcaSenha(senha, email);
            if (problema) {
                return res.status(400).json({ mensagem: problema });
            }
        }

        const senhaParaHash = senha || crypto.randomBytes(32).toString('hex');
        const senhaHash = await bcrypt.hash(senhaParaHash, 10);
        const resultado = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id', [nome, email, senhaHash]);
        const usuarioId = resultado.rows[0].id;
        await pool.query('INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3)', [usuarioId, 'Pedido inicial', 'Entregue']);
        res.status(201).json({ mensagem: 'Usuário salvo com sucesso!' });
    } catch (erro) {
        console.error('Erro ao salvar no banco:', erro);
        res.status(500).json({ mensagem: 'Erro ao salvar no banco.' });
    }
});

// Cria a conta sem abrir sessão: ela só entra depois de confirmar o e-mail
// pelo link. Confirmar prova que a pessoa controla o endereço — sem isso,
// qualquer um cadastrava o e-mail de outra pessoa.
app.post('/auth/cadastro', limitadorCadastro, async (req, res) => {
    const nome = String((req.body && req.body.nome) || '').trim();
    const { senha } = req.body;

    if (!nome || !req.body.email || !senha) {
        return res.status(400).json({ mensagem: 'Nome, e-mail e senha são obrigatórios.' });
    }

    if (nome.length < 2 || nome.length > 100) {
        return res.status(400).json({ mensagem: 'O nome precisa ter entre 2 e 100 caracteres.' });
    }

    const validacaoEmail = validarEmailDeCadastro(req.body.email);
    if (!validacaoEmail.ok) {
        return res.status(400).json({ mensagem: validacaoEmail.mensagem });
    }

    const { email } = validacaoEmail;
    const problemaSenha = validarForcaSenha(senha, email);
    if (problemaSenha) {
        return res.status(400).json({ mensagem: problemaSenha });
    }

    let usuario;
    let token;
    const cliente = await pool.connect();

    try {
        const existente = await cliente.query('SELECT id FROM usuarios WHERE lower(email) = $1', [email]);
        if (existente.rowCount > 0) {
            // Se o e-mail é da pessoa e ela não criou esta conta, "Esqueci
            // minha senha" prova que ela controla o endereço e toma a conta.
            return res.status(409).json({
                mensagem: 'Este e-mail já está cadastrado. Se ele é seu, entre ou use "Esqueci minha senha".'
            });
        }

        await cliente.query('BEGIN');

        const resultado = await cliente.query(
            `INSERT INTO usuarios (nome, email, senha, email_verificado)
             VALUES ($1, $2, $3, FALSE)
             RETURNING id, nome, email`,
            [nome, email, await bcrypt.hash(senha, 10)]
        );
        usuario = resultado.rows[0];

        await cliente.query(
            'INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3)',
            [usuario.id, 'Pedido de boas-vindas', 'Em transporte']
        );
        token = await criarTokenVerificacao(cliente, usuario.id);

        await cliente.query('COMMIT');
    } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        console.error('Erro ao cadastrar usuário:', erro);
        return res.status(500).json({ mensagem: 'Erro ao criar conta.' });
    } finally {
        cliente.release();
    }

    const envio = await enviarEmailVerificacao(email, token);

    // Sem o e-mail, a conta nunca poderia ser confirmada — e ainda ocuparia o
    // endereço. Desfaz, para a pessoa tentar de novo do zero.
    if (!envio.ok) {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [usuario.id]).catch(() => {});
        return res.status(502).json({
            mensagem: 'Não foi possível enviar o e-mail de confirmação agora. Tente novamente em alguns minutos.'
        });
    }

    return res.status(201).json({
        mensagem: `Conta criada! Enviamos um link de confirmação para ${email}. Confirme o e-mail para entrar.`,
        email
    });
});

// Confirma o e-mail pelo token do link. POST, e não GET no próprio link: o
// link abre uma página que chama esta rota, porque leitores de e-mail e
// antivírus visitam links sozinhos, e um GET consumiria o token sem a pessoa.
app.post('/auth/verificar-email', limitadorCadastro, async (req, res) => {
    const token = req.body && req.body.token;

    if (typeof token !== 'string' || !token) {
        return res.status(400).json({ mensagem: 'Link de confirmação inválido.' });
    }

    try {
        // Prazo comparado no banco, com o mesmo relógio que o gravou.
        const achado = await pool.query(
            `SELECT id, usuario_id, usado_em IS NOT NULL AS usado, expira_em <= NOW() AS expirado
               FROM verificacoes_email WHERE token_hash = $1`,
            [hashToken(token)]
        );

        if (achado.rowCount === 0 || achado.rows[0].usado) {
            return res.status(400).json({
                mensagem: 'Este link não vale mais. Se a conta ainda não foi confirmada, entre com seu e-mail e senha para receber outro.'
            });
        }

        if (achado.rows[0].expirado) {
            return res.status(400).json({
                mensagem: 'Este link expirou. Entre com seu e-mail e senha para receber outro.'
            });
        }

        const { usuario_id: usuarioId } = achado.rows[0];
        await pool.query('UPDATE usuarios SET email_verificado = TRUE WHERE id = $1', [usuarioId]);
        await pool.query(
            'UPDATE verificacoes_email SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL',
            [usuarioId]
        );

        return res.json({ mensagem: 'E-mail confirmado! Agora é só entrar com seu e-mail e senha.' });
    } catch (erro) {
        console.error('Erro ao confirmar e-mail:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível confirmar o e-mail.' });
    }
});

// Reenvia a confirmação. Exige a senha: assim só quem criou a conta pede o
// reenvio, e a rota não vira um jeito de disparar e-mails para qualquer um.
app.post('/auth/reenviar-verificacao', limitadorSenha, async (req, res) => {
    const email = normalizarEmail(req.body && req.body.email);
    const senha = String((req.body && req.body.senha) || '');

    if (!email || !senha) {
        return res.status(400).json({ mensagem: 'Informe e-mail e senha.' });
    }

    try {
        const resultado = await pool.query(
            `SELECT id, email, senha, email_verificado FROM usuarios
              WHERE lower(email) = $1 ORDER BY (email = $1) DESC LIMIT 1`,
            [email]
        );
        const usuario = resultado.rows[0];

        if (!usuario || usuario.senha === null || !(await bcrypt.compare(senha, usuario.senha))) {
            return res.status(401).json({ mensagem: 'E-mail ou senha inválidos.' });
        }

        if (usuario.email_verificado) {
            return res.json({ mensagem: 'Seu e-mail já está confirmado. Pode entrar.' });
        }

        const token = await criarTokenVerificacao(pool, usuario.id);
        const envio = await enviarEmailVerificacao(usuario.email, token);

        if (!envio.ok) {
            return res.status(502).json({ mensagem: 'Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.' });
        }

        return res.json({ mensagem: `Enviamos um novo link de confirmação para ${usuario.email}.` });
    } catch (erro) {
        console.error('Erro ao reenviar confirmação:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível reenviar a confirmação.' });
    }
});

app.post('/auth/login', limitadorLogin, async (req, res) => {
    const { senha } = req.body;
    const email = normalizarEmail(req.body.email);

    if (!email || !senha) {
        return res.status(400).json({ mensagem: 'E-mail e senha são obrigatórios.' });
    }

    try {
        // Sem diferenciar maiúsculas: contas novas gravam o e-mail em minúsculas,
        // as antigas como a pessoa digitou. Havendo duas, a de grafia exata vence.
        const resultado = await pool.query(
            `SELECT id, nome, email, senha, email_verificado FROM usuarios
              WHERE lower(email) = $1 ORDER BY (email = $1) DESC LIMIT 1`,
            [email]
        );

        if (resultado.rowCount === 0) {
            return res.status(401).json({ mensagem: 'E-mail ou senha inválidos.' });
        }

        const usuario = resultado.rows[0];

        // Conta criada pelo Google ainda sem senha. Comparar com bcrypt contra
        // NULL lança exceção e viraria um 500; a pessoa precisa saber o caminho.
        if (usuario.senha === null) {
            return res.status(401).json({
                mensagem: 'Esta conta entra com o Google. Use o botão "Entrar com Google" '
                    + 'ou crie uma senha em "Esqueci minha senha".'
            });
        }

        const senhaValida = await bcrypt.compare(senha, usuario.senha);

        if (!senhaValida) {
            return res.status(401).json({ mensagem: 'E-mail ou senha inválidos.' });
        }

        // Depois da senha, nunca antes: assim ninguém descobre se uma conta
        // está confirmada sem saber a senha dela. O código deixa a tela de
        // login oferecer o reenvio do link.
        if (!usuario.email_verificado) {
            return res.status(403).json({
                codigo: 'email_nao_verificado',
                mensagem: 'Confirme seu e-mail para entrar. Procure o link que enviamos para '
                    + `${usuario.email} (veja também o spam).`
            });
        }

        // O token vai nos cookies, não no corpo: o JavaScript da página não
        // precisa (nem deve) enxergá-lo.
        await iniciarSessao(res, usuario);
        res.json({ mensagem: 'Login realizado com sucesso!', usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
    } catch (erro) {
        console.error('Erro ao fazer login:', erro);
        res.status(500).json({ mensagem: 'Erro ao fazer login.' });
    }
});

// Troca o refresh token por um par novo (rotação). Não usa autenticarToken:
// é chamada justamente quando o access token já venceu, e se autentica pelo
// próprio cookie de refresh.
app.post('/auth/refresh', async (req, res) => {
    const bruto = req.cookies && req.cookies[COOKIE_REFRESH];

    if (!bruto) {
        return res.status(401).json({ mensagem: 'Sessão ausente ou expirada.' });
    }

    const cliente = await pool.connect();

    try {
        // Prazos comparados no banco, com o mesmo relógio que os gravou.
        const achado = await cliente.query(
            `SELECT id, usuario_id,
                    revogado_em IS NOT NULL AS revogado,
                    expira_em <= NOW() AS expirado,
                    substituido_por IS NOT NULL AS rotacionado,
                    substituido_por IS NOT NULL
                        AND revogado_em > NOW() - make_interval(secs => $2) AS rotacionado_agora
               FROM refresh_tokens
              WHERE token_hash = $1`,
            [hashToken(bruto), JANELA_CORRIDA_SEGUNDOS]
        );

        if (achado.rowCount === 0) {
            limparCookiesDeSessao(res);
            return res.status(401).json({ mensagem: 'Sessão ausente ou expirada.' });
        }

        const registro = achado.rows[0];

        if (registro.revogado) {
            // Corrida entre abas: outra acabou de rotacionar este token. Não
            // limpa os cookies — o navegador já guarda os novos, emitidos para
            // a outra aba, e limpar derrubaria a sessão que acabou de renovar.
            if (registro.rotacionado_agora) {
                return res.status(401).json({ mensagem: 'Sessão renovada por outra aba.' });
            }

            // Reuso de um token já TROCADO por outro: alguém mais tem uma cópia
            // dele. Derruba todas as sessões da pessoa e obriga novo login.
            if (registro.rotacionado) {
                await revogarSessoesDoUsuario(cliente, registro.usuario_id);
                console.warn(`[SESSAO] Reuso de refresh token do usuário ${registro.usuario_id}: todas as sessões revogadas.`);
                limparCookiesDeSessao(res);
                return res.status(401).json({ mensagem: 'Sessão encerrada por segurança. Entre novamente.' });
            }

            // Revogado por logout ou troca de senha: sessão encerrada, não sinal
            // de roubo. Tratar como reuso seria desastroso — o dispositivo que
            // ficou para trás, ao tentar renovar, derrubaria a sessão nova de
            // quem acabou de trocar a senha.
            limparCookiesDeSessao(res);
            return res.status(401).json({ mensagem: 'Sessão encerrada. Entre novamente.' });
        }

        if (registro.expirado) {
            limparCookiesDeSessao(res);
            return res.status(401).json({ mensagem: 'Sessão expirada. Entre novamente.' });
        }

        await cliente.query('BEGIN');

        // Reivindica o token de forma atômica. Se duas requisições chegarem
        // juntas com ele, só uma passa daqui; a outra cai na corrida acima.
        const reivindicado = await cliente.query(
            'UPDATE refresh_tokens SET revogado_em = NOW() WHERE id = $1 AND revogado_em IS NULL RETURNING id',
            [registro.id]
        );

        if (reivindicado.rowCount === 0) {
            await cliente.query('ROLLBACK');
            return res.status(401).json({ mensagem: 'Sessão renovada por outra aba.' });
        }

        const usuario = await cliente.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [registro.usuario_id]);

        if (usuario.rowCount === 0) {
            await cliente.query('ROLLBACK');
            limparCookiesDeSessao(res);
            return res.status(401).json({ mensagem: 'Sessão ausente ou expirada.' });
        }

        const novo = await gravarRefreshToken(cliente, registro.usuario_id);
        await cliente.query('UPDATE refresh_tokens SET substituido_por = $1 WHERE id = $2', [novo.id, registro.id]);
        await cliente.query('COMMIT');

        // O CSRF continua o mesmo durante a sessão. Trocá-lo a cada renovação
        // abriria corrida com requisições de outras abas já montadas com o valor
        // anterior; ele só nasce de novo quando a sessão nasce (login).
        const csrf = (req.cookies && req.cookies[COOKIE_CSRF]) || crypto.randomBytes(32).toString('hex');

        definirCookiesDeSessao(res, emitirAccessToken(usuario.rows[0]), novo.token, csrf);
        return res.json({ usuario: usuario.rows[0] });
    } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        console.error('Erro ao renovar sessão:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível renovar a sessão.' });
    } finally {
        cliente.release();
    }
});

// Encerra a sessão deste navegador. Sem autenticarToken, de propósito: sair
// precisa funcionar mesmo com o access token já vencido, e a sessão a encerrar
// é identificada pelo próprio cookie de refresh. Com cookie de sessão presente,
// o middleware de CSRF já exigiu o token — um site de fora não força o logout.
app.post('/auth/logout', async (req, res) => {
    const bruto = req.cookies && req.cookies[COOKIE_REFRESH];

    try {
        if (bruto) {
            await pool.query(
                'UPDATE refresh_tokens SET revogado_em = NOW() WHERE token_hash = $1 AND revogado_em IS NULL',
                [hashToken(bruto)]
            );
        }
    } catch (erro) {
        // Os cookies saem mesmo assim: o navegador fica deslogado, e o token
        // que sobrou no banco expira sozinho.
        console.error('Erro ao revogar sessão no logout:', erro);
    }

    limparCookiesDeSessao(res);
    return res.json({ mensagem: 'Sessão encerrada.' });
});

// Campos da conta devolvidos por GET e PUT /auth/me. Do Google e da senha só
// saem os indicadores — nunca o google_id nem o hash —, o bastante para a
// central da conta decidir que formulário mostrar.
const CAMPOS_USUARIO_CONTA = `id, nome, email, admin, criado_em,
    google_id IS NOT NULL AS "googleConectado",
    senha IS NOT NULL AS "temSenha"`;

// ---------------------------------------------------------------------------
// Login com Google
// ---------------------------------------------------------------------------

const URL_TOKENINFO_GOOGLE = 'https://oauth2.googleapis.com/tokeninfo';
const EMISSORES_GOOGLE = ['accounts.google.com', 'https://accounts.google.com'];

// Confere a credencial direto na Google, sem biblioteca: o endpoint público
// valida assinatura e expiração, e aqui se confere o resto. Mesmo raciocínio
// do webhook do Mercado Pago — nada que chega do navegador vale sem reconferir
// na fonte. O token nunca vai para o log.
async function verificarCredencialGoogle(credential) {
    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!clientId) {
        return { ok: false, status: 503, mensagem: 'O login com Google não está configurado nesta instalação.' };
    }

    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096) {
        return { ok: false, status: 400, mensagem: 'Credencial do Google ausente ou inválida.' };
    }

    let resposta;
    try {
        resposta = await fetch(`${URL_TOKENINFO_GOOGLE}?id_token=${encodeURIComponent(credential)}`, {
            signal: AbortSignal.timeout(5000)
        });
    } catch (erro) {
        console.error('[GOOGLE] Falha ao consultar o tokeninfo:', erro && erro.message ? erro.message : erro);
        return { ok: false, status: 502, mensagem: 'Não foi possível falar com o Google agora. Tente novamente.' };
    }

    const invalida = { ok: false, status: 401, mensagem: 'Credencial do Google inválida ou expirada.' };

    if (!resposta.ok) return invalida;

    const info = await resposta.json().catch(() => null);
    if (!info) return invalida;

    // Emitido para ESTE aplicativo: um token válido de outro site com login
    // Google não pode abrir sessão aqui.
    if (info.aud !== clientId) {
        return { ok: false, status: 401, mensagem: 'Credencial do Google emitida para outro aplicativo.' };
    }

    if (!EMISSORES_GOOGLE.includes(info.iss) || !(Number(info.exp) * 1000 > Date.now())) {
        return invalida;
    }

    // O vínculo automático por e-mail só é seguro porque a Google confirmou
    // que a pessoa controla esse endereço. O tokeninfo devolve texto.
    if (info.email_verified !== 'true' && info.email_verified !== true) {
        return { ok: false, status: 401, mensagem: 'O Google não confirmou este e-mail. Use outra forma de entrar.' };
    }

    if (!info.sub || !info.email) return invalida;

    const email = String(info.email).trim();
    const nome = String(info.name || info.given_name || email.split('@')[0]).trim().slice(0, 100);

    return { ok: true, googleId: String(info.sub), email, nome };
}

// Cria a conta na primeira vez e entra nas seguintes. Depois daqui a sessão é
// idêntica à de quem entra com senha: autenticarToken e exigirAdmin não sabem
// nem precisam saber como a pessoa entrou.
app.post('/auth/google', limitadorLogin, async (req, res) => {
    const verificacao = await verificarCredencialGoogle(req.body && req.body.credential);

    if (!verificacao.ok) {
        return res.status(verificacao.status).json({ mensagem: verificacao.mensagem });
    }

    const { googleId, email, nome } = verificacao;
    const cliente = await pool.connect();
    let usuario;
    let criada = false;

    try {
        await cliente.query('BEGIN');

        // 1. Já vinculada: o sub é estável, mesmo que o e-mail mude na Google.
        const porGoogle = await cliente.query('SELECT id, nome, email FROM usuarios WHERE google_id = $1', [googleId]);

        if (porGoogle.rowCount > 0) {
            usuario = porGoogle.rows[0];
        } else {
            // 2. Mesmo e-mail, já verificado pela Google: vincula. A comparação
            // ignora maiúsculas porque contas antigas gravaram o e-mail como a
            // pessoa digitou.
            const porEmail = await cliente.query(
                `SELECT id, nome, email, google_id, email_verificado FROM usuarios
                  WHERE lower(email) = lower($1)
                  ORDER BY (email = $1) DESC
                  LIMIT 1
                  FOR UPDATE`,
                [email]
            );

            if (porEmail.rowCount > 0) {
                const existente = porEmail.rows[0];

                // Já ligada a OUTRA conta Google (outro sub com o mesmo e-mail).
                // Trocar em silêncio entregaria a conta a quem chegou por último.
                if (existente.google_id) {
                    await cliente.query('ROLLBACK');
                    return res.status(409).json({
                        mensagem: 'Este e-mail já está conectado a outra conta Google. Entre com e-mail e senha.'
                    });
                }

                if (existente.email_verificado) {
                    await cliente.query('UPDATE usuarios SET google_id = $1 WHERE id = $2', [googleId, existente.id]);
                } else {
                    // Conta com e-mail nunca confirmado: a senha dela foi
                    // definida por alguém que não provou ser dono do endereço —
                    // talvez outra pessoa, cadastrando o e-mail alheio de
                    // antemão. Quem prova agora é a Google: a senha antiga é
                    // desativada e tudo que ela abriu cai. A dona define outra
                    // senha em Minha conta, se quiser.
                    await cliente.query(
                        'UPDATE usuarios SET google_id = $1, email_verificado = TRUE, senha = NULL WHERE id = $2',
                        [googleId, existente.id]
                    );
                    await cliente.query(
                        'UPDATE verificacoes_email SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL',
                        [existente.id]
                    );
                    await revogarSessoesDoUsuario(cliente, existente.id);
                }

                usuario = { id: existente.id, nome: existente.nome, email: existente.email };
            } else {
                // 3. Conta nova: sem senha e sem admin, como todo cadastro
                // público. O e-mail já vem confirmado pela Google.
                const nova = await cliente.query(
                    `INSERT INTO usuarios (nome, email, senha, admin, google_id, email_verificado)
                     VALUES ($1, $2, NULL, FALSE, $3, TRUE)
                     RETURNING id, nome, email`,
                    [nome, normalizarEmail(email), googleId]
                );
                usuario = nova.rows[0];
                criada = true;

                // Mesmo histórico inicial do cadastro com senha, para a central
                // da conta não abrir diferente para quem veio pelo Google.
                await cliente.query(
                    'INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3)',
                    [usuario.id, 'Pedido de boas-vindas', 'Em transporte']
                );
            }
        }

        await cliente.query('COMMIT');
    } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        console.error('Erro no login com Google:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível entrar com o Google.' });
    } finally {
        cliente.release();
    }

    try {
        await iniciarSessao(res, usuario);
    } catch (erro) {
        console.error('Erro ao abrir sessão do login com Google:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível entrar com o Google.' });
    }

    return res.status(criada ? 201 : 200).json({
        mensagem: criada ? 'Conta criada com o Google.' : 'Login realizado com sucesso!',
        usuario
    });
});

// Só com senha definida: sem ela, desconectar deixaria a conta sem nenhuma
// forma de entrar. A condição vai no próprio UPDATE, então não há janela entre
// conferir e gravar.
app.post('/auth/google/desconectar', autenticarToken, async (req, res) => {
    try {
        const situacao = await pool.query(
            'SELECT senha IS NOT NULL AS tem_senha, google_id IS NOT NULL AS conectado FROM usuarios WHERE id = $1',
            [req.usuario.id]
        );

        if (situacao.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Usuário não encontrado.' });
        }

        if (!situacao.rows[0].tem_senha) {
            return res.status(400).json({
                mensagem: 'Defina uma senha antes de desconectar do Google: sem ela, a conta ficaria sem nenhuma forma de entrar.'
            });
        }

        if (!situacao.rows[0].conectado) {
            return res.json({ mensagem: 'Sua conta já não está conectada ao Google.' });
        }

        await pool.query('UPDATE usuarios SET google_id = NULL WHERE id = $1 AND senha IS NOT NULL', [req.usuario.id]);
        return res.json({ mensagem: 'Conta desconectada do Google. A partir de agora, entre com e-mail e senha.' });
    } catch (erro) {
        console.error('Erro ao desconectar do Google:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível desconectar do Google.' });
    }
});

app.get('/auth/me', autenticarToken, async (req, res) => {
    try {
        const usuarioResult = await pool.query(
            `SELECT ${CAMPOS_USUARIO_CONTA} FROM usuarios WHERE id = $1`,
            [req.usuario.id]
        );

        if (usuarioResult.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Usuário não encontrado.' });
        }

        await expirarPedidosPendentes(req.usuario.id);

        const comprasResult = await pool.query(
            'SELECT id, pedido, status, criado_em FROM historico_compras WHERE usuario_id = $1 ORDER BY criado_em DESC',
            [req.usuario.id]
        );

        res.json({
            usuario: usuarioResult.rows[0],
            compras: comprasResult.rows
        });
    } catch (erro) {
        console.error('Erro ao buscar dados do usuário:', erro);
        res.status(500).json({ mensagem: 'Erro ao buscar perfil.' });
    }
});

// ---------------------------------------------------------------------------
// Central da conta
// ---------------------------------------------------------------------------

app.put('/auth/me', autenticarToken, async (req, res) => {
    const nome = String((req.body && req.body.nome) || '').trim();

    if (nome.length < 2 || nome.length > 100) {
        return res.status(400).json({ mensagem: 'O nome precisa ter entre 2 e 100 caracteres.' });
    }

    try {
        const resultado = await pool.query(
            `UPDATE usuarios SET nome = $1 WHERE id = $2 RETURNING ${CAMPOS_USUARIO_CONTA}`,
            [nome, req.usuario.id]
        );

        if (resultado.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Usuário não encontrado.' });
        }

        return res.json({ mensagem: 'Dados atualizados.', usuario: resultado.rows[0] });
    } catch (erro) {
        console.error('Erro ao atualizar dados do usuário:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível atualizar seus dados.' });
    }
});

// Trocar senha exige a senha atual. Sem isso, um token roubado — de uma sessão
// esquecida em máquina compartilhada, por exemplo — bastaria para tomar a conta.
app.post('/auth/alterar-senha', limitadorSenha, autenticarToken, async (req, res) => {
    const senhaAtual = String((req.body && req.body.senhaAtual) || '');
    const novaSenha = String((req.body && req.body.novaSenha) || '');

    try {
        const usuario = await pool.query('SELECT senha, email FROM usuarios WHERE id = $1', [req.usuario.id]);

        if (usuario.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Usuário não encontrado.' });
        }

        // Conta criada pelo Google, ainda sem senha: esta rota vira "definir a
        // primeira senha". Não há senha atual a conferir — e é essa senha que
        // depois libera o botão de desconectar do Google.
        const temSenha = usuario.rows[0].senha !== null;

        if (!novaSenha || (temSenha && !senhaAtual)) {
            return res.status(400).json({
                mensagem: temSenha ? 'Informe a senha atual e a nova senha.' : 'Informe a nova senha.'
            });
        }

        const problemaSenha = validarForcaSenha(novaSenha, usuario.rows[0].email);
        if (problemaSenha) {
            return res.status(400).json({ mensagem: problemaSenha });
        }

        // Com senha, a regra de sempre: a atual precisa conferir. É a guarda
        // contra um token roubado bastar para tomar a conta.
        if (temSenha) {
            if (novaSenha === senhaAtual) {
                return res.status(400).json({ mensagem: 'A nova senha precisa ser diferente da atual.' });
            }

            if (!(await bcrypt.compare(senhaAtual, usuario.rows[0].senha))) {
                return res.status(403).json({ mensagem: 'A senha atual não confere.' });
            }
        }

        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [
            await bcrypt.hash(novaSenha, 10),
            req.usuario.id
        ]);

        // Derruba todas as sessões e abre uma nova para este navegador. Quem
        // troca a senha costuma desconfiar de acesso indevido; sem isto, um
        // refresh token roubado seguiria renovando a sessão por 30 dias.
        const usuarioSessao = await pool.query('SELECT id, email FROM usuarios WHERE id = $1', [req.usuario.id]);
        await revogarSessoesDoUsuario(pool, req.usuario.id);
        await iniciarSessao(res, usuarioSessao.rows[0]);

        // Os outros dispositivos ainda têm o access token, que não se revoga
        // e dura até 15 minutos. A resposta diz isso em vez de prometer "na hora".
        return res.json({
            mensagem: temSenha
                ? 'Senha alterada com sucesso.'
                : 'Senha definida. Agora você também pode entrar com e-mail e senha.',
            aviso: 'Sessões abertas em outros dispositivos serão encerradas em até 15 minutos.'
        });
    } catch (erro) {
        console.error('Erro ao alterar senha:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível alterar a senha.' });
    }
});

// Avaliações que a pessoa escreveu, com o produto ao lado para dar contexto.
app.get('/auth/me/avaliacoes', autenticarToken, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT a.id, a.nota, a.titulo, a.comentario, a.criado_em, a.atualizado_em,
                    p.id AS produto_id, p.nome AS produto_nome, p.imagem_url, p.ativo
               FROM avaliacoes a
               JOIN produtos p ON p.id = a.produto_id
              WHERE a.usuario_id = $1
              ORDER BY a.criado_em DESC`,
            [req.usuario.id]
        );

        return res.json({
            avaliacoes: resultado.rows.map((linha) => ({
                id: linha.id,
                nota: linha.nota,
                titulo: linha.titulo,
                comentario: linha.comentario,
                criadoEm: linha.criado_em,
                produto: {
                    id: linha.produto_id,
                    nome: linha.produto_nome,
                    imagemUrl: linha.imagem_url,
                    // Produto fora do catálogo ainda aparece, mas sem link.
                    ativo: linha.ativo
                }
            }))
        });
    } catch (erro) {
        console.error('Erro ao listar avaliações do usuário:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar suas avaliações.' });
    }
});

app.post('/auth/recuperar-senha', limitadorSenha, async (req, res) => {
    const email = normalizarEmail(req.body && req.body.email);

    if (!email) {
        return res.status(400).json({ mensagem: 'Informe um e-mail para continuar.' });
    }

    try {
        const resultado = await pool.query(
            'SELECT id FROM usuarios WHERE lower(email) = $1 ORDER BY (email = $1) DESC LIMIT 1',
            [email]
        );

        // O mesmo log, idêntico, nos dois caminhos. Se ele saísse só quando a
        // conta existe, a presença da linha no log revelaria o cadastro — o
        // que a resposta genérica abaixo existe justamente para esconder.
        if (resultado.rowCount === 0) {
            console.log('[RESET] solicitação de recuperação processada');
            return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
        }

        const token = await criarTokenRecuperacao(resultado.rows[0].id);
        const resultadoEnvio = await enviarEmailRecuperacao(email, token);

        if (!resultadoEnvio || !resultadoEnvio.ok) {
            console.error('[RESET] envio SMTP falhou:', resultadoEnvio && resultadoEnvio.motivo ? resultadoEnvio.motivo : 'motivo não informado');
            // O banco guarda o hash, não o token: apagar pelo valor bruto não
            // acharia a linha e deixaria um link válido que ninguém recebeu.
            await pool.query('DELETE FROM password_resets WHERE token = $1', [hashToken(token)]);
            return res.status(502).json({ mensagem: 'Não foi possível enviar o e-mail de recuperação no momento. Tente novamente mais tarde.' });
        }

        console.log('[RESET] solicitação de recuperação processada');

        return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
    } catch (erro) {
        console.error('[RESET] erro ao solicitar recuperação:', erro && erro.message ? erro.message : erro);
        if (erro && erro.stack) {
            console.error('[RESET] stack:', erro.stack);
        }
        return res.status(500).json({ mensagem: 'Não foi possível solicitar a recuperação da senha.' });
    }
});

app.post('/auth/redefinir-senha', limitadorSenha, async (req, res) => {
    const { token, senha } = req.body;

    if (!token || !senha) {
        return res.status(400).json({ mensagem: 'Token e nova senha são obrigatórios.' });
    }

    try {
        // Compara hash com hash: o banco nunca viu o token bruto.
        const resultado = await pool.query(
            'SELECT id, usuario_id, expira_em, usado FROM password_resets WHERE token = $1',
            [hashToken(token)]
        );

        if (resultado.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Token inválido ou expirado.' });
        }

        const reset = resultado.rows[0];
        if (reset.usado) {
            return res.status(400).json({ mensagem: 'Este link já foi utilizado.' });
        }

        if (new Date(reset.expira_em) < new Date()) {
            return res.status(400).json({ mensagem: 'Este link expirou. Solicite um novo.' });
        }

        const conta = await pool.query('SELECT email FROM usuarios WHERE id = $1', [reset.usuario_id]);
        const problemaSenha = validarForcaSenha(senha, conta.rows[0] && conta.rows[0].email);
        if (problemaSenha) {
            return res.status(400).json({ mensagem: problemaSenha });
        }

        // O link chegou pelo e-mail: usá-lo prova que a pessoa controla o
        // endereço, então a conta fica confirmada. É também o caminho de quem
        // teve o e-mail cadastrado por outra pessoa — a senha que vale passa a
        // ser a dela.
        const senhaHash = await bcrypt.hash(senha, 10);
        await pool.query(
            'UPDATE usuarios SET senha = $1, email_verificado = TRUE WHERE id = $2',
            [senhaHash, reset.usuario_id]
        );
        // Invalida todos os pedidos pendentes da pessoa, não só o do link
        // clicado. Quem pediu recuperação duas vezes ficaria com o outro link
        // valendo por até 30 minutos depois de a senha já ter sido trocada.
        await pool.query(
            'UPDATE password_resets SET usado = TRUE WHERE usuario_id = $1 AND usado = FALSE',
            [reset.usuario_id]
        );
        // Redefinir a senha é o caminho de quem perdeu o controle da conta.
        // Sem revogar, quem tomou a sessão seguiria renovando-a por 30 dias.
        await revogarSessoesDoUsuario(pool, reset.usuario_id);

        res.json({ mensagem: 'Senha redefinida com sucesso!' });
    } catch (erro) {
        console.error('Erro ao redefinir senha:', erro);
        res.status(500).json({ mensagem: 'Não foi possível redefinir a senha.' });
    }
});

app.get('/produtos', async (req, res) => {
    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    try {
        // A média entra na consulta da vitrine para as estrelas aparecerem já
        // no cartão. LEFT JOIN porque produto sem avaliação ainda é listado.
        const resultado = await pool.query(
            `SELECT p.id, p.nome, p.descricao, p.preco, p.preco_original, p.categoria,
                    p.imagem_url, p.estoque, p.tags,
                    COALESCE(ROUND(AVG(a.nota)::numeric, 2), 0) AS nota_media,
                    COUNT(a.id)::int AS total_avaliacoes
             FROM produtos p
             LEFT JOIN avaliacoes a ON a.produto_id = p.id
             WHERE p.ativo = TRUE
             GROUP BY p.id
             ORDER BY p.id`
        );

        const emUso = new Set(resultado.rows.map((linha) => linha.categoria));

        return res.json({
            produtos: resultado.rows.map((linha) => ({
                id: linha.id,
                nome: linha.nome,
                descricao: linha.descricao,
                preco: Number(linha.preco),
                precoOriginal: linha.preco_original === null ? null : Number(linha.preco_original),
                categoria: linha.categoria,
                imagemUrl: linha.imagem_url,
                tags: linha.tags || [],
                notaMedia: Number(linha.nota_media),
                totalAvaliacoes: linha.total_avaliacoes,
                disponivel: linha.estoque > 0,
                // Sinal grosso, sem revelar o saldo exato do estoque.
                estoqueBaixo: linha.estoque > 0 && linha.estoque <= 5
            })),
            // Só as categorias que têm produto à venda: a loja monta os filtros
            // a partir daqui, e um filtro que não devolve nada é ruído.
            categorias: CATEGORIAS.filter((categoria) => emUso.has(categoria.slug))
        });
    } catch (erro) {
        console.error('Erro ao listar produtos:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar os produtos.' });
    }
});

// ---------------------------------------------------------------------------
// Painel administrativo
//
// Toda rota abaixo exige token válido E a flag admin conferida no banco.
// A ordem importa: autenticarToken preenche req.usuario, exigirAdmin o consulta.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Página de produto
// ---------------------------------------------------------------------------

const LIMITE_AVALIACOES_POR_PAGINA = 10;

// Quem escreveu a avaliação aparece pelo primeiro nome e a inicial do
// sobrenome. Nome completo de cliente numa página pública é exposição
// desnecessária, e só o primeiro nome confunde quando há homônimos.
function nomeAbreviado(nomeCompleto) {
    const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);

    if (partes.length === 0) return 'Cliente';
    if (partes.length === 1) return partes[0];

    return `${partes[0]} ${partes[partes.length - 1][0].toUpperCase()}.`;
}

function serializarAvaliacao(linha) {
    return {
        id: linha.id,
        nota: linha.nota,
        titulo: linha.titulo,
        comentario: linha.comentario,
        autor: nomeAbreviado(linha.usuario_nome),
        criadoEm: linha.criado_em,
        editada: linha.atualizado_em && linha.criado_em
            && new Date(linha.atualizado_em).getTime() - new Date(linha.criado_em).getTime() > 1000
    };
}

// Só avalia quem tem pedido pago contendo o produto. A consulta é a fonte da
// verdade tanto para liberar o formulário quanto para aceitar o POST — nunca
// confiamos no cliente dizer que comprou.
async function comprouOProduto(usuarioId, produtoId, executor = pool) {
    const resultado = await executor.query(
        `SELECT 1
           FROM pedidos ped
           JOIN pedido_itens item ON item.pedido_id = ped.id
          WHERE ped.usuario_id = $1
            AND item.produto_id = $2
            AND ped.status = 'Pago'
          LIMIT 1`,
        [usuarioId, produtoId]
    );

    return resultado.rowCount > 0;
}

async function resumoDeAvaliacoes(produtoId, executor = pool) {
    const resultado = await executor.query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(ROUND(AVG(nota)::numeric, 2), 0) AS media,
                COUNT(*) FILTER (WHERE nota = 5)::int AS n5,
                COUNT(*) FILTER (WHERE nota = 4)::int AS n4,
                COUNT(*) FILTER (WHERE nota = 3)::int AS n3,
                COUNT(*) FILTER (WHERE nota = 2)::int AS n2,
                COUNT(*) FILTER (WHERE nota = 1)::int AS n1
           FROM avaliacoes WHERE produto_id = $1`,
        [produtoId]
    );

    const linha = resultado.rows[0];

    return {
        total: linha.total,
        media: Number(linha.media),
        distribuicao: { 5: linha.n5, 4: linha.n4, 3: linha.n3, 2: linha.n2, 1: linha.n1 }
    };
}

app.get('/produtos/:id', async (req, res) => {
    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        const resultado = await pool.query(
            `SELECT id, nome, descricao, preco, preco_original, categoria, imagem_url,
                    estoque, tags, especificacoes
               FROM produtos WHERE id = $1 AND ativo = TRUE`,
            [id]
        );

        if (resultado.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Produto não encontrado.' });
        }

        const p = resultado.rows[0];

        const imagens = await pool.query(
            'SELECT url, descricao FROM produto_imagens WHERE produto_id = $1 ORDER BY posicao, id',
            [id]
        );

        const avaliacoes = await pool.query(
            `SELECT a.id, a.nota, a.titulo, a.comentario, a.criado_em, a.atualizado_em,
                    u.nome AS usuario_nome
               FROM avaliacoes a
               JOIN usuarios u ON u.id = a.usuario_id
              WHERE a.produto_id = $1
              ORDER BY a.criado_em DESC
              LIMIT $2`,
            [id, LIMITE_AVALIACOES_POR_PAGINA]
        );

        const precoOriginal = p.preco_original === null ? null : Number(p.preco_original);
        const preco = Number(p.preco);

        // A galeria começa pela imagem principal, que é a mesma da vitrine.
        const galeria = [];
        if (p.imagem_url) {
            galeria.push({ url: p.imagem_url, descricao: p.nome });
        }
        imagens.rows.forEach((linha) => {
            if (linha.url !== p.imagem_url) {
                galeria.push({ url: linha.url, descricao: linha.descricao || p.nome });
            }
        });

        return res.json({
            produto: {
                id: p.id,
                nome: p.nome,
                descricao: p.descricao,
                preco,
                // O percentual de desconto não sai daqui: a vitrine e esta
                // página calculam pela mesma função em public/script.js
                // (calcularDescontoPercentual), para a regra morar num lugar só.
                precoOriginal,
                categoria: p.categoria,
                categoriaRotulo: (CATEGORIAS.find((c) => c.slug === p.categoria) || {}).rotulo || p.categoria,
                imagemUrl: p.imagem_url,
                galeria,
                especificacoes: Array.isArray(p.especificacoes) ? p.especificacoes : [],
                tags: p.tags || [],
                disponivel: p.estoque > 0,
                estoqueBaixo: p.estoque > 0 && p.estoque <= 5
            },
            avaliacoes: {
                resumo: await resumoDeAvaliacoes(id),
                itens: avaliacoes.rows.map(serializarAvaliacao)
            },
            // A loja usa isto para explicar por que ninguém pode avaliar ainda.
            checkoutHabilitado: CHECKOUT_HABILITADO
        });
    } catch (erro) {
        console.error('Erro ao carregar produto:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar o produto.' });
    }
});

app.get('/produtos/:id/avaliacoes', async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    const porPagina = Math.min(50, Math.max(1, Number(req.query.porPagina) || LIMITE_AVALIACOES_POR_PAGINA));
    const pagina = Math.max(1, Number(req.query.pagina) || 1);

    try {
        const total = await pool.query('SELECT COUNT(*)::int AS total FROM avaliacoes WHERE produto_id = $1', [id]);

        const resultado = await pool.query(
            `SELECT a.id, a.nota, a.titulo, a.comentario, a.criado_em, a.atualizado_em,
                    u.nome AS usuario_nome
               FROM avaliacoes a
               JOIN usuarios u ON u.id = a.usuario_id
              WHERE a.produto_id = $1
              ORDER BY a.criado_em DESC
              LIMIT $2 OFFSET $3`,
            [id, porPagina, (pagina - 1) * porPagina]
        );

        return res.json({
            avaliacoes: resultado.rows.map(serializarAvaliacao),
            resumo: await resumoDeAvaliacoes(id),
            paginacao: {
                pagina,
                porPagina,
                total: total.rows[0].total,
                totalPaginas: Math.max(1, Math.ceil(total.rows[0].total / porPagina))
            }
        });
    } catch (erro) {
        console.error('Erro ao listar avaliações:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar as avaliações.' });
    }
});

// Diz à interface se o formulário deve aparecer, e devolve a avaliação já
// escrita para permitir edição.
app.get('/produtos/:id/avaliacoes/minha', autenticarToken, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        const comprou = await comprouOProduto(req.usuario.id, id);

        const minha = await pool.query(
            'SELECT id, nota, titulo, comentario, criado_em FROM avaliacoes WHERE produto_id = $1 AND usuario_id = $2',
            [id, req.usuario.id]
        );

        return res.json({
            podeAvaliar: comprou,
            motivo: comprou ? null : 'Só quem comprou este produto pode avaliá-lo.',
            avaliacao: minha.rowCount === 0 ? null : {
                id: minha.rows[0].id,
                nota: minha.rows[0].nota,
                titulo: minha.rows[0].titulo,
                comentario: minha.rows[0].comentario,
                criadoEm: minha.rows[0].criado_em
            }
        });
    } catch (erro) {
        console.error('Erro ao verificar avaliação do usuário:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível verificar sua avaliação.' });
    }
});

app.post('/produtos/:id/avaliacoes', limitadorCadastro, autenticarToken, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    const nota = Number(req.body && req.body.nota);
    const titulo = String((req.body && req.body.titulo) || '').trim().slice(0, 120);
    const comentario = String((req.body && req.body.comentario) || '').trim().slice(0, 2000);

    if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
        return res.status(400).json({ mensagem: 'A nota precisa ser um número inteiro de 1 a 5.' });
    }

    try {
        const existe = await pool.query('SELECT 1 FROM produtos WHERE id = $1 AND ativo = TRUE', [id]);

        if (existe.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Produto não encontrado.' });
        }

        // A checagem de compra é do servidor. Um cliente adulterado que poste
        // direto no endpoint esbarra aqui.
        if (!(await comprouOProduto(req.usuario.id, id))) {
            return res.status(403).json({
                mensagem: 'Só quem comprou este produto pode avaliá-lo.'
            });
        }

        // Reenviar substitui a avaliação anterior: a constraint UNIQUE impede
        // que a mesma pessoa acumule várias no mesmo produto.
        // O nome vem do banco, não do token: req.usuario só carrega id e email,
        // e devolver o e-mail aqui o exibiria como autor na página pública.
        const resultado = await pool.query(
            `WITH gravada AS (
                INSERT INTO avaliacoes (produto_id, usuario_id, nota, titulo, comentario)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (produto_id, usuario_id) DO UPDATE SET
                    nota = EXCLUDED.nota,
                    titulo = EXCLUDED.titulo,
                    comentario = EXCLUDED.comentario,
                    atualizado_em = CURRENT_TIMESTAMP
                RETURNING id, usuario_id, nota, titulo, comentario, criado_em, atualizado_em
            )
            SELECT g.id, g.nota, g.titulo, g.comentario, g.criado_em, g.atualizado_em,
                   u.nome AS usuario_nome
              FROM gravada g JOIN usuarios u ON u.id = g.usuario_id`,
            [id, req.usuario.id, nota, titulo, comentario]
        );

        return res.status(201).json({
            mensagem: 'Avaliação registrada.',
            avaliacao: serializarAvaliacao(resultado.rows[0]),
            resumo: await resumoDeAvaliacoes(id)
        });
    } catch (erro) {
        console.error('Erro ao registrar avaliação:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível registrar sua avaliação.' });
    }
});

app.delete('/produtos/:id/avaliacoes/minha', autenticarToken, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        const resultado = await pool.query(
            'DELETE FROM avaliacoes WHERE produto_id = $1 AND usuario_id = $2 RETURNING id',
            [id, req.usuario.id]
        );

        if (resultado.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Você não tem avaliação neste produto.' });
        }

        return res.json({ mensagem: 'Avaliação removida.', resumo: await resumoDeAvaliacoes(id) });
    } catch (erro) {
        console.error('Erro ao remover avaliação:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível remover sua avaliação.' });
    }
});

// Troca a galeria inteira pela lista recebida. Substituir é mais simples que
// reconciliar e evita ordem inconsistente: a posição vem do índice do array.
async function substituirGaleria(produtoId, urls, executor) {
    await executor.query('DELETE FROM produto_imagens WHERE produto_id = $1', [produtoId]);

    for (let i = 0; i < urls.length; i += 1) {
        await executor.query(
            'INSERT INTO produto_imagens (produto_id, url, posicao) VALUES ($1, $2, $3)',
            [produtoId, urls[i], i]
        );
    }
}

async function lerGaleria(produtoId, executor = pool) {
    const resultado = await executor.query(
        'SELECT url FROM produto_imagens WHERE produto_id = $1 ORDER BY posicao, id',
        [produtoId]
    );
    return resultado.rows.map((linha) => linha.url);
}

function serializarProduto(linha) {
    return {
        id: linha.id,
        nome: linha.nome,
        descricao: linha.descricao,
        preco: Number(linha.preco),
        precoOriginal: linha.preco_original === null || linha.preco_original === undefined
            ? null
            : Number(linha.preco_original),
        especificacoes: Array.isArray(linha.especificacoes) ? linha.especificacoes : [],
        categoria: linha.categoria,
        imagemUrl: linha.imagem_url,
        estoque: linha.estoque,
        ativo: linha.ativo,
        tags: linha.tags || [],
        criadoEm: linha.criado_em,
        atualizadoEm: linha.atualizado_em
    };
}

// Lista o catálogo inteiro, inclusive inativos — diferente do GET /produtos
// público, que só devolve o que está à venda.
app.get('/admin/produtos', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT p.id, p.nome, p.descricao, p.preco, p.preco_original, p.categoria, p.imagem_url,
                    p.estoque, p.ativo, p.tags, p.especificacoes, p.criado_em, p.atualizado_em,
                    COALESCE(SUM(i.quantidade) FILTER (WHERE ped.status = 'Pago'), 0)::int AS vendidos,
                    COALESCE(
                        (SELECT array_agg(img.url ORDER BY img.posicao, img.id)
                           FROM produto_imagens img WHERE img.produto_id = p.id),
                        ARRAY[]::text[]
                    ) AS imagens
             FROM produtos p
             LEFT JOIN pedido_itens i ON i.produto_id = p.id
             LEFT JOIN pedidos ped ON ped.id = i.pedido_id
             GROUP BY p.id
             ORDER BY p.id`
        );

        return res.json({
            produtos: resultado.rows.map((linha) => ({
                ...serializarProduto(linha),
                vendidos: linha.vendidos,
                imagens: linha.imagens || []
            })),
            categorias: CATEGORIAS
        });
    } catch (erro) {
        console.error('Erro ao listar produtos no painel:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar os produtos.' });
    }
});

app.post('/admin/produtos', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const validacao = validarDadosProduto(req.body || {});

    if (!validacao.valido) {
        return res.status(400).json({ mensagem: validacao.erros[0], erros: validacao.erros });
    }

    const d = validacao.dados;

    // Produto e galeria numa transação: gravar o produto e falhar nas imagens
    // deixaria um cadastro pela metade sem ninguém perceber.
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const resultado = await client.query(
            `INSERT INTO produtos (nome, descricao, preco, preco_original, categoria, imagem_url,
                                   estoque, ativo, tags, especificacoes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
             RETURNING *`,
            [d.nome, d.descricao, d.preco, d.precoOriginal, d.categoria, d.imagemUrl,
             d.estoque, d.ativo, d.tags, JSON.stringify(d.especificacoes || [])]
        );

        const produto = resultado.rows[0];

        if (d.imagens) {
            await substituirGaleria(produto.id, d.imagens, client);
        }

        await client.query('COMMIT');

        console.log(`[ADMIN] Usuário ${req.usuario.id} criou o produto "${d.nome}".`);

        return res.status(201).json({
            mensagem: 'Produto criado.',
            produto: { ...serializarProduto(produto), imagens: d.imagens || [] }
        });
    } catch (erro) {
        await client.query('ROLLBACK').catch(() => {});

        if (erro.code === '23505') {
            return res.status(409).json({ mensagem: 'Já existe um produto com esse nome.' });
        }

        console.error('Erro ao criar produto:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível criar o produto.' });
    } finally {
        client.release();
    }
});

app.put('/admin/produtos/:id', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    const validacao = validarDadosProduto(req.body || {}, { parcial: true });

    if (!validacao.valido) {
        return res.status(400).json({ mensagem: validacao.erros[0], erros: validacao.erros });
    }

    const d = validacao.dados;

    const colunas = {
        nome: 'nome',
        descricao: 'descricao',
        preco: 'preco',
        precoOriginal: 'preco_original',
        categoria: 'categoria',
        imagemUrl: 'imagem_url',
        estoque: 'estoque',
        ativo: 'ativo',
        tags: 'tags',
        especificacoes: 'especificacoes'
    };

    const atribuicoes = [];
    const valores = [];

    for (const [campo, coluna] of Object.entries(colunas)) {
        if (d[campo] === undefined) continue;

        // jsonb precisa de texto com cast: o driver mandaria um array do
        // Postgres, que a coluna recusa.
        if (campo === 'especificacoes') {
            valores.push(JSON.stringify(d[campo]));
            atribuicoes.push(`${coluna} = $${valores.length}::jsonb`);
            continue;
        }

        valores.push(d[campo]);
        atribuicoes.push(`${coluna} = $${valores.length}`);
    }

    if (atribuicoes.length === 0 && d.imagens === undefined) {
        return res.status(400).json({ mensagem: 'Nenhum campo para atualizar.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const atual = await client.query('SELECT preco, preco_original FROM produtos WHERE id = $1 FOR UPDATE', [id]);

        if (atual.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ mensagem: 'Produto não encontrado.' });
        }

        // Numa edição parcial, só um dos dois preços costuma vir. Sem comparar
        // com o valor já gravado, dava para deixar um desconto inválido no ar.
        const precoDepois = d.preco !== undefined ? d.preco : Number(atual.rows[0].preco);
        const originalDepois = d.precoOriginal !== undefined
            ? d.precoOriginal
            : (atual.rows[0].preco_original === null ? null : Number(atual.rows[0].preco_original));

        if (originalDepois !== null && originalDepois <= precoDepois) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                mensagem: 'O preço original precisa ser maior que o preço atual para valer como desconto.'
            });
        }

        let produto;

        if (atribuicoes.length > 0) {
            valores.push(id);
            const resultado = await client.query(
                `UPDATE produtos SET ${atribuicoes.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
                 WHERE id = $${valores.length}
                 RETURNING *`,
                valores
            );
            produto = resultado.rows[0];
        } else {
            produto = (await client.query('SELECT * FROM produtos WHERE id = $1', [id])).rows[0];
        }

        if (d.imagens !== undefined) {
            await substituirGaleria(id, d.imagens, client);
        }

        const galeria = await lerGaleria(id, client);
        await client.query('COMMIT');

        console.log(`[ADMIN] Usuário ${req.usuario.id} editou o produto ${id}.`);

        return res.json({
            mensagem: 'Produto atualizado.',
            produto: { ...serializarProduto(produto), imagens: galeria }
        });
    } catch (erro) {
        await client.query('ROLLBACK').catch(() => {});

        if (erro.code === '23505') {
            return res.status(409).json({ mensagem: 'Já existe um produto com esse nome.' });
        }

        console.error('Erro ao atualizar produto:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível atualizar o produto.' });
    } finally {
        client.release();
    }
});

app.delete('/admin/produtos/:id', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        // Itens de pedido apontam para o produto com ON DELETE SET NULL: o
        // histórico sobrevive porque nome e preço estão congelados na linha.
        const vinculos = await pool.query('SELECT COUNT(*)::int AS total FROM pedido_itens WHERE produto_id = $1', [id]);
        const resultado = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING nome', [id]);

        if (resultado.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Produto não encontrado.' });
        }

        console.log(`[ADMIN] Usuário ${req.usuario.id} excluiu o produto ${id} ("${resultado.rows[0].nome}").`);

        return res.json({
            mensagem: 'Produto excluído.',
            itensDePedidoAfetados: vinculos.rows[0].total
        });
    } catch (erro) {
        console.error('Erro ao excluir produto:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível excluir o produto.' });
    }
});

// Somente leitura. Alterar status de pagamento pela mão criaria divergência
// com o Mercado Pago, que é a fonte de verdade — a sincronização acontece pelo
// webhook e por /pagamentos/confirmar.
app.get('/admin/pedidos', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const porPagina = Math.min(100, Math.max(1, Number(req.query.porPagina) || 25));
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    const filtros = [];
    const valores = [];

    if (status && status !== 'todos') {
        valores.push(status);
        filtros.push(`p.status = $${valores.length}`);
    }

    const onde = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

    try {
        const total = await pool.query(`SELECT COUNT(*)::int AS total FROM pedidos p ${onde}`, valores);

        valores.push(porPagina, (pagina - 1) * porPagina);

        const resultado = await pool.query(
            `SELECT p.id, p.external_reference, p.status, p.payment_status, p.payment_id,
                    p.subtotal, p.frete, p.total, p.moeda, p.estoque_baixado,
                    p.criado_em, p.atualizado_em,
                    u.id AS usuario_id, u.nome AS usuario_nome, u.email AS usuario_email,
                    COUNT(i.id)::int AS total_itens
             FROM pedidos p
             JOIN usuarios u ON u.id = p.usuario_id
             LEFT JOIN pedido_itens i ON i.pedido_id = p.id
             ${onde}
             GROUP BY p.id, u.id
             ORDER BY p.criado_em DESC
             LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
            valores
        );

        const statusDisponiveis = await pool.query('SELECT DISTINCT status FROM pedidos ORDER BY status');

        return res.json({
            pedidos: resultado.rows.map((linha) => ({
                id: linha.id,
                referencia: linha.external_reference,
                status: linha.status,
                statusPagamento: linha.payment_status,
                paymentId: linha.payment_id,
                subtotal: Number(linha.subtotal),
                frete: Number(linha.frete),
                total: Number(linha.total),
                moeda: linha.moeda,
                estoqueBaixado: linha.estoque_baixado,
                totalItens: linha.total_itens,
                criadoEm: linha.criado_em,
                atualizadoEm: linha.atualizado_em,
                cliente: {
                    id: linha.usuario_id,
                    nome: linha.usuario_nome,
                    email: linha.usuario_email
                }
            })),
            paginacao: {
                pagina,
                porPagina,
                total: total.rows[0].total,
                totalPaginas: Math.max(1, Math.ceil(total.rows[0].total / porPagina))
            },
            statusDisponiveis: statusDisponiveis.rows.map((linha) => linha.status)
        });
    } catch (erro) {
        console.error('Erro ao listar pedidos no painel:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar os pedidos.' });
    }
});

app.get('/admin/pedidos/:id', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        const pedidoResult = await pool.query(
            `SELECT p.*, u.nome AS usuario_nome, u.email AS usuario_email, c.codigo AS cupom_codigo
             FROM pedidos p
             JOIN usuarios u ON u.id = p.usuario_id
             LEFT JOIN cupons c ON c.id = p.cupom_id
             WHERE p.id = $1`,
            [id]
        );

        if (pedidoResult.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Pedido não encontrado.' });
        }

        const pedido = pedidoResult.rows[0];

        const itensResult = await pool.query(
            `SELECT id, produto_id, nome, preco_unitario, quantidade, total
             FROM pedido_itens WHERE pedido_id = $1 ORDER BY id`,
            [id]
        );

        return res.json({
            pedido: {
                id: pedido.id,
                referencia: pedido.external_reference,
                preferenceId: pedido.preference_id,
                paymentId: pedido.payment_id,
                status: pedido.status,
                statusPagamento: pedido.payment_status,
                subtotal: Number(pedido.subtotal),
                desconto: Number(pedido.desconto),
                cupom: pedido.cupom_codigo || null,
                cupomContabilizado: pedido.cupom_contabilizado,
                frete: Number(pedido.frete),
                total: Number(pedido.total),
                moeda: pedido.moeda,
                estoqueBaixado: pedido.estoque_baixado,
                expiraEm: pedido.expira_em,
                criadoEm: pedido.criado_em,
                atualizadoEm: pedido.atualizado_em,
                cliente: {
                    id: pedido.usuario_id,
                    nome: pedido.usuario_nome,
                    email: pedido.usuario_email
                }
            },
            itens: itensResult.rows.map((linha) => ({
                id: linha.id,
                produtoId: linha.produto_id,
                nome: linha.nome,
                precoUnitario: Number(linha.preco_unitario),
                quantidade: linha.quantidade,
                total: Number(linha.total),
                // produto_id nulo significa que o produto saiu do catálogo
                // depois da compra; nome e preço aqui são os do momento.
                produtoRemovido: linha.produto_id === null
            }))
        });
    } catch (erro) {
        console.error('Erro ao buscar pedido no painel:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar o pedido.' });
    }
});

// ---------------------------------------------------------------------------
// Painel: cupons
// ---------------------------------------------------------------------------

const REGEX_CODIGO_CUPOM = /^[A-Z0-9_-]{3,50}$/;

function campoVazio(valor) {
    return valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '');
}

// Vazio vira null; o que não for data válida vira undefined, para acusar erro.
function lerDataOpcional(valor) {
    if (campoVazio(valor)) return null;
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? undefined : data;
}

// Valida um cupom completo. Na edição, o corpo parcial é mesclado com o cupom
// atual antes de chegar aqui, para as regras que cruzam campos (percentual até
// 100, fim depois do início) valerem sobre o resultado final, e não só sobre o
// pedaço que mudou.
function validarDadosCupom(corpo) {
    const erros = [];
    const dados = {};

    dados.codigo = normalizarCodigoCupom(corpo.codigo);
    if (!REGEX_CODIGO_CUPOM.test(dados.codigo)) {
        erros.push('O código precisa ter de 3 a 50 caracteres entre letras, números, "-" e "_".');
    }

    dados.tipo = corpo.tipo;
    if (!['percentual', 'fixo'].includes(dados.tipo)) {
        erros.push('O tipo precisa ser "percentual" ou "fixo".');
    }

    dados.valor = Number(corpo.valor);
    if (campoVazio(corpo.valor) || !Number.isFinite(dados.valor) || dados.valor <= 0) {
        erros.push('O valor do desconto precisa ser maior que zero.');
    } else if (dados.tipo === 'percentual' && dados.valor > 100) {
        erros.push('Um desconto percentual não passa de 100%.');
    } else if (dados.valor > 99999999.99) {
        erros.push('Valor do desconto alto demais.');
    }
    dados.valor = deCentavos(paraCentavos(dados.valor));

    dados.valorMinimoPedido = campoVazio(corpo.valorMinimoPedido) ? 0 : Number(corpo.valorMinimoPedido);
    if (!Number.isFinite(dados.valorMinimoPedido) || dados.valorMinimoPedido < 0 || dados.valorMinimoPedido > 99999999.99) {
        erros.push('O pedido mínimo precisa ser zero ou um valor positivo.');
    }

    dados.usoMaximo = campoVazio(corpo.usoMaximo) ? null : Number(corpo.usoMaximo);
    if (dados.usoMaximo !== null && (!Number.isInteger(dados.usoMaximo) || dados.usoMaximo < 1)) {
        erros.push('O limite total de usos precisa ser um número inteiro a partir de 1, ou vazio para ilimitado.');
    }

    dados.usoMaximoPorUsuario = campoVazio(corpo.usoMaximoPorUsuario) ? 1 : Number(corpo.usoMaximoPorUsuario);
    if (!Number.isInteger(dados.usoMaximoPorUsuario) || dados.usoMaximoPorUsuario < 1) {
        erros.push('O limite por cliente precisa ser um número inteiro a partir de 1.');
    }

    dados.validoDe = lerDataOpcional(corpo.validoDe);
    dados.validoAte = lerDataOpcional(corpo.validoAte);
    if (dados.validoDe === undefined) erros.push('Data de início inválida.');
    if (dados.validoAte === undefined) erros.push('Data de fim inválida.');
    if (dados.validoDe && dados.validoAte && dados.validoAte <= dados.validoDe) {
        erros.push('O fim da validade precisa ser depois do início.');
    }

    dados.ativo = corpo.ativo === undefined ? true : (corpo.ativo === true || corpo.ativo === 'true');

    return { valido: erros.length === 0, erros, dados };
}

function mapearCupom(linha) {
    return {
        id: linha.id,
        codigo: linha.codigo,
        tipo: linha.tipo,
        valor: Number(linha.valor),
        ativo: linha.ativo,
        validoDe: linha.valido_de,
        validoAte: linha.valido_ate,
        valorMinimoPedido: Number(linha.valor_minimo_pedido),
        usoMaximo: linha.uso_maximo,
        usoMaximoPorUsuario: linha.uso_maximo_por_usuario,
        usos: linha.usos === undefined ? undefined : Number(linha.usos),
        criadoEm: linha.criado_em
    };
}

const SELECT_CUPOM_COM_USOS = `
    SELECT c.*, (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = c.id)::int AS usos
      FROM cupons c`;

app.get('/admin/cupons', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    try {
        const resultado = await pool.query(`${SELECT_CUPOM_COM_USOS} ORDER BY c.criado_em DESC, c.id DESC`);
        return res.json({ cupons: resultado.rows.map(mapearCupom) });
    } catch (erro) {
        console.error('Erro ao listar cupons:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar os cupons.' });
    }
});

app.post('/admin/cupons', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const { valido, erros, dados: d } = validarDadosCupom(req.body || {});

    if (!valido) {
        return res.status(400).json({ mensagem: erros.join(' '), erros });
    }

    try {
        const resultado = await pool.query(
            `INSERT INTO cupons (codigo, tipo, valor, ativo, valido_de, valido_ate,
                                 valor_minimo_pedido, uso_maximo, uso_maximo_por_usuario)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *, 0 AS usos`,
            [d.codigo, d.tipo, d.valor, d.ativo, d.validoDe, d.validoAte,
                d.valorMinimoPedido, d.usoMaximo, d.usoMaximoPorUsuario]
        );

        return res.status(201).json({ mensagem: 'Cupom criado.', cupom: mapearCupom(resultado.rows[0]) });
    } catch (erro) {
        if (erro.code === '23505') {
            return res.status(409).json({ mensagem: 'Já existe um cupom com este código.' });
        }
        console.error('Erro ao criar cupom:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível criar o cupom.' });
    }
});

// Edição, inclusive de `ativo`. Não há DELETE: cupom não se apaga, se
// desativa, porque pedidos antigos continuam apontando para ele.
app.put('/admin/cupons/:id', limitadorAdmin, autenticarToken, exigirAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ mensagem: 'Identificador inválido.' });
    }

    try {
        const atual = await pool.query('SELECT * FROM cupons WHERE id = $1', [id]);

        if (atual.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Cupom não encontrado.' });
        }

        const mesclado = { ...mapearCupom(atual.rows[0]), ...(req.body || {}) };
        const { valido, erros, dados: d } = validarDadosCupom(mesclado);

        if (!valido) {
            return res.status(400).json({ mensagem: erros.join(' '), erros });
        }

        const resultado = await pool.query(
            `UPDATE cupons
                SET codigo = $1, tipo = $2, valor = $3, ativo = $4, valido_de = $5, valido_ate = $6,
                    valor_minimo_pedido = $7, uso_maximo = $8, uso_maximo_por_usuario = $9
              WHERE id = $10
             RETURNING *, (SELECT count(*) FROM cupom_usos u WHERE u.cupom_id = cupons.id)::int AS usos`,
            [d.codigo, d.tipo, d.valor, d.ativo, d.validoDe, d.validoAte,
                d.valorMinimoPedido, d.usoMaximo, d.usoMaximoPorUsuario, id]
        );

        return res.json({ mensagem: 'Cupom atualizado.', cupom: mapearCupom(resultado.rows[0]) });
    } catch (erro) {
        if (erro.code === '23505') {
            return res.status(409).json({ mensagem: 'Já existe um cupom com este código.' });
        }
        console.error('Erro ao atualizar cupom:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível atualizar o cupom.' });
    }
});

// Prévia do cupom no carrinho. Não cria pedido nem conta uso: só roda a mesma
// conta de /pagamentos/criar e devolve o resultado. Exige login porque o
// limite por cliente precisa saber quem é o cliente.
app.post('/cupons/validar', limitadorCupom, autenticarToken, async (req, res) => {
    const corpo = req.body || {};

    if (!normalizarCodigoCupom(corpo.codigo)) {
        return res.json({ valido: false, motivo: 'Informe o código do cupom.' });
    }

    try {
        // Aqui o campo se chama `codigo` (spec); no checkout, `cupom`. Só itens e
        // código seguem adiante — o resto do corpo não entra na conta.
        const resumo = await prepararCheckout({ itens: corpo.itens, cupom: corpo.codigo }, req.usuario);
        res.locals.cupomEncontrado = resumo.cupomEncontrado === true;

        if (!resumo.ok && resumo.origem === 'carrinho') {
            return res.status(400).json({ mensagem: resumo.mensagem });
        }

        if (!resumo.ok) {
            return res.json({ valido: false, motivo: resumo.mensagem });
        }

        // Os totais vão prontos: o carrinho exibe a conta do servidor, não refaz.
        return res.json({
            valido: true,
            codigo: resumo.cupom.codigo,
            desconto: resumo.desconto,
            subtotal: resumo.subtotal,
            frete: resumo.frete,
            total: resumo.total
        });
    } catch (erro) {
        console.error('Erro ao validar cupom:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível validar o cupom.' });
    }
});

app.post('/pagamentos/criar', autenticarToken, async (req, res) => {
    // Recusa antes de tocar no banco ou no Mercado Pago. Sem esta guarda, a
    // ausência de MP_ACCESS_TOKEN virava um 500 com detalhe de configuração.
    if (!CHECKOUT_HABILITADO) {
        return res.status(503).json({
            mensagem: 'A finalização de compra está desativada nesta instalação de demonstração.'
        });
    }

    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    try {
        // O corpo inteiro vai para prepararCheckout, que só lê itens e cupom.
        // Um "desconto" ou "total" forjado no corpo é ignorado por construção.
        const resumo = await prepararCheckout(req.body, req.usuario);

        if (!resumo.ok) {
            return res.status(400).json({ mensagem: resumo.mensagem });
        }

        const { itens: itensNormalizados, subtotal, desconto, frete, total, cupom } = resumo;

        const clienteMP = getMercadoPagoClient();
        const preferenceClient = new Preference(clienteMP);

        const pedido = await registrarPedidoPendente(req.usuario, itensNormalizados, subtotal, frete, total, {
            cupomId: cupom ? cupom.id : null,
            desconto
        });
        const baseUrl = getBaseUrl(req);

        const itensMercadoPago = montarItensMercadoPago(resumo);

        const preference = await preferenceClient.create({
            body: {
                items: itensMercadoPago,
                external_reference: pedido.externalReference,
                metadata: {
                    historico_id: pedido.historicoId,
                    pedido_id: pedido.pedidoId,
                    usuario_id: req.usuario.id
                },
                payer: {
                    email: req.usuario.email
                },
                back_urls: {
                    success: `${baseUrl}/cart.html?pagamento=sucesso`,
                    failure: `${baseUrl}/cart.html?pagamento=falha`,
                    pending: `${baseUrl}/cart.html?pagamento=pendente`
                },
                statement_descriptor: 'PETABYTE',
                notification_url: `${baseUrl}/pagamentos/webhook`
            }
        });

        await pool.query('UPDATE pedidos SET preference_id = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2', [preference.id, pedido.pedidoId]);

        await pool.query(
            'UPDATE historico_compras SET pedido = $1 WHERE id = $2',
            [`Pedido Petabyte - ${itensNormalizados.length} item(ns) - R$ ${total.toFixed(2)} | Ref: ${pedido.externalReference}`, pedido.historicoId]
        );

        return res.status(201).json({
            mensagem: 'Checkout criado com sucesso.',
            checkoutUrl: preference.init_point,
            checkoutSandboxUrl: preference.sandbox_init_point,
            historicoId: pedido.historicoId,
            publicKey: process.env.MP_PUBLIC_KEY || null
        });
    } catch (erro) {
        console.error('Erro ao criar checkout no Mercado Pago:', erro);
        const mensagemErro = erro && erro.message ? erro.message : 'Não foi possível iniciar o pagamento.';
        return res.status(500).json({ mensagem: mensagemErro });
    }
});

app.post('/pagamentos/confirmar', autenticarToken, async (req, res) => {
    if (!CHECKOUT_HABILITADO) {
        return res.status(503).json({
            mensagem: 'A finalização de compra está desativada nesta instalação de demonstração.'
        });
    }

    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    const paymentId = Number(req.body.paymentId);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
        return res.status(400).json({ mensagem: 'paymentId inválido.' });
    }

    try {
        await expirarPedidosPendentes(req.usuario.id);

        const clienteMP = getMercadoPagoClient();
        const paymentClient = new Payment(clienteMP);
        const pagamento = await paymentClient.get({ id: paymentId });

        const historicoId = extrairHistoricoId(pagamento.external_reference || (pagamento.metadata && pagamento.metadata.historico_id ? `hc_${pagamento.metadata.historico_id}` : null));
        if (!historicoId) {
            return res.status(400).json({ mensagem: 'Pedido sem referência válida.' });
        }

        const pedidoResult = await pool.query('SELECT usuario_id FROM pedidos WHERE historico_id = $1 LIMIT 1', [historicoId]);
        if (pedidoResult.rowCount === 0) {
            return res.status(404).json({ mensagem: 'Pedido não encontrado para este pagamento.' });
        }

        const pedido = pedidoResult.rows[0];
        if (pedido.usuario_id !== req.usuario.id) {
            return res.status(403).json({ mensagem: 'Este pagamento não pertence ao usuário autenticado.' });
        }

        const sincronizado = await sincronizarPagamentoNoBanco(pagamento);

        return res.json({
            mensagem: 'Pagamento confirmado com sucesso.',
            status: pagamento.status,
            statusPedido: sincronizado.statusPedido,
            historicoId: sincronizado.historicoId
        });
    } catch (erro) {
        console.error('Erro ao confirmar pagamento:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível confirmar o pagamento.' });
    }
});

app.post('/pagamentos/webhook', limitadorWebhook, async (req, res) => {
    // Com o checkout desligado não há pagamento a sincronizar. Responde 200
    // para o Mercado Pago não entrar em ciclo de retentativas.
    if (!CHECKOUT_HABILITADO) {
        return res.status(200).json({ recebido: true, ignorado: 'checkout desativado' });
    }

    try {
        const assinatura = validarAssinaturaWebhook(req);

        if (!assinatura.valido) {
            console.warn(`[WEBHOOK] Notificação rejeitada: ${assinatura.motivo}`);
            return res.status(401).json({ recebido: false, motivo: 'assinatura inválida' });
        }

        if (!assinatura.verificado) {
            avisarWebhookSemSegredo();
        }

        const paymentId = obterPaymentIdDaRequisicao(req);

        if (!paymentId) {
            return res.status(200).json({ recebido: true, ignorado: 'payment_id ausente' });
        }

        const clienteMP = getMercadoPagoClient();
        const paymentClient = new Payment(clienteMP);
        const pagamento = await paymentClient.get({ id: paymentId });
        const resultado = await sincronizarPagamentoNoBanco(pagamento);

        return res.status(200).json({
            recebido: true,
            sincronizado: true,
            historicoId: resultado.historicoId,
            status: resultado.status,
            statusPedido: resultado.statusPedido
        });
    } catch (erro) {
        console.error('Erro no webhook de pagamento:', erro);
        return res.status(200).json({ recebido: true, sincronizado: false });
    }
});

app.use((erro, req, res, next) => {
    console.error('[ERRO GLOBAL] Falha durante processamento da requisição:', erro);

    if (res.headersSent) {
        return next(erro);
    }

    const status = Number(erro && erro.status) || 500;
    const mensagem = status >= 500
        ? 'Erro interno no servidor.'
        : (erro && erro.message) || 'Requisição inválida.';

    return res.status(status).json({ mensagem });
});