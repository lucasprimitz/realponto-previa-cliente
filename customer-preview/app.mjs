import {SYSTEMS, SCHEDULES, EMPLOYEES, CAMPAIGN, calculateCustomerQuote, paymentOptions, paymentDisplay, formatMoney, formatNumber} from './customer-model.mjs';
import {PAYMENT_METHODS, buildCustomerRequest, formatPhone, formatTaxId} from './customer-request.mjs';
import {createRequestTransport} from './request-transport.mjs';

const form = document.querySelector('#customer-form');
const panels = [...document.querySelectorAll('.wizard-step')];
const steps = [...document.querySelectorAll('.stepper li')];
const errorBox = document.querySelector('#form-error');
const next = document.querySelector('#next-button');
const back = document.querySelector('#back-button');
const success = document.querySelector('#success-panel');
const formPanel = document.querySelector('.form-panel');
let currentStep = 1;
let furthestStep = 1;
let submitting = false;
let transport;
let transportError;
const apiBase = document.querySelector('meta[name="realponto-api-base"]')?.content ?? '';
const connected = apiBase.trim() !== '';
try { transport = createRequestTransport({apiBase}); } catch (error) { transportError = error; }
if (connected) {
  document.querySelector('#preview-ribbon').hidden = true;
  document.querySelector('#submission-note p').textContent = 'Ao solicitar a proposta, seus dados e suas escolhas serão encaminhados à equipe Realponto para dar continuidade ao atendimento.';
  document.querySelector('#success-kicker').textContent = 'SOLICITAÇÃO RECEBIDA';
  document.querySelector('#success-title').textContent = 'Recebemos sua solicitação!';
  document.querySelector('#success-description').textContent = 'Um analista da Realponto entrará em contato para conferir as informações e preparar sua proposta.';
  document.querySelector('#success-note').textContent = 'Guarde o protocolo para acompanhar seu atendimento. O envio da solicitação não equivale à aprovação da proposta.';
}
function setSubmitting(value) {
  submitting = value;
  form.setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll('#customer-form input, #customer-form select, #customer-form button, #edit-button')) control.disabled = value;
  renderSteps();
  next.firstChild.textContent = value ? 'Enviando… ' : currentStep === 4 ? 'Solicitar proposta ' : 'Continuar ';
}

function fillSelect(id, values, noun, customLabel) {
  const select = document.querySelector(id);
  for (const value of values) select.add(new Option(`Até ${formatNumber(value)} ${noun}`, String(value)));
  select.add(new Option(customLabel, 'consultar'));
}
fillSelect('#schedules', SCHEDULES, 'horários', 'Mais de 100 horários');
fillSelect('#employees', EMPLOYEES, 'funcionários', 'Mais de 1.000 funcionários');


