// Conferência local do pacote. Apache/Nginx servirão os arquivos no servidor da TI.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_FILES} from './package-customer-preview.mjs';

export function createPackagePreviewServer(packageDir) {
  const mount = '/previa-cliente/';
  const allowed = new Set(PUBLIC_FILES);
  const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png'};
  return createServer(async (req, res) => {
    const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
    const send = (status, body = '', extra = {}) => {
      res.writeHead(status, {...headers, ...extra});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!['GET','HEAD'].includes(req.method)) return send(405, '', {Allow:'GET, HEAD'});
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400); }
    if (url.pathname === '/previa-cliente') return send(302, '', {Location:mount});
    if (!url.pathname.startsWith(mount)) return send(404);
    const relative = url.pathname.slice(mount.length) || 'index.html';
    if (!allowed.has(relative)) return send(404);
    try {
      const bytes = await readFile(path.join(packageDir, 'public', relative));
      send(200, bytes, {'Content-Type':mime[path.extname(relative)]});
    } catch (error) { send(error.code === 'ENOENT' ? 404 : 500); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[3] ?? 8938);
  if (!process.argv[2] || !path.isAbsolute(process.argv[2]) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Uso: node scripts/preview-customer-package.mjs PASTA_ABSOLUTA_DO_PACOTE [PORTA]');
    process.exitCode = 1;
  } else {
    const server = createPackagePreviewServer(process.argv[2]);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Local http://127.0.0.1:${port}/previa-cliente/`));
  }
}
