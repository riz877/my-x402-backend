// File: netlify/functions/agent.js
const { JsonRpcProvider, Wallet, Contract } = require('ethers');

const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

// Guarded provider and relayer wallet initialization so module import
// doesn't throw when env vars are missing or invalid (helps GET checks).
let provider;
let relayerWallet;
try {
  provider = new JsonRpcProvider(PROVIDER_URL);
} catch (e) {
  console.warn('agent.js: provider initialization warning:', e.message);
  provider = null;
}

if (RELAYER_PRIVATE_KEY) {
  try {
    relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
  } catch (e) {
    console.warn('agent.js: RELAYER_PRIVATE_KEY invalid or provider missing:', e.message);
    relayerWallet = null;
  }
} else {
  relayerWallet = null;
}

// ABI kontrak yang dibutuhkan
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
];

const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

module.exports = {
  handler: async (event) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    };

    // Preflight CORS
    if (event.httpMethod === 'OPTIONS')
      return { statusCode: 200, headers };

    // Handle GET → Test
    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Agent function live ✅' }),
      };
    }

    // Hanya izinkan POST
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    // Parse JSON body
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: 'Invalid JSON body' };
    }

    console.log("📩 Received body:", body);

    // Validasi field dari x402scan
    if (!body.authorization || !body.resource || !body.resource.asset) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields (authorization/resource.asset)",
          received: body,
        }),
      };
    }

    try {
      const auth = body.authorization;
      const resource = body.resource;

      console.log("🔗 Using resource asset:", resource.asset);

      // Transfer USDC dengan tanda tangan user
      const usdcContract = new Contract(resource.asset, usdcAbi, relayerWallet);
      const usdcTx = await usdcContract.transferWithAuthorization(
        auth.from, auth.to, auth.value,
        auth.validAfter, auth.validBefore, auth.nonce,
        auth.v, auth.r, auth.s
      );
      console.log("💸 USDC TX sent:", usdcTx.hash);
      await usdcTx.wait();
      console.log("✅ USDC TX confirmed");

      // Mint NFT setelah transfer berhasil
      const nftContract = new Contract(NFT_CONTRACT_ADDRESS, nftAbi, relayerWallet);
      const mintTx = await nftContract.mint(auth.from, 1);
      console.log("🎨 Mint TX sent:", mintTx.hash);
      await mintTx.wait();
      console.log("✅ Mint TX confirmed");

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Claim successful!',
          usdcTransactionHash: usdcTx.hash,
          mintTransactionHash: mintTx.hash,
        }),
      };
    } catch (err) {
      console.error('❌ Agent failed:', err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: err.message || 'Internal server error.',
          stack: err.stack,
        }),
      };
    }
  },
};
