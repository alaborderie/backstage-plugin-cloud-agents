import { rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';

/**
 * The runner listens on a Unix socket; each `cloud-agent mcp-ask` process sends one JSON line per ask_user call
 * and waits for one reply line. Version 1 replies at once with no answer. A later version can hold the reply
 * until an operator answers, which makes ask_user block without changing the MCP side.
 */
export interface AskReply {
  answer: string | null;
}

export async function openAskChannel(path: string, onQuestion: (input: unknown) => AskReply): Promise<{ close(): Promise<void> }> {
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let input: unknown;
        try {
          input = JSON.parse(line);
        } catch {
          continue;
        }
        socket.write(`${JSON.stringify(onQuestion(input))}\n`);
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

export function sendQuestion(path: string, input: unknown, timeoutMs = 10_000): Promise<AskReply | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    const done = (reply: AskReply | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    socket.on('error', () => {
      done(null);
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(input)}\n`));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, end)) as AskReply);
      } catch {
        done(null);
      }
    });
    socket.on('end', () => {
      done(null);
    });
  });
}
