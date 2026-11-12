import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {contactPricing} from './export-contact-pricing.mjs';
import {getPricingCatalog} from '../dist/quote.mjs';
import {SYSTEMS} from '../customer-preview/customer-model.mjs';
import {validateCatalog} from '../dist/pricing-catalog.mjs';

export async function checkPricingSync() {
  const canonical = contactPricing();
  assert.deepEqual(getPricingCatalog(), validateCatalog(canonical), 'O navegador deve carregar customer-service/pricing.json.');
  assert.deepEqual(canonical.systems, SYSTEMS, 'Os sistemas do navegador e do PHP devem corresponder.');
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await checkPricingSync(); console.log('Tabela oficial validada: navegador e PHP usam customer-service/pricing.json.');}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
