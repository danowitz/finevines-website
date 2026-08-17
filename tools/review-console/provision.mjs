import process from 'node:process';

const API = 'https://api.bunny.net';
const repository = 'danowitz/finevines-website';
const environments = [
  {
    name: 'test',
    scriptName: 'finevines-review-test',
    host: 'review.finevines.biz',
    domain: 'finevines.biz',
    cookie: 'fv_review_test',
    sessionEnv: 'FINEVINES_REVIEW_TEST_SESSION_SECRET',
    incidentRecipient: 'joel@gritautomation.com',
  },
  {
    name: 'production',
    scriptName: 'finevines-review-production',
    host: 'review.finevines.com',
    domain: 'finevines.com',
    cookie: 'fv_review_production',
    sessionEnv: 'FINEVINES_REVIEW_PRODUCTION_SESSION_SECRET',
    incidentRecipient: 'barb@finevines.com',
  },
];

function required(name, minimum = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimum) throw new Error(`${name} is missing or too short`);
  return value;
}

const accountKey = required('FINEVINES_BUNNY_API_KEY');
const storageEndpoint = required('FINEVINES_REVIEW_STORAGE_ENDPOINT').replace(/\/$/, '');
const storageZone = required('FINEVINES_REVIEW_STORAGE_ZONE');
const storageKey = required('FINEVINES_REVIEW_STORAGE_KEY');
const databaseUrl = required('FINEVINES_REVIEW_DATABASE_URL');
const databaseToken = required('FINEVINES_REVIEW_DATABASE_TOKEN');
const dispatchToken = required('FINEVINES_REVIEW_GITHUB_DISPATCH_TOKEN');

async function bunny(path, { method = 'GET', body, acceptable = [] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      AccessKey: accountKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && !acceptable.includes(response.status)) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`${method} ${path} returned ${response.status}: ${detail}`);
  }
  if (response.status === 204 || response.status === 404) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function one(items, predicate, description) {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw new Error(`expected exactly one ${description}; found ${matches.length}`);
  return matches[0];
}

async function ensureScript(config) {
  const scripts = (await bunny('/compute/script')).Items ?? [];
  let matches = scripts.filter((script) => script.Name === config.scriptName && !script.Deleted);
  if (matches.length > 1) throw new Error(`duplicate Edge Scripts named ${config.scriptName}`);
  if (!matches.length) {
    await bunny('/compute/script', {
      method: 'POST',
      body: {
        Name: config.scriptName,
        Code: '',
        ScriptType: 1,
        CreateLinkedPullZone: true,
        LinkedPullZoneName: config.scriptName,
      },
    });
    const refreshed = (await bunny('/compute/script')).Items ?? [];
    matches = refreshed.filter((script) => script.Name === config.scriptName && !script.Deleted);
  }
  const summary = one(matches, () => true, `Edge Script named ${config.scriptName}`);
  const script = await bunny(`/compute/script/${summary.Id}`);
  if (script.ScriptType !== 1) throw new Error(`${config.scriptName} is not a Standalone/CDN script`);
  const pullZone = one(script.LinkedPullZones ?? [], () => true, `Pull Zone linked to ${config.scriptName}`);
  return { script, pullZone };
}

async function replaceVariables(script, values) {
  const current = script.EdgeScriptVariables ?? [];
  for (const [name, value] of Object.entries(values)) {
    const existing = current.filter((item) => item.Name === name);
    for (const variable of existing) {
      await bunny(`/compute/script/${script.Id}/variables/${variable.Id}`, { method: 'DELETE' });
    }
    await bunny(`/compute/script/${script.Id}/variables/add`, {
      method: 'POST',
      body: { Name: name, Required: true, DefaultValue: value },
    });
  }
}

async function upsertSecrets(script, values) {
  for (const [name, secret] of Object.entries(values)) {
    await bunny(`/compute/script/${script.Id}/secrets`, {
      method: 'PUT',
      body: { Name: name, Secret: secret },
    });
  }
}

async function ensureHostname(pullZoneId, host) {
  const pullZone = await bunny(`/pullzone/${pullZoneId}`);
  const dynamicSettings = {
    DisableCookies: false,
    CacheControlMaxAgeOverride: -1,
    CacheControlPublicMaxAgeOverride: -1,
    EnableSmartCache: true,
    EnableRequestCoalescing: false,
    CacheErrorResponses: false,
    UseStaleWhileUpdating: false,
    UseStaleWhileOffline: false,
  };
  if (Object.entries(dynamicSettings).some(([name, value]) => pullZone[name] !== value)) {
    await bunny(`/pullzone/${pullZoneId}`, { method: 'POST', body: dynamicSettings });
  }
  if ((pullZone.Hostnames ?? []).some((item) => item.Value === host)) return;
  await bunny(`/pullzone/${pullZoneId}/addHostname`, { method: 'POST', body: { Hostname: host } });
}

async function ensureDnsRecord(config, pullZone) {
  const zones = (await bunny('/dnszone')).Items ?? [];
  const zone = one(zones, (item) => item.Domain === config.domain, `DNS zone for ${config.domain}`);
  const full = await bunny(`/dnszone/${zone.Id}`);
  const existing = (full.Records ?? []).filter((record) => record.Name === 'review');
  if (existing.length) {
    const correct = existing.length === 1
      && existing[0].Type === 7
      && (existing[0].AcceleratedPullZoneId === pullZone.Id || existing[0].Value === pullZone.PullZoneName);
    if (!correct) throw new Error(`conflicting review DNS record already exists in ${config.domain}`);
    return;
  }
  await bunny(`/dnszone/${zone.Id}/records`, {
    method: 'PUT',
    body: {
      Type: 7,
      Ttl: 300,
      Value: pullZone.PullZoneName,
      Name: 'review',
      PullZoneId: pullZone.Id,
      Disabled: false,
      AutoSslIssuance: true,
    },
  });
}

async function requestCertificate(host) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await bunny(`/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(host)}&useOnlyHttp01=false`);
      return;
    } catch (error) {
      if (attempt === 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

for (const config of environments) {
  const sessionSecret = required(config.sessionEnv, 32);
  const { script, pullZone } = await ensureScript(config);
  await replaceVariables(script, {
    REVIEW_ENVIRONMENT: config.name,
    REVIEW_ORIGIN: `https://${config.host}`,
    REVIEW_COOKIE_NAME: config.cookie,
    GITHUB_REPOSITORY: repository,
    BUNNY_STORAGE_ENDPOINT: storageEndpoint,
    BUNNY_STORAGE_ZONE: storageZone,
    BUNNY_DATABASE_URL: databaseUrl,
    REVIEW_INCIDENT_RECIPIENT: config.incidentRecipient,
  });
  await upsertSecrets(script, {
    REVIEW_SESSION_SECRET: sessionSecret,
    BUNNY_STORAGE_KEY: storageKey,
    BUNNY_DATABASE_AUTH_TOKEN: databaseToken,
    GITHUB_DISPATCH_TOKEN: dispatchToken,
  });
  await ensureHostname(pullZone.Id, config.host);
  await ensureDnsRecord(config, pullZone);
  await requestCertificate(config.host);
  console.log(`${config.name}: script ${script.Id}, pull zone ${pullZone.Id}, host ${config.host}`);
}
