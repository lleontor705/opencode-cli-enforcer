/**
 * Order-tolerant pairing between Claude Code tools/call requests and the host's
 * tool results (REQ-CB-TOOL-002/003, D3).
 *
 * Call order does not reliably match the order Claude Code emits its tool_use
 * blocks, so pairing is keyed by Claude's own tool_use id rather than arrival
 * position. A result may reach the bridge before its call is parked, or the
 * reverse, so both sides wait in a map until the counterpart lands.
 */

/** A single MCP text content block. Handlers only ever return text. */
export interface ToolTextContent {
  readonly type: "text";
  readonly text: string;
}

/** The MCP-shaped result handed back to a parked tools/call handler. */
export interface ToolResult {
  readonly content: readonly ToolTextContent[];
  readonly isError?: boolean;
}

interface PendingToolCall {
  readonly toolName: string;
  readonly resolve: (result: ToolResult) => void;
}

export class ToolRendezvous {
  /** Parked tools/call handlers, keyed by Claude's tool_use id. */
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  /** Results that arrived before their call, keyed by Claude's tool_use id. */
  private readonly pendingResults = new Map<string, ToolResult>();

  get pendingToolCallCount(): number {
    return this.pendingToolCalls.size;
  }

  get pendingResultCount(): number {
    return this.pendingResults.size;
  }

  hasPendingToolCall(toolUseId: string): boolean {
    return this.pendingToolCalls.has(toolUseId);
  }

  hasPendingResult(toolUseId: string): boolean {
    return this.pendingResults.has(toolUseId);
  }

  /**
   * Park a tools/call handler until its result arrives. When the result was
   * buffered first, resolve immediately instead of parking.
   */
  awaitToolResult(toolUseId: string, toolName: string): Promise<ToolResult> {
    const buffered = this.pendingResults.get(toolUseId);
    if (buffered !== undefined) {
      this.pendingResults.delete(toolUseId);
      return Promise.resolve(buffered);
    }
    return new Promise<ToolResult>((resolve) => {
      this.pendingToolCalls.set(toolUseId, { toolName, resolve });
    });
  }

  /**
   * Deliver a host tool result. Returns true when it unblocked a parked
   * handler, false when it was buffered for a call that has not arrived yet.
   */
  deliverToolResult(toolUseId: string, result: ToolResult): boolean {
    const parked = this.pendingToolCalls.get(toolUseId);
    if (parked === undefined) {
      this.pendingResults.set(toolUseId, result);
      return false;
    }
    this.pendingToolCalls.delete(toolUseId);
    parked.resolve(result);
    return true;
  }

  /**
   * Resolve every parked handler with an explanatory text result and drop all
   * pending state. Handlers MUST be resolved, never rejected: a rejected
   * handler leaves Claude Code's tools/call open forever and wedges the turn.
   */
  releasePendingToolCalls(reason: string): void {
    const released: ToolResult = {
      content: [{ type: "text", text: reason }],
      isError: true,
    };
    for (const parked of this.pendingToolCalls.values()) parked.resolve(released);
    this.pendingToolCalls.clear();
    this.pendingResults.clear();
  }
}
