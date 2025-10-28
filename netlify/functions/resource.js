// 
exports.handler = async (event, context) => {

  console.log("Function 'resource' triggered, sending 402 response...");

  // 1. Buat objek 'Accepts'
  const paymentMethod = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "2000000", 
    resource: `https://\${event.headers.host}\${event.path}`, // Full public URL
    description: "Payment to access premium API data.",
    mimeType: "application/json",

    
    payTo: "0xbb3f8498c09D444B1Efe914B2eE7Bfd9e14664c1", 

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
    statusCode: 402, // 
    body: JSON.stringify(x402Response), // 
    headers: {
      'Content-Type': 'application/json'
    }
  };
};