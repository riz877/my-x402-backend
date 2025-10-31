const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function genJWT(cdpApiKeyId, cdpPrivateKey) {
  if (!cdpApiKeyId || !cdpPrivateKey) throw new Error('Missing env vars');

  const header = { alg: 'ES256', typ: 'JWT', kid: cdpApiKeyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: cdpApiKeyId, iss: 'coinbase-cloud', aud: ['api.developer.coinbase.com'], nbf: now, exp: now + 120, iat: now };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  // Normalize private key: accept PEM or base64 DER
  let privateKeyDerBuffer;
  if (typeof cdpPrivateKey === 'string' && cdpPrivateKey.includes('-----BEGIN')) {
    const keyObj = crypto.createPrivateKey({ key: cdpPrivateKey, format: 'pem', type: 'pkcs8' });
    privateKeyDerBuffer = keyObj.export({ format: 'der', type: 'pkcs8' });
  } else {
    privateKeyDerBuffer = Buffer.from(cdpPrivateKey, 'base64');
  }

  const sign = crypto.createSign('SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign({ key: privateKeyDerBuffer, format: 'der', type: 'pkcs8' });
  const signatureUrl = base64url(signature);

  return `${message}.${signatureUrl}`;
}

try {
  const id = process.env.CDP_API_KEY_ID;
  const key = process.env.CDP_PRIVATE_KEY;
  const jwt = genJWT(id, key);
  console.log('JWT:', jwt);
} catch (e) {
  console.error('Error generating JWT:', e.message);
  process.exit(1);
}
