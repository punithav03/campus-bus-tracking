/**
 * Local host.
 *
 * Serves the app on this machine AND on the Wi-Fi network, over both HTTP and
 * HTTPS. Nothing leaves the laptop — there is no tunnel and no cloud.
 *
 *   http://localhost:3100          fine for the student view on this machine
 *   https://<lan-ip>:3443          use this on your phone
 *
 * The phone needs HTTPS because browsers refuse `navigator.geolocation` on an
 * insecure origin, which would leave /drive unable to read GPS.
 *
 *   npm run host        build, then serve
 *   npm run host:fast   serve an existing build
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import next from 'next';
import qrcode from 'qrcode-terminal';
import { ensureCert, readCert, lanAddresses } from './scripts/make-cert.mjs';

const HTTP_PORT = Number(process.env.PORT ?? 3100);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3443);
const dev = process.env.NODE_ENV === 'development';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function listen(server, port, label) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          C.yellow(`! ${label} port ${port} is already in use.`) +
            `\n  Something else is serving it — stop that first:\n` +
            C.dim(`    netstat -ano | findstr :${port}\n    taskkill /PID <pid> /F\n`),
        );
        process.exit(1);
      }
      throw err;
    });
    server.listen(port, '0.0.0.0', () => resolve());
  });
}

const app = next({ dev, hostname: '0.0.0.0', port: HTTP_PORT });
const handle = app.getRequestHandler();

await app.prepare();

let cert = null;
try {
  ensureCert({ quiet: true });
  cert = readCert();
} catch (err) {
  console.error(C.yellow('! could not create a certificate — HTTPS disabled.'));
  console.error(C.dim(`  ${err.message}`));
  console.error(C.dim('  The student view still works over HTTP; /drive will not get GPS.'));
}

await listen(createHttpServer((req, res) => handle(req, res)), HTTP_PORT, 'HTTP');
if (cert) {
  await listen(
    createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => handle(req, res)),
    HTTPS_PORT,
    'HTTPS',
  );
}

const ips = lanAddresses();
const phoneUrl = cert && ips.length ? `https://${ips[0]}:${HTTPS_PORT}` : null;

console.log('');
console.log(C.bold('  Campus Bus — SVPCET') + C.dim(`  ${dev ? 'development' : 'production'}`));
console.log('');
console.log(`  ${C.dim('this laptop  ')} ${C.cyan(`http://localhost:${HTTP_PORT}`)}`);
if (cert) {
  for (const ip of ips) {
    console.log(`  ${C.dim('on Wi-Fi     ')} ${C.green(`https://${ip}:${HTTPS_PORT}`)}`);
  }
}
if (!ips.length) console.log(`  ${C.dim('on Wi-Fi     ')} ${C.yellow('not connected to a network')}`);
console.log('');

if (phoneUrl) {
  console.log(C.dim('  Scan on your phone (same Wi-Fi). The certificate is self-signed,'));
  console.log(C.dim('  so tap through the browser warning once — it is your own machine.'));
  console.log('');
  qrcode.generate(phoneUrl, { small: true }, (q) =>
    console.log(q.split('\n').map((l) => '  ' + l).join('\n')),
  );
  console.log(`  ${C.dim(phoneUrl)}`);
  console.log('');
}

console.log(C.dim('  /        student view      /drive  broadcaster      /admin  transport office'));
console.log(C.dim('  Ctrl-C to stop'));
console.log('');
