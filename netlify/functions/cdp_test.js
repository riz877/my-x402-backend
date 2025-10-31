const axios = require('axios');
const crypto = require('crypto');

// Admin-only test endpoint to send a single test event to Coinbase CDP.
// Protect this endpoint with a secret set in Netlify as ADMIN_TOKEN.

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generateCoinbaseJWTFromEnv() {
  const { CDP_API_KEY_ID, CDP_PRIVATE_KEY } = process.env;
  if (!CDP_API_KEY_ID || !CDP_PRIVATE_KEY) return null;

  const header = { alg: 'ES256', typ: 'JWT', kid: CDP_API_KEY_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: CDP_API_KEY_ID, iss: 'coinbase-cloud', aud: ['api.developer.coinbase.com'], nbf: now, exp: now + 120, iat: now };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  let privateKeyDerBuffer;
  try {
    if (typeof CDP_PRIVATE_KEY === 'string' && CDP_PRIVATE_KEY.includes('-----BEGIN')) {
      const keyObj = crypto.createPrivateKey({ key: CDP_PRIVATE_KEY, format: 'pem', type: 'pkcs8' });
      privateKeyDerBuffer = keyObj.export({ format: 'der', type: 'pkcs8' });
    } else {
      privateKeyDerBuffer = Buffer.from(CDP_PRIVATE_KEY, 'base64');
    }
  } catch (err) {
    throw new Error('Failed to parse CDP_PRIVATE_KEY: ' + err.message);
  }

  const sign = crypto.createSign('SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign({ key: privateKeyDerBuffer, format: 'der', type: 'pkcs8' });
  return `${message}.${base64url(signature)}`;
}

async function reportTestEvent() {
  const { CDP_API_URL, CDP_PROJECT_ID } = process.env;
  if (!CDP_API_URL || !CDP_PROJECT_ID) throw new Error('Missing CDP_API_URL or CDP_PROJECT_ID');

  const jwt = generateCoinbaseJWTFromEnv();
  if (!jwt) throw new Error('Failed to generate JWT - check CDP_API_KEY_ID / CDP_PRIVATE_KEY');

  const endpoint = `${CDP_API_URL.replace(/\/$/, '')}/v1/projects/${CDP_PROJECT_ID}/events`;
  const payload = {
    event_name: 'x402_admin_test',
    event_type: 'test',
    network: 'base',
    timestamp: new Date().toISOString(),
    properties: { note: 'admin test event from cdp_test function' }
  };

  const res = await axios.post(endpoint, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`
    },
    timeout: 10000,
    validateStatus: (s) => s < 500
  });

  return { status: res.status, data: res.data };
}

exports.handler = async (event) => {
  try {
    const adminTokenHeader = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
    if (!adminTokenHeader) return { statusCode: 401, body: JSON.stringify({ error: 'Missing X-Admin-Token header' }) };

    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return { statusCode: 500, body: JSON.stringify({ error: 'ADMIN_TOKEN not configured on server' }) };
    if (adminTokenHeader !== expected) return { statusCode: 403, body: JSON.stringify({ error: 'Invalid admin token' }) };

    const result = await reportTestEvent();
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, report: result })
    };
  } catch (err) {
    console.error('cdp_test error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
