const http = require('http');
const payload = JSON.stringify({ email: 'teste@petabyte.com' });

console.log('[TEST] Enviando requisição de recuperação...');

const req = http.request({
  hostname: '127.0.0.1',
  port: 3000,
  path: '/auth/recuperar-senha',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('[TEST] STATUS:' + res.statusCode);
    console.log('[TEST] BODY:' + data);
  });
});

req.on('error', (err) => {
  console.error('[TEST] ERR:' + err.message);
});

req.write(payload);
req.end();