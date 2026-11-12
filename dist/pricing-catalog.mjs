// Dados públicos apenas. Nunca carrega nem executa código da hospedagem.
const priceKeys = ['baseCents', 'perScheduleCents', 'perEmployeeCents', 'bankHoursPercent', 'workScalePercent', 'secullumPercent'];
const MAX_BYTES = 65536;
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tabela de preços inválida.');
  return value;
}
function integer(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Valor de preço inválido.');
  return value;
}
function quantities(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || n > 100000 || (i && n <= value[i - 1]))) throw new Error('Faixas de quantidades inválidas.');
  return Object.freeze([...value]);
}
export function validateCatalog(value) {
  const data = record(value), pricing = record(data.pricing), campaign = record(data.campaign);
  if (Object.keys(pricing).length !== priceKeys.length || priceKeys.some(key => !Object.hasOwn(pricing, key))) throw new Error('Campos de preços desconhecidos.');
  const cleanPricing = Object.fromEntries(priceKeys.map(key => [key, integer(pricing[key], key.endsWith('Percent') ? 100 : 100000000)]));
  const date = campaign.deadlineISO;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || campaign.deadlineLabel !== date.split('-').reverse().join('/') || campaign.timeZone !== 'America/Sao_Paulo') throw new Error('Campanha inválida.');
  return Object.freeze({
    pricing: Object.freeze(cleanPricing),
    campaign: Object.freeze({discountPercent: integer(campaign.discountPercent, 100), deadlineISO: date, deadlineLabel: campaign.deadlineLabel, timeZone: campaign.timeZone}),
    schedules: quantities(data.schedules), employees: quantities(data.employees),
  });
}
function envelope(value) {
  const data = record(value);
  if (data.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(data.version ?? '')) throw new Error('Versão da tabela inválida.');
  return {schemaVersion: 1, version: data.version, catalog: validateCatalog(data.catalog)};
}
async function readJson(response) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Tabela indisponível.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Resposta de preços incompleta.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Tabela muito grande.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
export async function loadSharedPricing({url, fallback, storage, fetcher = fetch, now = () => new Date(), timeoutMs = 5000}) {
  const baseline = validateCatalog(fallback);
  if (typeof url !== 'string' || !url || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('Consulta de preços inválida.');
  const key = 'realponto-pricing-v1:' + url;
  let cached;
  try {
    const raw = storage?.getItem(key);
    if (raw && raw.length <= MAX_BYTES) {
      const data = JSON.parse(raw), checked = Date.parse(data.checkedAt);
      if (!Number.isFinite(checked) || checked > now().getTime() + 300000) throw new Error('Data de confirmação inválida.');
      cached = {...envelope(data), checkedAt: new Date(checked).toISOString()};
    }
  } catch { cached = null; }
  const controller = new AbortController(); let timer;
  try {
    const request = async () => {
      const response = await fetcher(url, {method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal});
      return envelope(await readJson(response));
    };
    const data = await Promise.race([request(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Tempo de consulta excedido.')); }, timeoutMs);
    })]);
    const checkedAt = now().toISOString();
    try { storage?.setItem(key, JSON.stringify({...data, checkedAt})); } catch { /* Navegação privada ou armazenamento cheio não impedem a consulta. */ }
    return {catalog: data.catalog, version: data.version, checkedAt, source: 'remote'};
  } catch {
    if (cached) return {catalog: cached.catalog, version: cached.version, checkedAt: cached.checkedAt, source: 'cache'};
    return {catalog: baseline, version: null, checkedAt: null, source: 'bundled'};
  } finally { clearTimeout(timer); }
}
