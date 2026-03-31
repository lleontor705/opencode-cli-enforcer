/**
 * Secret Redaction — removes API keys and tokens from text before
 * returning it to the user in error messages or logs.
 */

export function redactSecrets(text: string): string {
  return text
    .replace(/(?:sk-|key-|AIza|ant-api)[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/g, "Bearer [REDACTED]")
}
