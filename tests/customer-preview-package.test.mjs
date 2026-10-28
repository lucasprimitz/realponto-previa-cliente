import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {packageCustomerPreview, PUBLIC_FILES} from '../scripts/package-customer-preview.mjs';
import {createPackagePreviewServer} from '../scripts/preview-customer-package.mjs';
import {calculateCustomerQuote} from '../customer-preview/customer-model.mjs';

test('pacote isolado mantém os cálculos e carrega todos os recursos dentro de /previa-cliente/', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'realponto-preview-package-'));
  t.after(() => fs.rm(temporary, {recursive:true, force:true}));
  const output = path.join(temporary, 'package');
  await packageCustomerPreview(output, 'test-preview');
  const guide = await fs.readFile(path.join(output, 'LEIA-ME-TI.md'), 'utf8');
  assert.match(guide, /\*\*Versão:\*\* `test-preview`/);
  assert.match(guide, /preview_version=test-preview/);
  assert.match(guide, /anterior-test-preview\.txt/);
  const publicDir = path.join(output, 'public');
  const actual = (await fs.readdir(publicDir, {recursive:true, withFileTypes:true}))
    .filter(entry=>entry.isFile()).map(entry=>path.relative(publicDir,path.join(entry.parentPath,entry.name)).replaceAll('\\','/')).sort();
  assert.deepEqual(actual, [...PUBLIC_FILES].sort());
  assert.deepEqual(await fs.readFile(path.join(publicDir,'quote.mjs')), await fs.readFile(new URL('../dist/quote.mjs',import.meta.url)));
  const packedModel = await import(pathToFileURL(path.join(publicDir,'customer-model.mjs')).href);
  const beforeDeadline = new Date('2026-11-01T12:00:00-03:00');
  for (const system of ['secullum-offline','secullum-rh','rhid','iponto']) {
    const input = {system,schedules:40,employees:100,bankHours:true,workScale:true};
    assert.deepEqual(packedModel.calculateCustomerQuote(input,beforeDeadline),calculateCustomerQuote(input,beforeDeadline));
  }
  const sums = (await fs.readFile(path.join(output,'SHA256SUMS'),'utf8')).trim().split('\n');
  for (const line of sums) {
    const [expected,relative] = line.split('  ');
    const actualHash = createHash('sha256').update(await fs.readFile(path.join(output,relative))).digest('hex');
    assert.equal(actualHash,expected,relative);
  }
  await assert.rejects(packageCustomerPreview(output,'test-preview'), {code:'EEXIST'});

  const server = createPackagePreviewServer(output);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/previa-cliente/`;
  const redirect = await fetch(base.slice(0,-1),{redirect:'manual'});
  assert.equal(redirect.status,302);
  assert.equal(redirect.headers.get('location'),'/previa-cliente/');
  const htmlResponse = await fetch(base);
  assert.equal(htmlResponse.status,200);
  const html = await htmlResponse.text();
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/form-action 'none'/);
  const references = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map(match=>match[1]);
  for (const reference of references) {
    const resolved = new URL(reference,base);
    assert.equal(resolved.origin,origin);
    assert.ok(resolved.pathname.startsWith('/previa-cliente/'),reference);
    assert.equal((await fetch(resolved)).status,200,reference);
  }
  for (const file of PUBLIC_FILES) {
    const response = await fetch(base+file);
    assert.equal(response.status,200,file);
    assert.equal(response.headers.get('cache-control'),'no-store');
    if (file.endsWith('.mjs')) assert.match(response.headers.get('content-type'),/^text\/javascript/);
  }
  for (const denied of ['/','/quote.mjs','/dist/quote.mjs','/assets/realponto-30-anos.png','/previa-cliente/server.mjs','/previa-cliente/README.md','/previa-cliente/missing.mjs','/previa-cliente/config/apache-previa-cliente.conf.example']) {
    assert.equal((await fetch(origin+denied)).status,404,denied);
  }
  assert.equal((await fetch(base,{method:'POST',body:'demo'})).status,405);
});
