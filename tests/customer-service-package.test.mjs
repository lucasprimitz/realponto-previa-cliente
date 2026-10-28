import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packageCustomerService} from '../scripts/package-customer-service.mjs';
import {contactPricing} from '../scripts/export-contact-pricing.mjs';

test('pacote funcional separa o PHP e os segredos dos arquivos públicos e preserva as regras compartilhadas', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'realponto-service-package-'));
  t.after(() => fs.rm(tmp, {recursive: true, force: true}));
  const output = path.join(tmp, 'release');
  const manifest = await packageCustomerService(output, 'test-functional');
  const html = await fs.readFile(path.join(output, 'public/index.html'), 'utf8');
  assert.match(html, /name="realponto-api-base" content="\.\/api\/"/);
  assert.match(html, /connect-src 'self'/);
  assert.match(await fs.readFile(path.join(output, 'public/contatos/index.html'), 'utf8'), /Senha de acesso/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'pricing.json'), 'utf8')), contactPricing());
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(output, file.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.file);
    assert.doesNotMatch(file.file, /(?:sqlite|private|vendor|tests|contacts-config)/);
    if (file.file.startsWith('public/')) {
      assert.ok(!/config|pricing\.json|composer|src\//.test(file.file), file.file);
      if (file.file.endsWith('.php')) assert.match(file.file, /^public\/api\/(session|requests|login|logout|request-update)\.php$/);
    }
  }
  assert.ok(manifest.files.some(item => item.file === 'composer.lock'));
  assert.ok(manifest.files.some(item => item.file === 'SINCRONIZACAO-PRECOS.md'));
  assert.ok(manifest.files.some(item => item.file === 'src/Http.php'));
  await assert.rejects(packageCustomerService(output, 'test-functional'), {code: 'EEXIST'});
  const original = await fs.readFile(new URL('../customer-preview/index.html', import.meta.url), 'utf8');
  assert.match(original, /name="realponto-api-base" content=""/);
  assert.match(original, /connect-src 'none'/);
});
