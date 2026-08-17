function validRepository(repository) {
  const parts = String(repository || '').split('/');
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && !part.includes('..'));
}

export async function sendRepositoryDispatch({ token, repository, eventType, payload, fetchImpl = fetch, signal }) {
  if (!validRepository(repository)) throw new Error('GitHub repository must be owner/name');
  if (!token) throw new Error('GitHub dispatch token is required');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(eventType || '')) throw new Error('GitHub dispatch event type is invalid');
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('GitHub dispatch payload must be an object');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'finevines-review-processor',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`GitHub dispatch returned HTTP ${response.status}`);
}
