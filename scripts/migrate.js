// Executa, em ordem alfabetica, todos os arquivos .sql de migrations/.
// Cada arquivo deve ser idempotente: o runner nao mantem registro do que ja rodou.
//
// Uso: npm run migrate

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pastaMigrations = path.join(__dirname, '..', 'migrations');

async function principal() {
    if (!fs.existsSync(pastaMigrations)) {
        console.error('Pasta migrations/ nao encontrada.');
        process.exit(1);
    }

    const arquivos = fs
        .readdirSync(pastaMigrations)
        .filter((nome) => nome.endsWith('.sql'))
        .sort();

    if (arquivos.length === 0) {
        console.log('Nenhuma migration encontrada.');
        return;
    }

    const pool = new Pool({
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'postgres',
        password: process.env.PGPASSWORD || '',
        port: Number(process.env.PGPORT || 5432)
    });

    let falhou = false;

    try {
        for (const arquivo of arquivos) {
            const sql = fs.readFileSync(path.join(pastaMigrations, arquivo), 'utf8');
            process.stdout.write(`-> ${arquivo} ... `);

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
