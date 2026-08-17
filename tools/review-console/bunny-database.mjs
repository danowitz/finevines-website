export function requireBunnyDatabaseUrl(value) {
  const url = value?.trim();
  if (!url) throw new Error('FINEVINES_REVIEW_DATABASE_URL is required');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('FINEVINES_REVIEW_DATABASE_URL must be a valid Bunny Database URL');
  }
  if (parsed.protocol !== 'libsql:' || !parsed.hostname.endsWith('.lite.bunnydb.net')) {
    throw new Error('FINEVINES_REVIEW_DATABASE_URL must use Bunny Database (*.lite.bunnydb.net)');
  }
  return url;
}
