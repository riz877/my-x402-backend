// facilitator-config.js
const FACILITATOR_CONFIG = {
    // Coinbase CDP API Credentials - DARI ENV VARIABLES
    cdpApiKeyId: process.env.CDP_API_KEY_ID || "",
    cdpPrivateKey: process.env.CDP_PRIVATE_KEY || "",
    
    // Coinbase CDP Project
    cdpProjectId: "33276cee-1caa-4998-af93-36c5a7f23c52",
    
    // Endpoints
    cdpApiUrl: "https://api.developer.coinbase.com",
    cdpRpcUrl: "https://api.developer.coinbase.com/rpc/v1/base",
    
    // X402 Server (public info - OK to hardcode)
    x402ServerId: "ffb8831e-8ac1-4ed1-bfcb-930bd4ee41f2"
};

module.exports = FACILITATOR_CONFIG;
