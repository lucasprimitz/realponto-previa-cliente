// Each read-modify-write transaction is atomic across all tabs, including first visits.
export function browserActivityStore(scope) {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open('realponto-simulador-atividade', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => reject(new Error('Armazenamento de atividade indisponível.'));
    });
    return database;
  }
  return async change => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      const get = store.get(scope);
      let result;
      get.onsuccess = () => {
        try {
          const state = get.result ?? {};
          result = change(state);
          store.put(state, scope);
        } catch { transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(new Error('Atividade indisponível.'));
    });
  };
}

const quantities = new Set(['schedules', 'employees']);
const switches = new Set(['bankHours', 'workScale']);
export function activityChoice(name, value) {
  if (name === 'system') return {configuration: {system: value || null}};
  if (name === 'paymentMethod') return {paymentMethod: value || null};
  if (quantities.has(name)) return {configuration: {[name]: value === 'consultar' ? value : value ? Number(value) : null}};
  if (switches.has(name)) return {configuration: {[name]: value === '' ? null : value === 'yes'}};
  return null;
}

const retentionMs = 90 * 24 * 60 * 60 * 1000;
export function createActivityTracker({update, send, now = Date.now, randomId = () => globalThis.crypto.randomUUID()}) {
  let pinned;
  let reviewed = false;
  let ended = false;
  let local = Promise.resolve();
  let deliveries = Promise.resolve();

  // Only local transactions are queued here. Network failures never hold a proposal.
  function transact(change) {
    const done = local.then(() => update(change)).catch(() => undefined);
    local = done;
    return done;
  }
  function identity(state) {
    if (pinned && pinned.browserId === state.browserId && pinned.simulationId === state.draft?.simulationId) return pinned;
  }
  function record({step, configuration = {}, paymentMethod, estimateViewed = false, displayedTotalCents, visit = false}) {
    const view = step === 4 && estimateViewed;
    return transact(state => {
      if (ended) return;
      const time = now();
      if (state.touchedAt && time - state.touchedAt >= retentionMs) {
        delete state.draft;
        delete state.browserId;
        delete state.touchedAt;
      }
      if (!pinned) {
        if (reviewed && state.draft) return; // A different tab already started the next customer's draft.
        state.browserId ??= randomId();
        state.draft ??= {simulationId: randomId(), revision: 0, step: 1, configuration: {}, paymentMethod: null};
        pinned = {browserId: state.browserId, simulationId: state.draft.simulationId};
      }
      if (!identity(state)) return;
      const draft = state.draft;
      const next = {...draft.configuration, ...configuration};
      const payment = paymentMethod === undefined ? draft.paymentMethod : paymentMethod;
      const changed = Object.keys(next).some(key => next[key] !== draft.configuration[key]);
      if (draft.revision && !visit && !view && !changed && draft.paymentMethod === payment && draft.step === step) return;
      if (!Number.isSafeInteger(draft.revision + 1)) return;
      state.touchedAt = time;
      Object.assign(draft, {configuration: next, paymentMethod: payment, step, revision: draft.revision + 1});
      const snapshot = {...pinned, revision: draft.revision, step, configuration: next, paymentMethod: payment, estimateViewed: view};
      if (view && (displayedTotalCents === null || (Number.isSafeInteger(displayedTotalCents) && displayedTotalCents >= 0))) {
        snapshot.displayedTotalCents = displayedTotalCents;
      }
      return snapshot;
    }).then(snapshot => {
      if (!snapshot) return;
      const deliver = () => send(snapshot);
      // Queue at commit time across tabs. A slow earlier POST must not allow a
      // later tab's refresh to jump ahead of an already queued estimate.
      if (globalThis.navigator?.locks?.request) {
        return globalThis.navigator.locks.request('realponto-atividade-' + snapshot.simulationId, deliver).catch(() => {});
      }
      deliveries = deliveries.then(deliver).catch(() => {});
      return deliveries;
    });
  }
  function link() {
    let timeout;
    return Promise.race([
      // A stale tab may only reference the draft it actually filled. The server
      // can then return its existing receipt, even after another tab has moved on.
      transact(state => !ended && pinned?.browserId === state.browserId &&
        now() - state.touchedAt < retentionMs ? pinned : undefined),
      new Promise(resolve => { timeout = setTimeout(resolve, 150); }),
    ]).finally(() => clearTimeout(timeout));
  }
  function complete() {
    return transact(state => {
      ended = true;
      if (identity(state)) delete state.draft;
    });
  }
  function review() {
    return transact(() => {
      if (ended) {
        pinned = undefined;
        reviewed = true;
        ended = false;
      }
    });
  }
  return {record, link, complete, review};
}
