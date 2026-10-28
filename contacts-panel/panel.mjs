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
const state = {authenticated: false, csrfToken: '', page: 1, totalPages: 1, busy: false, generation: 0, lastActivity: 0};
const idleMilliseconds = 15 * 60 * 1000;
let idleTimer;
let apiBase;

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
function safeText(value, fallback = 'Não informado') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}
function amount(cents) {
  return Number.isSafeInteger(cents) && cents >= 0
    ? new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'}).format(cents / 100)
    : 'Valor sob consulta';
}
function receivedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Data não disponível' : new Intl.DateTimeFormat('pt-BR', {dateStyle: 'short', timeStyle: 'short'}).format(date);
}
function quantity(value, upper) {
  if (value === 'consultar') return 'Mais de ' + new Intl.NumberFormat('pt-BR').format(upper);
  return Number.isSafeInteger(value) && value > 0 ? 'Até ' + new Intl.NumberFormat('pt-BR').format(value) : 'Não informado';
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
  const card = textElement('article', 'request-card', '');
  const top = textElement('div', 'request-top', '');
  const heading = textElement('div', 'request-heading', '');
  const headingTitle = textElement('h2', '', safeText(contact.company, 'Solicitação de proposta'));
  const meta = textElement('p', 'request-meta', '');
  meta.append(textElement('span', '', receivedDate(item.receivedAt)), textElement('span', 'request-id', 'Protocolo: ' + safeText(item.id, '—')));
  heading.append(headingTitle, meta);
  const badge = textElement('span', 'pill' + (item.handled ? ' handled' : ''), item.handled ? 'Encaminhada' : 'Pendente');
  top.append(heading, badge);
  const body = textElement('div', 'request-body', '');
  const person = section('Contato');
  addDetail(person.dl, 'Nome', safeText(contact.name));
  addDetail(person.dl, 'E-mail', safeText(contact.email), 'wide');
  addDetail(person.dl, 'Telefone / WhatsApp', safeText(contact.phone));
  if (contact.taxId) addDetail(person.dl, 'CPF / CNPJ', safeText(contact.taxId));
  const scope = section('Configuração solicitada');
  const systems = {'secullum-offline': 'Secullum Offline', 'secullum-rh': 'Secullum RH', rhid: 'RHID', iponto: 'iPonto'};
  addDetail(scope.dl, 'Sistema', systems[configuration.system] ?? 'Não informado');
  addDetail(scope.dl, 'Horários a cadastrar', quantity(configuration.schedules, 100));
  addDetail(scope.dl, 'Funcionários a reagendar', quantity(configuration.employees, 1000));
  addDetail(scope.dl, 'Banco de horas', configuration.bankHours === true ? 'Sim' : 'Não');
  addDetail(scope.dl, 'Escalas', configuration.workScale === true ? 'Sim' : 'Não');
  const investment = section('Proposta e pagamento');
  addDetail(investment.dl, 'Pagamento desejado', safeText(request.payment?.label));
  addDetail(investment.dl, estimate.campaignDiscountApplied ? 'Estimativa com a campanha' : 'Estimativa da parametrização', amount(estimate.totalCents), 'estimate-value');
  if (request.payment?.method === 'pix' && Number.isSafeInteger(estimate.pixCents)) addDetail(investment.dl, 'Estimativa no Pix', amount(estimate.pixCents));
  if (request.payment?.method === 'boleto' && Number.isSafeInteger(estimate.boletoInstallmentCents)) addDetail(investment.dl, 'Parcelamento sob consulta', '6x de ' + amount(estimate.boletoInstallmentCents));
  if (request.payment?.method === 'credit-card' && Number.isSafeInteger(estimate.cardInstallmentCents)) addDetail(investment.dl, 'Parcelamento sem juros', '10x de ' + amount(estimate.cardInstallmentCents));
  investment.container.append(textElement('p', 'estimate-note', 'Valores sujeitos à confirmação da proposta. O envio não equivale à aprovação.'));
  investment.container.append(textElement('p', 'delivery-state' + (item.mailStatus === 'failed' ? ' failed' : ''), displayDelivery(item.mailStatus)));
  body.append(person.container, scope.container, investment.container);
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
  card.append(top, body, edit);
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
    if (load && state.authenticated) await loadRequests(1);
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
    await loadRequests(1);
    $('#page-title').focus();
  } catch (error) {
    password.value = '';
    clearPrivateView();
    notice(error.message, 'error');
    if (error.status === 403) await refreshSession(false);
    password.focus();
  } finally { controlsBusy(false); loginButton.textContent = 'Entrar nas solicitações →'; }
});
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
