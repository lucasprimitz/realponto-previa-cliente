import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {checkPricingSync} from '../scripts/check-pricing-sync.mjs';
import {contactPricing, exportContactPricing, CANONICAL_PRICING} from '../scripts/export-contact-pricing.mjs';
import {applyPricingCatalog, getPricingCatalog} from '../dist/quote.mjs';
import {calculateCustomerQuote} from '../customer-preview/customer-model.mjs';

test('navegador e servidor têm customer-service/pricing.json como origem', async () => assert.equal(await checkPricingSync(), true));

test('uma tabela diferente altera base, adicionais, campanha e pacotes sem editar a fórmula', t => {
  const original = getPricingCatalog();
  t.after(() => applyPricingCatalog(original));
  const changed = structuredClone(contactPricing());
  changed.pricing = {baseCents: 90000, perScheduleCents: 3000, perEmployeeCents: 250, bankHoursPercent: 20, workScalePercent: 5, secullumPercent: 12};
  changed.campaign = {discountPercent: 25, deadlineISO: '2027-02-01', deadlineLabel: '01/02/2027', timeZone: 'America/Sao_Paulo'};
  changed.schedules = [12, 24]; changed.employees = [30, 60];
  applyPricingCatalog(changed);
  // 900+12*30+30*2.50=1335; adicionais25%=1668.75;
  // Secullum12%=1869.00; desconto25%=1401.75.
  const quote = calculateCustomerQuote({system:'secullum-rh', schedules:12, employees:30, bankHours:true, workScale:true}, new Date('2027-01-01T12:00:00Z'));
  assert.equal(quote.cents, 140175);
  assert.equal(calculateCustomerQuote({system:'rhid',schedules:10,employees:20}).status, 'incomplete');
});

test('exportação lê a tabela canônica e não aceita sobrescrever a fonte', async t => {
  await assert.rejects(exportContactPricing(), /destino diferente/);
  await assert.rejects(exportContactPricing(fileURLToPath(CANONICAL_PRICING)), /destino diferente/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'realponto-catalog-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const target = path.join(directory, 'copy.json');
  await exportContactPricing(target);
  assert.deepEqual(contactPricing(target), contactPricing());
  const bad = structuredClone(contactPricing()); bad.systems[0].secullum = false;
  await writeFile(target, JSON.stringify(bad));
  assert.throws(() => contactPricing(target), /Sistemas/);
});
