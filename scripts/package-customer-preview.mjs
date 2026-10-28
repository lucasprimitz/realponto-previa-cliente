import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
export const PUBLIC_FILES = Object.freeze([
  'index.html', 'preview.css', 'app.mjs', 'customer-model.mjs',
  'customer-request.mjs', 'request-transport.mjs', 'quote.mjs', 'assets/realponto-30-anos.png',
]);
const sha256 = content => createHash('sha256').update(content).digest('hex');

export async function packageCustomerPreview(destination, releaseId) {
  if (!destination || !path.isAbsolute(destination)) throw new Error('Informe uma pasta de destino absoluta e nova.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(releaseId ?? '')) throw new Error('Informe um identificador de versão válido.');
  const files = new Map();
  for (const relative of PUBLIC_FILES) {
    const source = ['quote.mjs', 'assets/realponto-30-anos.png'].includes(relative) ? 'dist' : 'customer-preview';
    let content = await fs.readFile(path.join(project, source, relative));
    if (relative === 'customer-model.mjs') {
      const text = content.toString('utf8');
      const sharedImport = "'../dist/quote.mjs'";
      if (text.split(sharedImport).length !== 3) throw new Error('Revisar os imports do módulo compartilhado antes de empacotar.');
      content = Buffer.from(text.replaceAll(sharedImport, "'./quote.mjs'"));
    }
    files.set(`public/${relative}`, content);
  }
  for (const server of ['apache', 'nginx']) {
    const name = `${server}-previa-cliente.conf.example`;
    files.set(`config/${name}`, await fs.readFile(path.join(project, 'customer-preview', 'hosting', name)));
  }
  const guide = await fs.readFile(path.join(project, 'docs', 'PREVIA-CLIENTE-TI.md'), 'utf8');
  const guideVersion = guide.match(/^\*\*Versão:\*\* `([A-Za-z0-9_-]+)`/m)?.[1];
  if (!guideVersion) throw new Error('O guia da TI precisa declarar o identificador da versão.');
  files.set('LEIA-ME-TI.md', Buffer.from(guide.replaceAll(guideVersion, releaseId)));
  files.set('ATUALIZACAO-AUTOMATICA-PREVIA.md', await fs.readFile(path.join(project, 'docs', 'ATUALIZACAO-AUTOMATICA-PREVIA.md')));
  const manifest = {
    releaseId,
    createdAt: new Date().toISOString(),
    mountPath: '/previa-cliente/',
    intendedUrl: 'http://192.168.90.7:8082/previa-cliente/',
    mode: 'internal-approval-demo',
    pricing: 'Snapshot sincronizado de dist/quote.mjs; regenerar e publicar o pacote após cada sincronização aprovada.',
    files: [...files].map(([file, content]) => ({file, bytes: content.length, sha256: sha256(content)})),
  };
  files.set('MANIFESTO.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  files.set('VERSAO.txt', Buffer.from(`${releaseId}\nPrévia interna demonstrativa. Publicação isolada do sistema principal.\n`));
  files.set('SHA256SUMS', Buffer.from([...files].map(([file, content]) => `${sha256(content)}  ${file}`).join('\n') + '\n'));
  // A pasta deve ser nova: nenhuma versão anterior é sobrescrita ou removida.
  await fs.mkdir(destination);
  for (const [relative, content] of files) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, content, {flag: 'wx'});
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await packageCustomerPreview(process.argv[2], process.argv[3]);
    console.log(`Pacote local preparado: ${process.argv[2]} (${manifest.releaseId}). Nenhum envio realizado.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
