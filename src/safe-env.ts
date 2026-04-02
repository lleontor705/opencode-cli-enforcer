/**
 * Environment Variable Filtering — only passes safe variables to
 * spawned CLI processes, preventing accidental secret leakage.
 *
 * CLIs handle their own auth inline (claude login, gcloud auth, etc.)
 * so we just need system essentials + proxy settings.
 */

export const SAFE_ENV_VARS = [
  // System essentials
  "PATH",
  "HOME",
  "USER",
  "TERM",
  "SHELL",
  "LANG",
  "LC_ALL",
  // Windows
  "USERPROFILE",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  // Proxy
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]

export function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}
