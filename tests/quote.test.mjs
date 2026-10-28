import test from 'node:test';
import assert from 'node:assert/strict';
import {getQuote, SCHEDULES, EMPLOYEES, PRICING, CAMPAIGN, isCampaignActive, withCampaignDiscount, withSecullumSurcharge} from '../dist/quote.mjs';

// O catálogo é recebido da origem. Estes testes verificam seu contrato e as
// invariantes de cálculo sem congelar os valores comerciais da última entrega.
const duringCampaign = new Date(CAMPAIGN.deadlineISO + 'T12:00:00-03:00');
const lastInstant = new Date(CAMPAIGN.deadlineISO + 'T23:59:59.999-03:00');
const expiredCampaign = new Date(lastInstant.getTime() + 1);
const percent = (cents, rate) => Number((BigInt(cents) * BigInt(rate) + 50n) / 100n);
const base = (schedules, employees) => PRICING.baseCents + schedules * PRICING.perScheduleCents + employees * PRICING.perEmployeeCents;

test('catálogo sincronizado tem valores monetários e percentuais válidos', () => {
  for (const key of ['baseCents', 'perScheduleCents', 'perEmployeeCents']) assert.ok(Number.isSafeInteger(PRICING[key]) && PRICING[key] >= 0, key);
  for (const rate of [PRICING.bankHoursPercent, PRICING.workScalePercent, PRICING.secullumPercent, CAMPAIGN.discountPercent]) assert.ok(Number.isInteger(rate) && rate >= 0 && rate <= 100);
  assert.match(CAMPAIGN.deadlineISO, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(CAMPAIGN.deadlineLabel, CAMPAIGN.deadlineISO.split('-').reverse().join('/'));
  assert.equal(CAMPAIGN.timeZone, 'America/Sao_Paulo');
  for (const options of [SCHEDULES, EMPLOYEES]) {
    assert.ok(options.length > 0);
    assert.equal(new Set(options).size, options.length);
    assert.ok(options.every(value => Number.isSafeInteger(value) && value > 0));
  }
});

test('quantidades mínimas e máximas usam preços recebidos e adicionais independentes', () => {
  for (const schedules of [SCHEDULES[0], SCHEDULES.at(-1)]) for (const employees of [EMPLOYEES[0], EMPLOYEES.at(-1)]) {
    for (const bankHours of [false, true]) for (const workScale of [false, true]) {
      const subtotalCents = base(schedules, employees);
      const surchargeCents = bankHours ? percent(subtotalCents, PRICING.bankHoursPercent) : 0;
      const scaleSurchargeCents = workScale ? percent(subtotalCents, PRICING.workScalePercent) : 0;
      assert.deepEqual(getQuote(String(schedules), String(employees), bankHours, workScale), {
        status: 'priced', subtotalCents, surchargeCents, scaleSurchargeCents,
        cents: subtotalCents + surchargeCents + scaleSurchargeCents, bankHours, workScale,
      });
    }
  }
});

test('opções omitidas mantêm o orçamento original sem adicionais', () => {
  assert.deepEqual(getQuote(SCHEDULES[0], EMPLOYEES[0]), getQuote(SCHEDULES[0], EMPLOYEES[0], false, false));
  assert.deepEqual(getQuote(SCHEDULES[0], EMPLOYEES[0], true), getQuote(SCHEDULES[0], EMPLOYEES[0], true, false));
});

test('campos vazios ou quantidades fora das opções não geram preço', () => {
  for (const [schedules, employees] of [['', ''], ['', EMPLOYEES[0]], [SCHEDULES[0], ''], [undefined, EMPLOYEES[0]], [SCHEDULES[0], null], [0, EMPLOYEES[0]], [SCHEDULES.at(-1) + 1, EMPLOYEES[0]], [SCHEDULES[0], EMPLOYEES.at(-1) + 1], ['consultar', ''], ['', 'consultar'], ['inválido', EMPLOYEES[0]]]) {
    assert.deepEqual(getQuote(schedules, employees, true, true), {status: 'incomplete'});
  }
});

test('consulta especial preserva opções e nunca cria preço', () => {
  for (const [schedules, employees] of [['consultar', EMPLOYEES[0]], [SCHEDULES[0], 'consultar'], ['consultar', 'consultar']]) {
    for (const bankHours of [false, true]) for (const workScale of [false, true]) {
      assert.deepEqual(getQuote(schedules, employees, bankHours, workScale), {status: 'consultation', bankHours, workScale});
    }
  }
});

test('todas as quantidades preservam centavos, soma e independência entre adicionais', () => {
  for (const schedules of SCHEDULES) for (const employees of EMPLOYEES) {
    const bank = getQuote(schedules, employees, true, false);
    const scale = getQuote(schedules, employees, false, true);
    const both = getQuote(schedules, employees, true, true);
    assert.equal(both.subtotalCents, base(schedules, employees));
    assert.equal(both.surchargeCents, bank.surchargeCents);
    assert.equal(both.scaleSurchargeCents, scale.scaleSurchargeCents);
    assert.equal(both.surchargeCents, percent(both.subtotalCents, PRICING.bankHoursPercent));
    assert.equal(both.scaleSurchargeCents, percent(both.subtotalCents, PRICING.workScalePercent));
    assert.equal(both.cents, both.subtotalCents + both.surchargeCents + both.scaleSurchargeCents);
    for (const value of [both.subtotalCents, both.surchargeCents, both.scaleSurchargeCents, both.cents]) assert.ok(Number.isSafeInteger(value));
  }
});

test('campanha usa todo o prazo configurado em São Paulo e expira na virada', () => {
  assert.equal(isCampaignActive(duringCampaign), true);
  assert.equal(isCampaignActive(lastInstant), true);
  assert.equal(isCampaignActive(expiredCampaign), false);
  assert.equal(isCampaignActive(new Date(expiredCampaign.getTime() + 86400000)), false);
});

test('data inválida ou ausência de adesão não concedem desconto', () => {
  const original = getQuote(SCHEDULES[0], EMPLOYEES[0], true, true);
  for (const now of [new Date('invalid'), null, CAMPAIGN.deadlineISO, expiredCampaign]) {
    assert.equal(isCampaignActive(now), false);
    const result = withCampaignDiscount(original, true, now);
    assert.equal(result.discountApplied, false);
    assert.equal(result.discountCents, 0);
    assert.equal(result.cents, original.cents);
  }
  const declined = withCampaignDiscount(original, false, duringCampaign);
  assert.equal(declined.discountApplied, false);
  assert.equal(declined.cents, original.cents);
});

test('campanha não atribui preço a seleção incompleta ou consulta especial', () => {
  for (const original of [getQuote('', ''), getQuote('consultar', EMPLOYEES[0], true, true)]) {
    for (const [now, active] of [[duringCampaign, true], [expiredCampaign, false]]) {
      assert.deepEqual(withCampaignDiscount(Object.freeze(original), true, now), {...original, campaignActive: active, discountApplied: false});
      assert.deepEqual(withSecullumSurcharge(original, true), {...original, secullum: true});
    }
  }
});

test('desconto e adicional do sistema arredondam ao centavo sem mutar o original', () => {
  for (const cents of [1, 99, 101, 104, 105, 109, 10001]) {
    const original = Object.freeze({status: 'priced', cents});
    const withSystem = withSecullumSurcharge(original, true);
    assert.equal(withSystem.totalBeforeSecullumCents, cents);
    assert.equal(withSystem.secullumSurchargeCents, percent(cents, PRICING.secullumPercent));
    assert.equal(withSystem.cents, cents + withSystem.secullumSurchargeCents);
    const result = withCampaignDiscount(original, true, duringCampaign);
    assert.equal(result.discountCents, percent(cents, CAMPAIGN.discountPercent));
    assert.equal(result.cents + result.discountCents, cents);
    assert.equal(original.cents, cents);
    assert.equal('discountCents' in original, false);
    assert.equal('secullumSurchargeCents' in original, false);
    assert.equal(withSecullumSurcharge(original, false).cents, cents);
  }
});

test('campanha incide depois de banco, escala e Secullum em todo o catálogo', () => {
  for (const schedules of SCHEDULES) for (const employees of EMPLOYEES) {
    for (const bankHours of [false, true]) for (const workScale of [false, true]) for (const secullum of [false, true]) {
      const baseQuote = getQuote(schedules, employees, bankHours, workScale);
      const original = withSecullumSurcharge(baseQuote, secullum);
      const result = withCampaignDiscount(original, true, duringCampaign);
      assert.equal(original.secullumSurchargeCents, secullum ? percent(baseQuote.cents, PRICING.secullumPercent) : 0);
      assert.equal(result.totalBeforeDiscountCents, original.cents);
      assert.equal(result.discountCents, percent(original.cents, CAMPAIGN.discountPercent));
      assert.equal(result.cents + result.discountCents, original.cents);
      assert.ok(Number.isSafeInteger(result.cents) && result.cents >= 0);
    }
  }
});
