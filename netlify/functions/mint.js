// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

// setup provider & relayer wallet
const provider = new JsonRpcProvider(PROVIDER_URL);
const relayer = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABIs
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"
];
const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers };

  // Handle GET → x402scan akan nerima ini
  if (event.httpMethod === "GET") {
    console.log("🚀 GET mint called → returning 402 Payment Required");

    const resourceUrl = `https://${event.headers.host}/.netlify/functions/mint`;

    const paymentMethod = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "2000000", // 2 USDC (6 decimals)
      resource: resourceUrl,
      description:
        "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
      mimeType: "application/json",
      image:
        "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
      payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2", // penerima
      maxTimeoutSeconds: 600,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
      outputSchema: {
        input: { type: "http", method: "POST" },
        output: { message: "string", data: "object" }
      }
    };

    return {
      statusCode: 402,
      headers,
      body: JSON.stringify({
        x402Version: 1,
        error: "Payment Required",
        accepts: [paymentMethod]
      })
    };
  }

  // Hanya POST buat handle klaim
  if (event.httpMethod !== "POST")
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };

  // Cek body
  if (!event.body) {
    console.error("❌ Empty body received");
    return { statusCode: 400, headers, body: "Empty body" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    console.error("❌ Invalid JSON:", err);
    return { statusCode: 400, headers, body: "Invalid JSON body" };
  }

  // validasi field
  if (!body.authorization || !body.resource || !body.resource.asset) {
    console.error("❌ Missing required fields:", body);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Missing required fields (authorization/resource.asset)"
      })
    };
  }

  try {
    const auth = body.authorization;
    const resource = body.resource;

    console.log("🔗 Using asset:", resource.asset);

    // Transfer USDC — user signed, relayer executes (user funds, relayer pays gas)
    const usdc = new Contract(resource.asset, usdcAbi, relayer);
    const usdcTx = await usdc.transferWithAuthorization(
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

    // Mint NFT setelah transfer sukses
    const nft = new Contract(NFT_CONTRACT_ADDRESS, nftAbi, relayer);
    const mintTx = await nft.mint(auth.from, 1);
    console.log("🎨 Mint TX sent:", mintTx.hash);
    await mintTx.wait();
    console.log("✅ Mint TX confirmed");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Claim successful!",
        usdcTx: usdcTx.hash,
        mintTx: mintTx.hash
      })
    };
  } catch (err) {
    console.error("❌ Handler failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Internal Server Error" })
    };
  }
};
