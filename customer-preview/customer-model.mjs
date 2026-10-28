import {
  SCHEDULES,
  EMPLOYEES,
  getQuote,
  withSecullumSurcharge,
  withCampaignDiscount,
} from '../dist/quote.mjs';

export {SCHEDULES, EMPLOYEES, formatMoney, formatNumber, CAMPAIGN} from '../dist/quote.mjs';

export const SYSTEMS = Object.freeze([
  Object.freeze({id: 'secullum-offline', name: 'Secullum Offline', secullum: true}),
  Object.freeze({id: 'secullum-rh', name: 'Secullum RH', secullum: true}),
  Object.freeze({id: 'rhid', name: 'RHID', secullum: false}),
  Object.freeze({id: 'iponto', name: 'iPonto', secullum: false}),
]);

const validQuantity = (value, options) => value === 'consultar' || (
  (typeof value === 'number' || typeof value === 'string') &&
  String(value).trim() !== '' &&
  options.includes(Number(value))
);

// A prévia compartilha os preços e o prazo com o simulador interno.
export function calculateCustomerQuote({
  system,
  schedules,
  employees,
  bankHours = false,
  workScale = false,
} = {}, now = new Date()) {
  const selectedSystem = SYSTEMS.find(item => item.id === system);
  if (!selectedSystem || !validQuantity(schedules, SCHEDULES) || !validQuantity(employees, EMPLOYEES)) {
    return {status: 'incomplete'};
  }

  const configuration = getQuote(schedules, employees, Boolean(bankHours), Boolean(workScale));
  const total = withSecullumSurcharge(configuration, selectedSystem.secullum);
  return withCampaignDiscount(total, true, now);
}

function splitInstallments(totalCents, quantity) {
  const base = Math.floor(totalCents / quantity);
  const remaining = totalCents % quantity;
  return Array.from({length: quantity}, (_, index) => base + (index < remaining ? 1 : 0));
}

export function paymentOptions(totalCents) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) return null;
  return {
    // Inteiros evitam perda de um centavo no arredondamento do Pix.
    pixCents: Number((BigInt(totalCents) * 95n + 50n) / 100n),
    boleto: splitInstallments(totalCents, 6),
    card: splitInstallments(totalCents, 10),
  };
}

// Apenas a apresentação usa parcelas uniformes arredondadas. O total da
// proposta e a distribuição exata dos centavos em paymentOptions não mudam.
export function paymentDisplay(totalCents) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) return null;
  const total = BigInt(totalCents);
  return {
    boletoInstallmentCents: Number((total + 3n) / 6n),
    cardInstallmentCents: Number((total + 5n) / 10n),
  };
}
