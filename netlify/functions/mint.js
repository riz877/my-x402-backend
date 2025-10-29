// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract } = require('ethers');

// Setup Ethers (diambil dari agent.js)
// Pastikan Environment Variables ini di-set di Netlify
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

const provider = new JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABI (diambil dari agent.js)
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint26 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
];
const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

// Handler utama
exports.handler = async (event, context) => {
  // Headers CORS yang memperbolehkan GET dan POST
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // Handle Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  // ==========================================================
  // LOGIKA #1: DISCOVERY (Jika diakses via GET oleh pengguna)
  // ==========================================================
  if (event.httpMethod === 'GET' || event.httpMethod !== 'POST') {
    console.log("🚀 GET request: Returning 402...");

    // PENTING: resourceUrl sekarang menunjuk ke file ini sendiri
    const resourceUrl = `https://${event.headers.host}/.netlify/functions/mint`;

    // Informasi pembayaran (dibaca oleh x402scan)
    const paymentMethod = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "2000000",
      resource: resourceUrl, // <--- KUNCI UTAMA ADA DI SINI
      description: "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
      mimeType: "application/json",
      image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
      payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2",
      maxTimeoutSeconds: 600,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
      outputSchema: {
        // Beri tahu x402scan untuk mengirim 'POST' ke 'resource'
        input: { type: "http", method: "POST" },
        output: { message: "string", data: "object" }
      }
    };

    const x402Response = {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [paymentMethod]
    };

    return {
      statusCode: 402,
      body: JSON.stringify(x402Response),
      headers: { ...headers, 'Content-Type': 'application/json' }
    };
  }

  // ==========================================================
  // LOGIKA #2: PROCESSOR (Jika diakses via POST oleh x402scan)
  // ==========================================================
  if (event.httpMethod === 'POST') {
    console.log("📩 POST request: Processing payment...");

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

      // 1. Transfer USDC dengan tanda tangan user
      const usdcContract = new Contract(resource.asset, usdcAbi, relayerWallet);
      const usdcTx = await usdcContract.transferWithAuthorization(
        auth.from, auth.to, auth.value,
        auth.validAfter, auth.validBefore, auth.nonce,
        auth.v, auth.r, auth.s
      );
      console.log("💸 USDC TX sent:", usdcTx.hash);
      await usdcTx.wait();
      console.log("✅ USDC TX confirmed");

      // 2. Mint NFT setelah transfer berhasil
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
  }
};