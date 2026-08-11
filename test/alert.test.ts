import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sendAlert, type AlertMessage } from '../src/alert.js';

const msg: AlertMessage = {
  target: 'https://shop.example.com',
  cycle: 4,
  summary: 'cycle 4: extraction failed — expected at least 4 item(s), got 0',
  at: '2026-08-11T00:00:00.000Z',
};

function captureServer() {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.end('ok');
    });
  });
  return new Promise<{ url: string; close: () => void; bodies: unknown[] }>((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/hook`, close: () => server.close(), bodies });
    });
  });
}

test('sendAlert: slack channel posts { text }', async () => {
  const cap = await captureServer();
  try {
    await sendAlert({ slack: cap.url }, msg);
    assert.equal(cap.bodies.length, 1);
    const body = cap.bodies[0] as { text: string };
    assert.ok(body.text.includes('shop.example.com'));
    assert.ok(body.text.includes('cycle 4'));
  } finally {
    cap.close();
  }
});

test('sendAlert: discord channel posts { content }', async () => {
  const cap = await captureServer();
  try {
    await sendAlert({ discord: cap.url }, msg);
    const body = cap.bodies[0] as { content: string };
    assert.ok(body.content.includes('shop.example.com'));
  } finally {
    cap.close();
  }
});

test('sendAlert: generic webhook receives the raw message', async () => {
  const cap = await captureServer();
  try {
    await sendAlert({ webhook: cap.url }, msg);
    assert.deepEqual(cap.bodies[0], msg);
  } finally {
    cap.close();
  }
});

test('sendAlert: multiple channels all fire', async () => {
  const a = await captureServer();
  const b = await captureServer();
  try {
    await sendAlert({ slack: a.url, discord: b.url }, msg);
    assert.equal(a.bodies.length, 1);
    assert.equal(b.bodies.length, 1);
  } finally {
    a.close();
    b.close();
  }
});

test('sendAlert: no channels is a no-op, not an error', async () => {
  await sendAlert({}, msg);
});

test('sendAlert: a dead channel makes the call throw with the channel count', async () => {
  await assert.rejects(
    sendAlert({ slack: 'http://127.0.0.1:1/nope', webhook: 'http://127.0.0.1:2/nope' }, msg),
    /2 alert channel\(s\) failed/,
  );
});
