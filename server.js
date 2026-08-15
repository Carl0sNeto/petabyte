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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);

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
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"]
        }
    },
    // O checkout do Mercado Pago acontece por redirecionamento para outro domínio.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

app.use(cors({
    origin: resolverCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
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
app.use(express.static(path.join(__dirname, 'public')));

app.use((erro, req, res, next) => {
    if (erro instanceof SyntaxError && erro.status === 400 && 'body' in erro) {
        return res.status(400).json({ mensagem: 'JSON inválido no corpo da requisição.' });
    }

    return next(erro);
});

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'postgres',
    password: process.env.PGPASSWORD || '',
    port: Number(process.env.PGPORT || 5432),
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error(
        'JWT_SECRET ausente ou muito curto (mínimo de 32 caracteres).\n' +
        'Gere um segredo forte com:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
        'e defina-o no arquivo .env antes de iniciar o servidor.'
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

// Cadastro público (newsletter e criação de conta).
const limitadorCadastro = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { mensagem: 'Muitas solicitações. Tente novamente mais tarde.' }
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

function calcularFrete(subtotal) {
    return subtotal > 199 ? 0 : 19.9;
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

async function registrarPedidoPendente(usuario, itens, subtotal, frete, total) {
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
                moeda
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '1 minute', $7, $8, $9, $10) RETURNING id`,
            [usuario.id, historicoId, externalReference, null, 'Aguardando pagamento', 'pending', subtotal, frete, total, 'BRL']
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
            'SELECT id, usuario_id, expira_em, estoque_baixado FROM pedidos WHERE historico_id = $1 LIMIT 1 FOR UPDATE',
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

function autenticarToken(req, res, next) {
    const cabecalho = req.headers.authorization;

    if (!cabecalho || !cabecalho.startsWith('Bearer ')) {
        return res.status(401).json({ mensagem: 'Token ausente ou inválido.' });
    }

    const token = cabecalho.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.usuario = decoded;
        next();
    } catch (erro) {
        return res.status(401).json({ mensagem: 'Token inválido ou expirado.' });
    }
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

function criarTransportadorEmail() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const timeout = Number(process.env.SMTP_TIMEOUT_MS || 10000);

    if (!host || !user || !pass) {
        return null;
    }

    return nodemailer.createTransport({
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
    });
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

async function enviarEmailRecuperacao(email, token) {
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
    const resetUrl = `${baseUrl}/redefinir-senha.html?token=${token}`;

    try {
        const transportadores = criarTransportadoresFallbackEmail();

        if (transportadores.length === 0) {
            console.log(`[RESET] E-mail para ${email}: ${resetUrl}`);
            return { ok: false, motivo: 'SMTP não configurado', resetUrl };
        }

        const mensagem = {
            from: process.env.SMTP_FROM || 'petabyte@local.dev',
            to: email,
            subject: 'Redefinição de senha Petabyte',
            html: `<p>Olá!</p><p>Use o link abaixo para redefinir sua senha:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
        };

        let ultimoErro = null;

        for (const [indice, transportador] of transportadores.entries()) {
            try {
                await transportador.verify();
                await transportador.sendMail(mensagem);
                console.log(`[RESET] E-mail enviado para ${email} usando a configuração SMTP #${indice + 1}`);
                return { ok: true };
            } catch (erro) {
                ultimoErro = erro;
                console.error(
                    `[RESET] Falha na configuração SMTP #${indice + 1}:`,
                    erro && erro.message ? erro.message : String(erro)
                );
            }
        }

        return {
            ok: false,
            motivo: ultimoErro && ultimoErro.message ? ultimoErro.message : 'Falha desconhecida no SMTP',
            resetUrl
        };
    } catch (erro) {
        const mensagemErro = erro && erro.message ? erro.message : String(erro);
        console.error('[RESET] Falha ao enviar e-mail:', mensagemErro);
        console.log(`[RESET] Link de recuperação: ${resetUrl}`);
        return { ok: false, motivo: mensagemErro, resetUrl };
    }
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
    sincronizarPagamentoNoBanco
};

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

if (process.env.NODE_ENV !== 'production') {
    app.post('/debug/teste', (req, res) => {
        console.log('[DEBUG] rota de teste chamada');
        res.json({ ok: true, recebida: req.body });
    });
}

app.post('/usuarios', limitadorCadastro, async (req, res) => {
    const { nome, email, senha } = req.body;

    if (!nome || !email) {
        return res.status(400).json({ mensagem: 'Nome e e-mail são obrigatórios.' });
    }

    try {
        // Cadastro de newsletter não define senha. Usamos um valor aleatório
        // descartado em seguida para que a conta não seja acessível por login
        // até que o usuário use o fluxo de recuperação de senha.
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

app.post('/auth/cadastro', limitadorCadastro, async (req, res) => {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha) {
        return res.status(400).json({ mensagem: 'Nome, e-mail e senha são obrigatórios.' });
    }

    try {
        const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existente.rowCount > 0) {
            return res.status(409).json({ mensagem: 'Este e-mail já está cadastrado.' });
        }

        const senhaHash = await bcrypt.hash(senha, 10);
        const resultado = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id', [nome, email, senhaHash]);
        const usuarioId = resultado.rows[0].id;
        await pool.query('INSERT INTO historico_compras (usuario_id, pedido, status) VALUES ($1, $2, $3)', [usuarioId, 'Pedido de boas-vindas', 'Em transporte']);
        res.status(201).json({ mensagem: 'Conta criada com sucesso!' });
    } catch (erro) {
        console.error('Erro ao cadastrar usuário:', erro);
        res.status(500).json({ mensagem: 'Erro ao criar conta.' });
    }
});

app.post('/auth/login', limitadorLogin, async (req, res) => {
    const { email, senha } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ mensagem: 'E-mail e senha são obrigatórios.' });
    }

    try {
        const resultado = await pool.query('SELECT id, nome, email, senha FROM usuarios WHERE email = $1', [email]);

        if (resultado.rowCount === 0) {
            return res.status(401).json({ mensagem: 'E-mail ou senha inválidos.' });
        }

        const usuario = resultado.rows[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha);

        if (!senhaValida) {
            return res.status(401).json({ mensagem: 'E-mail ou senha inválidos.' });
        }

        const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '2h' });
        res.json({ mensagem: 'Login realizado com sucesso!', token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
    } catch (erro) {
        console.error('Erro ao fazer login:', erro);
        res.status(500).json({ mensagem: 'Erro ao fazer login.' });
    }
});

