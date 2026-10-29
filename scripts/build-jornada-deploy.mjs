/**
 * Empacota a Jornada funcional (não a prévia), para deploy SSH na HostGator.
 * Não inclui config.php, SQLite, sessões, logs nem .htaccess de produção.
 * A correção SQLite 3.34.1 é fixada ao hash do Store.php conhecido: se a
 * implementação original mudar, o deploy PARA para revisão humana.
 *
 * Uso: node scripts/build-jornada-deploy.mjs /abs/nova/pasta RELEASE_SHA
 * Testes offline apenas: ... --from-package=/abs/pacote-funcional-existente
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_STORE_BLOB = 'e170d6931028a6ac857c87875500a229d0044127';
const API_REQUIRE = "require dirname(__DIR__, 2) . '/src/bootstrap.php';";
const API_REPLACE = "require __DIR__ . '/_bootstrap.php';";
const DIGEST = bytes => createHash('sha256').update(bytes).digest('hex');
const BLOB = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const safeRelease = release => /^[a-f0-9]{40}$/.test(release);

async function copyTree(src, dst) {
  await fs.cp(src, dst, {recursive: true, force: false, errorOnExist: true, dereference: false});
}
async function listFiles(dir, prefix = '') {
  let files = [];
  for (const ent of (await fs.readdir(dir, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const rel = [prefix, ent.name].filter(Boolean).join('/');
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) throw new Error('Link simbólico proibido: ' + rel);
    if (ent.isDirectory()) files = files.concat(await listFiles(full, rel));
    else if (ent.isFile()) files.push(rel);
    else throw new Error('Entrada não regular proibida: ' + rel);
  }
  return files;
}
export async function buildJornadaDeploy(destination, release, fromPackage = null) {
  if (!path.isAbsolute(destination || '') || !safeRelease(release)) throw new Error('Destino absoluto e SHA completo (40 hex) são obrigatórios.');
  await fs.mkdir(destination); // aborta se já existir
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jornada-funcional-'));
  try {
    let service;
    if (fromPackage) {
      if (!path.isAbsolute(fromPackage)) throw new Error('--from-package requer caminho absoluto.');
      service = fromPackage;
    } else {
      const {packageCustomerService} = await import('./package-customer-service.mjs');
      service = path.join(tmp, 'service');
      await packageCustomerService(service, release);
    }
    const originalManifest = JSON.parse(await fs.readFile(path.join(service, 'MANIFESTO.json'), 'utf8'));
    if (originalManifest.mode !== 'php-contact-service' || originalManifest.releaseId !== release) {
      throw new Error('Pacote não é o funcional ou possui versão divergente.');
    }
    for (const entry of originalManifest.files) {
      const rel = entry.file;
      if (typeof rel !== 'string' || rel.startsWith('/') || rel.split('/').some(seg => !seg || seg === '..' || seg === '.') || rel.includes('\\')) {
        throw new Error('Caminho irregular no manifesto do pacote funcional.');
      }
      const f = path.join(service, rel);
      if ((await fs.lstat(f)).isSymbolicLink()) throw new Error('Link no pacote original.');
      const bytes = await fs.readFile(f);
      if (bytes.length !== entry.bytes || DIGEST(bytes) !== entry.sha256) throw new Error('Falha de integridade: '+rel);
    }
    const app = path.join(destination, 'private/app');
    const pub = path.join(destination, 'public');
    await fs.mkdir(app, {recursive:true});
    await copyTree(path.join(service, 'public'), pub);
    for (const entry of ['src', 'bin', 'composer.json', 'composer.lock', 'pricing.json']) {
      await copyTree(path.join(service, entry), path.join(app, entry));
    }
    // Dependência SMTP gerada com composer install --locked (não sobe configurações privadas).
    const vendor = path.join(ROOT, 'customer-service/vendor');
    if (!(await fs.stat(path.join(vendor, 'autoload.php')).catch(()=>null))?.isFile()) {
      throw new Error('Composer não preparado. Faltou customer-service/vendor/autoload.php.');
    }
    await copyTree(vendor, path.join(app, 'vendor'));
    const store = path.join(app, 'src/Store.php');
    const original = await fs.readFile(store);
    if (BLOB(original) !== BASE_STORE_BLOB) {
      throw new Error('Store.php mudou no GitHub. Parado para revisar a compatibilidade com SQLite 3.34.1.');
    }
    const patched = await fs.readFile(path.join(ROOT, 'deploy/patches/Store.php'));
    if (!patched.includes(Buffer.from('BEGIN IMMEDIATE')) || patched.includes(Buffer.from('RETURNING counter')) || !patched.includes(Buffer.from('SELECT counter FROM rate_limits'))) {
      throw new Error('Patch de SQLite inesperado.');
    }
    await fs.writeFile(store, patched);
    // Os adaptadores existentes no servidor ficam intocados.
    for (const file of (await fs.readdir(path.join(pub, 'api'))).filter(n => n.endsWith('.php'))) {
      const filePath = path.join(pub, 'api', file);
      const content = await fs.readFile(filePath, 'utf8');
      if (content.split(API_REQUIRE).length !== 2) throw new Error('API mudou o bootstrap; requer revisão: ' + file);
      await fs.writeFile(filePath, content.replace(API_REQUIRE, API_REPLACE));
    }
    const index = await fs.readFile(path.join(pub, 'index.html'), 'utf8');
    if (!index.includes('content="./api/"') || !index.includes("connect-src 'self'")) {
      throw new Error('Página pública não está no modo funcional com API na mesma origem.');
    }
    for (const dangerous of ['.htaccess', 'config.php', 'config.example.php', 'contacts.sqlite', '_bootstrap.php']) {
      if ((await listFiles(destination)).some(n => n.split('/').at(-1) === dangerous)) throw new Error('Artefato contém arquivo proibido: ' + dangerous);
    }
    const paths = await listFiles(destination);
    if (!paths.some(p => p === 'public/index.html') || !paths.some(p => p === 'public/api/requests.php') || !paths.some(p => p === 'private/app/src/Store.php')) {
      throw new Error('Artefato sem arquivos essenciais.');
    }
    const hashes = [];
    for (const p of paths) {
      const bytes = await fs.readFile(path.join(destination, p));
      hashes.push(`${DIGEST(bytes)}  ${p}`);
    }
    await fs.writeFile(path.join(destination, 'SHA256SUMS'), hashes.join('\n') + '\n');
    await fs.writeFile(path.join(destination, 'MANIFESTO-JORNADA.json'), JSON.stringify({
      release, source: 'lucasprimitz/realponto-previa-cliente', mode:'funcional-hostgator',
      sqliteCompatibility:'3.34.1', protectedFiles:['config.php','data/','.htaccess','api/_bootstrap.php'],
      files:paths.length
    }, null, 2)+'\n');
    return {release, files:paths.length};
  } catch (error) {
    // Não deixar pacote incompleto se a construção for recusada.
    await fs.rm(destination, {recursive:true,force:true});
    throw error;
  } finally {
    await fs.rm(tmp, {recursive:true,force:true});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, release, option] = process.argv.slice(2);
  try {
    const result=await buildJornadaDeploy(destination,release,option?.startsWith('--from-package=')?option.slice('--from-package='.length):null);
    console.log(`Pacote funcional pronto: ${result.files} arquivos. SHA ${result.release}. Nenhum envio realizado.`);
  } catch(e) { console.error('[BLOQUEADO] '+e.message); process.exitCode=1; }
}
