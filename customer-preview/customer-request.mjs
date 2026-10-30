import {calculateCustomerQuote} from './customer-model.mjs';

export const PAYMENT_METHODS = Object.freeze([
  Object.freeze({id: 'pix', label: 'Pix — 5% de desconto'}),
  Object.freeze({id: 'boleto', label: 'Boleto em 6 parcelas — sob consulta'}),
  Object.freeze({id: 'credit-card', label: 'Cartão de crédito em 10 parcelas sem juros'}),
]);

export function normalizeTaxId(value) {
  return String(value ?? '').trim().replace(/[.\/\-\s]/g, '').toUpperCase();
}

export function formatTaxId(value) {
  const document = normalizeTaxId(value);
  if (!document || !/^[A-Z0-9]*$/.test(document)) return String(value ?? '').trim().toUpperCase();
  const cnpj = /[A-Z]/.test(document) || document.length > 11;
  const parts = cnpj
    ? [document.slice(0, 2), document.slice(2, 5), document.slice(5, 8), document.slice(8, 12), document.slice(12)]
    : [document.slice(0, 3), document.slice(3, 6), document.slice(6, 9), document.slice(9)];
  const separators = cnpj ? ['.', '.', '/', '-'] : ['.', '.', '-'];
  // A última parte não é limitada: letras nos verificadores ou excesso continuam visíveis.
  return parts.reduce((formatted, part, index) => part ? formatted + (index ? separators[index - 1] : '') + part : formatted, '');
}

export function formatPhone(value) {
  const original = String(value ?? '').trim();
  const compact = original.replace(/[()\s.\-]/g, '');
  if (!/^\+?\d*$/.test(compact)) return original;
  const explicitCountry = compact.startsWith('+');
  let digits = explicitCountry ? compact.slice(1) : compact;
  if (explicitCountry && !digits.startsWith('55')) return original;
  // Sem '+', 55 só é código do país quando antecede um número completo com DDD.
  const country = explicitCountry || (digits.startsWith('55') && [12, 13].includes(digits.length));
  if (country) digits = digits.slice(2);
  const prefix = country ? '+55' : '';
  if (!digits) return prefix;
  const area = '(' + digits.slice(0, 2) + (digits.length >= 2 ? ')' : '');
  const subscriber = digits.slice(2);
  const split = subscriber.length > 8 ? 5 : 4;
  const number = subscriber.slice(0, split) + (subscriber.length > split ? '-' + subscriber.slice(split) : '');
  return (prefix ? prefix + ' ' : '') + area + (number ? ' ' + number : '');
}

// Apenas formato: não verifica dígitos verificadores nem a existência do cadastro.
export function isTaxIdFormatValid(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return true;
  if (typeof value !== 'string' || value.length > 40) return false;
  return /^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(normalizeTaxId(value));
}

function invalid(field, message) {
  const error = new TypeError(message);
  error.field = field;
  throw error;
}

function requiredText(input, field) {
  if (typeof input[field] !== 'string' || !input[field].trim()) {
    invalid(field, 'Preencha este campo.');
  }
  return input[field].trim();
}

// A mesma solicitação reúne os dados de contato, o escopo e a preferência de
// pagamento. A prévia não envia nem armazena este objeto.
export function buildCustomerRequest(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('request', 'Solicitação inválida.');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    invalid('createdAt', 'Data da solicitação inválida.');
  }
  for (const field of ['bankHours', 'workScale']) {
    if (typeof input[field] !== 'boolean') invalid(field, 'Selecione uma opção.');
  }
  const quote = calculateCustomerQuote(input, now);
  if (quote.status === 'incomplete') {
    invalid('configuration', 'Confira o sistema e as quantidades selecionadas.');
  }
  const payment = PAYMENT_METHODS.find(item => item.id === input.paymentMethod);
  if (!payment) invalid('paymentMethod', 'Selecione a forma de pagamento desejada.');
  if (input.contactPermission !== true) {
    invalid('contactPermission', 'Autorize o contato para continuar.');
  }
  // O documento é uma referência opcional para conferência, não uma condição de envio.
  if (input.taxId != null && (typeof input.taxId !== 'string' || input.taxId.length > 40 || /[\u0000-\u001f\u007f]/.test(input.taxId))) {
    invalid('taxId', 'Confira o campo CPF / CNPJ.');
  }
  const taxId = normalizeTaxId(input.taxId) || String(input.taxId ?? '').trim().toUpperCase() || null;

  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    contact: {
      name: requiredText(input, 'contactName'),
      company: requiredText(input, 'company'),
      email: requiredText(input, 'email'),
      phone: requiredText(input, 'phone'),
      taxId,
    },
    configuration: {
      system: input.system,
      schedules: input.schedules === 'consultar' ? 'consultar' : Number(input.schedules),
      employees: input.employees === 'consultar' ? 'consultar' : Number(input.employees),
      bankHours: input.bankHours,
      workScale: input.workScale,
    },
    payment: {method: payment.id, label: payment.label},
    estimate: {
      status: quote.status,
      totalCents: quote.status === 'priced' ? quote.cents : null,
      campaignDiscountApplied: quote.discountApplied === true,
    },
    consent: true,
  };
}
