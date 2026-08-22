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

    const pool = new Pool(configuracaoDoBanco());

    let falhou = false;

    try {
        for (const arquivo of arquivos) {
            const sql = fs.readFileSync(arquivo.caminho, 'utf8');
            process.stdout.write(`-> ${arquivo.rotulo} ... `);

            try {
                await pool.query(sql);
                console.log('OK');
            } catch (erro) {
                console.log('FALHOU');
                console.error(`   ${erro.message}`);
                falhou = true;
                break;
            }
        }
    } finally {
        await pool.end();
    }

    if (falhou) {
        process.exit(1);
    }

    console.log('\nMigrations aplicadas com sucesso.');
}

principal().catch((erro) => {
    console.error('Erro inesperado ao rodar migrations:', erro.message);
    process.exit(1);
});
