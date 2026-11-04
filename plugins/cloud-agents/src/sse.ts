export interface SseMessage {
  id: string | undefined;
  event: string;
  data: string;
}

/** Parses one SSE block. Comment lines, such as `: ping`, carry nothing. */
export function parseSseBlock(block: string): SseMessage | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { id, event, data: data.join('\n') } : undefined;
}

/**
 * Reads a `text/event-stream` body to its end. The browser's EventSource
 * cannot send the Backstage token, so the plugin reads the stream with fetch.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const message = parseSseBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (message) onMessage(message);
      end = buffer.indexOf('\n\n');
    }
  }
}
