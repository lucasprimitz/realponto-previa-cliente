import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCustomerQuote, paymentOptions, paymentDisplay, SYSTEMS, SCHEDULES, EMPLOYEES, CAMPAIGN} from './customer-model.mjs';
import {PRICING, getQuote, withSecullumSurcharge, withCampaignDiscount} from '../dist/quote.mjs';

const duringCampaign = new Date(CAMPAIGN.deadlineISO + 'T12:00:00-03:00');
const deadlineEnd = new Date(CAMPAIGN.deadlineISO + 'T23:59:59.999-03:00');
const afterCampaign = new Date(deadlineEnd.getTime() + 1);
const baseSelection = {system: 'rhid', schedules: SCHEDULES[3] ?? SCHEDULES[0], employees: EMPLOYEES[4] ?? EMPLOYEES[0]};
const quote = (changes = {}, now = duringCampaign) => calculateCustomerQuote({...baseSelection, ...changes}, now);

test('os quatro sistemas usam os nomes confirmados e os dois Secullum têm a mesma regra', () => {
  assert.deepEqual(SYSTEMS.map(({name}) => name), ['Secullum Offline', 'Secullum RH', 'RHID', 'iPonto']);
  const offline = quote({system: 'secullum-offline'});
  assert.deepEqual(offline, quote({system: 'secullum-rh'}));
  assert.equal(offline.totalBeforeSecullumCents, quote().totalBeforeSecullumCents);
  assert.equal(offline.secullumSurchargeCents, Math.round(offline.totalBeforeSecullumCents * PRICING.secullumPercent / 100));
});

test('RHID e iPonto têm o mesmo preço sem adicional do sistema', () => {
  const rhid = quote();
  assert.deepEqual(rhid, quote({system: 'iponto'}));
  assert.equal(rhid.secullumSurchargeCents, 0);
  assert.equal(rhid.totalBeforeDiscountCents, getQuote(baseSelection.schedules, baseSelection.employees).cents);
});

test('modelo do cliente aplica o motor sincronizado em todos os sistemas e adicionais', () => {
  for (const system of SYSTEMS) for (const bankHours of [false, true]) for (const workScale of [false, true]) {
    const configuration = getQuote(baseSelection.schedules, baseSelection.employees, bankHours, workScale);
    const expected = withCampaignDiscount(withSecullumSurcharge(configuration, system.secullum), true, duringCampaign);
    assert.deepEqual(quote({system: system.id, bankHours, workScale}), expected);
  }
});

test('a campanha respeita o último instante do prazo sincronizado e encerra na virada', () => {
  const last = quote({}, deadlineEnd);
  const next = quote({}, afterCampaign);
  assert.equal(last.discountApplied, true);
  assert.equal(last.cents, quote().cents);
  assert.equal(next.campaignActive, false);
  assert.equal(next.discountApplied, false);
  assert.equal(next.discountCents, 0);
  assert.equal(next.cents, last.totalBeforeDiscountCents);
});

test('seleções ausentes ou inválidas não produzem orçamento', () => {
  assert.deepEqual(calculateCustomerQuote(), {status: 'incomplete'});
  for (const changes of [
    {system: ''}, {system: 'outro'}, {schedules: ''}, {employees: null},
    {schedules: SCHEDULES.at(-1) + 1}, {employees: EMPLOYEES.at(-1) + 1}, {schedules: [40]}, {employees: {valueOf: () => 100}},
  ]) assert.deepEqual(quote(changes), {status: 'incomplete'});
  assert.equal(quote({schedules: String(baseSelection.schedules), employees: String(baseSelection.employees)}).cents, quote().cents);
});

test('acima dos limites encaminha para consulta sem inventar valor', () => {
  for (const changes of [{schedules: 'consultar'}, {employees: 'consultar'}, {schedules: 'consultar', employees: 'consultar'}]) {
    const result = quote({...changes, system: 'secullum-rh', bankHours: true});
    assert.equal(result.status, 'consultation');
    assert.equal(result.discountApplied, false);
    assert.equal('cents' in result, false);
  }
});

test('parcelas distribuem os centavos e preservam o total escolhido', () => {
  const payments = paymentOptions(10001);
  assert.equal(payments.pixCents, 9501);
  assert.deepEqual(payments.boleto, [1667, 1667, 1667, 1667, 1667, 1666]);
  assert.deepEqual(payments.card, [1001, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  for (const total of [1, 10001, 141400, 194425, Number.MAX_SAFE_INTEGER]) {
    const options = paymentOptions(total);
    for (const installments of [options.boleto, options.card]) {
      assert.equal(installments.reduce((sum, value) => sum + BigInt(value), 0n), BigInt(total));
      assert.ok(Math.max(...installments) - Math.min(...installments) <= 1);
    }
  }
});

test('pagamento aceita zero e recusa valores não inteiros, negativos ou inseguros', () => {
  assert.deepEqual(paymentOptions(0), {pixCents: 0, boleto: Array(6).fill(0), card: Array(10).fill(0)});
  for (const invalid of [-1, 1.5, NaN, Infinity, '100', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(paymentOptions(invalid), null);
  }
});

test('exibição arredonda uma única parcela sem alterar o total nem o pagamento exato', () => {
  assert.deepEqual(paymentDisplay(194425), {boletoInstallmentCents: 32404, cardInstallmentCents: 19443});
  assert.deepEqual(paymentDisplay(10005), {boletoInstallmentCents: 1668, cardInstallmentCents: 1001});
  assert.deepEqual(paymentDisplay(0), {boletoInstallmentCents: 0, cardInstallmentCents: 0});
  const total = 194425;
  const exact = paymentOptions(total);
  assert.equal(exact.card.reduce((sum, value) => sum + value, 0), total);
  assert.equal(exact.boleto.reduce((sum, value) => sum + value, 0), total);
  const large = paymentDisplay(Number.MAX_SAFE_INTEGER);
  assert.equal(large.boletoInstallmentCents, 1501199875790165);
  assert.equal(large.cardInstallmentCents, 900719925474099);
  for (const invalid of [-1, 1.5, NaN, Infinity, '100', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(paymentDisplay(invalid), null);
  }
});
