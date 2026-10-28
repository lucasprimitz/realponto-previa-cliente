import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {contactPricing} from './export-contact-pricing.mjs';

const root = new URL('../', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
export function validatePricingSnapshot(quoteBytes, pricingBytes, provenance, expectedPricing) {
  assert.equal(provenance.schemaVersion, 1, 'Versão de sincronização desconhecida.');
  assert.equal(provenance.sourceRepository, 'lucasprimitz/realponto-jornada');
  assert.equal(provenance.sourceBranch, 'main');
  assert.equal(provenance.sourceFile, 'dist/quote.mjs');
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.quoteSha256, digest(quoteBytes), 'O módulo de preços diverge da origem registrada.');
  assert.equal(provenance.pricingSha256, digest(pricingBytes), 'Os preços PHP divergem da origem registrada.');
  assert.deepEqual(JSON.parse(pricingBytes.toString('utf8')), expectedPricing, 'Navegador e PHP precisam usar as mesmas regras.');
  return true;
}
export async function checkPricingSync() {
  const [quote, pricing, provenance] = await Promise.all([
    readFile(new URL('dist/quote.mjs', root)),
    readFile(new URL('customer-service/pricing.json', root)),
    readFile(new URL('pricing-sync.json', root), 'utf8'),
  ]);
  return validatePricingSnapshot(quote, pricing, JSON.parse(provenance), contactPricing());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await checkPricingSync(); console.log('Preços JS e PHP consistentes com a versão de origem registrada.');}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
