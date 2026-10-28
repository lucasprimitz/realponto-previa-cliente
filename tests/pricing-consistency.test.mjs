import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validatePricingSnapshot, checkPricingSync} from '../scripts/check-pricing-sync.mjs';
import {contactPricing} from '../scripts/export-contact-pricing.mjs';
const quote = await readFile(new URL('../dist/quote.mjs', import.meta.url));
const pricing = await readFile(new URL('../customer-service/pricing.json', import.meta.url));
const provenance = JSON.parse(await readFile(new URL('../pricing-sync.json', import.meta.url), 'utf8'));
test('regras JS, PHP e versão registrada formam um conjunto consistente', async () => assert.equal(await checkPricingSync(), true));
test('recusa preço JS alterado sem nova versão', () => assert.throws(() => validatePricingSnapshot(Buffer.concat([quote, Buffer.from(' ')]), pricing, provenance, contactPricing())));
test('recusa preço PHP alterado sem nova versão', () => assert.throws(() => validatePricingSnapshot(quote, Buffer.concat([pricing, Buffer.from(' ')]), provenance, contactPricing())));
test('recusa origem diferente e revisão inválida', () => {
  for (const changed of [{sourceRepository:'outro/projeto'}, {sourceBranch:'outra'}, {sourceFile:'outro.mjs'}, {sourceCommit:'invalida'}]) {
    assert.throws(() => validatePricingSnapshot(quote, pricing, {...provenance, ...changed}, contactPricing()));
  }
});
test('recusa divergência de preços mesmo quando os hashes foram atualizados', () => {
  const changed = contactPricing(); changed.pricing = {...changed.pricing, baseCents: changed.pricing.baseCents + 100};
  const bytes = Buffer.from(JSON.stringify(changed));
  assert.throws(() => validatePricingSnapshot(quote, bytes, {...provenance, pricingSha256:createHash('sha256').update(bytes).digest('hex')}, contactPricing()));
});
