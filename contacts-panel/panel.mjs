import {safeText, amount, receivedDate, quantity, formatPhone, formatTaxId, systemLabel, selectedPayment, buildRequestText, PAYMENTS, installmentExample} from './panel-model.mjs';
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
filter.value = 'all';
const refreshButton = $('#refresh');
const previousButton = $('#previous-page');
const nextButton = $('#next-page');
const state = {authenticated: false, csrfToken: '', page: 1, totalPages: 1, busy: false, generation: 0, lastActivity: 0, view: 'requests'};
const activityPagination = {page: 1, totalPages: 1};
const activityMonth = $('#activity-month');
const dailyViewToggle = $('#calendar-chart-toggle');
let dailyFlip = null;
const monthFormat = new Intl.DateTimeFormat('pt-BR', {year: 'numeric', month: 'long', timeZone: 'UTC'});
const views = {
  requests: ['Solicitações recebidas', 'Organize os contatos, confira o investimento e encaminhe cada solicitação.'],
  activity: ['Atividade do simulador', 'Consulte as visitas e acompanhe as simulações em aberto no mês.'],
  reports: ['Relatórios mensais', 'Veja o movimento dos contatos e os valores estimados ao longo do ano.'],
};
const viewNames = Object.keys(views);
const idleMilliseconds = 15 * 60 * 1000;
let idleTimer;
let apiBase;
let requestCardSequence = 0;
let archiveSelection = null;

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
  $('#refresh-activity').disabled = busy;
  activityMonth.disabled = busy || !activityMonth.options.length;
  $('#activity-previous').disabled = busy || activityPagination.page <= 1;
  $('#activity-next').disabled = busy || activityPagination.page >= activityPagination.totalPages;
  $('#refresh-reports').disabled = busy;
  $('#report-year').disabled = busy;
  for (const tab of document.querySelectorAll('.workspace-tab')) {
    tab.setAttribute('aria-disabled', String(busy));
  }
  previousButton.disabled = busy || state.page <= 1;
  nextButton.disabled = busy || state.page >= state.totalPages;
  workspace.setAttribute('aria-busy', String(busy));
  list.classList.toggle('loading-list', busy);
}
function clearPrivateView() {
  state.generation++;
  state.authenticated = false;
  state.lastActivity = 0;
  filter.value = 'all';
  clearTimeout(idleTimer);
  list.replaceChildren();
  activityMonth.replaceChildren();
  clearSimulationActivity();
  setActivityMode('calendar');
  $('#report-metrics').replaceChildren();
  $('#report-rows').replaceChildren();
  $('#report-total').replaceChildren();
  $('#report-status').textContent = '';
  $('#report-table-wrap').hidden = true;
  $('#copy-text').value = '';
  if ($('#copy-dialog').open) $('#copy-dialog').close();
  archiveSelection = null;
  if ($('#archive-dialog').open) $('#archive-dialog').close();
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
  const titleRow = textElement('div', 'request-title-row', '');
  const headingTitle = textElement('h2', '', safeText(contact.company));
  const protocol = textElement('p', 'request-id', 'Protocolo: ' + safeText(item.id));
  titleRow.append(headingTitle, protocol);
  const meta = textElement('p', 'request-meta', receivedDate(item.receivedAt));
  heading.append(titleRow, meta);
  const actions = textElement('div', 'request-actions', '');
  const badge = textElement('span', 'pill' + (item.archived ? ' inactive' : item.handled ? ' handled' : ''), item.archived ? 'Inativa' : item.handled ? 'Encaminhada' : 'Pendente');
  const copy = textElement('button', 'button copy-button', 'Copiar solicitação');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copiar todas as informações de ' + safeText(contact.company, 'esta solicitação'));
  copy.addEventListener('click', async () => {
    if (!state.authenticated) return;
    const text = buildRequestText(item);
    const generation = state.generation;
    copy.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (generation !== state.generation || !state.authenticated) return;
      recordActivity();
    } catch {
      if (generation !== state.generation || !state.authenticated) return;
      $('#copy-text').value = text;
      $('#copy-dialog').showModal();
      $('#copy-text').focus();
      $('#copy-text').select();
    } finally { copy.disabled = false; }
  });
  const statuses = textElement('div', 'request-statuses', '');
  statuses.append(badge);
  actions.append(statuses, copy);
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
  addDetail(person.dl, 'E-mail', safeText(contact.email));
  addDetail(person.dl, 'CPF / CNPJ', safeText(formatTaxId(contact.taxId)));
  const showDetails = textElement('button', 'request-details-button', 'Ver configuração e valores');
  showDetails.type = 'button';
  showDetails.setAttribute('aria-controls', back.id);
  showDetails.setAttribute('aria-expanded', 'false');
  const backTop = textElement('div', 'request-back-top', '');
  const returnButton = textElement('button', 'button secondary return-button', 'Voltar à solicitação');
  returnButton.type = 'button';
  backTop.append(returnButton, textElement('h3', '', 'Configuração e valores'), textElement('p', '', safeText(contact.company)));
  const details = textElement('div', 'request-back-content', '');
  details.tabIndex = 0;
  details.setAttribute('role', 'region');
  details.setAttribute('aria-label', 'Detalhes da configuração e valores');
  const scope = section('Configuração solicitada');
  addDetail(scope.dl, 'Sistema', systemLabel(configuration.system));
  addDetail(scope.dl, 'Horários a cadastrar', quantity(configuration.schedules, 100));
  addDetail(scope.dl, 'Funcionários a reagendar', quantity(configuration.employees, 1000));
  addDetail(scope.dl, 'Banco de horas', typeof configuration.bankHours === 'boolean' ? (configuration.bankHours ? 'Sim' : 'Não') : 'Não informado');
  addDetail(scope.dl, 'Escalas', typeof configuration.workScale === 'boolean' ? (configuration.workScale ? 'Sim' : 'Não') : 'Não informado');
  addDetail(scope.dl, 'Inativação dos horários antigos', configuration.system === 'secullum-offline' ? 'Não contemplada no Secullum Offline' : ['secullum-rh', 'rhid', 'iponto'].includes(configuration.system) ? 'Incluída' : 'Não informado', 'wide');
  const values = section('Estimativa e opções de pagamento');
  addDetail(values.dl, estimate.campaignDiscountApplied ? 'Total com a campanha' : 'Total da parametrização', amount(estimate.totalCents));
  if (estimate.campaignDiscountApplied) {
    addDetail(values.dl, 'Total sem a campanha', amount(estimate.totalBeforeDiscountCents));
    addDetail(values.dl, 'Economia da campanha', amount(estimate.discountCents));
  }
  addDetail(values.dl, 'Pix', amount(estimate.pixCents));
  addDetail(values.dl, PAYMENTS.boleto, installmentExample(6, estimate.boletoInstallmentCents));
  addDetail(values.dl, PAYMENTS['credit-card'], installmentExample(10, estimate.cardInstallmentCents));
  details.append(scope.container, values.container);
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
  body.append(investment, person.container, showDetails);
  const delivery = textElement('span', '', '');
  function updateDelivery() {
    delivery.className = 'delivery-state ' + (item.mailStatus === 'sent' ? 'sent' : 'not-sent');
    delivery.textContent = ({sent: 'E-mail enviado', pending: 'E-mail na fila', failed: 'Falha no e-mail', disabled: 'E-mail não configurado'})[item.mailStatus] ?? 'E-mail não informado';
    delivery.title = displayDelivery(item.mailStatus);
    delivery.setAttribute('aria-label', displayDelivery(item.mailStatus));
  }
  updateDelivery();
  statuses.append(delivery);
  const edit = textElement('form', 'request-edit', '');
  const handledLabel = textElement('label', 'handled-label', '');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.handled === true;
  handledLabel.append(checkbox, document.createTextNode('Encaminhado'));
  const noteGroup = textElement('label', 'note-group', '');
  const note = document.createElement('input'); note.type = 'text'; note.maxLength = 160; note.autocomplete = 'off'; note.value = typeof item.note === 'string' ? item.note : ''; note.placeholder = 'Ex.: Direcionado para Ana';
  noteGroup.append(textElement('span', 'note-label', 'Responsável / observação'), note);
  const save = textElement('button', 'button primary', 'Salvar'); save.type = 'submit';
  const saveMessage = textElement('p', 'save-message', ''); saveMessage.setAttribute('role', 'status'); saveMessage.setAttribute('aria-live', 'polite'); saveMessage.hidden = true;
  const archiveButton = textElement('button', 'button archive-button' + (item.archived ? ' restore-button' : ''), item.archived ? 'Restaurar' : 'Inativar');
  archiveButton.type = 'button';
  archiveButton.setAttribute('aria-label', (item.archived ? 'Restaurar solicitação de ' : 'Inativar solicitação de ') + safeText(contact.company, 'esta empresa'));
  archiveButton.addEventListener('click', () => {
    if (save.disabled || state.busy || !state.authenticated) return;
    openArchiveDialog(item, archiveButton, checkbox.checked !== item.handled || note.value.trim() !== (item.note ?? ''));
  });
  const editActions = textElement('div', 'request-edit-actions', '');
  editActions.append(archiveButton, save);
  if (item.archived) {
    save.hidden = true;
    const archivedNote = textElement('p', 'archived-card-note', 'Fora dos relatórios. Restaure para retomar o atendimento.');
    edit.append(archivedNote, editActions);
  } else edit.append(handledLabel, noteGroup, editActions, saveMessage);
  edit.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || state.busy || item.archived || !state.authenticated) return;
    save.disabled = true; archiveButton.disabled = true; checkbox.disabled = true; note.disabled = true;
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
      save.disabled = false; archiveButton.disabled = false; checkbox.disabled = false; note.disabled = false; save.textContent = 'Salvar';
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
    let result = await api('requests.php?page=' + page + '&status=' + encodeURIComponent(filter.value));
    if (generation !== state.generation || !state.authenticated) return;
    if (Number.isSafeInteger(result.totalPages) && page > result.totalPages && result.totalPages > 0) {
      result = await api('requests.php?page=' + result.totalPages + '&status=' + encodeURIComponent(filter.value));
    }
    if (generation !== state.generation || !state.authenticated) return;
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new Error('Não foi possível carregar a lista. Fale com a TI.');
    state.page = Number.isSafeInteger(result.page) ? result.page : page;
    state.totalPages = Math.max(1, Number.isSafeInteger(result.totalPages) ? result.totalPages : 1);
    list.replaceChildren(...result.items.map(renderItem));
    $('#request-count').textContent = new Intl.NumberFormat('pt-BR').format(result.total);
    $('#empty-list').hidden = result.items.length > 0;
    $('#inactive-help').hidden = filter.value !== 'archived';
    $('#empty-list h2').textContent = filter.value === 'archived' ? 'Nenhuma solicitação inativa.' : 'Nenhuma solicitação por aqui.';
    $('#empty-list p').textContent = filter.value === 'archived' ? 'As solicitações inativadas aparecerão aqui e poderão ser restauradas.' : 'Os novos contatos aparecerão nesta área após o envio pelo formulário.';
    $('#pagination').hidden = state.totalPages <= 1;
    $('#page-indicator').textContent = 'Página ' + state.page + ' de ' + state.totalPages;
    $('#list-status').textContent = result.items.length ? result.items.length + (result.items.length === 1 ? ' solicitação exibida.' : ' solicitações exibidas.') : '';
    notice();
    recordActivity();
    return true;
  } catch (error) {
    if (generation !== state.generation || expired(error)) return false;
    $('#list-status').textContent = '';
    notice(error.message, 'error');
    return false;
  } finally { controlsBusy(false); }
}
function openArchiveDialog(item, trigger, unsaved) {
  const restoring = item.archived === true;
  archiveSelection = {id: item.id, version: item.version, archived: !restoring, trigger};
  $('#archive-title').textContent = restoring ? 'Restaurar solicitação?' : 'Inativar solicitação?';
  $('#archive-company').textContent = safeText(item.request?.contact?.company);
  $('#archive-description').textContent = restoring
    ? 'A solicitação voltará para a lista de atendimento e para as quantidades e valores dos relatórios, no mês em que foi recebida. Os dados e o encaminhamento serão preservados.'
    : 'Esta solicitação ficará fora da lista de atendimento e das quantidades e valores dos relatórios. Os dados serão preservados e você poderá restaurá-la pelo filtro Inativas.';
  $('#archive-unsaved').hidden = !unsaved;
  $('#archive-error').hidden = true;
  $('#confirm-archive').className = 'button ' + (restoring ? 'primary' : 'danger');
  $('#confirm-archive').textContent = restoring ? 'Restaurar solicitação' : 'Inativar solicitação';
  $('#archive-dialog').showModal();
  $('#cancel-archive').focus();
}
$('#cancel-archive').addEventListener('click', () => { if (!state.busy) $('#archive-dialog').close(); });
$('#archive-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
$('#archive-dialog').addEventListener('close', () => {
  const trigger = archiveSelection?.trigger;
  archiveSelection = null;
  $('#archive-company').textContent = '';
  $('#archive-error').textContent = '';
  if (state.authenticated && trigger?.isConnected) trigger.focus({preventScroll: true});
});
$('#confirm-archive').addEventListener('click', async () => {
  if (!archiveSelection || state.busy || !state.authenticated) return;
  const selection = archiveSelection;
  const generation = state.generation;
  controlsBusy(true);
  $('#confirm-archive').disabled = true;
  $('#cancel-archive').disabled = true;
  $('#archive-error').hidden = true;
  $('#confirm-archive').textContent = selection.archived ? 'Inativando…' : 'Restaurando…';
  try {
    const result = await api('request-archive.php', {method: 'POST', body: {id: selection.id, version: selection.version, archived: selection.archived}});
    if (generation !== state.generation || !state.authenticated) return;
    if (result.item?.archived !== selection.archived || result.item?.id !== selection.id) throw new Error('Não foi possível confirmar a alteração. Atualize a lista.');
    $('#archive-dialog').close();
    controlsBusy(false);
    list.replaceChildren();
    $('#request-count').textContent = '—';
    $('#pagination').hidden = true;
    const reloaded = await loadRequests();
    if (!state.authenticated) return;
    if (!reloaded) {
      notice((selection.archived ? 'Solicitação inativada.' : 'Solicitação restaurada.') + ' A alteração foi salva, mas não foi possível recarregar a lista. Clique em Atualizar lista.', 'error');
      refreshButton.focus({preventScroll: true});
      return;
    }
    notice(selection.archived ? 'Solicitação inativada. Ela não entra mais nos relatórios e pode ser restaurada no filtro Inativas.' : 'Solicitação restaurada. Ela voltou para a lista e para os relatórios.', 'success');
    filter.focus({preventScroll: true});
    recordActivity();
  } catch (error) {
    if (generation !== state.generation || expired(error)) return;
    if (error.status === 409) {
      $('#archive-dialog').close();
      controlsBusy(false);
      list.replaceChildren();
      $('#request-count').textContent = '—';
      $('#pagination').hidden = true;
      const reloaded = await loadRequests();
      if (state.authenticated) notice(reloaded ? 'Esta solicitação foi alterada por outra pessoa. A lista foi atualizada; confira o registro antes de tentar novamente.' : 'Esta solicitação foi alterada por outra pessoa. Não foi possível recarregar a lista; clique em Atualizar lista antes de tentar novamente.', 'error');
    } else {
      $('#archive-error').textContent = error.message;
      $('#archive-error').hidden = false;
    }
  } finally {
    controlsBusy(false);
    $('#confirm-archive').disabled = false;
    $('#cancel-archive').disabled = false;
    $('#confirm-archive').textContent = selection.archived ? 'Inativar solicitação' : 'Restaurar solicitação';
  }
});
function setView(view) {
  state.view = view;
  if (view === 'activity') setActivityMode('calendar');
  for (const name of viewNames) {
    const selected = name === view;
    const tab = $('#' + name + '-tab');
    $('#' + name + '-view').hidden = !selected;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const [title, description] = views[view];
  $('#page-title').textContent = title;
  document.querySelector('.page-heading > div > p').textContent = description;
  document.querySelector('.count-badge').hidden = view !== 'requests';
  const delivery = $('#delivery-notice');
  delivery.hidden = view === 'activity' || !delivery.textContent;
}
async function loadActiveView(reset = false) {
  if (state.view === 'reports') return loadReports();
  if (state.view === 'activity') return loadSimulationActivity(reset ? 1 : activityPagination.page);
  return loadRequests(reset ? 1 : state.page);
}
function clearSimulationActivity() {
  activityPagination.page = 1;
  activityPagination.totalPages = 1;
  $('#activity-status').textContent = '';
  $('#activity-page').textContent = '';
  $('#activity-empty').hidden = true;
  $('#activity-pagination').hidden = true;
  $('#activity-list').replaceChildren();
  $('#activity-metrics').replaceChildren();
  $('#activity-devices').hidden = true;
  $('#activity-mobile-total').textContent = '';
  $('#activity-desktop-total').textContent = '';
  $('#calendar-content').replaceChildren();
  dailyViewToggle.disabled = true;
  $('#traffic-content').replaceChildren();
}

const activitySteps = ['Seu sistema', 'Quantidades', 'Rotina de ponto', 'Sua proposta'];
const activityDevices = new Map([
  ['mobile', 'Celular'],
  ['desktop', 'Computador'],
  ['tablet', 'Tablet'],
  ['unknown', 'Não identificado'],
]);

function activityChoices(configuration, paymentMethod) {
  const details = textElement('dl', 'activity-details', '');
  if (configuration.system) addDetail(details, 'Sistema', systemLabel(configuration.system));
  if (configuration.schedules != null) addDetail(details, 'Horários', quantity(configuration.schedules, 100));
  if (configuration.employees != null) addDetail(details, 'Funcionários', quantity(configuration.employees, 1000));
  if (typeof configuration.bankHours === 'boolean') addDetail(details, 'Banco de horas', configuration.bankHours ? 'Sim' : 'Não');
  if (typeof configuration.workScale === 'boolean') addDetail(details, 'Escalas', configuration.workScale ? 'Sim' : 'Não');
  if (paymentMethod) {
    const label = selectedPayment({payment: {method: paymentMethod}}).label;
    addDetail(details, 'Pagamento', label);
  }
  return details;
}

function renderSimulation(item) {
  const row = textElement('li', 'activity-card', '');
  const configuration = item.configuration || {};
  const choices = activityChoices(configuration, item.paymentMethod);
  const hasChoices = choices.childElementCount > 0;
  const summary = textElement(hasChoices ? 'summary' : 'div', 'activity-summary', '');
  const title = configuration.system ? systemLabel(configuration.system) : 'Visita ao simulador';
  const meta = textElement('span', 'activity-access-meta', '');
  const device = activityDevices.get(item.device) ?? activityDevices.get('unknown');
  const region = typeof item.region === 'string' && item.region.trim() ? item.region : 'Não informada';
  for (const [field, label, value] of [
    ['activity-card-time', 'Data e hora', receivedDate(item.lastActivityAt)],
    ['activity-device', 'Origem', device],
    ['activity-region', 'Região aprox.', region],
  ]) {
    const group = textElement('span', field, '');
    if (meta.childElementCount) {
      const divider = textElement('span', 'activity-meta-divider', '|');
      divider.setAttribute('aria-hidden', 'true');
      group.append(divider);
    }
    group.append(label + ' ', textElement('strong', '', value));
    meta.append(group);
  }
  const heading = textElement('strong', 'activity-card-title', title);

  const step = 'Etapa ' + item.maxStep + ' de 4 · ' + activitySteps[item.maxStep - 1];
  const status = textElement('span', 'activity-status-pill', item.started ? 'Preenchimento iniciado' : 'Página visitada');
  if (item.maxStep === 4) {
    status.textContent = 'Não finalizado';
    status.classList.add('unfinished');
  }
  const stage = textElement('span', 'activity-stage', step);
  const statusGroup = textElement('span', 'activity-status-group', '');
  statusGroup.append(status);
  if (!hasChoices) statusGroup.append(textElement('span', 'activity-empty-choices', 'Nenhuma escolha registrada.'));
  summary.append(heading, stage, statusGroup, meta);

  const body = textElement('div', 'activity-body', '');
  if (item.step && item.step !== item.maxStep) {
    body.append(textElement('p', 'activity-card-time', 'Última tela visitada · ' + activitySteps[item.step - 1]));
  }
  if (hasChoices) body.append(choices);
  if (item.estimateViewed && item.estimate) {
    const quote = textElement('p', 'activity-outcome', '');
    quote.append(textElement('span', '', 'Última estimativa exibida'), textElement('strong', '', amount(item.estimate.totalCents)));
    body.append(quote);
    if (item.estimate.matchesCatalog === false) {
      body.append(textElement('p', 'activity-card-time', 'O valor exibido no navegador difere da tabela vigente no registro.'));
    }
  }
  if (hasChoices) {
    const arrow = textElement('span', 'activity-chevron', '');
    arrow.setAttribute('aria-hidden', 'true');
    summary.append(arrow);
    const card = document.createElement('details');
    card.append(summary, body);
    row.append(card);
  } else {
    row.append(summary);
    if (body.childElementCount) row.append(body);
  }
  return row;
}

function showActivityMonths({firstMonth, currentMonth, month}) {
  const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  if (![firstMonth, currentMonth, month].every(validMonth) || month < firstMonth || month > currentMonth) {
    throw new Error('Não foi possível identificar o mês da atividade.');
  }
  if (activityMonth.options[0]?.value !== currentMonth || activityMonth.options[activityMonth.length - 1]?.value !== firstMonth) {
    const options = [];
    const cursor = new Date(currentMonth + '-01T00:00:00Z');
    const first = new Date(firstMonth + '-01T00:00:00Z');
    while (cursor >= first) {
      const value = cursor.toISOString().slice(0, 7);
      options.push(new Option(monthFormat.format(cursor), value));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
    activityMonth.replaceChildren(...options);
  }
  activityMonth.value = month;
}

function renderDeviceSummary(visitorsByDevice) {
  const section = $('#activity-devices');
  const {mobile, desktop} = visitorsByDevice ?? {};
  if (![mobile, desktop].every(value => Number.isSafeInteger(value) && value >= 0)) {
    section.hidden = true;
    return;
  }
  $('#activity-mobile-total').textContent = mobile.toLocaleString('pt-BR');
  $('#activity-desktop-total').textContent = desktop.toLocaleString('pt-BR');
  section.hidden = false;
}

const activityPanels = {list: '#activity-list-view', calendar: '#activity-calendar', traffic: '#activity-traffic'};
function setActivityMode(mode) {
  resetDailyCard();
  for (const [name, selector] of Object.entries(activityPanels)) {
    const selected = name === mode;
    $('#activity-mode-' + name).setAttribute('aria-pressed', String(selected));
    $(selector).hidden = !selected;
  }
}

const trafficZone = 'America/Sao_Paulo';
const localDay = new Intl.DateTimeFormat('sv-SE', {timeZone: trafficZone, year: 'numeric', month: '2-digit', day: '2-digit'});
const localTimestamp = new Intl.DateTimeFormat('pt-BR', {timeZone: trafficZone, dateStyle: 'short', timeStyle: 'short'});
const localClock = new Intl.DateTimeFormat('pt-BR', {timeZone: trafficZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'});
const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const hourLabel = hour => String(hour).padStart(2, '0') + 'h';
const browserCount = n => n.toLocaleString('pt-BR') + (n === 1 ? ' navegador' : ' navegadores');

function trafficStatus(message) {
  resetDailyCard();
  dailyViewToggle.disabled = true;
  for (const selector of ['#calendar-content', '#traffic-content']) {
    $(selector).replaceChildren(textElement('p', 'traffic-message', message));
  }
}

function missingDailyCount(date, browsers, traffic, today, startDay, partialStartDay) {
  if (date > today) return 'Dia futuro';
  const incomplete = traffic.partialHistory && (date < startDay || (date === startDay && partialStartDay));
  return incomplete && browsers === 0 ? 'Histórico incompleto' : '';
}

function chartSvg(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value);
  return element;
}

function renderDailyBarChart(month, traffic, today, startDay, partialStartDay) {
  const days = traffic.days.filter(day => day.date <= today);
  const figure = textElement('figure', 'daily-bar-chart', '');
  const monthName = monthFormat.format(new Date(month + '-01T00:00:00Z'));
  figure.append(textElement('figcaption', '', monthName));
  if (!days.length) {
    figure.append(textElement('p', 'traffic-message', 'Ainda não há dias para exibir neste mês.'));
    return figure;
  }

  const max = Math.max(...days.map(day => day.browsers));
  const limit = max <= 1 ? 1 : 2 * Math.ceil(max / 2);
  const ticks = limit === 1 ? [0, 1] : [0, limit / 2, limit];
  const compact = new Intl.NumberFormat('pt-BR', {notation: 'compact', maximumFractionDigits: 1});
  const labelFor = n => n < 1000 ? String(n) : compact.format(n);
  // Coordinates are percentages of the plot; text and corner radii stay in pixels.
  const baseline = 97;
  const barHeight = value => 85 * value / limit;

  const frame = textElement('div', 'daily-bar-frame', '');
  frame.append(textElement('span', 'daily-bar-axis-name', 'Navegadores'));
  const layout = textElement('div', 'daily-bar-layout', '');
  const axis = chartSvg('svg', {class: 'daily-bar-axis', 'aria-hidden': 'true'});
  const guides = chartSvg('svg', {class: 'daily-bar-guides', 'aria-hidden': 'true'});
  for (const n of ticks) {
    const y = (baseline - barHeight(n)) + '%';
    const label = chartSvg('text', {x: '92%', y, dy: 4, 'text-anchor': 'end'});
    label.textContent = labelFor(n);
    axis.append(label);
    guides.append(chartSvg('line', {class: n ? 'guide' : 'baseline', x1: 0, x2: '100%', y1: y, y2: y}));
  }

  const scroll = textElement('div', 'daily-bar-scroll', '');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'Acessos por dia em ' + monthName);
  const canvas = textElement('div', 'daily-bar-canvas', '');
  const series = textElement('ol', 'daily-bar-series', '');
  if (max >= 1000) series.classList.add('large-counts');
  for (const {date, browsers} of days) {
    const missing = missingDailyCount(date, browsers, traffic, today, startDay, partialStartDay);
    const peak = !missing && browsers > 0 && browsers === max;
    const day = textElement('li', 'daily-bar-day', '');
    day.dataset.date = date;
    day.dataset.weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    day.classList.toggle('unavailable', Boolean(missing));
    day.classList.toggle('peak', peak);
    const detail = date.slice(-2) + '/' + date.slice(5, 7) + ' · ' + (missing || browserCount(browsers)) +
      (peak ? ' · Maior movimento no mês' : '');
    day.title = detail;
    const plot = chartSvg('svg', {class: 'daily-bar-mark', 'aria-hidden': 'true'});
    const height = missing ? 0 : barHeight(browsers);
    const y = (baseline - height) + '%';
    if (!missing) {
      day.dataset.browsers = browsers;
      plot.append(chartSvg('rect', {class: 'daily-bar', 'data-browsers': browsers, x: '25%', width: '50%', y, height: height + '%', rx: 3}));
    }
    const value = chartSvg('text', {class: 'daily-bar-value', x: '50%', y, dy: -6, 'text-anchor': 'middle'});
    value.textContent = missing ? '—' : labelFor(browsers);
    plot.append(value);
    const time = textElement('time', '', date.slice(-2));
    time.dateTime = date;
    time.setAttribute('aria-hidden', 'true');
    if (date === today) time.setAttribute('aria-current', 'date');
    day.append(plot, time, textElement('span', 'sr-only', detail));
    series.append(day);
  }

  canvas.append(guides, series);
  layout.append(axis, canvas);
  scroll.append(layout);
  frame.append(scroll, textElement('p', 'daily-bar-day-axis', 'Dia do mês'));
  figure.append(frame);
  return figure;
}

function renderCalendar(month, traffic, today, startDay, partialStartDay) {
  const first = new Date(month + '-01T00:00:00Z');
  const table = document.createElement('table');
  table.className = 'activity-calendar-table';
  table.createCaption().textContent = monthFormat.format(first);
  const header = table.createTHead().insertRow();
  for (const weekday of weekdays) {
    const th = textElement('th', '', weekday.slice(0, 3));
    th.scope = 'col';
    th.abbr = weekday;
    header.append(th);
  }
  const body = table.createTBody();
  let row = body.insertRow();
  for (let offset = 0; offset < first.getUTCDay(); offset++) row.insertCell();
  const max = Math.max(...traffic.days.map(day => day.browsers));
  for (const {date, browsers} of traffic.days) {
    if (row.cells.length === 7) row = body.insertRow();
    const cell = row.insertCell();
    const time = textElement('time', '', String(Number(date.slice(-2))));
    time.dateTime = date;
    const missing = missingDailyCount(date, browsers, traffic, today, startDay, partialStartDay);
    const unavailable = Boolean(missing);
    const count = textElement('strong', 'calendar-count', unavailable ? '—' : browsers.toLocaleString('pt-BR'));
    const cellBox = textElement('div', 'calendar-day', '');
    if (date === today) time.setAttribute('aria-current', 'date');
    if (unavailable) cellBox.classList.add('unavailable');
    else if (browsers > 0) cellBox.classList.add(browsers === max ? 'peak' : 'visited');
    const description = missing || browserCount(browsers);
    count.setAttribute('aria-hidden', 'true');
    const detail = cellBox.classList.contains('peak') ? description + '. Maior movimento no mês.' : description;
    cellBox.append(time, count, textElement('span', 'sr-only', detail));
    cell.append(cellBox);
  }
  while (row.cells.length < 7) row.insertCell();
  const legend = textElement('div', 'calendar-legend', '');
  for (const [className, label] of [['visited', 'Com acessos'], ['peak', 'Maior movimento']]) {
    const item = textElement('span', 'calendar-key ' + className, label);
    legend.append(item);
  }
  legend.append(textElement('span', '', '— Dia futuro ou sem histórico completo'));
  return [table, legend];
}

function renderTrafficMetrics(traffic, today) {
  const days = traffic.days.filter(day => day.date <= today);
  const dayPeak = Math.max(0, ...days.map(day => day.browsers));
  const hourPeak = Math.max(...traffic.hours);
  if (!dayPeak && !hourPeak) {
    const empty = traffic.partialHistory ? 'Nenhum acesso consta nos registros disponíveis para este mês.' : 'Nenhum acesso registrado neste mês.';
    return [textElement('p', 'traffic-message', empty)];
  }
  const peaks = textElement('div', 'traffic-peaks', '');
  const dates = days.filter(day => day.browsers === dayPeak).map(day => day.date.slice(-2) + '/' + day.date.slice(5, 7));
  const hours = traffic.hours.flatMap((value, hour) => value === hourPeak ? [hourLabel(hour)] : []);
  for (const [title, maximum, labels, description] of [
    ['Dias com maior acesso', dayPeak, dates, browserCount(dayPeak) + ' por dia de pico'],
    ['Horários com maior acesso', hourPeak, hours, hourPeak.toLocaleString('pt-BR') + (hourPeak === 1 ? ' acesso' : ' acessos') + ' por horário de pico no mês'],
  ]) {
    const card = textElement('div', 'traffic-peak', '');
    card.append(textElement('h3', '', title),
      textElement('strong', '', maximum ? labels.join(' · ') : '—'),
      textElement('p', '', maximum ? description : 'Sem registros'));
    peaks.append(card);
  }
  const chart = textElement('div', 'traffic-chart', '');
  chart.append(textElement('h3', '', 'Distribuição por hora'),
    textElement('p', 'hint', 'Em cada faixa de uma hora, contamos cada navegador uma vez por dia e somamos os dias do mês.'));
  const bars = textElement('ol', 'traffic-bars', '');
  for (const [hour, count] of traffic.hours.entries()) {
    const item = textElement('li', count === hourPeak && count > 0 ? 'peak' : '', '');
    const bar = document.createElement('progress');
    bar.max = hourPeak || 1;
    bar.value = count;
    bar.setAttribute('aria-hidden', 'true');
    item.append(textElement('span', '', hourLabel(hour)), bar, textElement('strong', '', count.toLocaleString('pt-BR')));
    bars.append(item);
  }
  chart.append(bars);
  return [peaks, chart];
}

function renderTraffic(month, traffic) {
  const [year, monthNumber] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const started = new Date(traffic?.trackingStartedAt);
  const asOf = new Date(traffic?.asOf);
  if (traffic?.timeZone !== trafficZone || typeof traffic.trackingStartedAt !== 'string' || !Number.isFinite(started.getTime()) ||
      typeof traffic.asOf !== 'string' || !Number.isFinite(asOf.getTime()) ||
      typeof traffic.partialHistory !== 'boolean' || !Array.isArray(traffic.days) || traffic.days.length !== length ||
      !traffic.days.every((day, i) => day?.date === month + '-' + String(i + 1).padStart(2, '0') && count(day.browsers)) ||
      !Array.isArray(traffic.hours) || traffic.hours.length !== 24 || !traffic.hours.every(count)) {
    trafficStatus('Os dados por dia e horário estão indisponíveis para este mês.');
    return;
  }
  const today = localDay.format(asOf);
  const startDay = localDay.format(started);
  const calendar = $('#calendar-content');
  const metrics = $('#traffic-content');
  const partialStartDay = localClock.format(started) !== '00:00:00';
  const gridFace = document.createElement('div');
  gridFace.id = 'calendar-grid';
  gridFace.append(...renderCalendar(month, traffic, today, startDay, partialStartDay));
  const chartFace = document.createElement('div');
  chartFace.id = 'calendar-chart';
  chartFace.append(renderDailyBarChart(month, traffic, today, startDay, partialStartDay));
  const faces = document.createElement('div');
  faces.className = 'daily-card-faces';
  faces.append(gridFace, chartFace);
  calendar.replaceChildren(faces);
  dailyViewToggle.disabled = false;
  setDailyFace(false);
  metrics.replaceChildren(...renderTrafficMetrics(traffic, today));
  if (month === today.slice(0, 7)) {
    const cutoff = 'Mês em andamento. Contagem até ' + localTimestamp.format(asOf) + '.';
    for (const section of [calendar, metrics]) section.append(textElement('p', 'traffic-cutoff', cutoff));
  }
  if (traffic.partialHistory) {
    const note = 'Histórico parcial. A contagem por dia e hora começou em ' + localTimestamp.format(started) + '. Para o período anterior, só estão disponíveis os acessos que puderam ser recuperados.';
    for (const section of [calendar, metrics]) section.prepend(textElement('p', 'traffic-coverage', note));
  }
}

function setDailyFace(showChart) {
  const grid = $('#calendar-grid');
  const chart = $('#calendar-chart');
  if (grid && chart) {
    grid.inert = showChart;
    chart.hidden = !showChart;
  }
  const action = showChart ? 'Voltar ao calendário' : 'Ver gráfico de barras';
  dailyViewToggle.setAttribute('aria-label', action);
  dailyViewToggle.title = action;
  dailyViewToggle.classList.toggle('shows-chart', showChart);
}

function resetDailyCard() {
  dailyFlip?.cancel();
  dailyFlip = null;
  setDailyFace(false);
}

function flipDailyCard() {
  if (dailyFlip || dailyViewToggle.disabled) return;
  const card = $('#activity-calendar');
  const showChart = $('#calendar-chart').hidden;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !card.animate) {
    setDailyFace(showChart);
    return;
  }
  const edge = showChart ? -90 : 90;
  const rotation = angle => ({transform: 'perspective(1400px) rotateY(' + angle + 'deg)'});
  const outgoing = card.animate([rotation(0), rotation(edge)], {duration: 240, easing: 'ease-in', fill: 'forwards'});
  dailyFlip = outgoing;
  outgoing.onfinish = () => {
    if (dailyFlip !== outgoing) return;
    setDailyFace(showChart);
    const incoming = card.animate([rotation(-edge), rotation(0)], {duration: 240, easing: 'ease-out'});
    dailyFlip = incoming;
    outgoing.cancel();
    incoming.onfinish = () => { if (dailyFlip === incoming) dailyFlip = null; };
  };
}

function renderSimulationActivity(result) {
  const stats = result.summary;
  const metricNames = ['browsers', 'started', 'viewed'];
  if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || !stats ||
      !metricNames.every(name => Number.isSafeInteger(stats[name]) && stats[name] >= 0)) {
    throw new Error('Não foi possível conferir as atividades. Tente atualizar novamente.');
  }
  const number = value => value.toLocaleString('pt-BR');
  showActivityMonths(result);
  const items = result.items.filter(item => !item.requestId).map(renderSimulation);
  $('#activity-metrics').replaceChildren(
    reportMetric('Navegadores', number(stats.browsers), 'Navegadores distintos com visitas registradas.'),
    reportMetric('Preenchimento iniciado', number(stats.started), 'Simulações com pelo menos uma escolha.'),
    reportMetric('Orçamento visualizado', number(stats.viewed), 'Simulações que chegaram ao orçamento.')
  );
  renderDeviceSummary(stats.visitorsByDevice);
  renderTraffic(result.month, result.traffic);
  $('#activity-list').replaceChildren(...items);
  $('#activity-empty').hidden = result.total !== 0;
  activityPagination.page = result.page;
  activityPagination.totalPages = Math.max(1, result.totalPages);
  $('#activity-pagination').hidden = activityPagination.totalPages <= 1;
  $('#activity-page').textContent = 'Página ' + result.page + ' de ' + activityPagination.totalPages;
  // Older servers return totals that also include completed simulations.
  const pageOnly = !stats.visitorsByDevice;
  const count = pageOnly ? items.length : result.total;
  const label = count === 1 ? 'registro em aberto' : 'registros em aberto';
  $('#activity-status').textContent = number(count) + ' ' + label + (pageOnly ? ' nesta página.' : '.');
}

async function loadSimulationActivity(page) {
  if (!state.authenticated || state.busy) return;
  controlsBusy(true);
  const month = activityMonth.value;
  const monthQuery = month ? '&month=' + encodeURIComponent(month) : '';
  $('#activity-status').textContent = 'Carregando atividade…';
  trafficStatus('Carregando acessos do mês…');
  const generation = ++state.generation;
  try {
    let result = await api('activity.php?page=' + page + monthQuery);
    if (generation !== state.generation || !state.authenticated) return;
    if (page > 1 && Number.isSafeInteger(result.totalPages) && result.totalPages < page) {
      result = await api('activity.php?page=' + Math.max(1, result.totalPages) + monthQuery);
      if (generation !== state.generation || !state.authenticated) return;
    }
    renderSimulationActivity(result);
    notice();
    recordActivity();
  } catch (error) {
    if (generation !== state.generation || expired(error)) return;
    clearSimulationActivity();
    $('#activity-status').textContent = 'Não foi possível carregar as atividades.';
    trafficStatus('Não foi possível carregar os acessos. Use Atualizar atividade para tentar novamente.');
    notice(error.message, 'error');
  } finally {
    if (generation === state.generation) controlsBusy(false);
  }
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
    reportMetric('Solicitações em ' + result.year, number(total.count), 'Contatos ativos recebidos no ano.'),
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
  $('#report-status').textContent = total.count ? 'Relatório atualizado. Inclui somente solicitações ativas do ano, independentemente do filtro da lista.' : 'Nenhuma solicitação ativa recebida neste ano.';
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
  deliveryNotice.hidden = !state.authenticated || state.view === 'activity' || !notices.length;
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
for (const view of viewNames) {
  const tab = $('#' + view + '-tab');
  tab.addEventListener('click', () => {
    if (state.busy || !state.authenticated || state.view === view) return;
    setView(view); notice(); void loadActiveView();
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.busy) return;
    event.preventDefault();
    const index = viewNames.indexOf(view);
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    let next = viewNames[(index + offset + viewNames.length) % viewNames.length];
    if (event.key === 'Home') next = viewNames[0];
    if (event.key === 'End') next = viewNames[viewNames.length - 1];
    const nextTab = $('#' + next + '-tab');
    nextTab.focus();
    nextTab.click();
  });
}
for (const mode of Object.keys(activityPanels)) {
  $('#activity-mode-' + mode).addEventListener('click', () => setActivityMode(mode));
}
dailyViewToggle.addEventListener('click', flipDailyCard);
activityMonth.addEventListener('change', () => { clearSimulationActivity(); void loadSimulationActivity(1); });
$('#refresh-activity').addEventListener('click', () => { void loadSimulationActivity(1); });
$('#activity-previous').addEventListener('click', () => { if (activityPagination.page > 1) void loadSimulationActivity(activityPagination.page - 1); });
$('#activity-next').addEventListener('click', () => { if (activityPagination.page < activityPagination.totalPages) void loadSimulationActivity(activityPagination.page + 1); });
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
