import { sendRepositoryDispatch } from './github-repository-dispatch.mjs';

export function createGitHubDispatch({ token, repository, fetchImpl = fetch }) {
  // A repository-scoped token enables immediate processing, but it is not an
  // availability dependency. Without one the immutable pending action remains
  // in private storage and the scheduled pipeline processes it automatically.
  // Never substitute an operator's broad desktop token here.
  const send = async (eventType, payload) => {
    try { await sendRepositoryDispatch({ token, repository, eventType, payload, fetchImpl }); }
    catch (error) {
      if (error.message === 'GitHub dispatch token is required') throw new Error('GitHub dispatch is not configured');
      throw error;
    }
  };
  const dispatch = (actionId, environment) => send('review-console', { actionId, environment });
  dispatch.recovery = (actionId, slug, environment) => send('review-recovery', { action_id: actionId, slug, environment });
  return dispatch;
}