app.get('/auth/me', autenticarToken, async (req, res) => {
    try {
        const usuarioResult = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [req.usuario.id]);

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

app.post('/auth/recuperar-senha', limitadorSenha, async (req, res) => {
    const { email } = req.body;

    console.log(`[RESET] solicitação recebida para: ${email || '(sem e-mail)'}`);

    if (!email) {
        console.log('[RESET] e-mail ausente na requisição');
        return res.status(400).json({ mensagem: 'Informe um e-mail para continuar.' });
    }

    try {
        const resultado = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        console.log(`[RESET] consulta de usuário retornou ${resultado.rowCount} linha(s)`);

        if (resultado.rowCount === 0) {
            console.log('[RESET] e-mail não encontrado; retornando resposta genérica');
            return res.json({ mensagem: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiraEm = new Date(Date.now() + 30 * 60 * 1000);
        console.log(`[RESET] criando token para usuário ${resultado.rows[0].id}`);
        await pool.query('INSERT INTO password_resets (usuario_id, token, expira_em) VALUES ($1, $2, $3)', [resultado.rows[0].id, token, expiraEm]);
        console.log('[RESET] token salvo no banco');
        const resultadoEnvio = await enviarEmailRecuperacao(email, token);

        if (!resultadoEnvio || !resultadoEnvio.ok) {
            console.error('[RESET] envio SMTP falhou:', resultadoEnvio && resultadoEnvio.motivo ? resultadoEnvio.motivo : 'motivo não informado');
            await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);
            return res.status(502).json({ mensagem: 'Não foi possível enviar o e-mail de recuperação no momento. Tente novamente mais tarde.' });
        }

        console.log('[RESET] fluxo concluído com sucesso');

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
        const resultado = await pool.query('SELECT id, usuario_id, expira_em, usado FROM password_resets WHERE token = $1', [token]);

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

        const senhaHash = await bcrypt.hash(senha, 10);
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [senhaHash, reset.usuario_id]);
        await pool.query('UPDATE password_resets SET usado = TRUE WHERE id = $1', [reset.id]);

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
        const resultado = await pool.query(
            `SELECT id, nome, descricao, preco, categoria, imagem_url, estoque
             FROM produtos
             WHERE ativo = TRUE
             ORDER BY id`
        );

        return res.json({
            produtos: resultado.rows.map((linha) => ({
                id: linha.id,
                nome: linha.nome,
                descricao: linha.descricao,
                preco: Number(linha.preco),
                categoria: linha.categoria,
                imagemUrl: linha.imagem_url,
                disponivel: linha.estoque > 0
            }))
        });
    } catch (erro) {
        console.error('Erro ao listar produtos:', erro);
        return res.status(500).json({ mensagem: 'Não foi possível carregar os produtos.' });
    }
});

app.post('/pagamentos/criar', autenticarToken, async (req, res) => {
    if (!bancoDisponivel) {
        return res.status(503).json({ mensagem: 'Banco de dados indisponível no momento.' });
    }

    const { itens } = req.body;

    try {
        const resolucao = await resolverItensCarrinho(itens);

        if (!resolucao.ok) {
            return res.status(400).json({ mensagem: resolucao.mensagem });
        }

        const itensNormalizados = resolucao.itens;

        const clienteMP = getMercadoPagoClient();
        const preferenceClient = new Preference(clienteMP);

        const subtotal = itensNormalizados.reduce((acumulador, item) => acumulador + (item.unit_price * item.quantity), 0);
        const frete = calcularFrete(subtotal);
        const total = subtotal + frete;

        const pedido = await registrarPedidoPendente(req.usuario, itensNormalizados, subtotal, frete, total);
        const baseUrl = getBaseUrl(req);

        // produtoId é de uso interno; a API do Mercado Pago não o conhece.
        const itensMercadoPago = itensNormalizados.map(({ produtoId, ...item }) => item);

        if (frete > 0) {
            itensMercadoPago.push({
                title: 'Frete',
                quantity: 1,
                currency_id: 'BRL',
                unit_price: Number(frete.toFixed(2))
            });
        }

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

app.post('/pagamentos/webhook', async (req, res) => {
    try {
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