import test from 'node:test';
import assert from 'node:assert/strict';
import {PAYMENT_METHODS, normalizeTaxId, formatTaxId, formatPhone, isTaxIdFormatValid, buildCustomerRequest} from './customer-request.mjs';

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

test('formata CPF e CNPJ progressivamente, incluindo CNPJ alfanumérico em maiúsculas', () => {
  const cases = [
    [null, ''], [undefined, ''], ['', ''], ['1', '1'], ['123', '123'], ['1234', '123.4'],
    ['1234567', '123.456.7'], ['1234567890', '123.456.789-0'], ['12345678900', '123.456.789-00'],
    ['123456780001', '12.345.678/0001'], ['12345678000190', '12.345.678/0001-90'],
    ['a', 'A'], ['12a', '12.A'], ['12abc3', '12.ABC.3'], ['12abc3450', '12.ABC.345/0'],
    ['12abc34501de6', '12.ABC.345/01DE-6'], [' 12.abc.345/01de-67 ', '12.ABC.345/01DE-67'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(formatTaxId(value), expected);
    assert.equal(formatTaxId(expected), expected);
    assert.equal(normalizeTaxId(expected), normalizeTaxId(value));
  }
});

test('máscara de documento preserva letras finais inválidas, caracteres desconhecidos e excesso', () => {
  for (const value of ['12abc34501deab', '123456780001901', '12abc34501de678', '123!45678900']) {
    const formatted = formatTaxId(value);
    assert.equal(normalizeTaxId(formatted), normalizeTaxId(value));
    assert.equal(isTaxIdFormatValid(formatted), false);
    assert.equal(request({taxId: formatted}).contact.taxId, normalizeTaxId(value));
  }
  assert.equal(formatTaxId('12abc34501deab'), '12.ABC.345/01DE-AB');
  assert.equal(request({taxId: formatTaxId('12abc34501de67')}).contact.taxId, '12ABC34501DE67');
});

test('formata telefone progressivamente com DDD, fixo e celular sem alterar seus dígitos', () => {
  const cases = [
    [null, ''], [undefined, ''], ['', ''], ['1', '(1'], ['11', '(11)'], ['119', '(11) 9'],
    ['113333', '(11) 3333'], ['1133334', '(11) 3333-4'], ['1133334444', '(11) 3333-4444'],
    ['11999990000', '(11) 99999-0000'], [' (11) 99999-0000 ', '(11) 99999-0000'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(formatPhone(value), expected);
    assert.equal(formatPhone(expected), expected);
    assert.equal(expected.replace(/\D/g, ''), String(value ?? '').replace(/\D/g, ''));
  }
});

test('aceita código brasileiro explícito ou completo sem confundir com DDD 55', () => {
  const cases = [
    ['+', '+'], ['+5', '+5'], ['+55', '+55'], ['+551', '+55 (1'], ['+5511', '+55 (11)'],
    ['+55 (11) 3333-4444', '+55 (11) 3333-4444'], ['551133334444', '+55 (11) 3333-4444'],
    ['5511999990000', '+55 (11) 99999-0000'], ['+5511999990000', '+55 (11) 99999-0000'],
    ['55', '(55)'], ['5533334444', '(55) 3333-4444'], ['55999990000', '(55) 99999-0000'],
    ['555533334444', '+55 (55) 3333-4444'], ['5555999990000', '+55 (55) 99999-0000'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(formatPhone(value), expected);
    assert.equal(formatPhone(expected), expected);
    assert.equal(expected.replace(/\D/g, ''), value.replace(/\D/g, ''));
  }
});

test('máscara de telefone não trunca excesso nem remove caracteres inválidos', () => {
  for (const value of ['119999900001', '55119999900001', '+551199999000012', '11999990000 ramal 123', '11+999990000', '+1 (415) 555-0100']) {
    const formatted = formatPhone(value);
    assert.equal(formatted.replace(/\D/g, ''), value.replace(/\D/g, ''));
    assert.equal(formatPhone(formatted), formatted);
  }
  assert.equal(formatPhone('11999990000 ramal 123'), '11999990000 ramal 123');
  assert.equal(formatPhone('11+999990000'), '11+999990000');
  assert.equal(formatPhone('+1 (415) 555-0100'), '+1 (415) 555-0100');
});

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

test('documento incompleto ou fora do padrão é enviado para conferência sem bloquear o contato', () => {
  for (const taxId of ['123', '123.456.789-000', '12.345.678/0001-AB', '123!45678900', '...']) {
    assert.equal(isTaxIdFormatValid(taxId), false);
    const result = request({taxId});
    assert.equal(result.contact.taxId, normalizeTaxId(taxId) || taxId);
    assert.equal(result.contact.phone, '(11) 99999-0000');
  }
  assert.equal(formatTaxId('...'), '...');
});

test('proteções de texto permanecem sem exigir validade cadastral do documento', () => {
  for (const taxId of [12345678900, ['12345678900'], {}, 'A'.repeat(41), '123\n456', '123\u0000456']) {
    assert.throws(() => request({taxId}), error => error.field === 'taxId');
  }
});

test('pagamento desconhecido e falta de autorização são recusados', () => {
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
