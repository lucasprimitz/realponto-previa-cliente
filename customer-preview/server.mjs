import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const portArgument = process.argv[2] ?? '8937';
if (!/^\d+$/.test(portArgument) || Number(portArgument) < 1 || Number(portArgument) > 65535) {
  console.error('Informe uma porta válida entre 1 e 65535.');
  process.exit(1);
}

const port = Number(portArgument);
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/customer-model.mjs', ['customer-model.mjs', 'text/javascript; charset=utf-8']],
  ['/customer-request.mjs', ['customer-request.mjs', 'text/javascript; charset=utf-8']],
  ['/request-transport.mjs', ['request-transport.mjs', 'text/javascript; charset=utf-8']],
  ['/dist/quote.mjs', ['../dist/quote.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/realponto-30-anos.png', ['../dist/assets/realponto-30-anos.png', 'image/png']],
]);

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const server = createServer(async (request, response) => {
  const send = (status, content, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) => {
    response.writeHead(status, {
      ...securityHeaders,
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(content),
      ...extraHeaders,
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(405, 'Método não permitido.', undefined, { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  } catch {
    send(400, 'Endereço inválido.');
    return;
  }

  const route = routes.get(pathname);
  if (!route) {
    send(404, 'Página não encontrada.');
    return;
  }

  try {
    const [relativePath, contentType] = route;
    const content = await readFile(new URL(relativePath, import.meta.url));
    send(200, content, contentType);
  } catch (error) {
    send(error.code === 'ENOENT' ? 404 : 500,
      error.code === 'ENOENT' ? 'Arquivo não encontrado.' : 'Não foi possível abrir a prévia.');
  }
});

server.on('error', error => {
  console.error(`Não foi possível iniciar a prévia local: ${error.code ?? error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local http://127.0.0.1:${port}`);
});
