// mint.js (Netlify Function or similar)
exports.handler = async (event, context) => {

  console.log("Function '/mint' triggered, sending 402 response...");

  // 1. Define Accepts object sesuai schema X402
  const paymentMethod = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "2000000", // 2 USDC (6 decimals)
    symbol: "USDC",
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base contract
    description: "Payment to access premium API data.",
    mimeType: "application/json",
    payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2",
    maxTimeoutSeconds: 600
  };

  // 2. Format sesuai X402Response
  const x402Response = {
    x402Version: 1,
    error: "Payment Required",
    accepts: [paymentMethod],
    payer: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2"
  };

  // 3. Return response 402 JSON
  return {
    statusCode: 402,
    body: JSON.stringify(x402Response),
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    }
  };
};