// Preserve the cursor when punctuation is inserted or an existing value is edited.
function bindContactMask(input, format) {
  const meaningful = character => /[A-Za-z0-9]/.test(character ?? '');
  const apply = () => {
    const previous = input.value;
    const caret = input.selectionStart ?? previous.length;
    const count = [...previous.slice(0, caret)].filter(meaningful).length;
    const formatted = format(previous);
    if (formatted === previous) return;
    input.value = formatted;
    if (document.activeElement !== input) return;
    let position = 0;
    let seen = 0;
    while (position < formatted.length && seen < count) {
      if (meaningful(formatted[position])) seen++;
      position++;
    }
    if (caret === previous.length) position = formatted.length;
    input.setSelectionRange(position, position);
  };
  input.addEventListener('input', event => { if (!event.isComposing) apply(); });
  input.addEventListener('compositionend', apply);
  input.addEventListener('blur', apply);
  input.addEventListener('beforeinput', event => {
    if (event.isComposing || input.selectionStart !== input.selectionEnd) return;
    const backward = event.inputType === 'deleteContentBackward';
    if (!backward && event.inputType !== 'deleteContentForward') return;
    let position = (input.selectionStart ?? 0) - (backward ? 1 : 0);
    if (position < 0 || position >= input.value.length || meaningful(input.value[position])) return;
    // Deleting a separator should remove the adjacent digit, not reinsert the separator forever.
    while (position >= 0 && position < input.value.length && !meaningful(input.value[position])) position += backward ? -1 : 1;
    if (position < 0 || position >= input.value.length) return;
    event.preventDefault();
    input.value = input.value.slice(0, position) + input.value.slice(position + 1);
    input.setSelectionRange(position, position);
    apply();
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  apply();
}
bindContactMask(form.elements.phone, formatPhone);
bindContactMask(form.elements.taxId, formatTaxId);

function selected(name) { return form.elements.namedItem(name).value; }
function selections() {
  return {
    system: selected('system'), schedules: selected('schedules'), employees: selected('employees'),
    bankHours: selected('bankHours') === 'yes', workScale: selected('workScale') === 'yes',
  };
}
function setText(selector, value) { document.querySelector(selector).textContent = value; }
function quantityLabel(value, upper) {
  return value === 'consultar' ? `Mais de ${formatNumber(upper)}` : value ? `Até ${formatNumber(Number(value))}` : 'A selecionar';
}
function summaryField(id, value, complete) {
  const field = document.querySelector(id);
  field.textContent = value;
  field.classList.toggle('empty', !complete);
}
function updateCampaign(active) {
  for (const item of document.querySelectorAll('[data-deadline]')) item.textContent = CAMPAIGN.deadlineLabel;
  for (const item of document.querySelectorAll('[data-campaign-percent]')) item.textContent = `${CAMPAIGN.discountPercent}%`;
  const offer = document.querySelector('#offer-percent');
  if (active) {
    offer.replaceChildren(document.createTextNode(String(CAMPAIGN.discountPercent)));
    const percent = document.createElement('span'); percent.textContent = '%'; offer.append(percent);
  } else {
    document.querySelector('.offer-tag').textContent = 'CONFIGURAÇÃO PARA SUA EMPRESA';
    document.querySelector('.offer-value').hidden = true;
    document.querySelector('.campaign-card>p').textContent = 'A campanha de antecipação encerrou em ' + CAMPAIGN.deadlineLabel + '. Simule sua configuração com os valores atuais.';
  }
}
function renderSummary() {
  const state = selections();
  const system = SYSTEMS.find(item => item.id === state.system);
  document.querySelector('#scope-retire-schedules').hidden = !system || system.id === 'secullum-offline';
  summaryField('#summary-system', system?.name ?? 'A selecionar', Boolean(system));
  summaryField('#summary-schedules', quantityLabel(state.schedules, 100), Boolean(state.schedules));
  summaryField('#summary-employees', quantityLabel(state.employees, 1000), Boolean(state.employees));
  summaryField('#summary-bank', selected('bankHours') ? (state.bankHours ? 'Sim' : 'Não') : 'A informar', Boolean(selected('bankHours')));
  summaryField('#summary-scale', selected('workScale') ? (state.workScale ? 'Sim' : 'Não') : 'A informar', Boolean(selected('workScale')));
  const quote = calculateCustomerQuote(state);
  const answered = Boolean(selected('bankHours')) && Boolean(selected('workScale'));
  const ready = currentStep === 4 && answered && quote.status !== 'incomplete';
  document.querySelector('#quote-overview').hidden = !ready;
  document.querySelector('#quote-placeholder').hidden = ready;
  document.querySelector('#price-block').hidden = !ready || quote.status !== 'priced';
  document.querySelector('#custom-quote').hidden = !ready || quote.status !== 'consultation';
  document.querySelector('#edit-button').hidden = currentStep < 4;
  if (!ready) return;
  if (quote.status !== 'priced') {
    setText('#pix-price', 'Valor sob consulta');
    setText('#boleto-price', 'Em até 6 parcelas');
    setText('#card-price', 'Em 10 parcelas');
    setText('#pix-saving', 'Desconto calculado na proposta');
    setText('#payment-method-help', 'Informe sua preferência. Os valores e as condições serão confirmados na proposta.');
    return;
  }
  setText('#original-price', formatMoney(quote.totalBeforeDiscountCents));
  setText('#final-price', formatMoney(quote.cents));
  setText('#discount-label', `${CAMPAIGN.discountPercent}% de antecipação`);
  setText('#price-title', quote.discountApplied ? 'Valor com desconto' : 'Total da parametrização');
  setText('#price-saving', `Você economiza ${formatMoney(quote.discountCents)}`);
  for (const id of ['#price-before', '#discount-label', '#price-saving']) document.querySelector(id).hidden = !quote.discountApplied;
  setText('#price-condition', quote.discountApplied ? `Condição para aprovação até ${CAMPAIGN.deadlineLabel}. Enviar a solicitação não equivale à aprovação.` : 'A campanha de antecipação foi encerrada. O valor acima corresponde ao total sem o desconto da campanha.');
  const payments = paymentOptions(quote.cents);
  const installments = paymentDisplay(quote.cents);
  setText('#pix-price', formatMoney(payments.pixCents));
  setText('#pix-saving', `Economize mais ${formatMoney(quote.cents - payments.pixCents)} no Pix`);
  setText('#boleto-price', `6x de ${formatMoney(installments.boletoInstallmentCents)}`);
  setText('#card-price', `10x de ${formatMoney(installments.cardInstallmentCents)}`);
  setText('#payment-method-help', 'Parcelas com valores aproximados por arredondamento. As condições serão confirmadas na proposta.');
}
function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
  form.querySelectorAll('[aria-invalid]').forEach(item => item.removeAttribute('aria-invalid'));
}
function renderRequestPreview(request, receipt) {
  const rows = [
    ['Nome', request.contact.name],
    ['Empresa', request.contact.company],
    ['CPF / CNPJ', request.contact.taxId ? formatTaxId(request.contact.taxId) : 'Não informado'],
    ['E-mail', request.contact.email],
    ['Telefone / WhatsApp', formatPhone(request.contact.phone)],
    ['Pagamento desejado', request.payment.label],
  ];
  if (receipt && !receipt.demo) rows.unshift(['Protocolo', receipt.id, 'request-detail-wide']);
  document.querySelector('#request-preview-data').replaceChildren(...rows.map(([label, value, className]) => {
    const row = document.createElement('div');
    if (className) row.className = className;
    const title = document.createElement('dt');
    const description = document.createElement('dd');
    title.textContent = label;
    description.textContent = value;
    row.append(title, description);
    return row;
  }));
}
function fail(message, target) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  if (target) { target.setAttribute('aria-invalid', 'true'); target.focus(); }
  return false;
}
function stepIssue(step) {
  const issue = (message, target) => ({message, target});
  if (step === 1 && !SYSTEMS.some(item => item.id === selected('system'))) {
    return issue('Selecione o sistema de ponto da sua empresa para continuar.', form.querySelector('[name="system"]'));
  }
  if (step === 2) {
    if (!selected('schedules')) return issue('Selecione o pacote de horários que deseja cadastrar.', form.elements.schedules);
    if (!selected('employees')) return issue('Selecione o pacote de funcionários que deseja reagendar.', form.elements.employees);
  }
  if (step === 3) {
    if (!selected('bankHours')) return issue('Informe se sua empresa utiliza banco de horas.', form.querySelector('[name="bankHours"]'));
    if (!selected('workScale')) return issue('Informe se sua empresa possui escalas cíclicas ou mensais.', form.querySelector('[name="workScale"]'));
  }
  if (step === 4) {
    const name = form.elements.contactName;
    const company = form.elements.company;
    const email = form.elements.email;
    const phone = form.elements.phone;
    if (name.value.trim().length < 2) return issue('Informe seu nome para continuar.', name);
    if (company.value.trim().length < 2) return issue('Informe o nome da sua empresa.', company);
    if (!email.value.trim() || !email.validity.valid) return issue('Informe um endereço de e-mail válido.', email);
    const digits = phone.value.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return issue('Informe um telefone com DDD, incluindo o código do país se necessário.', phone);
    if (!PAYMENT_METHODS.some(method => method.id === selected('paymentMethod'))) return issue('Selecione a forma de pagamento desejada.', form.querySelector('[name="paymentMethod"]'));
    const permission = document.querySelector('#contact-permission');
    if (!permission.checked) return issue('Marque a autorização de contato para continuar.', permission);
  }
  return null;
}
function releasedStep() {
  for (let step = 1; step < furthestStep; step++) {
    if (stepIssue(step)) return step;
  }
  return furthestStep;
}
function renderSteps() {
  const released = releasedStep();
  const finished = !success.hidden;
  steps.forEach((item, index) => {
    const number = index + 1;
    const button = item.querySelector('button');
    const current = !finished && number === currentStep;
    const complete = finished || (!current && number < furthestStep && number <= released && !stepIssue(number));
    button.disabled = submitting || number > released;
    item.classList.toggle('current', current);
    item.classList.toggle('complete', complete);
    item.classList.toggle('available', !button.disabled && !current);
    if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    item.querySelector('.step-circle').textContent = complete ? '✓' : String(number);
    item.querySelector('.step-state').textContent = current ? 'Etapa atual' : button.disabled ? 'Preencha as etapas anteriores para acessar' : complete ? 'Concluída. Clique para revisar' : 'Disponível para revisão';
  });
  document.querySelector('#step-navigation-help').hidden = furthestStep === 1;
}
function showStep(step, focus = true) {
  if (submitting) return;
  currentStep = step;
  furthestStep = Math.max(furthestStep, step);
  clearError();
  success.hidden = true;
  document.querySelector('#request-preview-data').replaceChildren();
  formPanel.hidden = false;
  document.querySelector('.wizard-grid').classList.toggle('review-step', step === 4);
  panels.forEach(panel => { panel.hidden = Number(panel.dataset.step) !== step; });
  renderSteps();
  setText('#progress-caption', `Etapa ${step} de 4`);
  back.hidden = step === 1;
  document.querySelector('.wizard-actions').classList.toggle('has-back', step > 1);
  next.firstChild.textContent = step === 4 ? 'Solicitar proposta ' : 'Continuar ';
  setText('#step-footnote', step === 4 ? (connected ? 'Seus dados serão enviados à equipe Realponto.' : 'Envio demonstrativo nesta prévia.') : 'Você pode revisar suas escolhas antes de enviar.');
  renderSummary();
  if (focus) {
    document.querySelector(`#step-${step}-title`).focus({preventScroll: true});
    document.querySelector('.wizard-top').scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  clearError();
  for (let step = 1; step <= currentStep; step++) {
    const issue = stepIssue(step);
    if (issue) {
      if (step !== currentStep) showStep(step);
      fail(issue.message, issue.target);
      return;
    }
  }
  if (currentStep < 4) { showStep(currentStep + 1); return; }
  // Contato, documento, configuração e pagamento seguem na mesma solicitação.
  try {
    const request = buildCustomerRequest({
      ...selections(),
      contactName: selected('contactName'), company: selected('company'),
      email: selected('email'), phone: selected('phone'),
      taxId: selected('taxId'), paymentMethod: selected('paymentMethod'),
      contactPermission: document.querySelector('#contact-permission').checked,
    });
    if (transportError) throw transportError;
    setSubmitting(true);
    const receipt = await transport.submit(request);
    renderRequestPreview(request, receipt);
  } catch (error) {
    fail(error.message || 'Confira os dados da solicitação.', form.querySelector(`[name="${CSS.escape(error.field || '')}"]`));
    return;
  } finally {
    if (submitting) setSubmitting(false);
  }
  formPanel.hidden = true;
  success.hidden = false;
  setText('#progress-caption', connected ? 'Solicitação recebida' : 'Prévia concluída');
  renderSteps();
  // O modo conectado só chega aqui após a confirmação do registro pelo servidor.
  document.querySelector('#success-title').focus();
});
form.addEventListener('change', () => { clearError(); renderSummary(); renderSteps(); });
form.addEventListener('input', renderSteps);
steps.forEach((item, index) => item.querySelector('button').addEventListener('click', () => {
  const targetStep = index + 1;
  if (targetStep <= releasedStep() && (targetStep !== currentStep || !success.hidden)) showStep(targetStep);
}));
back.addEventListener('click', () => showStep(Math.max(1, currentStep - 1)));
document.querySelector('#edit-button').addEventListener('click', () => showStep(1));
document.querySelector('#restart-button').addEventListener('click', () => showStep(1));
const campaign = calculateCustomerQuote({system:'rhid', schedules:10, employees:20});
updateCampaign(campaign.campaignActive);
showStep(1, false);
