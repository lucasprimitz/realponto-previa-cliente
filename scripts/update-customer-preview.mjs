import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const BRANCH = 'main';
export const PUBLIC_FILES = Object.freeze([
  'index.html', 'preview.css', 'app.mjs', 'customer-model.mjs',
  'customer-request.mjs', 'request-transport.mjs', 'quote.mjs', 'assets/realponto-30-anos.png',
]);
const METADATA = 'preview-deployment.json';
const MAX_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const digest = data => createHash('sha256').update(data).digest('hex');
const validCommit = value => /^[a-f0-9]{40,64}$/.test(value ?? '');
const validId = value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value ?? '');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function readConfig(env = process.env) {
  const root = env.PREVIEW_DEPLOY_ROOT || '/var/www/realponto-previa';
  const state = env.PREVIEW_STATE_ROOT || '/var/lib/realponto-previa';
  for (const directory of [root, state]) {
    if (!path.isAbsolute(directory) || path.basename(directory) !== 'realponto-previa') {
      throw new Error('As pastas exclusivas da prévia devem ser absolutas e terminar em realponto-previa.');
    }
  }
  if (within(root, state) || within(state, root)) throw new Error('Estado e publicação devem usar pastas separadas.');
  const repository = env.PREVIEW_REPOSITORY || 'git@github.com:lucasprimitz/realponto-previa-cliente.git';
  if (!['git@github.com:lucasprimitz/realponto-previa-cliente.git', 'https://github.com/lucasprimitz/realponto-previa-cliente.git'].includes(repository)) {
    throw new Error('PREVIEW_REPOSITORY deve apontar ao repositório exclusivo realponto-previa-cliente, sem token na URL.');
  }
  let url;
  try { url = new URL(env.PREVIEW_HEALTH_URL || 'http://192.168.90.7:8082/previa-cliente/'); }
  catch { throw new Error('PREVIEW_HEALTH_URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/previa-cliente/' || url.username || url.password || url.hash || url.search) {
    throw new Error('A conferência HTTP deve usar /previa-cliente/, sem credenciais ou parâmetros.');
  }
  return {root: path.resolve(root), state: path.resolve(state), repository, healthUrl: url.href, timeoutMs: 15000};
}

async function realDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`A pasta deve ser real, sem links: ${current}`);
  }
  return absolute;
}

