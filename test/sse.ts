// Fake Claude servers build a whole message; this sends it as the event stream the SDK reads when a call is streamed.
import type http from 'node:http';

export function sendStream(res: http.ServerResponse, msg: any) {
  const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.setHeader('content-type', 'text/event-stream');
  ev('message_start', { message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((block: object, index: number) => { ev('content_block_start', { index, content_block: block }); ev('content_block_stop', { index }); });
  ev('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null, stop_details: null }, usage: msg.usage });
  ev('message_stop', {});
  res.end();
}
