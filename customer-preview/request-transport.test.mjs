import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestTransport} from './request-transport.mjs';

const pageUrl = 'https://jornada.example.test/';
const request = () => ({schemaVersion: 1, createdAt: '2026-10-28T12:00:00Z', contact: {name: 'Cliente Exemplo', company: 'Empresa Exemplo', email: 'cliente@example.test', phone: '11999999999', taxId: null}, configuration: {system: 'rhid', schedules: 10, employees: 20, bankHours: false, workScale: false}, payment: {method: 'pix', label: 'Pix'}, estimate: {status: 'priced', totalCents: 76580, campaignDiscountApplied: true}, consent: true});
const json = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const session = () => json({csrfToken: 'test-csrf-token', submissionEnabled: true, mailConfigured: false});
const receipt = () => json({ok: true, id: 'req-test-protocol', receivedAt: '2026-10-28T12:00:01Z', mailStatus: 'pending'});
const setup = fetchImpl => createRequestTransport({apiBase: './api/', pageUrl, fetchImpl, randomId: () => 'idempotency-test-key'});

test('a prévia sem API não faz nenhuma requisição', async () => {
  const transport = createRequestTransport({fetchImpl() {throw new Error('Não deve acessar a rede');}});
  assert.equal(transport.mode, 'demo');
  assert.deepEqual(await transport.submit(request()), {demo: true});
});

test('recusa endereço de API externo antes de transmitir informações', () => {
  for (const apiBase of ['https://outro.example.test/api/', '//outro.example.test/api/', 'javascript:alert(1)', './api/?secret=value', './api/#x', './api']) {
    assert.throws(() => createRequestTransport({apiBase, pageUrl}), /configurado corretamente/);
  }
});

test('envia dados, CSRF e idempotência apenas para a mesma origem', async () => {
  const calls = [];
  const transport = setup(async (url, options) => {calls.push({url, options}); return calls.length === 1 ? session() : receipt();});
  const body = request();
  const result = await transport.submit(body);
  assert.equal(result.demo, false);
  assert.equal(result.id, 'req-test-protocol');
  assert.equal(result.mailStatus, 'pending');
  assert.equal(calls[0].url, 'https://jornada.example.test/api/session.php');
  assert.equal(calls[1].url, 'https://jornada.example.test/api/requests.php');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'test-csrf-token');
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'idempotency-test-key');
  assert.deepEqual(JSON.parse(calls[1].options.body), body);
});

test('recusa envio se o servidor ainda não foi habilitado', async () => {
  let calls = 0;
  const transport = setup(async () => {calls++; return json({csrfToken: 'token', submissionEnabled: false});});
  await assert.rejects(transport.submit(request()), /ainda não está disponível/);
  assert.equal(calls, 1);
});

test('falha de rede nunca se transforma em sucesso demonstrativo', async () => {
  const transport = setup(async () => {throw new TypeError('network failure');});
  await assert.rejects(transport.submit(request()), /Não foi possível confirmar o envio/);
});

test('resposta inválida de servidor não confirma o registro', async () => {
  let calls = 0;
  const transport = setup(async () => ++calls === 1 ? session() : json({ok: true}));
  await assert.rejects(transport.submit(request()), /Não foi possível confirmar o registro/);
});

test('reenvio após falha ambígua mantém a chave, mesmo com nova data local', async () => {
  let ids = 0;
  const keys = [];
  const transport = createRequestTransport({apiBase: './api/', pageUrl, randomId: () => 'key-' + ++ids, fetchImpl: async (url, options) => {
    if (url.endsWith('session.php')) return session();
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) throw new TypeError('Resposta perdida após o registro');
    return receipt();
  }});
  await assert.rejects(transport.submit(request()), /Não foi possível confirmar/);
  const later = {...request(), createdAt: '2026-10-28T12:01:00Z', estimate: {...request().estimate, totalCents: 88888}};
  assert.equal((await transport.submit(later)).id, 'req-test-protocol');
  assert.deepEqual(keys, ['key-1', 'key-1']);
  assert.equal(ids, 1);
});

test('envio já confirmado é reutilizado e alteração de dados gera outra chave', async () => {
  let ids = 0;
  const keys = [];
  const transport = createRequestTransport({apiBase: './api/', pageUrl, randomId: () => 'key-' + ++ids, fetchImpl: async (url, options) => {
    if (url.endsWith('session.php')) return session();
    keys.push(options.headers['Idempotency-Key']);
    return receipt();
  }});
  await transport.submit(request());
  await transport.submit({...request(), createdAt: '2026-10-29T12:00:00Z'});
  const changed = request(); changed.configuration.employees = 40;
  await transport.submit(changed);
  assert.deepEqual(keys, ['key-1', 'key-2']);
});

test('impede uma segunda requisição enquanto o primeiro envio está em andamento', async () => {
  let release;
  const transport = setup(() => new Promise(resolve => {release = resolve;}));
  const first = transport.submit(request());
  await assert.rejects(transport.submit(request()), /Aguarde a confirmação/);
  release(json({submissionEnabled: false}));
  await assert.rejects(first, /ainda não está disponível/);
});

test('erro de validação do servidor mantém o formulário sem confirmação', async () => {
  let calls = 0;
  const transport = setup(async () => ++calls === 1 ? session() : json({ok: false, message: 'Confira o telefone informado.'}, 422));
  await assert.rejects(transport.submit(request()), /Confira o telefone informado/);
});

test('prazo de espera encerra uma conexão parada sem perder a possibilidade de repetição', async () => {
  const transport = createRequestTransport({apiBase: './api/', pageUrl, timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))});
  await assert.rejects(transport.submit(request()), /Não foi possível confirmar o envio/);
});

test('recusa envio em HTTP remoto, permitindo HTTP apenas no desenvolvimento local', () => {
  assert.throws(() => createRequestTransport({apiBase: './api/', pageUrl: 'http://192.168.90.7:8082/'}), /configurado corretamente/);
  assert.equal(createRequestTransport({apiBase: './api/', pageUrl: 'http://127.0.0.1:8937/'}).mode, 'connected');
});
