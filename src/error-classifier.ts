/**
 * Error Classification — determines retry strategy based on error type.
 *
 * Categories:
 *   transient  → retry with standard backoff
 *   rate_limit → retry with longer delay
 *   permanent  → do not retry, fallback immediately
 *   crash      → do not retry, fallback immediately
 */

export type ErrorClass = "transient" | "rate_limit" | "permanent" | "crash"

export function classifyError(error: any): ErrorClass {
  const msg = String(error?.message || error?.stderr || "")

  // Crash: process killed, binary not found
  if (error?.exitCode === 137 || msg.includes("SIGKILL") || msg.includes("ENOENT")) {
    return "crash"
  }

  // Rate limit: HTTP 429 or quota errors
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
    return "rate_limit"
  }

  // Permanent: auth failures, not found
  if (
    msg.includes("auth") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("not found")
  ) {
    return "permanent"
  }

  // Everything else is transient (timeout, network, etc.)
  return "transient"
}
