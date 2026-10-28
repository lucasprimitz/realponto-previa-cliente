import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packageCustomerPreview} from '../scripts/package-customer-preview.mjs';
import {BRANCH, PUBLIC_FILES, readConfig, inspectPackage, verifyHealth, currentRelease, publishPackage, updatePreview, run} from '../scripts/update-customer-preview.mjs';

const command = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const silent = () => {};

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'realponto-preview-update-'));
  t.after(async () => {
    // The mkdtemp return is the only recursive cleanup target in these tests.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('realponto-preview-update-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}/previa-cliente/`;
}

test('configuração fixa a branch da prévia e recusa produção, sobreposição e credenciais na URL', () => {
  assert.equal(BRANCH, 'main');
  const config = readConfig({
    PREVIEW_DEPLOY_ROOT: path.resolve('test-web/realponto-previa'),
    PREVIEW_STATE_ROOT: path.resolve('test-state/realponto-previa'),
  });
  assert.equal(config.healthUrl, 'http://192.168.90.7:8082/previa-cliente/');
  for (const env of [
    {PREVIEW_DEPLOY_ROOT: '/var/www/realponto'},
    {PREVIEW_DEPLOY_ROOT: 'relative/realponto-previa'},
    {PREVIEW_DEPLOY_ROOT: '/var/lib/realponto-previa', PREVIEW_STATE_ROOT: '/var/lib/realponto-previa'},
    {PREVIEW_HEALTH_URL: 'http://example.com/'},
    {PREVIEW_HEALTH_URL: 'http://user:secret@example.com/previa-cliente/'},
    {PREVIEW_REPOSITORY: 'https://secret@github.com/lucasprimitz/realponto-previa-cliente.git'},
  ]) assert.throws(() => readConfig(env));
});

test('pacote adulterado ou com arquivo extra nunca chega à publicação', async t => {
  const root = await temporary(t);
  const bundle = path.join(root, 'package');
  await packageCustomerPreview(bundle, 'verification');
  const files = await inspectPackage(bundle, 'verification');
  assert.equal(files.size, PUBLIC_FILES.length);
  await assert.rejects(inspectPackage(bundle, 'other-version'), /Manifesto/);
  await fs.appendFile(path.join(bundle, 'public', 'quote.mjs'), '\n// alteração não empacotada\n');
  await assert.rejects(inspectPackage(bundle, 'verification'), /Integridade/);
  await fs.writeFile(path.join(bundle, 'public', 'quote.mjs'), files.get('quote.mjs'));
  await fs.writeFile(path.join(bundle, 'public', 'secret.txt'), 'extra');
  await assert.rejects(inspectPackage(bundle, 'verification'), /lista de arquivos/);
});

test('conferência HTTP exige conteúdo exato, MIME correto e nenhum redirecionamento', async t => {
  let mode = 'valid';
  const bytes = Buffer.from('export const value = 1;');
  const base = await server(t, (req, res) => {
    if (mode === 'redirect') { res.writeHead(302, {location: '/another'}); res.end(); return; }
    res.writeHead(200, {'Content-Type': mode === 'mime' ? 'text/html' : 'text/javascript'});
    res.end(mode === 'content' ? 'bad response' : bytes);
  });
  const files = new Map([['app.mjs', bytes]]);
  await verifyHealth(base, files, 1000);
  mode = 'mime';
  await assert.rejects(verifyHealth(base, files, 1000), /HTTP\/MIME/);
  mode = 'content';
  await assert.rejects(verifyHealth(base, files, 1000), /divergente/);
  mode = 'redirect';
  await assert.rejects(verifyHealth(base, files, 1000));
});

test('validação executa o arquivo de teste mesmo quando chamada de outro node:test', async t => {
  const root = await temporary(t);
  const failingTest = path.join(root, 'intentional-failure.test.mjs');
  await fs.writeFile(failingTest, "throw new Error('intentional validation failure');\n");
  await assert.rejects(run(process.execPath, ['--test', failingTest]), /Node\/testes\/pacote falhou/);
});

test('Linux: publicação, no-op, falha de teste, rollback HTTP, nova tentativa e isolamento de outras branches', {skip: process.platform !== 'linux'}, async t => {
  const temporaryRoot = await temporary(t);
  const root = path.join(temporaryRoot, 'web', 'realponto-previa');
  const state = path.join(temporaryRoot, 'state', 'realponto-previa');
  const origin = path.join(temporaryRoot, 'origin');
  await fs.mkdir(path.join(root, 'releases', 'manual', 'public'), {recursive: true});
  await fs.mkdir(state, {recursive: true});
  await fs.mkdir(origin);
  await fs.writeFile(path.join(root, 'releases', 'manual', 'public', 'index.html'), 'manual version');
  await fs.symlink('releases/manual', path.join(root, 'current'));
  const paths = [
    ...PUBLIC_FILES.map(file => ['quote.mjs', 'assets/realponto-30-anos.png'].includes(file) ? `dist/${file}` : `customer-preview/${file}`),
    'customer-preview/customer-model.test.mjs', 'customer-preview/customer-request.test.mjs', 'customer-preview/request-transport.test.mjs',
    'customer-preview/hosting/apache-previa-cliente.conf.example', 'customer-preview/hosting/nginx-previa-cliente.conf.example',
    'scripts/package-customer-preview.mjs', 'scripts/preview-customer-package.mjs',
    'scripts/check-pricing-sync.mjs', 'scripts/export-contact-pricing.mjs', 'customer-service/pricing.json', 'pricing-sync.json',
    'tests/quote.test.mjs', 'tests/customer-preview-package.test.mjs', 'docs/PREVIA-CLIENTE-TI.md', 'docs/ATUALIZACAO-AUTOMATICA-PREVIA.md',
  ];
  for (const relative of paths) {
    await fs.mkdir(path.dirname(path.join(origin, relative)), {recursive: true});
    await fs.copyFile(path.join(project, relative), path.join(origin, relative));
  }
  const git = async args => (await command('git', ['-c', 'user.name=Preview Test', '-c', 'user.email=preview@example.invalid', ...args], {cwd: origin})).stdout.trim();
  await git(['init', '-b', 'other-branch']);
  await git(['add', '.']);
  await git(['commit', '-m', 'initial fixture']);
  await git(['checkout', '-b', BRANCH]);
  const firstCommit = await git(['rev-parse', 'HEAD']);
  let httpFailure = false;
  const base = await server(t, async (req, res) => {
    try {
      const requestPath = new URL(req.url, 'http://localhost').pathname;
      const file = requestPath === '/previa-cliente/' ? 'index.html' : requestPath.slice('/previa-cliente/'.length);
      assert.ok(PUBLIC_FILES.includes(file));
      const type = file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html';
      const bytes = await fs.readFile(path.join(root, 'current', 'public', file));
      res.writeHead(200, {'Content-Type': type});
      res.end(httpFailure && file === 'quote.mjs' ? 'wrong version' : bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  const config = {...readConfig({PREVIEW_DEPLOY_ROOT: root, PREVIEW_STATE_ROOT: state, PREVIEW_HEALTH_URL: base}), repository: pathToFileURL(origin).href};
  const first = await updatePreview(config, silent);
  assert.equal(first.changed, true);
  assert.equal(first.commit, firstCommit);
  assert.equal(first.previousTarget, 'releases/manual');
  assert.equal(first.verified, true);
  const firstTarget = (await currentRelease(root)).target;
  assert.equal(await fs.readFile(path.join(root, 'releases', 'manual', 'public', 'index.html'), 'utf8'), 'manual version');
  assert.deepEqual(await fs.readdir(path.join(state, 'work')), []);
  assert.equal((await updatePreview(config, silent)).changed, false);

  await git(['checkout', 'other-branch']);
  await fs.writeFile(path.join(origin, 'other-branch-only.txt'), 'other branch update');
  await git(['add', '.']);
  await git(['commit', '-m', 'other-branch-only']);
  assert.equal((await updatePreview(config, silent)).changed, false);
  await git(['checkout', BRANCH]);

  const modelTests = path.join(origin, 'customer-preview', 'customer-model.test.mjs');
  const validTests = await fs.readFile(modelTests, 'utf8');
  await fs.appendFile(modelTests, '\nthrow new Error("intentional test failure");\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'failing preview']);
  await assert.rejects(updatePreview(config, silent), /Node\/testes\/pacote falhou/);
  assert.equal((await currentRelease(root)).target, firstTarget);
  assert.deepEqual(await fs.readdir(path.join(state, 'work')), []);

  await fs.writeFile(modelTests, validTests);
  await fs.appendFile(path.join(origin, 'customer-preview', 'preview.css'), '\n/* new approved preview */\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'valid preview update']);
  const nextCommit = await git(['rev-parse', 'HEAD']);
  httpFailure = true;
  await assert.rejects(updatePreview(config, silent), /versão anterior restaurada/);
  assert.equal((await currentRelease(root)).target, firstTarget);
  httpFailure = false;
  const retry = await updatePreview(config, silent);
  assert.equal(retry.changed, true);
  assert.equal(retry.commit, nextCommit);
  assert.notEqual(retry.releaseId, first.releaseId);
  assert.equal((await updatePreview(config, silent)).changed, false);
  assert.equal((await fs.readdir(path.join(root, 'releases'))).length, 4);
});

test('Linux: recusa current fora da prévia e restaura uma tentativa interrompida', {skip: process.platform !== 'linux'}, async t => {
  const temporaryRoot = await temporary(t);
  const root = path.join(temporaryRoot, 'web', 'realponto-previa');
  const state = path.join(temporaryRoot, 'state', 'realponto-previa');
  await fs.mkdir(path.join(root, 'releases', 'manual', 'public'), {recursive: true});
  await fs.mkdir(state, {recursive: true});
  await fs.symlink('/var/www/realponto/current', path.join(root, 'current'));
  await assert.rejects(currentRelease(root), /dentro de releases/);
  await fs.unlink(path.join(root, 'current'));
  await fs.mkdir(path.join(root, 'releases', 'interrupted', 'public'), {recursive: true});
  await fs.writeFile(path.join(root, 'releases', 'interrupted', 'preview-deployment.json'), JSON.stringify({verified: false, previousTarget: 'releases/manual', branch: BRANCH, releaseId: 'interrupted'}));
  await fs.symlink('releases/interrupted', path.join(root, 'current'));
  const config = {...readConfig({PREVIEW_DEPLOY_ROOT: root, PREVIEW_STATE_ROOT: state}), repository: path.join(temporaryRoot, 'missing-repository')};
  await assert.rejects(updatePreview(config, silent), /Git falhou/);
  assert.equal((await currentRelease(root)).target, 'releases/manual');
  const bundle = path.join(temporaryRoot, 'bundle');
  await packageCustomerPreview(bundle, 'never-published');
  await fs.unlink(path.join(root, 'current'));
  await fs.mkdir(path.join(root, 'current'));
  await assert.rejects(publishPackage(config, bundle, 'never-published', 'a'.repeat(40)), /link simbólico/);
});
