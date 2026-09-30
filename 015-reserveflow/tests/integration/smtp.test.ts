import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../src/server/services/notifications.js';

// Minimal local SMTP sink (no TLS) to verify the real SMTP transport path end-to-end.
let server: Server;
let port = 0;
const received: string[] = [];
beforeAll(async () => {
  server = createServer((sock) => {
    let data = false;
    let buf = '';
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while (true) {
        if (data) {
          i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          received.push(buf.slice(0, i));
          buf = buf.slice(i + 5);
          data = false;
          sock.write('250 queued\r\n');
          continue;
        }
        i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250 8BITMIME\r\n');
        else if (cmd === 'DATA') {
          data = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe('SMTP 送信経路', () => {
  it('nodemailer 経由で plain text メールを送信できる（件名の改行は除去）', async () => {
    const m = new SmtpMailer(`smtp://127.0.0.1:${port}`);
    const id = await m.send({ to: 'guest@example.test', subject: '【店】ご予約\r\nBcc: evil@example.test', text: '本文です\nhttps://x/manage#t=abc' }, 'Shop <no-reply@example.test>');
    expect(id).toBeTruthy();
    expect(received).toHaveLength(1);
    const raw = received[0];
    expect(raw).toMatch(/^To: guest@example\.test/m);
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
  });
});
