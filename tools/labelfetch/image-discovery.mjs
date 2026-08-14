import { createBraveImageDiscovery } from './brave-images.mjs';
import { createCombinedImageDiscovery } from './combined-image-discovery.mjs';
import { createGoogleImageDiscovery } from './google-images.mjs';
import { createSerperImageDiscovery } from './serper-images.mjs';

export const IMAGE_DISCOVERY_PROVIDERS = new Set(['google', 'brave', 'serper', 'brave-serper']);

export function validateImageDiscoveryCredentials(name, credentials = {}) {
  if (!IMAGE_DISCOVERY_PROVIDERS.has(name)) throw new Error(`unknown image search provider: ${name}`);
  const missing = [];
  if (name === 'google' && (!credentials.googleKey || !credentials.googleCx)) missing.push('Google image credentials');
  if ((name === 'brave' || name === 'brave-serper') && !credentials.braveKey) missing.push('Brave image credentials');
  if ((name === 'serper' || name === 'brave-serper') && !credentials.serperKey) missing.push('Serper image credentials');
  if (missing.length) throw new Error(`${missing.join(' and ')} are missing`);
}

// One provider factory is shared by preflight and the real pipeline so health
// checks cannot silently exercise a different endpoint or composition.
export function createImageDiscovery({
  name,
  googleKey,
  googleCx,
  braveKey,
  serperKey,
  googleSearchParams,
  fetchImpl = globalThis.fetch,
} = {}) {
  validateImageDiscoveryCredentials(name, { googleKey, googleCx, braveKey, serperKey });
  if (name === 'google') return createGoogleImageDiscovery({
    key: googleKey, cx: googleCx, searchParams: googleSearchParams, fetchImpl,
  });
  if (name === 'brave') return createBraveImageDiscovery({ token: braveKey, fetchImpl });
  if (name === 'serper') return createSerperImageDiscovery({ apiKey: serperKey, fetchImpl });
  return createCombinedImageDiscovery({ providers: [
    { name: 'brave', discover: createBraveImageDiscovery({ token: braveKey, fetchImpl }) },
    { name: 'serper', discover: createSerperImageDiscovery({ apiKey: serperKey, fetchImpl }) },
  ] });
}
