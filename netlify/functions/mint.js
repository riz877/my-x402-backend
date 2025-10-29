// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

// === ENVIRONMENT VARIABLES ===
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS,
} = process.env;

// Setup provider dan wallet relayer (pembayar gas)
const provider = new JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABI kontrak yang dibutuhkan
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

const nftAbi = ["function mint(address _to, uint256 _mintAmount)"];

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  };

  // ==== Preflight CORS ====
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers };
  }

  // ==== Handle GET → return 402 Payment Required ====
  if (event.httpMethod === "GET") {
    console.log("🚀 Function 'mint' triggered → returning 402 Payment Required...");

    const resourceUrl = `https://${event.headers.host}/.netlify/functions/mint`;

    const paymentMethod = {
      scheme: "exact",
      network: "base", // ganti ke "ethereum" kalau di mainnet
      maxAmountRequired: "2000000", // 2.0 USDC (6 desimal)
      resource: resourceUrl,
      description:
        "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
      mimeType: "application/json",
      image:
        "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
      payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2",
      maxTimeoutSeconds: 600,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
      outputSchema: {
        input: { type: "http", method: "POST" },
        output: { message: "string", data: "object" },
      },
    };

    const x402Response = {
      x402Version: 1,
      error: "Payment Required",
      accepts: [paymentMethod],
    };

    return {
      statusCode: 402,
      headers,
      body: JSON.stringify(x402Response),
    };
  }

  // ==== Handle POST ====
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // === SAFE JSON PARSE ===
  let body;
  try {
    // kadang x402scan atau Netlify udah parse otomatis
    if (!event.body) {
      console.error("❌ Empty body received");
      return { statusCode: 400, headers, body: "Empty body" };
    }

    console.log("📦 Raw body:", event.body);

    if (typeof event.body === "object") {
      // Netlify runtime baru kadang auto-parse
      body = event.body;
    } else if (typeof event.body === "string") {
      // Bisa jadi Base64 encoded
      const parsed =
        event.isBase64Encoded === true
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body;
      body = JSON.parse(parsed);
    } else {
      throw new Error("Unknown body type");
    }
  } catch (err) {
    console.error("❌ JSON parse error:", err);
    return { statusCode: 400, headers, body: "Invalid JSON body" };
  }

  console.log("📩 Parsed body:", body);

  // === Validasi field dari x402scan ===
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

    // === Transfer USDC dengan tanda tangan user ===
    const usdcContract = new Contract(resource.asset, usdcAbi, relayerWallet);
    const usdcTx = await usdcContract.transferWithAuthorization(
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      auth.v,
      auth.r,
      auth.s
    );
    console.log("💸 USDC TX sent:", usdcTx.hash);
    await usdcTx.wait();
    console.log("✅ USDC TX confirmed");

    // === Mint NFT setelah transfer berhasil ===
    const nftContract = new Contract(
      NFT_CONTRACT_ADDRESS,
      nftAbi,
      relayerWallet
    );
    const mintTx = await nftContract.mint(auth.from, 1);
    console.log("🎨 Mint TX sent:", mintTx.hash);
    await mintTx.wait();
    console.log("✅ Mint TX confirmed");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Claim successful!",
        usdcTransactionHash: usdcTx.hash,
        mintTransactionHash: mintTx.hash,
      }),
    };
  } catch (err) {
    console.error("❌ Mint function failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: err.message || "Internal server error.",
        stack: err.stack,
      }),
    };
  }
};
