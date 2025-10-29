// File: netlify/functions/mint.js

exports.handler = async (event, context) => {
  console.log("🚀 Function 'mint' triggered → returning 402 Payment Required...");

  // URL publik resource (biar x402scan tahu di mana bayar)
  const resourceUrl = `https://${event.headers.host}/.netlify/functions/agent`;

  // Informasi pembayaran (dibaca oleh x402scan)
  const paymentMethod = {
    scheme: "exact",
    network: "base", // blockchain yang dipakai (ganti ke "ethereum" kalau mainnet)
    maxAmountRequired: "10000", // jumlah token (6 desimal kalau USDC = 2.0 USDC)
    resource: resourceUrl, // resource target → agent.js
    description: "API Test",
    mimeType: "application/json",
    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
    payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2", // alamat penerima
    maxTimeoutSeconds: 600,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
    outputSchema: {
      input: { type: "http", method: "POST" },
      output: { message: "string", data: "object" }
    }
  };

  const x402Response = {
    x402Version: 1,
    error: "Payment Required",
    accepts: [paymentMethod]
  };

  return {
    statusCode: 402,
    body: JSON.stringify(x402Response),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    }
  };
};
