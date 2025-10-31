const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// This is the API route you will register with x402scan
app.get('/api/resource', (req, res) => {

  console.log("Received request for /api/resource, sending 402 response...");

  // 1. Create the 'Accepts' object defining the payment method
  const paymentMethod = {
    scheme: "exact",
    network: "base", // Correct network
    
    // === SETTING FOR 2 USDC ===
    maxAmountRequired: "2000000", // 2 USDC (since USDC has 6 decimals)
    // ==========================

    resource: req.originalUrl, // The URL being accessed
    description: "Payment to access premium API data.",
    mimeType: "application/json", // The data type sent after payment
    
    // !!! CHANGE THIS TO YOUR WALLET ADDRESS !!!
    payTo: "0x2e6e06f71786955474d35293b09a3527debbbfce", 
    
    maxTimeoutSeconds: 600, // Payment is valid for 10 minutes
    
    // === SETTING FOR USDC ON BASE ===
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Official USDC address on Base
    // ================================

    // (Optional) Describe how this API works after payment
    outputSchema: {
      input: {
        type: "http",
        method: "GET" // Because this is an app.get() route
      },
      output: {
        message: "string",
        data: "object"
      }
    }
  };

  // 2. Create the 'X402Response' object
  const x402Response = {
    x402Version: 1, // Schema version
    error: "Payment Required",
    accepts: [paymentMethod] // Insert the payment method here
  };

  // 3. Send the 402 response with the complete JSON object
  res.status(402).json(x402Response);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});