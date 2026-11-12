import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {validateCatalog} from '../dist/pricing-catalog.mjs';

export const CANONICAL_PRICING = new URL('../customer-service/pricing.json', import.meta.url);
const expectedSystems = new Map([['secullum-offline', true], ['secullum-rh', true], ['rhid', false], ['iponto', false]]);
export function contactPricing(source = CANONICAL_PRICING) {
  const data = JSON.parse(readFileSync(source, 'utf8'));
  const catalog = validateCatalog(data);
  if (!Array.isArray(data.systems) || data.systems.length !== expectedSystems.size || new Set(data.systems.map(s => s?.id)).size !== expectedSystems.size || data.systems.some(s => !s || !expectedSystems.has(s.id) || s.secullum !== expectedSystems.get(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120 || /[\u0000-\u001f\u007f]/.test(s.name))) throw new Error('Sistemas do catálogo inválidos.');
  return {...catalog, systems: data.systems.map(({id, name, secullum}) => ({id, name, secullum}))};
}
// Exporta uma cópia validada. Nunca reconstitui a fonte a partir do JavaScript.
export async function exportContactPricing(destination) {
  if (!destination || path.resolve(destination) === path.resolve(fileURLToPath(CANONICAL_PRICING))) throw new Error('Informe um arquivo de destino diferente da tabela oficial.');
  await writeFile(destination, JSON.stringify(contactPricing(), null, 2) + '\n');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await exportContactPricing(process.argv[2]);
  console.log('Cópia validada da tabela oficial exportada.');
}
