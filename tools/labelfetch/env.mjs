// Where the Node image pipeline finds the things it needs from its
// environment: the Go helper binaries, and any secret normally kept in .env
// (the OpenAI key, the Google Custom Search key/cx).
//
// All of it was Windows-only by accident rather than by design, and all of it
// silently broke on Linux. The binaries were invoked as bare "imgcheck.exe",
// which cmd.exe resolves from the working directory and a POSIX shell does
// not; the secrets were read only out of .env, a file that does not exist in
// CI, where they arrive as environment variables instead — and reading it
// unconditionally, with no try/catch, doesn't just miss the secret, it throws
// ENOENT and kills the whole script. Resolved here, once, so the same
// commands run on a workstation and on ubuntu-latest.
import { readFile } from 'node:fs/promises';

// binPath resolves a Go helper built into the repo root.
//
// FINEVINES_<NAME>_BIN overrides it outright, for a CI job that builds
// elsewhere or a cross-build. Otherwise: the historical .exe name on Windows,
// and an explicit ./ prefix everywhere else, because execFile does not search
// the working directory on POSIX and would report ENOENT with the binary
// sitting right next to it.
export function binPath(name, platform = process.platform, env = process.env) {
  const override = env[`FINEVINES_${name.toUpperCase()}_BIN`];
  if (override) return override;
  return platform === 'win32' ? `${name}.exe` : `./${name}`;
}

// envOrFile prefers the real environment variable and falls back to the same
// key inside .env, so a workstation keeps working with no changes and CI needs
// no .env file at all. A missing key — env unset AND no .env AND the key not
// in it — is an empty string, not a throw: every caller of this (the OpenAI
// key, the Google Custom Search key/cx) already treats absence as "the feature
// is simply off" rather than fatal, and a thrown ENOENT here would crash the
// whole pipeline before a single wine is selected. That crash is exactly the
// bug this function exists to close: the Google CSE key block used to read
// .env directly and unconditionally, so on ubuntu-latest — where .env does not
// exist — it took the entire script down before anything ran.
export async function envOrFile(name, env = process.env, envPath = '.env') {
  if (env[name]) return env[name].trim();
  try {
    const re = new RegExp(`^${name}=(.*)$`, 'm');
    return (await readFile(envPath, 'utf8')).match(re)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

// openaiKey is envOrFile pinned to OPENAI_API_KEY, kept as its own named
// export because it is the one key every labelfetch tool needs and callers
// read better as `await openaiKey()` than `await envOrFile('OPENAI_API_KEY')`.
// A missing key is an empty string, not a throw: the fetch pipeline runs
// without vision at a lower recovery rate, while the watermark sweep cannot —
// so the caller, not this function, decides whether absence is fatal.
export async function openaiKey(env = process.env, envPath = '.env') {
  return envOrFile('OPENAI_API_KEY', env, envPath);
}
