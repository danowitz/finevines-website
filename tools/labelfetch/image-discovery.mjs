import { createBraveImageDiscovery } from './brave-images.mjs';

export const IMAGE_DISCOVERY_PROVIDERS = new Set(['brave']);

export function validateImageDiscoveryCredentials(name, credentials = {}) {
  if (!IMAGE_DISCOVERY_PROVIDERS.has(name)) throw new Error(`unknown image search provider: ${name}`);
  const missing = [];
  if (!credentials.braveKey) missing.push('Brave image credentials');
  if (missing.length) throw new Error(`${missing.join(' and ')} are missing`);
}

// One provider factory is shared by preflight and the real pipeline so health
// checks cannot silently exercise a different endpoint or composition.
export function createImageDiscovery({
  name,
  braveKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  validateImageDiscoveryCredentials(name, { braveKey });
  return createBraveImageDiscovery({ token: braveKey, fetchImpl });
}
