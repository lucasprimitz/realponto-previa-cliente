import test from 'node:test';
import assert from 'node:assert/strict';
import {PAYMENT_METHODS, normalizeTaxId, isTaxIdFormatValid, buildCustomerRequest} from './customer-request.mjs';

import {calculateCustomerQuote, CAMPAIGN} from './customer-model.mjs';
const now = new Date(CAMPAIGN.deadlineISO + 'T12:00:00-03:00');
const expired = new Date(new Date(CAMPAIGN.deadlineISO + 'T23:59:59.999-03:00').getTime() + 1);
const input = {
  system: 'rhid', schedules: '40', employees: '100', bankHours: false, workScale: false,
  contactName: ' Pessoa de teste ', company: ' Empresa de exemplo ',
  email: ' teste@example.com ', phone: ' (11) 99999-0000 ',
  taxId: '', paymentMethod: 'pix', contactPermission: true,
};
const request = (changes = {}, date = now) => buildCustomerRequest({...input, ...changes}, date);
const expectedTotal = calculateCustomerQuote(input, now).cents;

test('solicitação única reúne escopo, contatos, documento e forma de pagamento', () => {
  assert.deepEqual(request({taxId: '123.456.789-00'}), {
    schemaVersion: 1, createdAt: now.toISOString(),
    contact: {name: 'Pessoa de teste', company: 'Empresa de exemplo', email: 'teste@example.com', phone: '(11) 99999-0000', taxId: '12345678900'},
    configuration: {system: 'rhid', schedules: 40, employees: 100, bankHours: false, workScale: false},
    payment: {method: 'pix', label: 'Pix — 5% de desconto'},
    estimate: {status: 'priced', totalCents: expectedTotal, campaignDiscountApplied: true},
    consent: true,
  });
});

test('CPF/CNPJ é opcional e não impede uma solicitação sem documento', () => {
  for (const taxId of ['', '   ', null, undefined]) {
    assert.equal(isTaxIdFormatValid(taxId), true);
    assert.equal(request({taxId}).contact.taxId, null);
  }
});

test('normaliza máscaras e admite CNPJ alfanumérico sem afirmar validade cadastral', () => {
  assert.equal(normalizeTaxId(' 12.abc.345/01de-67 '), '12ABC34501DE67');
  for (const taxId of ['12345678900', '123.456.789-00', '12.345.678/0001-90', '12.abc.345/01de-67']) {
    assert.equal(isTaxIdFormatValid(taxId), true);
    assert.equal(request({taxId}).contact.taxId, normalizeTaxId(taxId));
  }
  assert.equal(normalizeTaxId('123!456'), '123!456');
});

test('as três preferências são incluídas sem transformar preferência em cobrança', () => {
  assert.deepEqual(PAYMENT_METHODS.map(item => item.id), ['pix', 'boleto', 'credit-card']);
  assert.equal(request({paymentMethod: 'boleto'}).payment.label, 'Boleto em 6 parcelas — sob consulta');
  assert.equal(request({paymentMethod: 'credit-card'}).payment.label, 'Cartão de crédito em 10 parcelas sem juros');
  for (const method of PAYMENT_METHODS) {
    const result = request({paymentMethod: method.id});
    assert.deepEqual(result.payment, {method: method.id, label: method.label});
    assert.equal(result.estimate.totalCents, expectedTotal);
  }
});

test('documento malformado, pagamento desconhecido e falta de autorização são recusados', () => {
  for (const taxId of ['123', '123.456.789-000', '12.345.678/0001-AB', '123!45678900', 12345678900, ['12345678900'], '...']) {
    assert.equal(isTaxIdFormatValid(taxId), false);
    assert.throws(() => request({taxId}), error => error.field === 'taxId');
  }
  for (const paymentMethod of ['', 'cash', null, 'PIX']) {
    assert.throws(() => request({paymentMethod}), error => error.field === 'paymentMethod');
  }
  for (const contactPermission of [false, undefined, 'true']) {
    assert.throws(() => request({contactPermission}), error => error.field === 'contactPermission');
  }
});

test('contatos e escolhas incompletos não geram uma solicitação pronta', () => {
  for (const field of ['contactName', 'company', 'email', 'phone']) {
    assert.throws(() => request({[field]: '   '}), error => error.field === field);
  }
  for (const changes of [{system: 'outro'}, {schedules: 15}, {employees: ''}]) {
    assert.throws(() => request(changes), error => error.field === 'configuration');
  }
  for (const field of ['bankHours', 'workScale']) {
    assert.throws(() => request({[field]: 'false'}), error => error.field === field);
  }
});

test('consulta personalizada guarda as preferências sem inventar orçamento', () => {
  const result = request({schedules: 'consultar', employees: 'consultar', bankHours: true, workScale: true, paymentMethod: 'boleto'});
  assert.deepEqual(result.configuration, {system: 'rhid', schedules: 'consultar', employees: 'consultar', bankHours: true, workScale: true});
  assert.deepEqual(result.estimate, {status: 'consultation', totalCents: null, campaignDiscountApplied: false});
  assert.equal(result.payment.method, 'boleto');
});

test('estimativa pública não inclui taxas internas e respeita o encerramento da campanha', () => {
  const result = request({system: 'secullum-rh', bankHours: true, workScale: true}, expired);
  assert.deepEqual(result.estimate, {status: 'priced', totalCents: calculateCustomerQuote({...input, system: 'secullum-rh', bankHours: true, workScale: true}, expired).cents, campaignDiscountApplied: false});
  assert.deepEqual(Object.keys(result.estimate).sort(), ['campaignDiscountApplied', 'status', 'totalCents']);
  assert.equal(JSON.stringify(result).includes('secullumSurcharge'), false);
});
