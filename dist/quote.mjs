export const SCHEDULES = Object.freeze(Array.from({length: 10}, (_, i) => (i + 1) * 10));
export const EMPLOYEES = Object.freeze([
  ...Array.from({length: 5}, (_, i) => (i + 1) * 20),
  ...Array.from({length: 8}, (_, i) => 150 + i * 50),
  ...Array.from({length: 5}, (_, i) => 600 + i * 100),
]);

// Regra inicial ajustável. Valores monetários em centavos.
// Referências: 20 horários + 100 funcionários = R$ 1.520;
// 30 horários + 100 funcionários = R$ 1.770, sem adicionais.
export const PRICING = Object.freeze({
  baseCents: 80000,
  perScheduleCents: 2500,
  perEmployeeCents: 220,
  bankHoursPercent: 15,
  workScalePercent: 10,
  secullumPercent: 10,
});

export const CAMPAIGN = Object.freeze({
  discountPercent: 30,
  deadlineISO: '2026-12-15',
  deadlineLabel: '15/12/2026',
  timeZone: 'America/Sao_Paulo',
});

const campaignDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPAIGN.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function isCampaignActive(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const parts = Object.fromEntries(campaignDateFormatter.formatToParts(now).map(({type, value}) => [type, value]));
  const localDate = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  return localDate <= CAMPAIGN.deadlineISO;
}

export function withCampaignDiscount(quote, requested = false, now = new Date()) {
  const campaignActive = isCampaignActive(now);
  if (quote.status !== 'priced') return {...quote, campaignActive, discountApplied: false};
  const discountApplied = Boolean(requested) && campaignActive;
  const totalBeforeDiscountCents = quote.cents;
  const discountCents = discountApplied ? Math.round(totalBeforeDiscountCents * CAMPAIGN.discountPercent / 100) : 0;
  return {...quote, campaignActive, discountApplied, totalBeforeDiscountCents, discountCents, cents:totalBeforeDiscountCents - discountCents};
}

export function withSecullumSurcharge(quote, requested = false) {
  const secullum = Boolean(requested);
  if (quote.status !== 'priced') return {...quote, secullum};
  const totalBeforeSecullumCents = quote.cents;
  const secullumSurchargeCents = secullum ? Math.round(totalBeforeSecullumCents * PRICING.secullumPercent / 100) : 0;
  return {...quote, secullum, totalBeforeSecullumCents, secullumSurchargeCents, cents:totalBeforeSecullumCents + secullumSurchargeCents};
}

export function getQuote(schedules, employees, bankHours = false, workScale = false) {
  const validSchedule = schedules === 'consultar' || SCHEDULES.includes(Number(schedules));
  const validEmployees = employees === 'consultar' || EMPLOYEES.includes(Number(employees));
  if (!validSchedule || !validEmployees) return {status: 'incomplete'};
  if (schedules === 'consultar' || employees === 'consultar') return {status: 'consultation', bankHours, workScale};
  const scheduleCents = Number(schedules) * PRICING.perScheduleCents;
  const employeeCents = Number(employees) * PRICING.perEmployeeCents;
  const subtotalCents = PRICING.baseCents + scheduleCents + employeeCents;
  const surchargeCents = bankHours ? Math.round(subtotalCents * PRICING.bankHoursPercent / 100) : 0;
  const scaleSurchargeCents = workScale ? Math.round(subtotalCents * PRICING.workScalePercent / 100) : 0;
  return {status:'priced', subtotalCents, surchargeCents, scaleSurchargeCents, cents:subtotalCents + surchargeCents + scaleSurchargeCents, bankHours, workScale};
}

export const formatNumber = value => new Intl.NumberFormat('pt-BR').format(value);
export const formatMoney = cents => new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'}).format(cents / 100);
