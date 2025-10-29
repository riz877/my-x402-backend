// 
exports.handler = async (event, context) => {

  console.log("Function 'resource' triggered, sending 402 response...");

  // 1. Buat objek 'Accepts'
  const paymentMethod = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "100000", 
    resource: `https://\${event.headers.host}\${event.path}`, // Full public URL
    description: "Try to mint, i will decide whether you are lucky or not. by https://x.com/sanukek https://x402hood.xyz",
    mimeType: "application/json",

     image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
    
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
