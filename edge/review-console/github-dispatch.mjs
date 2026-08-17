export function createGitHubDispatch({ token, repository, fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) throw new Error('GitHub dispatch repository is invalid');
  // A repository-scoped token enables immediate processing, but it is not an
  // availability dependency. Without one the immutable pending action remains
  // in private storage and the scheduled pipeline processes it automatically.
  // Never substitute an operator's broad desktop token here.
  const send = async (eventType, payload) => {
    if (!token) throw new Error('GitHub dispatch is not configured');
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    });
    if (!response.ok) throw new Error(`GitHub dispatch returned ${response.status}`);
  };
  const dispatch = (actionId, environment) => send('review-console', { actionId, environment });
  dispatch.recovery = (actionId, slug, environment) => send('review-recovery', { action_id: actionId, slug, environment });
  return dispatch;
}
