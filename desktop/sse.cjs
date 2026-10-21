'use strict';
// A small pure parser for a server-sent event stream (the desktop reads GET /api/events with it). Feed it the text as it
// arrives, in any size of piece; it calls onEvent once for each complete event with the data parsed as JSON (or the raw text
// when the data is not JSON). Comment lines (": ping") and the id, retry and event fields are ignored, lines may end in LF,
// CRLF or CR, and the data lines of one event are joined with a newline. A block with no data line is not an event.
function createSseParser(onEvent) {
  let buffer = '';
  // A CR at the end of a piece may be the first half of a CRLF, so it waits for the next piece.
  let heldCr = false;
  let data = [];

  function dispatch() {
    if (!data.length) return;
    const text = data.join('\n');
    data = [];
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Not JSON: the raw text goes on as it is.
    }
    onEvent(value);
  }

  function line(text) {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return undefined;
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
    return undefined;
  }

  function feed(chunk) {
    let text = (heldCr ? '\r' : '') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    heldCr = text.endsWith('\r');
    if (heldCr) text = text.slice(0, -1);
    buffer += text.replace(/\r\n|\r/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const one = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      line(one);
    }
  }

  return { feed };
}

module.exports = { createSseParser };
