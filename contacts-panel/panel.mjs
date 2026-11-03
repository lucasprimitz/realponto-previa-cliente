import {safeText, amount, receivedDate, quantity, formatPhone, formatTaxId, systemLabel, selectedPayment, buildRequestText} from './panel-model.mjs';
const $ = selector => document.querySelector(selector);
const list = $('#requests-list');
const loginPanel = $('#login-panel');
const workspace = $('#workspace');
const logoutButton = $('#logout');
const loginForm = $('#login-form');
const loginButton = $('#login-button');
const password = $('#password');
const message = $('#status-message');
const filter = $('#status-filter');
const refreshButton = $('#refresh');
const previousButton = $('#previous-page');
const nextButton = $('#next-page');
const state = {authenticated: false, csrfToken: '', page: 1, totalPages: 1, busy: false, generation: 0, lastActivity: 0, view: 'requests'};
const idleMilliseconds = 15 * 60 * 1000;
let idleTimer;
let apiBase;
let requestCardSequence = 0;

function notice(text = '', kind = '') {
  message.textContent = text;
  message.className = 'notice' + (kind ? ' ' + kind : '');
  message.hidden = !text;
}
function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}
function controlsBusy(busy) {
  state.busy = busy;
  loginButton.disabled = busy;
  refreshButton.disabled = busy;
  filter.disabled = busy;
  $('#refresh-reports').disabled = busy;
  $('#report-year').disabled = busy;
  for (const tab of document.querySelectorAll('.workspace-tab')) tab.disabled = busy;
  previousButton.disabled = busy || state.page <= 1;
  nextButton.disabled = busy || state.page >= state.totalPages;
  workspace.setAttribute('aria-busy', String(busy));
  list.classList.toggle('loading-list', busy);
}
function clearPrivateView() {
  state.generation++;
  state.authenticated = false;
  state.lastActivity = 0;
  clearTimeout(idleTimer);
  list.replaceChildren();
  $('#report-metrics').replaceChildren();
  $('#report-rows').replaceChildren();
  $('#report-total').replaceChildren();
  $('#report-status').textContent = '';
  $('#report-table-wrap').hidden = true;
  $('#copy-text').value = '';
  if ($('#copy-dialog').open) $('#copy-dialog').close();
  password.value = '';
  $('#request-count').textContent = '0';
  $('#list-status').textContent = '';
  $('#delivery-notice').textContent = '';
  $('#delivery-notice').hidden = true;
  $('#pagination').hidden = true;
  $('#empty-list').hidden = true;
  workspace.hidden = true;
  loginPanel.hidden = false;
  logoutButton.hidden = true;
  controlsBusy(false);
}
function addDetail(dl, title, value, className = '') {
  const row = document.createElement('div');
  if (className === 'wide') row.className = 'wide';
  row.append(textElement('dt', '', title), textElement('dd', className === 'wide' ? '' : className, value));
  dl.append(row);
}
function section(title) {
  const container = textElement('section', 'detail-section', '');
  const dl = textElement('dl', 'detail-list', '');
  container.append(textElement('h3', '', title), dl);
  return {container, dl};
}
function displayDelivery(status) {
  return ({sent: 'Cópia entregue ao serviço de e-mail.', pending: 'Cópia por e-mail na fila de envio.', failed: 'O envio da cópia precisa de verificação pela TI.', disabled: 'Cópia por e-mail ainda não configurada.'})[status] ?? 'Situação do e-mail não disponível.';
}
async function api(path, options = {}) {
  if (!apiBase) throw new Error('Esta área precisa ser configurada pela TI antes de receber acessos.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const method = options.method ?? 'GET';
  try {
    const response = await fetch(new URL(path, apiBase), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {'Accept': 'application/json', ...(method === 'GET' ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken})},
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok === false) {
      const error = new Error(typeof data?.message === 'string' ? data.message : 'Não foi possível concluir. Tente novamente ou fale com a TI.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.status) throw error;
    throw new Error('Não foi possível conectar à área de solicitações. Verifique a conexão e a configuração com a TI.');
  } finally { clearTimeout(timeout); }
}
function expired(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  clearPrivateView();
  state.csrfToken = '';
  notice('Seu acesso expirou. Entre novamente para continuar.', 'error');
  void refreshSession();
  return true;
}
function recordActivity() {
  if (!state.authenticated) return;
  state.lastActivity = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void logout(true); }, idleMilliseconds);
}
function renderItem(item) {
  const request = item.request ?? {};
  const contact = request.contact ?? {};
  const configuration = request.configuration ?? {};
  const estimate = request.estimate ?? {};
  const payment = selectedPayment(item);
  const card = textElement('article', 'request-card', '');
  const front = textElement('div', 'request-face request-front', '');
  const back = textElement('div', 'request-face request-back', '');
  back.id = 'request-details-' + (++requestCardSequence);
  back.inert = true;
  back.setAttribute('aria-hidden', 'true');
  const top = textElement('div', 'request-top', '');
  const heading = textElement('div', 'request-heading', '');
  const headingTitle = textElement('h2', '', safeText(contact.company, 'Solicitação de proposta'));
  const meta = textElement('p', 'request-meta', receivedDate(item.receivedAt));
  heading.append(headingTitle, meta);
  const actions = textElement('div', 'request-actions', '');
  const badge = textElement('span', 'pill' + (item.handled ? ' handled' : ''), item.handled ? 'Encaminhada' : 'Pendente');
  const copy = textElement('button', 'button copy-button', 'Copiar solicitação');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copiar todas as informações de ' + safeText(contact.company, 'esta solicitação'));
  const copyStatus = textElement('p', 'copy-status', '');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  copyStatus.hidden = true;
  copy.addEventListener('click', async () => {
    if (!state.authenticated) return;
    const text = buildRequestText(item);
    const generation = state.generation;
    copy.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (generation !== state.generation || !state.authenticated) return;
      copyStatus.textContent = 'Resumo completo copiado. Pronto para colar.';
      copyStatus.className = 'copy-status';
      copyStatus.hidden = false;
      recordActivity();
    } catch {
      if (generation !== state.generation || !state.authenticated) return;
      $('#copy-text').value = text;
      $('#copy-dialog').showModal();
      $('#copy-text').focus();
      $('#copy-text').select();
      copyStatus.textContent = 'Use o texto aberto para copiar a solicitação.';
      copyStatus.hidden = false;
    } finally { copy.disabled = false; }
  });
  actions.append(badge, copy);
  top.append(heading, actions);
  const body = textElement('div', 'request-body', '');
  const investment = textElement('section', 'investment-card', '');
  investment.append(textElement('span', 'investment-label', 'FORMA DE PAGAMENTO ESCOLHIDA'));
  investment.append(textElement('h3', '', payment.label));
  investment.append(textElement('p', 'investment-value', payment.value));
  investment.append(textElement('p', 'investment-caption', payment.caption));
  if (Number.isSafeInteger(payment.totalCents) && request.payment?.method !== 'pix') {
    const total = textElement('p', 'investment-total', '');
    total.append(textElement('span', '', 'Total estimado'), textElement('strong', '', amount(payment.totalCents)));
    investment.append(total);
  }
  const person = section('Contato');
  addDetail(person.dl, 'Nome', safeText(contact.name));
  addDetail(person.dl, 'Telefone / WhatsApp', formatPhone(contact.phone) || 'Não informado');
  addDetail(person.dl, 'E-mail', safeText(contact.email), contact.taxId ? '' : 'wide');
  if (contact.taxId) addDetail(person.dl, 'CPF / CNPJ', formatTaxId(contact.taxId));
  const showDetails = textElement('button', 'request-details-button', 'Ver configuração e valores');
  showDetails.type = 'button';
  showDetails.setAttribute('aria-controls', back.id);
  showDetails.setAttribute('aria-expanded', 'false');
  const backTop = textElement('div', 'request-back-top', '');
  const returnButton = textElement('button', 'button secondary return-button', 'Voltar à solicitação');
  returnButton.type = 'button';
  backTop.append(returnButton, textElement('h3', '', 'Configuração e valores'), textElement('p', '', safeText(contact.company, 'Solicitação de proposta')));
  const details = textElement('div', 'request-back-content', '');
  details.tabIndex = 0;
  details.setAttribute('role', 'region');
  details.setAttribute('aria-label', 'Detalhes da configuração e valores');
  const scope = section('Configuração solicitada');
  addDetail(scope.dl, 'Sistema', systemLabel(configuration.system));
  addDetail(scope.dl, 'Horários a cadastrar', quantity(configuration.schedules, 100));
  addDetail(scope.dl, 'Funcionários a reagendar', quantity(configuration.employees, 1000));
  addDetail(scope.dl, 'Banco de horas', configuration.bankHours === true ? 'Sim' : 'Não');
  addDetail(scope.dl, 'Escalas', configuration.workScale === true ? 'Sim' : 'Não');
  addDetail(scope.dl, 'Inativação dos horários antigos', configuration.system === 'secullum-offline' ? 'Não contemplada no Secullum Offline' : 'Incluída', 'wide');
  const values = section('Estimativa e opções de pagamento');
  addDetail(values.dl, estimate.campaignDiscountApplied ? 'Total com a campanha' : 'Total da parametrização', amount(estimate.totalCents));
  if (estimate.campaignDiscountApplied) {
    addDetail(values.dl, 'Total sem a campanha', amount(estimate.totalBeforeDiscountCents));
    addDetail(values.dl, 'Economia da campanha', amount(estimate.discountCents));
  }
  addDetail(values.dl, 'Pix', amount(estimate.pixCents));
  addDetail(values.dl, 'Boleto · sob consulta', Number.isSafeInteger(estimate.boletoInstallmentCents) ? '6x de ' + amount(estimate.boletoInstallmentCents) : 'Valor sob consulta');
  addDetail(values.dl, 'Cartão · sem juros', Number.isSafeInteger(estimate.cardInstallmentCents) ? '10x de ' + amount(estimate.cardInstallmentCents) : 'Valor sob consulta');
  details.append(scope.container, values.container, textElement('p', 'request-id', 'Protocolo: ' + safeText(item.id, '—')));
  back.append(backTop, details);
  function flipCard(flipped) {
    card.classList.toggle('is-flipped', flipped);
    showDetails.setAttribute('aria-expanded', String(flipped));
    const activeFace = flipped ? back : front;
    const inactiveFace = flipped ? front : back;
    activeFace.inert = false;
    activeFace.removeAttribute('aria-hidden');
    (flipped ? returnButton : showDetails).focus({preventScroll: true});
    inactiveFace.inert = true;
    inactiveFace.setAttribute('aria-hidden', 'true');
    recordActivity();
  }
  showDetails.addEventListener('click', () => flipCard(true));
  returnButton.addEventListener('click', () => flipCard(false));
  back.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); flipCard(false); }
  });
  body.append(investment, person.container, showDetails, copyStatus);
  const delivery = textElement('p', '', '');
  function updateDelivery() {
    delivery.className = 'delivery-state ' + (item.mailStatus === 'sent' ? 'sent' : 'not-sent');
    delivery.textContent = displayDelivery(item.mailStatus);
  }
  updateDelivery();
  body.append(delivery);
  const edit = textElement('form', 'request-edit', '');
  const handledLabel = textElement('label', 'handled-label', '');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.handled === true;
  handledLabel.append(checkbox, document.createTextNode('Encaminhado'));
  const noteGroup = textElement('label', 'note-group', '');
  const note = document.createElement('input'); note.type = 'text'; note.maxLength = 160; note.autocomplete = 'off'; note.value = typeof item.note === 'string' ? item.note : ''; note.placeholder = 'Ex.: Direcionado para Ana';
  noteGroup.append(textElement('span', 'note-label', 'Responsável / observação'), note);
  const save = textElement('button', 'button primary', 'Salvar'); save.type = 'submit';
  const saveMessage = textElement('p', 'save-message', ''); saveMessage.setAttribute('role', 'status'); saveMessage.setAttribute('aria-live', 'polite'); saveMessage.hidden = true;
  edit.append(handledLabel, noteGroup, save, saveMessage);
  edit.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || !state.authenticated) return;
    save.disabled = true; checkbox.disabled = true; note.disabled = true;
    save.textContent = 'Salvando…'; saveMessage.hidden = true;
    const generation = state.generation;
    try {
      const result = await api('request-update.php', {method: 'POST', body: {id: item.id, handled: checkbox.checked, note: note.value.trim(), version: item.version}});
      if (generation !== state.generation || !state.authenticated) return;
      item = result.item;
      if (!item || !Number.isSafeInteger(item.version)) throw new Error('Não foi possível confirmar a atualização. Atualize a lista.');
      badge.className = 'pill' + (item.handled ? ' handled' : ''); badge.textContent = item.handled ? 'Encaminhada' : 'Pendente';
      checkbox.checked = item.handled === true; note.value = item.note ?? '';
      updateDelivery();
      saveMessage.textContent = 'Encaminhamento salvo.'; saveMessage.className = 'save-message'; saveMessage.hidden = false;
      recordActivity();
    } catch (error) {
      if (generation !== state.generation || expired(error)) return;
      saveMessage.textContent = error.status === 409 ? 'Outra pessoa alterou esta solicitação. Atualize a lista antes de salvar novamente.' : error.message;
      saveMessage.className = 'save-message error'; saveMessage.hidden = false;
    } finally {
      save.disabled = false; checkbox.disabled = false; note.disabled = false; save.textContent = 'Salvar';
    }
  });
  front.append(top, body, edit);
  card.append(front, back);
  return card;
}
async function loadRequests(page = state.page) {
  if (!state.authenticated || state.busy) return;
  controlsBusy(true);
  $('#list-status').textContent = 'Carregando solicitações…';
  const generation = ++state.generation;
  try {
    const result = await api('requests.php?page=' + page + '&status=' + encodeURIComponent(filter.value));
    if (generation !== state.generation || !state.authenticated) return;
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new Error('Não foi possível carregar a lista. Fale com a TI.');
    state.page = Number.isSafeInteger(result.page) ? result.page : page;
    state.totalPages = Math.max(1, Number.isSafeInteger(result.totalPages) ? result.totalPages : 1);
    list.replaceChildren(...result.items.map(renderItem));
    $('#request-count').textContent = new Intl.NumberFormat('pt-BR').format(result.total);
    $('#empty-list').hidden = result.items.length > 0;
    $('#pagination').hidden = state.totalPages <= 1;
    $('#page-indicator').textContent = 'Página ' + state.page + ' de ' + state.totalPages;
    $('#list-status').textContent = result.items.length ? result.items.length + (result.items.length === 1 ? ' solicitação exibida.' : ' solicitações exibidas.') : '';
    notice();
    recordActivity();
  } catch (error) {
    if (generation !== state.generation || expired(error)) return;
    $('#list-status').textContent = '';
    notice(error.message, 'error');
  } finally { controlsBusy(false); }
}
function setView(view) {
  state.view = view;
  const reports = view === 'reports';
  $('#requests-view').hidden = reports;
  $('#reports-view').hidden = !reports;
  for (const name of ['requests', 'reports']) {
    const tab = $('#' + name + '-tab');
    tab.setAttribute('aria-selected', String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
  }
  $('#page-title').textContent = reports ? 'Relatórios mensais' : 'Solicitações recebidas';
  document.querySelector('.page-heading > div > p').textContent = reports ? 'Veja o movimento dos contatos e os valores estimados ao longo do ano.' : 'Organize os contatos, confira o investimento e encaminhe cada solicitação.';
  document.querySelector('.count-badge').hidden = reports;
}
async function loadActiveView(reset = false) {
  if (state.view === 'reports') return loadReports();
  return loadRequests(reset ? 1 : state.page);
}
function validMetrics(row) {
  return row && ['count', 'pricedCount', 'consultationCount', 'totalCents', 'handledCount'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0);
}
function reportMetric(label, value, description, accent = false) {
  const box = textElement('article', 'report-metric' + (accent ? ' accent' : ''), '');
  box.append(textElement('h3', '', label), textElement('strong', '', value), textElement('p', '', description));
  return box;
}
function renderReport(result) {
  if (!Number.isInteger(result.year) || !Array.isArray(result.months) || result.months.length !== 12 || !validMetrics(result.total) || result.months.some((row, index) => !validMetrics(row) || row.month !== result.year + '-' + String(index + 1).padStart(2, '0'))) throw new Error('Não foi possível conferir o relatório. Atualize e tente novamente.');
  const total = result.total;
  const number = value => new Intl.NumberFormat('pt-BR').format(value);
  const average = total.pricedCount ? amount(Math.round(total.totalCents / total.pricedCount)) : '—';
  $('#report-metrics').replaceChildren(
    reportMetric('Solicitações em ' + result.year, number(total.count), 'Todos os contatos recebidos no ano.'),
    reportMetric('Valor estimado no ano', amount(total.totalCents), number(total.pricedCount) + ' solicitações com valor definido.', true),
    reportMetric('Ticket médio estimado', average, 'Média das solicitações com valor definido.'),
    reportMetric('Sob consulta', number(total.consultationCount), 'Aguardam definição do valor da proposta.')
  );
  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const current = new Intl.DateTimeFormat('en-CA', {year: 'numeric', month: '2-digit', timeZone: 'America/Sao_Paulo'}).formatToParts(new Date());
  const currentMonth = current.find(part => part.type === 'year').value + '-' + current.find(part => part.type === 'month').value;
  const rows = result.months.map((month, index) => {
    const row = textElement('tr', month.month === currentMonth ? 'current-month' : '', '');
    const label = textElement('th', '', monthNames[index]); label.scope = 'row';
    if (month.month === currentMonth) label.append(textElement('span', 'current-label', 'Mês atual'));
    row.append(label, ...[number(month.count), number(month.handledCount), number(month.consultationCount), amount(month.totalCents)].map((value, column) => textElement('td', column === 3 ? 'report-amount' : '', value)));
    return row;
  });
  $('#report-rows').replaceChildren(...rows);
  const totalRow = textElement('tr', '', '');
  const totalLabel = textElement('th', '', 'Total do ano'); totalLabel.scope = 'row';
  totalRow.append(totalLabel, ...[number(total.count), number(total.handledCount), number(total.consultationCount), amount(total.totalCents)].map(value => textElement('td', '', value)));
  $('#report-total').replaceChildren(totalRow);
  $('#report-caption').textContent = 'Solicitações recebidas por mês · ' + result.year;
  $('#report-table-wrap').hidden = false;
  $('#report-status').textContent = total.count ? 'Relatório atualizado. Todas as solicitações do ano estão incluídas, independentemente do filtro da lista.' : 'Nenhuma solicitação recebida neste ano.';
}
async function loadReports() {
  if (!state.authenticated || state.busy) return;
  const year = Number($('#report-year').value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) { notice('Informe um ano entre 2000 e 2100.', 'error'); $('#report-year').focus(); return; }
  controlsBusy(true);
  $('#report-metrics').replaceChildren();
  $('#report-table-wrap').hidden = true;
  $('#report-status').textContent = 'Carregando relatório de ' + year + '…';
  const generation = ++state.generation;
  try {
    const result = await api('reports.php?year=' + year);
    if (generation !== state.generation || !state.authenticated) return;
    if (result.year !== year) throw new Error('O ano retornado não corresponde ao selecionado. Atualize o relatório.');
    renderReport(result);
    notice(); recordActivity();
  } catch (error) {
    if (generation !== state.generation || expired(error)) return;
    $('#report-status').textContent = 'Não foi possível atualizar o relatório.';
    notice(error.message, 'error');
  } finally { controlsBusy(false); }
}
function applySession(data) {
  if (typeof data.csrfToken !== 'string' || data.csrfToken.length < 16) throw new Error('A área de solicitações ainda precisa ser configurada pela TI.');
  state.csrfToken = data.csrfToken;
  state.authenticated = data.authenticated === true;
  loginPanel.hidden = state.authenticated;
  workspace.hidden = !state.authenticated;
  logoutButton.hidden = !state.authenticated;
  const deliveryNotice = $('#delivery-notice');
  const notices = [];
  if (!data.mailConfigured) notices.push('O recebimento por e-mail ainda precisa ser configurado pela TI. As solicitações ficam registradas neste painel.');
  if (!data.submissionEnabled) notices.push('O recebimento de novas solicitações ainda não está ativado.');
  deliveryNotice.textContent = notices.join(' ');
  deliveryNotice.hidden = !state.authenticated || !notices.length;
  if (state.authenticated) recordActivity();
}
async function refreshSession(load = true) {
  const generation = state.generation;
  try {
    const result = await api('session.php');
    if (generation !== state.generation) return;
    applySession(result);
    if (load && state.authenticated) await loadActiveView(true);
    else if (load) notice();
  } catch (error) {
    if (generation !== state.generation) return;
    clearPrivateView();
    state.csrfToken = '';
    notice(error.message, 'error');
    loginButton.disabled = true;
  }
}
async function logout(automatic = false) {
  clearPrivateView();
  controlsBusy(true);
  try {
    await api('logout.php', {method: 'POST', body: {}});
    state.csrfToken = '';
    await refreshSession(false);
    notice(automatic ? 'Sua sessão foi encerrada por inatividade. Entre novamente para continuar.' : 'Você saiu da área de solicitações.');
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      state.csrfToken = '';
      await refreshSession(false);
      notice('Entre novamente para acessar as solicitações.');
    } else {
      logoutButton.hidden = false;
      notice('Os dados foram ocultados, mas não foi possível confirmar a saída. Use Sair novamente quando a conexão voltar.', 'error');
    }
  } finally { controlsBusy(false); }
}
loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !password.value || !state.csrfToken) return;
  controlsBusy(true); notice(); loginButton.textContent = 'Verificando…';
  try {
    const result = await api('login.php', {method: 'POST', body: {password: password.value}});
    password.value = '';
    applySession(result);
    if (!state.authenticated) throw new Error('Não foi possível acessar. Confira a senha e tente novamente.');
    controlsBusy(false);
    await loadActiveView(true);
    $('#page-title').focus();
  } catch (error) {
    password.value = '';
    clearPrivateView();
    notice(error.message, 'error');
    if (error.status === 403) await refreshSession(false);
    password.focus();
  } finally { controlsBusy(false); loginButton.textContent = 'Entrar nas solicitações →'; }
});
$('#report-year').value = new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'America/Sao_Paulo'}).format(new Date());
for (const view of ['requests', 'reports']) {
  const tab = $('#' + view + '-tab');
  tab.addEventListener('click', () => {
    if (state.busy || !state.authenticated || state.view === view) return;
    setView(view); notice(); void loadActiveView();
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.busy) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'requests' : event.key === 'End' ? 'reports' : view === 'requests' ? 'reports' : 'requests';
    $('#' + next + '-tab').click(); $('#' + next + '-tab').focus();
  });
}
$('#refresh-reports').addEventListener('click', () => { void loadReports(); });
$('#report-year').addEventListener('change', () => { void loadReports(); });
$('#report-year').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void loadReports(); } });
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());
$('#copy-dialog').addEventListener('close', () => { $('#copy-text').value = ''; });
logoutButton.addEventListener('click', () => { void logout(); });
filter.addEventListener('change', () => { void loadRequests(1); });
refreshButton.addEventListener('click', () => { void loadRequests(); });
previousButton.addEventListener('click', () => { if (state.page > 1) void loadRequests(state.page - 1); });
nextButton.addEventListener('click', () => { if (state.page < state.totalPages) void loadRequests(state.page + 1); });
for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, recordActivity, {passive: true});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.authenticated) return;
  if (Date.now() - state.lastActivity >= idleMilliseconds) { void logout(true); return; }
  const generation = state.generation;
  void api('session.php').then(data => {
    if (generation !== state.generation) return;
    if (data.authenticated !== true) { clearPrivateView(); state.csrfToken = data.csrfToken ?? ''; notice('Seu acesso expirou. Entre novamente para continuar.'); }
  }).catch(error => { if (generation !== state.generation) return; if (!expired(error)) { clearPrivateView(); notice('Confirme seu acesso novamente para consultar as solicitações.', 'error'); void refreshSession(false); } });
});
window.addEventListener('pagehide', clearPrivateView);
window.addEventListener('pageshow', event => { if (event.persisted) { clearPrivateView(); void refreshSession(); } });
try {
  apiBase = new URL(document.querySelector('meta[name="realponto-api-base"]')?.content || '../api/', location.href);
  if (apiBase.origin !== location.origin || apiBase.username || apiBase.password || apiBase.search || apiBase.hash || !/^https?:$/.test(apiBase.protocol)) throw new Error('Endereço de acesso inválido.');
  if (!apiBase.pathname.endsWith('/')) apiBase.pathname += '/';
  void refreshSession();
} catch {
  apiBase = null;
  clearPrivateView();
  notice('Esta área precisa ser configurada pela TI antes de receber acessos.', 'error');
  loginButton.disabled = true;
}
