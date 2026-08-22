// Executa, em ordem alfabetica, todos os arquivos .sql de migrations/.
// Cada arquivo deve ser idempotente: o runner nao mantem registro do que ja rodou.
//
// Uso: npm run migrate

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const raiz = path.join(__dirname, '..');
const pastaMigrations = path.join(raiz, 'migrations');
const schemaBase = path.join(raiz, 'inicializar_banco.sql');

// Mesma lógica de server.js: hospedagens gerenciadas entregam DATABASE_URL.
function configuracaoDoBanco() {
    if (process.env.DATABASE_URL) {
        return {
            connectionString: process.env.DATABASE_URL,
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

async function principal() {
    if (!fs.existsSync(pastaMigrations)) {
        console.error('Pasta migrations/ nao encontrada.');
        process.exit(1);
    }

    // O schema base vem primeiro: num banco vazio, a migration 001 falharia
    // porque faz ALTER TABLE em pedido_itens, criada por este arquivo.
    // Como tudo usa IF NOT EXISTS, rodar de novo num banco pronto e inofensivo.
    const arquivos = [];

    if (fs.existsSync(schemaBase)) {
        arquivos.push({ rotulo: 'inicializar_banco.sql', caminho: schemaBase });
    }

    fs.readdirSync(pastaMigrations)
        .filter((nome) => nome.endsWith('.sql'))
        .sort()
        .forEach((nome) => arquivos.push({ rotulo: nome, caminho: path.join(pastaMigrations, nome) }));

    if (arquivos.length === 0) {
        console.log('Nenhuma migration encontrada.');
        return;
    }

    // Diz de onde vem a conexão antes de tentar. Num deploy, "não conectou" sem
    // saber qual host foi usado é o pior lugar para começar a investigar.
    if (process.env.DATABASE_URL) {
        let destino = '(URL ilegível)';
        try {
            const url = new URL(process.env.DATABASE_URL);
            destino = `${url.hostname}:${url.port || 5432}${url.pathname}`;
        } catch (erro) {
            destino = '(DATABASE_URL malformada)';
        }
        const ssl = process.env.DATABASE_SSL === 'false' ? 'desligado' : 'ligado';
        console.log(`Conexão: DATABASE_URL -> ${destino} | TLS ${ssl}`);
    } else {
        const host = process.env.PGHOST || 'localhost';
        const porta = process.env.PGPORT || 5432;
        const banco = process.env.PGDATABASE || 'postgres';
        console.log(`Conexão: variáveis PG* -> ${host}:${porta}/${banco}`);

        if (!process.env.PGHOST) {
            console.warn('AVISO: DATABASE_URL não definida e PGHOST ausente. Vai tentar localhost,');
            console.warn('       que em hospedagem gerenciada não existe. Defina DATABASE_URL.');
        }
    }

    const pool = new Pool(configuracaoDoBanco());

    let falhou = false;

    // Sem isto, um erro de conexão aparecia como "FALHOU" seguido de linha em
    // branco, porque nem todo erro do pg preenche .message. Num deploy remoto
    // isso deixa o diagnóstico impossível.
    function relatarErro(erro) {
        if (!erro) {
            console.error('   Erro desconhecido (nenhum detalhe recebido).');
            return;
        }

        const campos = [
            ['mensagem', erro.message],
            ['código', erro.code],
            ['detalhe', erro.detail],
            ['dica', erro.hint],
            ['posição', erro.position],
            ['endereço', erro.address && `${erro.address}:${erro.port || ''}`],
            ['origem', erro.routine]
        ].filter(([, valor]) => valor);

        if (campos.length === 0) {
            // Último recurso: despeja o objeto inteiro.
            console.error('   Erro sem campos reconhecidos:', erro);
            return;
        }

        campos.forEach(([rotulo, valor]) => console.error(`   ${rotulo}: ${valor}`));

        if (erro.code === 'ECONNREFUSED' || erro.code === 'ENOTFOUND') {
            console.error('   -> O banco não respondeu. Confira DATABASE_URL nas variáveis do serviço.');
        }

        if (/SSL|self signed|certificate/i.test(erro.message || '')) {
            console.error('   -> Parece problema de TLS. Tente inverter DATABASE_SSL (true/false).');
        }
    }

    try {
        // Falha cedo e com mensagem clara se o banco nem responde.
        try {
            const teste = await pool.query('SELECT current_database() AS banco, version() AS versao');
            console.log(`Conectado em "${teste.rows[0].banco}".`);
            console.log(`${teste.rows[0].versao.split(',')[0]}\n`);
        } catch (erro) {
            console.error('Não foi possível conectar ao banco.');
            relatarErro(erro);
            await pool.end();
            process.exit(1);
        }

        for (const arquivo of arquivos) {
            const sql = fs.readFileSync(arquivo.caminho, 'utf8');
            process.stdout.write(`-> ${arquivo.rotulo} ... `);

            try {
                await pool.query(sql);
                console.log('OK');
            } catch (erro) {
                console.log('FALHOU');
                relatarErro(erro);
                falhou = true;
                break;
            }
        }
    } finally {
        await pool.end().catch(() => {});
    }

    if (falhou) {
        process.exit(1);
    }

    console.log('\nMigrations aplicadas com sucesso.');
}

principal().catch((erro) => {
    console.error('Erro inesperado ao rodar migrations:');
    console.error(erro);
    process.exit(1);
});
