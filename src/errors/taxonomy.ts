/**
 * Closed error taxonomy for the bridge (REQ-CB-ERR-002).
 *
 * Every error the bridge surfaces MUST be classified into exactly one of these
 * categories, carrying a stable machine-readable code from that category's
 * registry. Codes are append-only: adding a code is backward compatible, while
 * renaming or removing one breaks downstream consumers.
 */
export const BRIDGE_ERROR_CATEGORIES = [
  "config",
  "transport",
  "tool",
  "stream",
  "rate-limit",
  "session-mirror",
] as const;

export type BridgeErrorCategory = (typeof BRIDGE_ERROR_CATEGORIES)[number];

export const BRIDGE_ERROR_CODES = {
  config: [
    "CB_CONFIG_INVALID_OPTIONS",
    "CB_CONFIG_MISSING_ACKNOWLEDGMENT",
  ],
  transport: [
    "CB_TRANSPORT_SPAWN_FAILED",
    "CB_TRANSPORT_TRANSIENT",
    "CB_TRANSPORT_PROTOCOL",
    "CB_TRANSPORT_FATAL_FRAME",
  ],
  tool: [
    "CB_TOOL_UNKNOWN",
    "CB_TOOL_INVALID_SCHEMA",
    "CB_TOOL_UNPAIRED_RESULT",
  ],
  stream: [
    "CB_STREAM_UNSENDABLE_PROMPT",
    "CB_STREAM_MAPPING_FAILED",
    "CB_STREAM_ABORTED",
  ],
  "rate-limit": [
    "CB_RATE_LIMIT_EXCEEDED",
  ],
  "session-mirror": [
    "CB_SESSION_MIRROR_INTEGRITY",
    "CB_SESSION_MIRROR_WRITE_FAILED",
    "CB_SESSION_MIRROR_DIVERGENCE",
  ],
} as const satisfies Record<BridgeErrorCategory, readonly string[]>;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[BridgeErrorCategory][number];

export function isBridgeErrorCategory(value: string): value is BridgeErrorCategory {
  return (BRIDGE_ERROR_CATEGORIES as readonly string[]).includes(value);
}

export function isBridgeErrorCode(value: string): value is BridgeErrorCode {
  return BRIDGE_ERROR_CATEGORIES.some((category) =>
    (BRIDGE_ERROR_CODES[category] as readonly string[]).includes(value),
  );
}

export function codesForCategory(category: BridgeErrorCategory): readonly string[] {
  return BRIDGE_ERROR_CODES[category];
}

export function categoryOfCode(code: BridgeErrorCode): BridgeErrorCategory {
  for (const category of BRIDGE_ERROR_CATEGORIES) {
    if ((BRIDGE_ERROR_CODES[category] as readonly string[]).includes(code)) return category;
  }
  throw new Error(`cli-providers: unknown taxonomy code ${code}`);
}

export interface BridgeErrorOptions {
  readonly cause?: unknown;
  /** True when retrying the same operation can succeed without a code change. */
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class BridgeError extends Error {
  readonly category: BridgeErrorCategory;
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    category: BridgeErrorCategory,
    code: BridgeErrorCode,
    message: string,
    options: BridgeErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BridgeError";
    this.category = category;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};

    // The closed set is a runtime invariant, not just a compile-time one: a code
    // fabricated outside its category would defeat every isBridgeErrorCode check.
    if (categoryOfCode(code) !== category) {
      throw new Error(`cli-providers: taxonomy code ${code} does not belong to category ${category}`);
    }
  }
}

/** Classified error factory: the single sanctioned way to raise a bridge error. */
export function bridgeError(
  category: BridgeErrorCategory,
  code: BridgeErrorCode,
  message: string,
  options: BridgeErrorOptions = {},
): BridgeError {
  return new BridgeError(category, code, message, options);
}

/** Wraps an arbitrary thrown value so it carries a taxonomy code, preserving an
 *  already-classified error unchanged. */
export function toBridgeError(
  error: unknown,
  category: BridgeErrorCategory,
  code: BridgeErrorCode,
): BridgeError {
  if (error instanceof BridgeError) return error;
  return bridgeError(category, code, errorSignature(error), { cause: error });
}

/**
 * Signatures of transient transport failures: the child process, socket, or
 * upstream HTTP layer dropped a request that a retry can replay.
 */
const TRANSIENT_TRANSPORT_SIGNATURES: readonly RegExp[] = [
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bECONNABORTED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bsocket hang up\b/i,
  /\btemporarily unavailable\b/i,
  /\bnetwork (?:error|failure|unreachable)\b/i,
  /\btime[ds]?\s?out\b/i,
  /\b(?:429|502|503|504)\b/,
  /\boverloaded\b/i,
];

export function isTransientTransportError(error: unknown): boolean {
  const signature = errorSignature(error);
  return TRANSIENT_TRANSPORT_SIGNATURES.some((pattern) => pattern.test(signature));
}

/** Classifies a transport-layer failure, tagging transient failures retryable. */
export function classifyTransportError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const retryable = isTransientTransportError(error);
  return bridgeError(
    "transport",
    retryable ? "CB_TRANSPORT_TRANSIENT" : "CB_TRANSPORT_PROTOCOL",
    `cli-providers transport error: ${errorSignature(error)}`,
    { cause: error, retryable },
  );
}

function errorSignature(error: unknown): string {
  const signature: string[] = [];
  if (error instanceof Error) {
    signature.push(error.name, error.message);
  } else {
    signature.push(safeString(error));
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" || typeof code === "number") signature.push(String(code));
  return signature.filter((part) => part.length > 0).join(" ");
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
