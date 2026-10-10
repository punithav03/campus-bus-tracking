/**
 * Generates a self-signed certificate for local hosting.
 *
 * Why this is needed: browsers only expose `navigator.geolocation` on a SECURE
 * origin. `localhost` counts as secure, but `http://10.x.x.x:3100` from your
 * phone does not — so /drive would silently be denied GPS. Serving over HTTPS,
 * even with a self-signed certificate, makes the phone a usable bus tracker.
 *
 * The certificate covers localhost plus every LAN address this machine
 * currently has, so it keeps working when you switch Wi-Fi networks (re-run it).
 *
 *   node scripts/make-cert.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = join(ROOT, '.cert');

/**
 * The addresses a phone on the same Wi-Fi could actually reach.
 *
 * This used to skip every 172.x address to dodge WSL and Hyper-V virtual
 * switches. That is too blunt: 172.16-172.31 is a real private range, and on
 * a college network the laptop's own Wi-Fi address often sits in it — so the
 * one address that mattered was the one being thrown away, and the server
 * reported "not connected to a network" while plainly connected.
 *
 * Filter by what the adapter IS, not by the number it was given. Virtual
 * switches announce themselves in their names; APIPA addresses mean the
 * adapter never got a lease and leads nowhere.
 */
const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|loopback|bluetooth/i;

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;   // no DHCP lease
      out.push(a.address);
    }
  }
  // Wi-Fi first: it is the one the phone is on.
  return out;
}

export function certPaths() {
  return { key: join(CERT_DIR, 'key.pem'), cert: join(CERT_DIR, 'cert.pem') };
}

/** True when the existing cert already covers every address we need. */
function certCovers(certPath, ips) {
  try {
    const text = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], {
      encoding: 'utf8',
    });
    return ips.every((ip) => text.includes(`IP Address:${ip}`));
  } catch {
    return false;
  }
}

export function ensureCert({ quiet = false } = {}) {
  const ips = lanAddresses();
  const { key, cert } = certPaths();

  if (existsSync(key) && existsSync(cert) && certCovers(cert, ips)) {
    if (!quiet) console.log('· certificate already covers', ips.join(', ') || 'localhost');
    return { key, cert, ips };
  }

  mkdirSync(CERT_DIR, { recursive: true });
  const san = [
    'DNS:localhost',
    'IP:127.0.0.1',
    ...ips.map((ip) => `IP:${ip}`),
  ].join(',');

  if (!quiet) console.log('· generating certificate for', san);

  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '825',
      '-keyout', key,
      '-out', cert,
      '-subj', '/CN=campus-bus.local',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
    ],
    { stdio: 'pipe' },
  );

  return { key, cert, ips };
}

export function readCert() {
  const { key, cert } = certPaths();
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// pathToFileURL, not string concatenation — Windows paths produce `file:///C:/…`
// with three slashes and a naive comparison silently never matches.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ips } = ensureCert();
  console.log('\n✓ .cert/key.pem and .cert/cert.pem ready');
  console.log('  covers: localhost, 127.0.0.1' + (ips.length ? ', ' + ips.join(', ') : ''));
}
