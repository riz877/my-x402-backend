// 
exports.handler = async (event, context) => {

  console.log("Function 'resource' triggered, sending 402 response...");

  const paymentMethod = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "2000000", 
    resource: `https://${event.headers.host}${event.path}`, // Full public URL
    name: "x402HOOD NFT Mint",
    description: "the hood runs deep in 402. every face got a story. mint yours at https://x402hood.xyz",
    website: "https://x402hood.xyz",
    author: "https://x.com/sanukek",
    image: "https://i.ibb.co.com/ym2XTpSZ/G4-SIx-Pc-XEAAuo7-O.gif",
    category: ["NFT", "Crypto", "Base"],
    mimeType: "application/json",

    payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2", 
    maxTimeoutSeconds: 600, 
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

    outputSchema: {
      input: { type: "http", method: "GET" },
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
