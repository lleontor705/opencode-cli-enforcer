/**
 * Ack-carrying stdin prompt stream (REQ-CB-TOOL-004, design D3).
 *
 * Ported from pi-claude-bridge `src/prompt-stream.ts`. The Agent SDK accepts
 * `prompt: AsyncIterable<SDKUserMessage>` and pumps it to the Claude Code CLI's
 * stdin. Keeping that iterable parked for the life of the query is what lets a
 * steer be written *while* a tool is running, so CC drains it at the next tool
 * boundary (`priority: "next"`) instead of treating it as a follow-up turn.
 *
 * The ack is load-bearing: `push()` resolves on the line after `yield`, and the
 * SDK's pump is `for await (m of stream) { await transport.write(m) }`, so
 * resuming past the yield proves the stdin write completed. Tool-result
 * delivery awaits that ack first, which is what guarantees CC observes a steer
 * before the tool result travelling back over the same stdin FIFO.
 *
 * The drain and the FIFO ordering are Claude Code CLI internals, not SDK
 * contract, so either can break under a CC upgrade without any type error.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
  stream: AsyncGenerator<SDKUserMessage>;
  /** Enqueue a message; resolves once the SDK has written it to stdin.
   *  Rejects (never hangs) if the stream is already ended or failed. */
  push: (msg: SDKUserMessage) => Promise<void>;
  /** Close the input: the generator returns, the SDK closes the CLI's stdin. */
  end: () => void;
  /** Abandon the input, rejecting every queued and in-flight ack. */
  fail: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
  type Item = { msg: SDKUserMessage; resolve: () => void; reject: (error: Error) => void };
  const queue: Item[] = [];
  // The item currently parked at `yield`, tracked separately so fail() can
  // settle it: a dying CLI may abandon the pump without ever resuming us, and
  // an unsettled ack would wedge tool-result delivery forever.
  let inflight: Item | null = null;
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = () => {
    wake?.();
    wake = null;
  };

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure) throw failure;
        const item = queue.shift();
        if (!item) return; // ended and drained
        inflight = item;
        try {
          yield item.msg;
          item.resolve();
        } finally {
          // Reached either normally (no-op, already resolved) or when the pump
          // abandons iteration — a `for await` break/throw calls gen.return(),
          // which resumes the yield as a return.
          item.reject(new Error("prompt stream closed"));
          inflight = null;
        }
      }
    } finally {
      // No consumer is left to drain the queue, so nothing would ever settle a
      // later push. Closing here keeps the reject-never-hang contract a
      // property of this module rather than of every call site.
      done = true;
    }
  }

  return {
    stream: gen(),
    push: (msg) =>
      failure || done
        ? Promise.reject(failure ?? new Error("prompt stream closed"))
        : new Promise<void>((resolve, reject) => {
            queue.push({ msg, resolve, reject });
            kick();
          }),
    end: () => {
      done = true;
      kick();
    },
    fail: (error) => {
      // First failure wins: the query's `finally` fails the stream a second
      // time with a generic "query ended", which would otherwise mask the real
      // cause its `catch` recorded.
      if (failure) return;
      failure = error;
      queue.splice(0).forEach((item) => item.reject(error));
      inflight?.reject(error);
      kick();
    },
  };
}

/** `uuid` is deliberately omitted: no dedup is needed, and supplying one makes
 *  CC's stdin loop do a session lookup on the message. */
export function userMessage(
  content: SDKUserMessage["message"]["content"],
  priority?: SDKUserMessage["priority"],
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}
