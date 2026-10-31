// Minimal RFC6455 WebSocket SERVER for tests (Node has a WS client built in, but no server).
// Text frames only, masked client frames, ping→pong, close — just enough to stand in for the
// Discord Gateway and Slack Socket Mode endpoints so the real providers can be driven e2e.
import http from "node:http";
import crypto from "node:crypto";

export function createWsStub(onConn) {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    const conn = {
      send(obj) { try { socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), "utf8"))); } catch {} },
      close() { try { socket.end(frame(0x8, Buffer.alloc(0))); } catch {} },
      onJson: () => {},
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = decodeFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.consumed);
        if (f.opcode === 0x9) socket.write(frame(0xa, f.payload));                       // ping → pong
        else if (f.opcode === 0x8) { try { socket.write(frame(0x8, Buffer.alloc(0))); } catch {} socket.destroy(); }
        else if (f.opcode === 0x1) { try { conn.onJson(JSON.parse(f.payload.toString("utf8"))); } catch {} }
      }
    });
    socket.on("error", () => {});
    onConn(conn);
  });
  return server;
}

function frame(opcode, payload) {
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([head, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, consumed: off + maskLen + len };
}
