const currency = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
const integer = new Intl.NumberFormat('pt-BR');
const dateTime = new Intl.DateTimeFormat('pt-BR', {dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'});
const SYSTEMS = Object.freeze({'secullum-offline': 'Secullum Offline', 'secullum-rh': 'Secullum RH', rhid: 'RHID', iponto: 'iPonto'});
const PAYMENTS = Object.freeze({pix: 'Pix', boleto: 'Boleto em 6 parcelas', 'credit-card': 'Cartão de crédito em 10 parcelas'});

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const validCents = value => Number.isSafeInteger(value) && value >= 0;
const requestOf = value => {
  const source = object(value);
  return Object.hasOwn(source, 'request') ? object(source.request) : source;
};

export function safeText(value, fallback = 'Não informado') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function amount(cents) {
  return validCents(cents) ? currency.format(cents / 100) : 'Valor sob consulta';
}

export function receivedDate(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Data não disponível';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Data não disponível' : dateTime.format(date);
}

export function quantity(value, upper) {
  if (value === 'consultar' && Number.isSafeInteger(upper) && upper > 0) return 'Mais de ' + integer.format(upper);
  return Number.isSafeInteger(value) && value > 0 ? 'Até ' + integer.format(value) : 'Não informado';
}

export function systemLabel(value) {
  return Object.hasOwn(SYSTEMS, value) ? SYSTEMS[value] : 'Não informado';
}

// O documento é apenas uma referência: não corrigimos nem ocultamos valores incompletos.
export function formatTaxId(value) {
  const original = safeText(value, '');
  const compact = original.replace(/[.\/\-\s]/g, '').toUpperCase();
  if (/^\d{11}$/.test(compact)) return compact.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (/^[A-Z0-9]{12}\d{2}$/.test(compact)) return compact.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5');
  return original;
}

export function formatPhone(value) {
  const original = safeText(value, '');
  const compact = original.replace(/[()\s.\-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return original;
  const explicitCountry = compact.startsWith('+');
  let digits = explicitCountry ? compact.slice(1) : compact;
  if (explicitCountry && !digits.startsWith('55')) return original;
  const country = explicitCountry || (digits.startsWith('55') && [12, 13].includes(digits.length));
  if (country) digits = digits.slice(2);
  if (![10, 11].includes(digits.length)) return original;
  const split = digits.length === 11 ? 7 : 6;
  return (country ? '+55 ' : '') + '(' + digits.slice(0, 2) + ') ' + digits.slice(2, split) + '-' + digits.slice(split);
}

function pricedEstimate(request) {
  const estimate = object(request.estimate);
  // Nunca reaproveitar valores residuais de uma solicitação sob consulta.
  return estimate.status === 'priced' || (estimate.status == null && validCents(estimate.totalCents)) ? estimate : {};
}

export function selectedPayment(itemOrRequest) {
  const request = requestOf(itemOrRequest);
  const payment = object(request.payment);
  const estimate = pricedEstimate(request);
  const method = payment.method;
  const label = Object.hasOwn(PAYMENTS, method) ? PAYMENTS[method] : safeText(payment.label, 'Pagamento não informado');
  const total = method === 'pix' ? estimate.pixCents : estimate.totalCents;
  const totalCents = validCents(total) ? total : null;
  let value = amount(totalCents);
  let caption = 'Condições a confirmar na proposta.';
  if (method === 'pix') caption = 'À vista · desconto extra do Pix já considerado.';
  if (method === 'boleto') {
    if (totalCents !== null && validCents(estimate.boletoInstallmentCents)) value = '6x de ' + amount(estimate.boletoInstallmentCents);
    caption = 'Sob consulta e análise do cliente.';
  }
  if (method === 'credit-card') {
    if (totalCents !== null && validCents(estimate.cardInstallmentCents)) value = '10x de ' + amount(estimate.cardInstallmentCents);
    caption = 'Sem juros · parcelas aproximadas.';
  }
  if (totalCents === null) caption = method === 'boleto' ? 'Valor e parcelamento sob consulta.' : 'Valor e condições a confirmar na proposta.';
  return {label, value, caption, totalCents};
}

function yesNo(value) {
  return typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : 'Não informado';
}

function deadline(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '';
  const [year, month, day] = value.split('-');
  return day + '/' + month + '/' + year;
}

export function buildRequestText(value) {
  const item = object(value);
  const request = requestOf(item);
  const contact = object(request.contact);
  const configuration = object(request.configuration);
  const estimate = pricedEstimate(request);
  const payment = selectedPayment(request);
  const knownSystem = Object.hasOwn(SYSTEMS, configuration.system);
  const retirement = configuration.system === 'secullum-offline'
    ? 'Não contemplada no Secullum Offline'
    : knownSystem ? 'Contemplada pela Realponto' : 'A confirmar conforme o sistema';
  const lines = [
    'REALPONTO · SOLICITAÇÃO DE PROPOSTA',
    'Protocolo: ' + safeText(item.id, 'Não informado'),
    'Recebida em: ' + receivedDate(item.receivedAt ?? request.createdAt),
    '',
    'CONTATO',
    'Empresa: ' + safeText(contact.company),
    'Nome: ' + safeText(contact.name),
    'Telefone / WhatsApp: ' + safeText(formatPhone(contact.phone)),
    'E-mail: ' + safeText(contact.email),
    'CPF / CNPJ: ' + safeText(formatTaxId(contact.taxId)),
    '',
    'CONFIGURAÇÃO SOLICITADA',
    'Sistema: ' + systemLabel(configuration.system),
    'Horários a cadastrar: ' + quantity(configuration.schedules, 100),
    'Funcionários a reagendar: ' + quantity(configuration.employees, 1000),
    'Banco de horas: ' + yesNo(configuration.bankHours),
    'Escalas: ' + yesNo(configuration.workScale),
    'Inativação dos horários antigos: ' + retirement,
    'Execução: implantação e parametrização pela Realponto, com reagendamento na data combinada.',
    '',
    'ESTIMATIVA E PAGAMENTO',
  ];
  if (validCents(estimate.totalBeforeDiscountCents)) lines.push('Total sem desconto da campanha: ' + amount(estimate.totalBeforeDiscountCents));
  if (estimate.campaignDiscountApplied === true && validCents(estimate.discountCents)) lines.push('Desconto da campanha: −' + amount(estimate.discountCents));
  lines.push((estimate.campaignDiscountApplied === true ? 'Estimativa com a campanha: ' : 'Estimativa da parametrização: ') + amount(estimate.totalCents));
  const campaignDeadline = deadline(object(request.estimate).campaignDeadline);
  if (estimate.campaignDiscountApplied === true && campaignDeadline) lines.push('Campanha condicionada à aprovação até ' + campaignDeadline + '.');
  lines.push('OPÇÃO ESCOLHIDA: ' + payment.label + ' — ' + payment.value, payment.caption);
  if (payment.totalCents !== null) lines.push('Total estimado na opção escolhida: ' + amount(payment.totalCents));
  lines.push(
    '',
    'OPÇÕES DE PAGAMENTO PARA CONFERÊNCIA',
    'Pix: ' + amount(estimate.pixCents) + ' à vista.',
    'Boleto: ' + (validCents(estimate.totalCents) && validCents(estimate.boletoInstallmentCents) ? '6x de ' + amount(estimate.boletoInstallmentCents) : 'Valor sob consulta') + ' — sob consulta e análise do cliente.',
    'Cartão de crédito: ' + (validCents(estimate.totalCents) && validCents(estimate.cardInstallmentCents) ? '10x de ' + amount(estimate.cardInstallmentCents) : 'Valor sob consulta') + ' — sem juros.',
    'Parcelas aproximadas por arredondamento; condições a confirmar na proposta.',
    '',
    'ACOMPANHAMENTO',
    'Encaminhada: ' + yesNo(item.handled),
    'Responsável / observação: ' + safeText(item.note),
  );
  if (request.consent === true) lines.push('Contato autorizado pelo cliente para esta solicitação.');
  lines.push('', 'O preenchimento não equivale à proposta nem à sua aprovação. Confirmar os dados com o cliente, enviar a proposta e solicitar sua aprovação.');
  return lines.join('\n');
}
