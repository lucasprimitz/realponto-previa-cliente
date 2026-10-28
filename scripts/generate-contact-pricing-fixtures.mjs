import {writeFile} from 'node:fs/promises';
import {SYSTEMS, SCHEDULES, EMPLOYEES, CAMPAIGN, calculateCustomerQuote} from '../customer-preview/customer-model.mjs';
import {buildCustomerRequest} from '../customer-preview/customer-request.mjs';

const fixtures = [];
const deadlineEnd = new Date(CAMPAIGN.deadlineISO + 'T23:59:59.999-03:00');
const afterCampaign = new Date(deadlineEnd.getTime() + 1);
function add(configuration, when) {
  const now = new Date(when);
  fixtures.push({now: now.toISOString(), input: buildCustomerRequest({...configuration,
    contactName: 'Teste automático', company: 'Empresa de teste', email: 'teste@example.invalid',
    phone: '11999999999', paymentMethod: 'pix', contactPermission: true}, now),
    expected: calculateCustomerQuote(configuration, now)});
}
for (const {id: system} of SYSTEMS) for (const schedules of SCHEDULES) for (const employees of EMPLOYEES)
  for (const bankHours of [false, true]) for (const workScale of [false, true]) {
    add({system, schedules, employees, bankHours, workScale}, deadlineEnd);
  }
for (const {id: system} of SYSTEMS) for (const schedules of [SCHEDULES[0], 'consultar']) {
  add({system, schedules, employees: EMPLOYEES[0], bankHours: true, workScale: true}, afterCampaign);
}
await writeFile(new URL('../customer-service/tests/pricing-fixtures.json', import.meta.url), JSON.stringify(fixtures));
console.log(`${fixtures.length} cenários de comparação gerados a partir das regras compartilhadas.`);
