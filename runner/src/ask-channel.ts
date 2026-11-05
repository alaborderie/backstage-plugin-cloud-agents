import { rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';

/**
 * The runner listens on a Unix socket; each `cloud-agent mcp-ask` process sends one JSON line per tool call
 * and waits for one reply line. The runner answers `ask_user` at once with no answer, and calls the plugin
 * for the hub tools, so the run's token never reaches the harness.
 */
export interface ToolCall {
  tool: string;
  input: unknown;
}

export interface ToolReply {
  text: string;
  isError: boolean;
}

export async function openToolChannel(path: string, onCall: (call: ToolCall) => Promise<ToolReply>): Promise<{ close(): Promise<void> }> {
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let call: ToolCall;
        try {
          call = JSON.parse(line) as ToolCall;
        } catch {
          continue;
        }
        void onCall(call)
          .catch((e: unknown) => ({ text: e instanceof Error ? e.message : String(e), isError: true }))
          .then((reply) => socket.write(`${JSON.stringify(reply)}\n`));
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      }),
  };
}

export function callTool(path: string, call: ToolCall, timeoutMs: number): Promise<ToolReply | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const done = (reply: ToolReply | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    socket.on('error', () => {
      done(null);
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(call)}\n`));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, end)) as ToolReply);
      } catch {
        done(null);
      }
    });
    socket.on('end', () => {
      done(null);
    });
  });
}
