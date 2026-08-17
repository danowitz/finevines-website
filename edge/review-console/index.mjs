import * as BunnySDK from '@bunny.net/edgescript-sdk';
import { createClient } from '@libsql/client/web';
import process from 'node:process';
import { createBunnyStorage } from './bunny-storage.mjs';
import { createGitHubDispatch } from './github-dispatch.mjs';
import { createReviewConsole } from './handler.mjs';
import { createReviewState } from './review-state.mjs';
import { createReviewerAccounts } from './reviewer-accounts.mjs';

const environment = process.env.REVIEW_ENVIRONMENT;
const config = {
  environment,
  origin: process.env.REVIEW_ORIGIN,
  cookieName: process.env.REVIEW_COOKIE_NAME || `fv_review_${environment}`,
  sessionSecret: process.env.REVIEW_SESSION_SECRET,
  databaseUrl: process.env.BUNNY_DATABASE_URL,
  databaseToken: process.env.BUNNY_DATABASE_AUTH_TOKEN,
};
const required = Object.entries(config).filter(([, value]) => !value).map(([name]) => name);
if (required.length) throw new Error(`review console configuration missing: ${required.join(', ')}`);
if (!['test', 'production'].includes(environment)) throw new Error('REVIEW_ENVIRONMENT must be test or production');
if (new URL(config.origin).origin !== config.origin) throw new Error('REVIEW_ORIGIN must be an exact HTTPS origin');
if (!config.origin.startsWith('https://')) throw new Error('REVIEW_ORIGIN must use HTTPS');
if (config.sessionSecret.length < 32) throw new Error('REVIEW_SESSION_SECRET must contain at least 32 characters');
if (!/^[A-Za-z0-9_]{1,48}$/.test(config.cookieName)) throw new Error('REVIEW_COOKIE_NAME is invalid');

const storage = createBunnyStorage({
  endpoint: process.env.BUNNY_STORAGE_ENDPOINT,
  zone: process.env.BUNNY_STORAGE_ZONE,
  key: process.env.BUNNY_STORAGE_KEY,
});
const dispatch = createGitHubDispatch({ token: process.env.GITHUB_DISPATCH_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const state = createReviewState({ client: createClient({ url: config.databaseUrl, authToken: config.databaseToken }) });
// Invitation delivery is deliberately unavailable until the administrator
// activates the mail transport. Login and review never depend on a shared
// environment password.
const mailer = { send: async () => { throw new Error('review invitation email is not configured'); } };
const accounts = createReviewerAccounts({ state, mailer });
const handle = createReviewConsole({ config, storage, state, accounts, dispatch });
BunnySDK.net.http.serve(handle);
