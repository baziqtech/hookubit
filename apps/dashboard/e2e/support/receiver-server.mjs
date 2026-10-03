// The consumer on the other end of a delivery.
//
// Records every POST it receives - headers, raw body bytes, arrival time - and
// answers 200. `GET /__received` hands the list to the test, which verifies the
// HMAC itself (the receiver must not know the secret: a test that verified
// here could not fail on a wrong secret in the right place).
//
// `POST /__mode` switches the reply: `{ "status": 500 }` makes every delivery
// fail, which is how the retry, breaker and pause flows get something to show.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9797);
const received = [];
let mode = { status: 200 };

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/__health') return res.writeHead(200).end('ok');
    if (req.url === '/__received') {
      res.setHeader('content-type', 'application/json');
      return res.writeHead(200).end(JSON.stringify(received));
    }
    if (req.url === '/__reset') {
      received.length = 0;
      mode = { status: 200 };
      return res.writeHead(200).end('reset');
    }
    if (req.url === '/__mode') {
      mode = JSON.parse(body.toString('utf8') || '{}');
      return res.writeHead(200).end('ok');
    }
    received.push({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.toString('utf8'),
    });
    res.writeHead(mode.status ?? 200).end(mode.status >= 500 ? 'simulated outage' : 'ok');
  });
}).listen(port, '127.0.0.1', () => console.log(`receiver listening on 127.0.0.1:${port}`));
