export function createGitHubDispatch({ token, repository, fetchImpl = fetch }) {
  if (!token || !/^[^/]+\/[^/]+$/.test(repository || '')) throw new Error('GitHub dispatch configuration is incomplete');
  return async (actionId, environment) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ event_type: 'review-console', client_payload: { actionId, environment } }),
    });
    if (!response.ok) throw new Error(`GitHub dispatch returned ${response.status}`);
  };
}
