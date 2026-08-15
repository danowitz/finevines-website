function bytesEqual(left, right) {
  const a = left instanceof Uint8Array ? left : new TextEncoder().encode(String(left));
  const b = right instanceof Uint8Array ? right : new TextEncoder().encode(String(right));
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

export function createBunnyStorage({ endpoint, zone, key, fetchImpl = fetch }) {
  if (!endpoint || !zone || !key) throw new Error('Bunny storage configuration is incomplete');
  const root = `${String(endpoint).replace(/\/$/, '')}/${encodeURIComponent(zone)}`;
  const url = (path) => `${root}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
  const request = async (method, path, body, contentType) => {
    const response = await fetchImpl(url(path), {
      method, headers: { AccessKey: key, ...(contentType ? { 'Content-Type': contentType } : {}) }, body,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Bunny storage ${method} ${path} returned ${response.status}`);
    return response;
  };
  const getBytes = async (path) => {
    const response = await request('GET', path);
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
  };
  return {
    getBytes,
    get: async (path) => {
      const response = await request('GET', path);
      return response ? response.text() : undefined;
    },
    put: async (path, body, contentType = 'application/octet-stream') => { await request('PUT', path, body, contentType); },
    putImmutable: async (path, body, contentType = 'application/octet-stream') => {
      const existing = await getBytes(path);
      if (existing) {
        if (!bytesEqual(existing, body)) throw new Error(`immutable review object already exists with different bytes: ${path}`);
        return;
      }
      await request('PUT', path, body, contentType);
    },
    delete: async (path) => { await request('DELETE', path); },
  };
}
