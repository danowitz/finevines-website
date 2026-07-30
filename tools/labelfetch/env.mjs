// Where the Node image pipeline finds the two things it needs from its
// environment: the Go helper binaries, and the OpenAI key.
//
// Both were Windows-only by accident rather than by design, and both silently
// produced zero images on Linux. The binaries were invoked as bare
// "imgcheck.exe", which cmd.exe resolves from the working directory and a POSIX
// shell does not; the key was read only out of .env, a file that does not exist
// in CI, where secrets arrive as environment variables. Resolved here, once, so
// the same commands run on a workstation and on ubuntu-latest.
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

// openaiKey prefers the real environment variable and falls back to .env, so a
// workstation keeps working with no changes and CI needs no .env file at all.
// A missing key is an empty string, not a throw: the fetch pipeline runs without
// vision at a lower recovery rate, while the watermark sweep cannot — so the
// caller, not this function, decides whether absence is fatal.
export async function openaiKey(env = process.env, envPath = '.env') {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY.trim();
  try {
    return (await readFile(envPath, 'utf8')).match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}
