import {calculateCustomerQuote} from './customer-model.mjs';

export const PAYMENT_METHODS = Object.freeze([
  Object.freeze({id: 'pix', label: 'Pix — 5% de desconto'}),
  Object.freeze({id: 'boleto', label: 'Boleto em 6 parcelas — sob consulta'}),
  Object.freeze({id: 'credit-card', label: 'Cartão de crédito em 10 parcelas sem juros'}),
]);

export function normalizeTaxId(value) {
  return String(value ?? '').trim().replace(/[.\/\-\s]/g, '').toUpperCase();
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
  if (!isTaxIdFormatValid(input.taxId)) {
    invalid('taxId', 'Informe um CPF ou CNPJ completo, ou deixe o campo em branco.');
  }

  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    contact: {
      name: requiredText(input, 'contactName'),
      company: requiredText(input, 'company'),
      email: requiredText(input, 'email'),
      phone: requiredText(input, 'phone'),
      taxId: normalizeTaxId(input.taxId) || null,
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
