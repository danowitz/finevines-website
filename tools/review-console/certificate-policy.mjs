export function shouldDeferCertificate({ environment, status, detail }) {
  if (environment !== 'production' || status !== 400) return false;
  try {
    return JSON.parse(detail)?.ErrorKey === 'pullzone.certificate_request_failed';
  } catch {
    return false;
  }
}
