/**
 * OS Detection — resolves once at import time.
 */

export type Platform = "windows" | "macos" | "linux"

export function detectPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows"
    case "darwin":
      return "macos"
    default:
      return "linux"
  }
}

export const PLATFORM = detectPlatform()
export const IS_WINDOWS = PLATFORM === "windows"
