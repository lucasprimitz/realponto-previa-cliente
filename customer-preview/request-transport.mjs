// O modo demonstrativo não transmite dados. A integração ativa só aceita a mesma origem.
export function createRequestTransport({apiBase = '', pageUrl = globalThis.location?.href, fetchImpl = globalThis.fetch, randomId = () => globalThis.crypto.randomUUID(), timeoutMs = 20000} = {}) {
  const configured = typeof apiBase === 'string' && apiBase.trim() !== '';
  if (!configured) return Object.freeze({mode: 'demo', submit: async () => ({demo: true})});
  let base;
  try {
    const page = new URL(pageUrl);
    base = new URL(apiBase, page);
    const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
    if (page.protocol !== 'https:' && !(page.protocol === 'http:' && localDevelopment)) throw new Error();
    if (!['https:', 'http:'].includes(page.protocol) || base.origin !== page.origin || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error();
  } catch {
    throw new Error('O envio ainda não foi configurado corretamente. Entre em contato com a Realponto.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Este navegador não oferece suporte ao envio.');
  let previousFingerprint;
  let idempotencyKey;
  let pending = false;
  let completed;
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  };
  async function api(file, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(file, base).href, {...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal});
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok === false) {
        const message = typeof body?.message === 'string' && body.message.length <= 350 ? body.message : 'Não foi possível confirmar o envio. Tente novamente.';
        throw new Error(message);
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted || error instanceof TypeError) throw new Error('Não foi possível confirmar o envio. Confira sua conexão e tente novamente; repetir este envio não cria outra solicitação.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    mode: 'connected',
    async submit(request) {
      if (pending) throw new Error('Aguarde a confirmação do envio em andamento.');
      // A data e a estimativa local não identificam uma nova solicitação: o servidor as calcula.
      const {createdAt, estimate, ...content} = request;
      const fingerprint = JSON.stringify(stable(content));
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        idempotencyKey = randomId();
        completed = undefined;
      }
      if (completed) return completed;
      pending = true;
      try {
        const session = await api('session.php', {method: 'GET', headers: {'Accept': 'application/json'}});
        if (session.submissionEnabled !== true || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('O recebimento de solicitações ainda não está disponível. Tente novamente mais tarde.');
        const result = await api('requests.php', {
          method: 'POST',
          headers: {'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': idempotencyKey},
          body: JSON.stringify(request),
        });
        if (result.ok !== true || typeof result.id !== 'string' || !result.id || typeof result.receivedAt !== 'string') throw new Error('Não foi possível confirmar o registro. Tente novamente.');
        completed = Object.freeze({id: result.id, receivedAt: result.receivedAt, mailStatus: result.mailStatus, demo: false});
        return completed;
      } finally {
        pending = false;
      }
    },
  });
}
