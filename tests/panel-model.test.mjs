import test from 'node:test';
import assert from 'node:assert/strict';
import {amount, receivedDate, quantity, formatPhone, formatTaxId, safeText, selectedPayment, buildRequestText} from '../contacts-panel/panel-model.mjs';

function item(method = 'boleto') {
  return {
    id: 'RP-000000000000000000000001',
    receivedAt: '2026-11-01T01:30:00Z',
    handled: false,
    note: 'Direcionar para Ana',
    request: {
      createdAt: '2026-11-01T01:30:00Z',
      contact: {name: 'Pessoa Exemplo', company: 'Empresa Exemplo', email: 'contato@example.invalid', phone: '11999990000', taxId: '12ABC34501DE35'},
      configuration: {system: 'rhid', schedules: 40, employees: 100, bankHours: true, workScale: false},
      payment: {method, label: 'Preferência salva'},
      estimate: {
        status: 'priced', totalCents: 84238, totalBeforeDiscountCents: 120340,
        discountCents: 36102, campaignDiscountApplied: true, campaignDeadline: '2026-12-15',
        pixCents: 80026, boletoInstallmentCents: 14040, cardInstallmentCents: 8424,
      },
      consent: true,
    },
  };
}

test('formats money without coercing missing, unsafe or negative cents into a value', () => {
  assert.equal(amount(0).replace(/\s/g, ' '), 'R$ 0,00');
  assert.equal(amount(123456).replace(/\s/g, ' '), 'R$ 1.234,56');
  for (const value of [null, undefined, '', '100', -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(amount(value), 'Valor sob consulta');
});

test('received dates use São Paulo even across a UTC month boundary', () => {
  const date = receivedDate('2026-11-01T01:30:00Z');
  assert.match(date, /31\/10\/2026/);
  assert.match(date, /22:30/);
  for (const value of [null, undefined, '', 'invalid']) assert.equal(receivedDate(value), 'Não informado');
});

test('formats complete phone, CPF and numeric or alphanumeric CNPJ and retains malformed documents', () => {
  assert.equal(formatPhone('11999990000'), '(11) 99999-0000');
  assert.equal(formatPhone('1133334444'), '(11) 3333-4444');
  assert.equal(formatPhone('+5511999990000'), '+55 (11) 99999-0000');
  assert.equal(formatPhone('5533334444'), '(55) 3333-4444');
  assert.equal(formatPhone('+14155551234'), '+14155551234');
  assert.equal(formatPhone('123'), '123');
  assert.equal(formatTaxId('12345678901'), '123.456.789-01');
  assert.equal(formatTaxId('12345678000190'), '12.345.678/0001-90');
  assert.equal(formatTaxId('12abc34501de35'), '12.ABC.345/01DE-35');
  assert.equal(formatTaxId('123'), '123');
  assert.equal(formatTaxId('12-?incompleto'), '12-?incompleto');
  assert.equal(formatTaxId('...'), '...');
  assert.equal(formatTaxId(null), '');
});

test('selected Pix uses stored net price without recalculating historical prices', () => {
  const data = item('pix');
  data.request.estimate.pixCents = 79999;
  const payment = selectedPayment(data);
  assert.equal(payment.totalCents, 79999);
  assert.equal(payment.value, amount(79999));
  assert.match(payment.label, /Pix/);
  assert.match(payment.caption, /À vista/);
  assert.deepEqual(selectedPayment(data.request), payment);
});

test('installments preserve saved rounded amounts and aggregate only the saved total', () => {
  const boleto = selectedPayment(item('boleto'));
  assert.equal(boleto.label, 'Boleto em até 6x, sob consulta');
  assert.equal(boleto.value, 'Exemplo: 6x de ' + amount(14040));
  assert.equal(boleto.totalCents, 84238);
  assert.match(boleto.caption, /análise do cliente/);
  const card = selectedPayment(item('credit-card'));
  assert.equal(card.label, 'Cartão de crédito em até 10x sem juros');
  assert.equal(card.value, 'Exemplo: 10x de ' + amount(8424));
  assert.equal(card.totalCents, 84238);
  assert.match(card.caption, /aproximadas/);
});

test('zero-value estimates remain known and missing Pix prices do not fall back to a higher total', () => {
  const data = item('pix');
  data.request.estimate.pixCents = 0;
  assert.equal(selectedPayment(data).totalCents, 0);
  assert.equal(selectedPayment(data).value, amount(0));
  delete data.request.estimate.pixCents;
  assert.equal(selectedPayment(data).totalCents, null);
  assert.equal(selectedPayment(data).value, 'Valor sob consulta');
});

test('consultation suppresses residual prices throughout display and copied text', () => {
  const data = item('boleto');
  data.request.estimate.status = 'consultation';
  data.request.configuration.schedules = 'consultar';
  const payment = selectedPayment(data);
  assert.equal(payment.totalCents, null);
  assert.equal(payment.value, 'Valor sob consulta');
  const copy = buildRequestText(data);
  assert.match(copy, /Mais de 100/);
  assert.doesNotMatch(copy, /R\$|842,38|140,40|361,02/);
});

test('copied request contains contact, scope, selected and alternative payments, and proposal guidance', () => {
  const data = item('boleto');
  const copy = buildRequestText(data);
  for (const text of [
    data.id, data.request.contact.name, data.request.contact.company, data.request.contact.email,
    '(11) 99999-0000', '12.ABC.345/01DE-35', 'Sistema: RHID', 'Horários a cadastrar: Até 40',
    'Funcionários a reagendar: Até 100', 'Banco de horas: Sim', 'Escalas: Não',
    'Inativação dos horários antigos: Contemplada pela Realponto',
    'Total sem desconto da campanha: ' + amount(120340),
    'Desconto da campanha: −' + amount(36102),
    'Estimativa com a campanha: ' + amount(84238),
    'OPÇÃO ESCOLHIDA: Boleto em até 6x, sob consulta — Exemplo: 6x de ' + amount(14040),
    'Pix: ' + amount(80026), 'Cartão de crédito em até 10x sem juros — Exemplo: 10x de ' + amount(8424),
    '15/12/2026',
    'Contato autorizado', 'O preenchimento não equivale à proposta nem à sua aprovação',
  ]) assert.ok(copy.includes(text), text);
});

test('copy explicitly excludes retiring old schedules on Secullum Offline', () => {
  const data = item();
  data.request.configuration.system = 'secullum-offline';
  data.handled = true;
  assert.match(buildRequestText(data), /Inativação dos horários antigos: Não contemplada no Secullum Offline/);
  for (const system of ['secullum-rh', 'rhid', 'iponto']) {
    data.request.configuration.system = system;
    assert.match(buildRequestText(data), /Inativação dos horários antigos: Contemplada pela Realponto/);
  }
});

test('plain copied text preserves names and document references without HTML interpretation', () => {
  const data = item();
  data.request.contact.company = 'Oficina <Norte> & Sul';
  data.request.contact.taxId = '123?';
  data.note = '<Ana> & Bruno';
  const copy = buildRequestText(data);
  assert.ok(copy.includes('Empresa: Oficina <Norte> & Sul'));
  assert.ok(copy.includes('CPF / CNPJ: 123?'));
  assert.ok(!copy.includes('<Ana> & Bruno')); 
  assert.ok(!copy.includes('&lt;'));
});

test('incomplete or malformed request objects remain readable without fabricated amounts', () => {
  for (const data of [null, undefined, {}, [], {request: null}, {request: {estimate: {status: 'broken', totalCents: 999}}}]) {
    const copy = buildRequestText(data);
    assert.doesNotMatch(copy, /undefined|NaN|\[object Object\]|R\$/);
    assert.match(copy, /Valor sob consulta/);
    assert.doesNotThrow(() => selectedPayment(data));
  }
  assert.equal(safeText({}, '—'), '—');
  assert.equal(quantity('100', 100), 'Não informado');
});

test('missing installment snapshots never fabricate an installment and invalid deadline stays absent', () => {
  const data = item();
  delete data.request.estimate.boletoInstallmentCents;
  data.request.estimate.campaignDeadline = '2026-02-30';
  assert.equal(selectedPayment(data).value, amount(84238));
  assert.doesNotMatch(buildRequestText(data), /30\/02\/2026|6x de/);
});


test('copied summary omits internal tracking while preserving proposal and contact details', () => {
  const data = item();
  for (const archived of [false, true]) {
    data.archived = archived;
    data.handled = true;
    const copied = buildRequestText(data);
    assert.doesNotMatch(copied, /ACOMPANHAMENTO|Situação:|Encaminhada:|Responsável \/ observação:|Direcionar para Ana/);
    assert.match(copied, /contato@example.invalid/);
    assert.match(copied, /Contato autorizado pelo cliente/);
    assert.match(copied, /6x de/);
    assert.equal(data.note, 'Direcionar para Ana');
    assert.equal(data.handled, true);
  }
});
