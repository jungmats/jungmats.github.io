/**
 * Test signer for the booking gateway's Web Bot Auth support (checklist 4.1,
 * see src/verify.js). Not deployed anywhere and not part of the gateway
 * itself — a local dev tool, same idea as eleviq-lab's
 * docs/reference/sign-request.mjs, adapted for POST + a JSON body.
 *
 * A real agent signs client-side with its OWN key; this script signs with
 * our own committed demo key (keys/booking-agent.jwk.json) purely to prove
 * the verification pipeline runs end-to-end.
 *
 * Setup: `npm install` in this directory (installs web-bot-auth).
 *
 * Use:
 *   node sign-request.mjs --url <gateway URL> [--body '<json>'] [--send]
 *
 *   --url    the URL to call, e.g.
 *            https://eleviq-booking-gateway.gateway-worker.workers.dev/book
 *   --body   JSON string to POST (default: a harmless /waitlist signup)
 *   --key    path to an Ed25519 JWK with a private component
 *            (default keys/booking-agent.jwk.json)
 *   --send   actually send the request and print the response;
 *            without it, print a ready-to-run curl instead
 */
import { readFileSync } from 'node:fs';
import { sign, generateNonce } from 'web-bot-auth';
import { signerFromJWK } from 'web-bot-auth/crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const url = arg('url');
const keyPath = arg('key', new URL('./keys/booking-agent.jwk.json', import.meta.url).pathname);
const doSend = arg('send', false);
const bodyStr = arg(
  'body',
  JSON.stringify({ name: 'Web Bot Auth test', email: 'webbotauth-test@example.com', topic: 'signature verification test', via: 'sign-request.mjs' })
);

if (!url) {
  console.error("usage: node sign-request.mjs --url <URL> [--body '<json>'] [--key <jwk>] [--send]");
  process.exit(1);
}

const jwk = JSON.parse(readFileSync(keyPath, 'utf8'));
const origin = new URL(url).origin;
const signatureAgent = `sig1="${origin}";type=directory`;

const now = new Date();
const fields = await sign(
  new Request(url, { method: 'POST', headers: { 'Signature-Agent': signatureAgent, 'Content-Type': 'application/json' } }),
  {
    signer: await signerFromJWK(jwk),
    created: now,
    expires: new Date(now.getTime() + 5 * 60_000),
    nonce: generateNonce(),
    target: '@target-uri',
    label: 'sig1',
  }
);

const headers = {
  'Signature-Input': fields.signatureInput,
  Signature: fields.signature,
  'Signature-Agent': signatureAgent,
  'Content-Type': 'application/json',
};

if (doSend) {
  const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
  console.error(`${res.status} ${res.statusText}\n`);
  console.log(await res.text());
} else {
  console.log(`curl -i '${url}' \\`);
  for (const [k, v] of Object.entries(headers)) console.log(`  -H '${k}: ${v}' \\`);
  console.log(`  -d '${bodyStr}'`);
}
