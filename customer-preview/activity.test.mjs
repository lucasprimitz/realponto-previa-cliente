import test from 'node:test';
import assert from 'node:assert/strict';
import {activityChoice, createActivityTracker} from './activity.mjs';

const priced = {system: 'rhid', schedules: 10, employees: 20, bankHours: false, workScale: true};
function browser() {
  const state = {};
  const sent = [];
  let queue = Promise.resolve();
  const update = change => {
    const result = queue.then(() => change(state));
    queue = result.catch(() => {});
    return result;
  };
  return {
    tab: () => createActivityTracker({update, send: async data => sent.push(structuredClone(data))}),
    sent,
  };
}

test('duas abas iniciadas juntas compartilham visita, rascunho e revisões', async () => {
  const {tab, sent} = browser();
  const a = tab(), b = tab();
  await Promise.all([a.record({step: 1, visit: true}), b.record({step: 1, visit: true})]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].simulationId, sent[1].simulationId);
  assert.deepEqual(await a.link(), await b.link());
  assert.match(sent[0].browserId, /^[a-f0-9-]{14}4[a-f0-9]{3}-[89ab]/);
  await Promise.all([a.record({step: 1, configuration: {system: 'rhid'}}), b.record({step: 2, configuration: {employees: 20}})]);
  assert.deepEqual(sent.map(event => event.revision).sort((x,y) => x-y), [1,2,3,4]);
  const latest = sent.find(event => event.revision === 4);
  assert.equal(latest.step, 2);
  assert.deepEqual(latest.configuration, {system: 'rhid', employees: 20});
  assert.equal(latest.estimateViewed, false);
});

test('a recarga preserva progresso e estimativa, edições anteriores não implicam nova exibição', async () => {
  const {tab, sent} = browser();
  const a = tab();
  await a.record({step: 3, configuration: priced, estimateViewed: true});
  assert.equal(sent[0].estimateViewed, false);
  await a.record({step: 4, configuration: priced, estimateViewed: true});
  assert.equal(sent[1].estimateViewed, true);
  await a.record({step: 1});
  const reloaded = tab();
  await reloaded.record({step: 1, visit: true});
  assert.equal(sent.length, 4);
  assert.equal(sent[3].step, 1);
  assert.equal(sent[3].estimateViewed, false);
  assert.deepEqual(sent[3].configuration, priced);
  await reloaded.record({step: 2, configuration: {employees: 'consultar'}});
  assert.equal(sent[4].step, 2);
  assert.equal(sent[4].estimateViewed, false);
  assert.deepEqual(sent[4].configuration, {...priced, employees: 'consultar'});
  assert.equal(Math.max(...sent.map(event => event.step)), 4);
  assert.deepEqual(await reloaded.link(), await a.link());
});

test('depois do envio, a próxima visita tem novo rascunho e abas antigas ficam desvinculadas', async () => {
  const {tab, sent} = browser();
  const a = tab(), stale = tab();
  await a.record({step: 1});
  await stale.record({step: 1});
  const before = await a.link();
  await a.complete();
  const fresh = tab();
  await fresh.record({step: 1});
  await stale.record({step: 2, configuration: {employees: 20}});
  await a.review();
  await a.record({step: 1});
  assert.deepEqual(await stale.link(), before);
  assert.equal(await a.link(), undefined);
  assert.equal(sent.length, 2);
  assert.equal((await fresh.link()).browserId, before.browserId);
  assert.notEqual((await fresh.link()).simulationId, before.simulationId);
});

test('a revisão após confirmação pode iniciar o próximo rascunho no mesmo navegador', async () => {
  const {tab} = browser();
  const a = tab();
  await a.record({step: 1});
  const before = await a.link();
  await a.complete();
  await a.review();
  await a.record({step: 1});
  const after = await a.link();
  assert.equal(after.browserId, before.browserId);
  assert.notEqual(after.simulationId, before.simulationId);
});

test('somente escolhas são convertidas e ausência se distingue da resposta não', () => {
  assert.deepEqual(activityChoice('bankHours','no'), {configuration: {bankHours: false}});
  assert.deepEqual(activityChoice('workScale',''), {configuration: {workScale: null}});
  assert.deepEqual(activityChoice('employees','20'), {configuration: {employees: 20}});
  assert.deepEqual(activityChoice('schedules','consultar'), {configuration: {schedules: 'consultar'}});
  assert.deepEqual(activityChoice('paymentMethod','pix'), {paymentMethod: 'pix'});
  for (const field of ['email','phone','taxId','contactName','company','contactPermission']) {
    assert.equal(activityChoice(field, 'privado'), null);
  }
});

test('falhas e atrasos do acompanhamento liberam o envio da proposta', async () => {
  const unavailable = createActivityTracker({update: async () => {throw new Error('Indisponível');}, send: assert.fail});
  await unavailable.record({step: 1});
  assert.equal(await unavailable.link(), undefined);
  const stalled = createActivityTracker({update: () => new Promise(() => {}), send: assert.fail});
  assert.equal(await stalled.link(), undefined);
});

test('após 90 dias inativos a próxima visita recebe novas identidades e escolhas vazias', async () => {
  const state = {};
  let time = Date.UTC(2026, 0, 1);
  const sent = [];
  const tab = () => createActivityTracker({update: async change => change(state), send: async event => sent.push(event), now: () => time});
  const a = tab();
  await a.record({step: 2, configuration: {employees: 20}});
  const before = await a.link();
  time += 90 * 24 * 60 * 60 * 1000;
  const b = tab();
  await b.record({step: 1, visit: true});
  const after = await b.link();
  assert.notEqual(after.browserId, before.browserId);
  assert.notEqual(after.simulationId, before.simulationId);
  assert.equal(await a.link(), undefined);
  assert.deepEqual(sent[1].configuration, {});
});

test('somente a estimativa visível transmite o valor efetivamente apresentado ou a consulta sem preço', async () => {
  const {tab, sent} = browser();
  const a = tab();
  await a.record({step: 3, configuration: priced, estimateViewed: true, displayedTotalCents: 12345});
  await a.record({step: 4, configuration: priced, estimateViewed: true, displayedTotalCents: 12345});
  await a.record({step: 2, configuration: {employees: 'consultar'}, displayedTotalCents: 12345});
  await a.record({step: 4, estimateViewed: true, displayedTotalCents: null});
  assert.equal(Object.hasOwn(sent[0], 'displayedTotalCents'), false);
  assert.equal(sent[1].displayedTotalCents, 12345);
  assert.equal(Object.hasOwn(sent[2], 'displayedTotalCents'), false);
  assert.equal(sent[3].displayedTotalCents, null);
});