async function regularFile(filename, maxBytes = MAX_BYTES) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Arquivo inválido: ${filename}`);
  const bytes = await fs.readFile(filename);
  if (bytes.length > maxBytes) throw new Error(`Arquivo excede o limite: ${filename}`);
  return bytes;
}

async function optionalFile(filename) {
  try { return await regularFile(filename, 65536); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function mkdir(directory, mode = 0o700) {
  await fs.mkdir(directory, {mode});
  await fs.chmod(directory, mode);
}

async function ensureDirectory(directory, mode = 0o700) {
  try { await mkdir(directory, mode); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await realDirectory(directory);
}

export async function inspectPackage(packageRoot, releaseId) {
  await realDirectory(packageRoot);
  const manifest = JSON.parse(await regularFile(path.join(packageRoot, 'MANIFESTO.json'), 1024 * 1024));
  if (manifest.releaseId !== releaseId || manifest.mountPath !== '/previa-cliente/' || !Array.isArray(manifest.files)) {
    throw new Error('Manifesto do pacote não corresponde à prévia solicitada.');
  }
  const publicRoot = path.join(packageRoot, 'public');
  await realDirectory(publicRoot);
  const actual = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw new Error('O pacote não pode conter links simbólicos.');
      if (stat.isDirectory()) await visit(filename);
      else if (stat.isFile()) actual.push(path.relative(publicRoot, filename).split(path.sep).join('/'));
      else throw new Error('O pacote contém entrada que não é arquivo regular.');
    }
  }
  await visit(publicRoot);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...PUBLIC_FILES].sort())) throw new Error('A lista de arquivos públicos mudou; revise o atualizador antes de publicar.');
  const files = new Map();
  for (const file of PUBLIC_FILES) {
    const entries = manifest.files.filter(entry => entry.file === `public/${file}`);
    if (entries.length !== 1) throw new Error(`Arquivo ausente ou duplicado no manifesto: ${file}`);
    const content = await regularFile(path.join(publicRoot, file));
    if (content.length !== entries[0].bytes || digest(content) !== entries[0].sha256) throw new Error(`Integridade reprovada: ${file}`);
    files.set(file, content);
  }
  return files;
}

export async function currentRelease(root) {
  const current = path.join(root, 'current');
  let stat;
  try { stat = await fs.lstat(current); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isSymbolicLink()) throw new Error('current deve ser um link simbólico; nenhuma pasta existente será substituída.');
  const target = await fs.readlink(current);
  const absolute = path.resolve(root, target);
  if (path.dirname(absolute) !== path.join(root, 'releases')) throw new Error('current precisa apontar a uma versão dentro de releases da prévia.');
  await realDirectory(absolute);
  await realDirectory(path.join(absolute, 'public'));
  const data = await optionalFile(path.join(absolute, METADATA));
  return {target, directory: absolute, metadata: data ? JSON.parse(data) : null};
}

async function switchCurrent(root, target) {
  const temporary = path.join(root, `.current-${randomUUID()}`);
  try {
    await fs.symlink(target, temporary, 'dir');
    await fs.rename(temporary, path.join(root, 'current'));
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function verifyHealth(healthUrl, files, timeoutMs = 15000) {
  const mime = file => file.endsWith('.mjs') ? /^(?:text|application)\/javascript(?:;|$)/i
    : file.endsWith('.css') ? /^text\/css(?:;|$)/i
      : file.endsWith('.png') ? /^image\/png(?:;|$)/i : /^text\/html(?:;|$)/i;
  const signal = AbortSignal.timeout(timeoutMs);
  for (const [file, expected] of files) {
    const url = new URL(file === 'index.html' ? './' : file, healthUrl);
    url.searchParams.set('preview-check', randomUUID());
    const response = await fetch(url, {redirect: 'error', cache: 'no-store', signal});
    if (response.status !== 200 || !mime(file).test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error(`Conferência HTTP/MIME reprovada: ${file}`);
    }
    const reader = response.body.getReader();
    let length = 0;
    const chunks = [];
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expected.length) { await reader.cancel(); throw new Error(`Conteúdo HTTP divergente: ${file}`); }
      chunks.push(value);
    }
    if (!Buffer.concat(chunks).equals(expected)) throw new Error(`Conteúdo HTTP divergente: ${file}`);
  }
}

export async function publishPackage(config, packageRoot, releaseId, commit) {
  if (!validId(releaseId) || !validCommit(commit)) throw new Error('Versão ou commit inválido.');
  await realDirectory(config.root);
  await realDirectory(path.join(config.root, 'releases'));
  const previous = await currentRelease(config.root);
  if (!previous) throw new Error('Instale a prévia inicial antes de ativar a atualização automática.');
  const files = await inspectPackage(packageRoot, releaseId);
  const release = path.join(config.root, 'releases', releaseId);
  await mkdir(release, 0o755);
  await mkdir(path.join(release, 'public'), 0o755);
  await mkdir(path.join(release, 'public', 'assets'), 0o755);
  for (const [file, content] of files) {
    const filename = path.join(release, 'public', file);
    await fs.writeFile(filename, content, {flag: 'wx', mode: 0o644});
    await fs.chmod(filename, 0o644);
  }
  const metadata = {releaseId, branch: BRANCH, commit, previousTarget: previous.target, createdAt: new Date().toISOString(), verified: false};
  await fs.writeFile(path.join(release, METADATA), `${JSON.stringify(metadata, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  const target = `releases/${releaseId}`;
  if ((await currentRelease(config.root))?.target !== previous.target) throw new Error('current mudou durante a preparação; a nova versão não foi ativada.');
  await switchCurrent(config.root, target);
  try {
    await verifyHealth(config.healthUrl, files, config.timeoutMs);
    metadata.verified = true;
    const ready = path.join(release, `${METADATA}.ready`);
    await fs.writeFile(ready, `${JSON.stringify(metadata, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    await fs.rename(ready, path.join(release, METADATA));
  } catch (error) {
    const active = await currentRelease(config.root);
    if (active?.directory !== release) throw new Error('A conferência falhou e current foi alterado por outro processo; confira a instalação antes de tentar novamente.', {cause: error});
    await switchCurrent(config.root, previous.target);
    throw new Error(`Nova prévia reprovada; versão anterior restaurada. ${error.message}`, {cause: error});
  }
  return metadata;
}

async function run(command, args, options = {}) {
  try {
    const {stdout} = await execFileAsync(command, args, {
      ...options, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes'},
    });
    return stdout.trim();
  } catch (error) {
    // Never echo command arguments or child stderr: credential helpers may include secrets.
    throw new Error(`${command === process.execPath ? 'Node/testes/pacote' : 'Git'} falhou (${error.killed ? 'tempo limite' : error.code || 'erro'}). Consulte a TI.`, {cause: error});
  }
}

export async function updatePreview(config, log = console.log) {
  await realDirectory(config.root);
  await realDirectory(config.state);
  await realDirectory(path.join(config.root, 'releases'));
  let active = await currentRelease(config.root);
  if (!active) throw new Error('A instalação inicial da prévia não foi encontrada.');
  // If the process was interrupted after switching current, restore the known previous target.
  if (active.metadata?.verified === false) {
    if (active.metadata.branch !== BRANCH || active.metadata.releaseId !== path.basename(active.directory)) throw new Error('Metadados da tentativa interrompida não correspondem à versão ativa.');
    const previous = path.resolve(config.root, active.metadata.previousTarget || '');
    if (path.dirname(previous) !== path.join(config.root, 'releases') || previous === active.directory) throw new Error('Versão interrompida sem destino de retorno válido.');
    await realDirectory(path.join(previous, 'public'));
    await switchCurrent(config.root, active.metadata.previousTarget);
    log('Tentativa interrompida: versão anterior restaurada.');
    active = await currentRelease(config.root);
  }
  const cache = path.join(config.state, 'repository.git');
  const work = path.join(config.state, 'work');
  await ensureDirectory(work);
  try {
    await realDirectory(cache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const preparing = path.join(config.state, `.git-init-${randomUUID()}`);
    await mkdir(preparing);
    try {
      await run('git', ['init', '--bare', preparing]);
      await fs.rename(preparing, cache);
    } catch (failure) {
      if (path.dirname(preparing) !== config.state) throw new Error('Pasta de inicialização inválida.');
      await realDirectory(preparing);
      await fs.rm(preparing, {recursive: true, force: false});
      throw failure;
    }
  }
  await realDirectory(cache);
  const git = args => run('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', cache, ...args]);
  if (await git(['rev-parse', '--is-bare-repository']) !== 'true') throw new Error('O cache da prévia precisa ser um repositório Git bare exclusivo.');
  await git(['fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', config.repository, `+refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
  const commit = await git(['rev-parse', '--verify', `refs/heads/${BRANCH}^{commit}`]);
  if (!validCommit(commit)) throw new Error('O Git não retornou um commit válido.');
  if (active.metadata?.verified === true && active.metadata.branch === BRANCH && active.metadata.commit === commit && active.metadata.releaseId === path.basename(active.directory)) {
    log(`Prévia já atualizada: ${commit.slice(0, 12)}.`);
    return {changed: false, commit};
  }
  const releaseId = `previa-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const attempt = path.join(work, releaseId);
  await mkdir(attempt);
  try {
    const source = path.join(attempt, 'source');
    await mkdir(source);
    await git(['--work-tree', source, 'checkout', '--force', commit, '--', '.']);
    const tests = [
      'tests/quote.test.mjs', 'customer-preview/customer-model.test.mjs',
      'customer-preview/customer-request.test.mjs', 'customer-preview/request-transport.test.mjs', 'tests/customer-preview-package.test.mjs',
    ];
    log(`Validando a prévia ${commit.slice(0, 12)}.`);
    await run(process.execPath, ['scripts/check-pricing-sync.mjs'], {cwd: source});
    await run(process.execPath, ['--test', ...tests], {cwd: source});
    const packageRoot = path.join(attempt, 'package');
    await run(process.execPath, ['scripts/package-customer-preview.mjs', packageRoot, releaseId], {cwd: source});
    const metadata = await publishPackage(config, packageRoot, releaseId, commit);
    log(`Prévia atualizada e conferida: ${releaseId}.`);
    return {changed: true, ...metadata};
  } finally {
    // Only the newly-created working attempt is disposable; published releases are retained.
    if (path.dirname(attempt) !== work || path.basename(attempt) !== releaseId) throw new Error('Pasta temporária inválida.');
    await realDirectory(attempt);
    await fs.rm(attempt, {recursive: true, force: false});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux') throw new Error('Este atualizador é destinado ao servidor Linux.');
    if (process.getuid() === 0) throw new Error('Execute com o usuário dedicado realponto-previa, nunca root.');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Instale Node.js 24 ou superior para preparar a prévia.');
    await updatePreview(readConfig());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
