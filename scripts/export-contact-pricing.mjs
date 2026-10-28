import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {PRICING, CAMPAIGN, SCHEDULES, EMPLOYEES} from '../dist/quote.mjs';
import {SYSTEMS} from '../customer-preview/customer-model.mjs';

export const contactPricing = () => ({pricing: PRICING, campaign: CAMPAIGN, schedules: SCHEDULES, employees: EMPLOYEES, systems: SYSTEMS});
export async function exportContactPricing(destination = new URL('../customer-service/pricing.json', import.meta.url)) {
  await writeFile(destination, JSON.stringify(contactPricing(), null, 2) + '\n');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await exportContactPricing();
  console.log('Regras exportadas de dist/quote.mjs para o serviço de solicitações.');
}
