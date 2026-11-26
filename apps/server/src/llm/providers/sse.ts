/**
 * Server-Sent Events decoding shared by the streaming provider transports.
 */

/**
 * Yield the joined `data:` payload of each SSE block in `body`, in order.
 *
 * Blocks without data are skipped. A final block that the server left unterminated is still
 * yielded. The reader is cancelled when the consumer stops early or the stream fails, so an
 * abandoned response does not keep its connection open.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  // A streaming decoder keeps multi-byte characters intact when a chunk boundary splits them.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const data = (block: string) => block.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A lone trailing CR waits for its LF in the next chunk instead of faking a blank line.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const payload = data(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (payload) yield payload;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        const payload = buffer.trim() ? data(buffer) : '';
        if (payload) yield payload;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
