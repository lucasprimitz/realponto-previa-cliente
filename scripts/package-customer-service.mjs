import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PUBLIC_FILES} from './package-customer-preview.mjs';
import {contactPricing} from './export-contact-pricing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Pacote separado da prévia estática: nunca ativa o backend ao atualizar a demo.
export async function packageCustomerService(destination, releaseId) {
  if (!path.isAbsolute(destination ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(releaseId ?? '')) {
    throw new Error('Informe uma pasta absoluta nova e um identificador de versão válido.');
  }
  const files = new Map();
  for (const file of PUBLIC_FILES) {
    const source = ['quote.mjs', 'assets/realponto-30-anos.png'].includes(file) ? 'dist' : 'customer-preview';
    let bytes = await fs.readFile(path.join(root, source, file));
    if (file === 'customer-model.mjs') {
      const text = bytes.toString('utf8');
      if (text.split("'../dist/quote.mjs'").length !== 3) throw new Error('Imports compartilhados precisam de revisão.');
      bytes = Buffer.from(text.replaceAll("'../dist/quote.mjs'", "'./quote.mjs'"));
    }
    if (file === 'index.html') {
      const text = bytes.toString('utf8');
      const meta = '<meta name="realponto-api-base" content="">';
      if (!text.includes(meta) || !text.includes("connect-src 'none'")) throw new Error('Configuração de envio da página não reconhecida.');
      bytes = Buffer.from(text.replace(meta, '<meta name="realponto-api-base" content="./api/">').replace("connect-src 'none'", "connect-src 'self'"));
    }
    files.set('public/' + file, bytes);
  }
  for (const file of ['index.html', 'panel.css', 'panel.mjs']) {
    files.set('public/contatos/' + file, await fs.readFile(path.join(root, 'contacts-panel', file)));
  }
  // Apenas fontes explicitamente permitidas. Banco, sessões, chaves, configurações
  // locais, testes e dependências instaladas nunca entram no pacote de revisão.
  async function collect(relative) {
    const dir = path.join(root, 'customer-service', relative);
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) throw new Error('Link não permitido no serviço.');
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && entry.name.endsWith('.php')) files.set(name, await fs.readFile(path.join(dir, entry.name)));
    }
  }
  for (const dir of ['src', 'public/api', 'bin']) await collect(dir);
  for (const file of ['composer.json', 'config.example.php']) files.set(file, await fs.readFile(path.join(root, 'customer-service', file)));
  try { files.set('composer.lock', await fs.readFile(path.join(root, 'customer-service/composer.lock'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.set('config/nginx.conf.example', await fs.readFile(path.join(root, 'nginx/contacts-service.conf.example')));
  files.set('pricing.json', Buffer.from(JSON.stringify(contactPricing(), null, 2) + '\n'));
  files.set('LEIA-ME-TI.md', await fs.readFile(path.join(root, 'docs/SOLICITACOES-PHP-TI.md')));
  files.set('SINCRONIZACAO-PRECOS.md', await fs.readFile(path.join(root, 'docs/SINCRONIZACAO-PRECOS.md')));
  const manifest = {releaseId, createdAt: new Date().toISOString(), mode: 'php-contact-service', requiresActivation: true,
    files: [...files].map(([file, bytes]) => ({file, bytes: bytes.length, sha256: digest(bytes)}))};
  files.set('MANIFESTO.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  files.set('SHA256SUMS', Buffer.from([...files].map(([file, bytes]) => `${digest(bytes)}  ${file}`).join('\n') + '\n'));
  await fs.mkdir(destination);
  for (const [file, bytes] of files) {
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, bytes, {flag: 'wx'});
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageCustomerService(process.argv[2], process.argv[3]);
    console.log(`Pacote PHP local preparado: ${process.argv[2]} (${result.releaseId}). Nenhum envio realizado.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
