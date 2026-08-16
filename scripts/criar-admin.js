// Concede ou revoga acesso de administrador a uma conta já existente.
//
// A promoção acontece pela linha de comando, nunca pela interface: só quem tem
// acesso ao servidor pode criar um admin. O painel não expõe esta operação.
//
// Uso:
//   npm run criar-admin -- pessoa@exemplo.com
//   npm run criar-admin -- pessoa@exemplo.com --revogar
//   npm run criar-admin -- --listar

require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'postgres',
    password: process.env.PGPASSWORD || '',
    port: Number(process.env.PGPORT || 5432)
});

function mostrarAjuda() {
    console.log(`
Uso:
  npm run criar-admin -- <email>              concede acesso de administrador
  npm run criar-admin -- <email> --revogar    revoga o acesso
  npm run criar-admin -- --listar             lista os administradores atuais

A conta precisa existir. Cadastre-se normalmente pelo site antes de promover.
`.trim());
}

async function listarAdmins() {
    const resultado = await pool.query(
        'SELECT id, nome, email FROM usuarios WHERE admin = TRUE ORDER BY id'
    );

    if (resultado.rowCount === 0) {
        console.log('Nenhum administrador cadastrado.');
        return;
    }

    console.log(`${resultado.rowCount} administrador(es):`);
    resultado.rows.forEach((linha) => {
        console.log(`  #${linha.id}  ${linha.nome}  <${linha.email}>`);
    });
}

async function alterarAcesso(email, conceder) {
    // Busca sem diferenciar maiúsculas: o cadastro grava o e-mail como digitado
    // e a constraint UNIQUE é sensível a caixa, então contas podem divergir
    // apenas na capitalização.
    const usuario = await pool.query(
        'SELECT id, nome, email, admin FROM usuarios WHERE LOWER(email) = LOWER($1) ORDER BY id',
        [email]
    );

    if (usuario.rowCount === 0) {
        console.error(`Nenhuma conta encontrada para "${email}".`);
        console.error('Cadastre-se pelo site primeiro e rode este comando de novo.');
        process.exitCode = 1;
        return;
    }

    if (usuario.rowCount > 1) {
        console.error(`Há ${usuario.rowCount} contas que diferem só na capitalização de "${email}":`);
        usuario.rows.forEach((linha) => console.error(`  #${linha.id}  <${linha.email}>`));
        console.error('Consolide os registros antes de promover qualquer uma delas.');
        process.exitCode = 1;
        return;
    }

    const atual = usuario.rows[0];

    if (atual.admin === conceder) {
        console.log(`Nada a fazer: ${atual.nome} <${email}> já está ${conceder ? 'como administrador' : 'sem acesso de administrador'}.`);
        return;
    }

    // Impede remover o último administrador e deixar o painel inacessível.
    if (!conceder) {
        const totalAdmins = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios WHERE admin = TRUE');

        if (totalAdmins.rows[0].total <= 1) {
            console.error('Este é o único administrador. Promova outra conta antes de revogar esta.');
            process.exitCode = 1;
            return;
        }
    }

    await pool.query('UPDATE usuarios SET admin = $1 WHERE id = $2', [conceder, atual.id]);
    console.log(`${conceder ? 'Concedido' : 'Revogado'} acesso de administrador para ${atual.nome} <${email}>.`);

    if (conceder) {
        console.log('A pessoa precisa sair e entrar de novo para o painel liberar.');
    }
}

async function principal() {
    const argumentos = process.argv.slice(2);

    if (argumentos.length === 0 || argumentos.includes('--ajuda') || argumentos.includes('-h')) {
        mostrarAjuda();
        return;
    }

    if (argumentos.includes('--listar')) {
        await listarAdmins();
        return;
    }

    const email = argumentos.find((argumento) => !argumento.startsWith('--'));

    if (!email) {
        console.error('Informe o e-mail da conta.\n');
        mostrarAjuda();
        process.exitCode = 1;
        return;
    }

    await alterarAcesso(email.trim(), !argumentos.includes('--revogar'));
}

principal()
    .catch((erro) => {
        console.error('Erro:', erro.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
