// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract, isAddress } = require('ethers');

// --- 1. CONFIGURATION AND SETUP ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const X402_RECIPIENT_ADDRESS = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ASSET_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (Base)
const MINT_COST_USDC = "2000000"; // 2.0 USDC (6 decimals)

// Setup Ethers
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
} = process.env;

// Initialize Provider and Wallet (for gas-sponsored minting)
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// MINIMAL ABI
const NFT_ABI = [
  "function mint(address _to, uint256 _mintAmount)"
];

// TOPIC HASH for Transfer(address indexed from, address indexed to, uint256 value)
const USDC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// --- UTILITY: Extract transaction hash from payment proof ---
const extractTxHash = (payload) => {
  console.log("=== EXTRACTING TX HASH ===");
  console.log("Full payload:", JSON.stringify(payload, null, 2));
  
  // Try direct properties first
  if (payload.transactionHash) return payload.transactionHash;
  if (payload.txHash) return payload.txHash;
  if (payload.hash) return payload.hash;
  if (payload.tx) return payload.tx;
  if (payload.txId) return payload.txId;
  if (payload.transactionId) return payload.transactionId;
  
  // Try proof object
  if (payload.proof) {
    const proof = payload.proof;
    if (proof.transactionHash) return proof.transactionHash;
    if (proof.txHash) return proof.txHash;
    if (proof.hash) return proof.hash;
    if (proof.tx) return proof.tx;
    if (proof.txId) return proof.txId;
    if (proof.transactionId) return proof.transactionId;
  }
  
  // Try payment object
  if (payload.payment) {
    const payment = payload.payment;
    if (payment.transactionHash) return payment.transactionHash;
    if (payment.txHash) return payment.txHash;
    if (payment.hash) return payment.hash;
    if (payment.tx) return payment.tx;
  }
  
  // Try transaction object
  if (payload.transaction) {
    const tx = payload.transaction;
    if (tx.hash) return tx.hash;
    if (tx.transactionHash) return tx.transactionHash;
    if (tx.txHash) return tx.txHash;
  }
  
  // Try data object
  if (payload.data) {
    const data = payload.data;
    if (typeof data === 'string') return data; // Sometimes it's just a string
    if (data.transactionHash) return data.transactionHash;
    if (data.txHash) return data.txHash;
    if (data.hash) return data.hash;
  }
  
  // If payload is just a string (transaction hash directly)
  if (typeof payload === 'string' && payload.startsWith('0x')) {
    return payload;
  }
  
  console.log("❌ Could not find transaction hash in any known location");
  return null;
};

// --- UTILITY FUNCTION: Get Payer Address from Transfer Log ---
const getPayerAddressAndVerifyPayment = (receipt) => {
    console.log("Checking transaction logs for USDC transfer...");
    
    for (const log of receipt.logs) {
        // Check if this is a USDC transfer log
        if (log.address.toLowerCase() === USDC_ASSET_ADDRESS.toLowerCase() && 
            log.topics[0] === USDC_TRANSFER_TOPIC) {
            
            console.log("Found USDC transfer log:", log);
            
            // Extract sender address from topic[1] (FROM) - This is the user who paid
            const senderTopic = log.topics[1]; 
            const payerAddress = '0x' + senderTopic.substring(26); 
            
            // Extract recipient address from topic[2] (TO) - Should be x402 recipient
            const recipientTopic = log.topics[2];
            const recipientLogAddress = '0x' + recipientTopic.substring(26);

            console.log(`User who paid: ${payerAddress}, Received at: ${recipientLogAddress}`);

            // Verify payment was sent to the x402 recipient address
            if (recipientLogAddress.toLowerCase() === X402_RECIPIENT_ADDRESS.toLowerCase() && 
                isAddress(payerAddress)) {
                
                // Verify amount (data field contains the value)
                const amountHex = log.data;
                const amount = BigInt(amountHex);
                
                console.log(`Transfer amount: ${amount.toString()} (required: ${MINT_COST_USDC})`);
                
                if (amount >= BigInt(MINT_COST_USDC)) {
                    console.log(`✅ Valid payment of ${amount.toString()} USDC from ${payerAddress}`);
                    return payerAddress; // Return the user who paid
                } else {
                    console.warn(`❌ Payment amount ${amount.toString()} is less than required ${MINT_COST_USDC}`);
                }
            }
        }
    }
    return null;
}

// --- 2. MAIN HANDLER ---
exports.handler = async (event, context) => {
  const xPaymentHeader = event.headers['x-payment'] || event.headers['X-Payment'];
  const resourceUrl = `https://${event.headers.host}${event.path}`; 

  // CORS/OPTIONS LOGIC
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Payment, X-PAYMENT',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      }
    };
  }

  // =======================================================
  // 1. SUCCESS LOGIC: User paid USDC, now mint NFT to them (POST)
  // =======================================================
  if (xPaymentHeader && event.httpMethod === 'POST') {
    console.log("=== PAYMENT VERIFICATION STARTED ===");
    console.log("X-PAYMENT header found");
    console.log("Raw header value:", xPaymentHeader);

    let txHash;
    let userAddress;
    let decodedPayload;

    // 1.1 Verify X-Payment Payload and On-Chain
    try {
        // Decode base64 payload
        let payloadJson;
        try {
          payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
          console.log("Decoded payload string:", payloadJson);
        } catch (decodeError) {
          console.error("Base64 decode error:", decodeError);
          throw new Error("Failed to decode X-Payment header from base64");
        }
        
        // Parse JSON
        try {
          decodedPayload = JSON.parse(payloadJson);
        } catch (parseError) {
          console.error("JSON parse error:", parseError);
          throw new Error("X-Payment header is not valid JSON");
        }
        
        console.log("=== PARSED PAYLOAD ===");
        console.log(JSON.stringify(decodedPayload, null, 2));
        
        // Extract transaction hash using helper function
        txHash = extractTxHash(decodedPayload);

        if (!txHash) {
            console.error("❌ All extraction methods failed");
            console.error("Available keys in payload:", Object.keys(decodedPayload));
            throw new Error("Missing transaction hash in payment proof. Please check the payment format.");
        }

        console.log(`✅ Extracted transaction hash: ${txHash}`);
        console.log(`Verifying USDC payment transaction on Base network...`);

        // On-Chain Verification: Check transaction status
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            throw new Error(`Transaction ${txHash} not found on Base network. It may still be pending.`);
        }

        if (receipt.status !== 1) {
            throw new Error(`Transaction ${txHash} failed on-chain (status: ${receipt.status}).`);
        }

        console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`);

        // 1.2 Extract the user's address from the USDC transfer logs
        userAddress = getPayerAddressAndVerifyPayment(receipt);
        
        if (!userAddress) {
            throw new Error("Could not verify USDC payment. Ensure you sent exactly 2 USDC to the correct address.");
        }

        console.log(`✅ Payment verified! User ${userAddress} paid USDC`);

    } catch (error) {
        console.error("❌ Payment Verification Failed:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: `Invalid or unverified payment: ${error.message}`,
                debug: {
                  headerReceived: !!xPaymentHeader,
                  payloadKeys: decodedPayload ? Object.keys(decodedPayload) : null
                }
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // 1.3 MINT NFT TO THE USER (Relayer pays gas, user gets NFT)
    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
        
        console.log(`Minting NFT to user: ${userAddress} (relayer pays gas)...`);
        
        // Mint to the user who paid USDC
        const tx = await nftContract.mint(userAddress, 1); 

        console.log(`Mint transaction sent: ${tx.hash}`);
        
        const mintReceipt = await tx.wait(); 

        console.log(`✅ NFT Minted Successfully! Block: ${mintReceipt.blockNumber}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "NFT Minted Successfully!",
                data: { 
                    recipient: userAddress, 
                    mintTransactionHash: tx.hash,
                    paymentTransactionHash: txHash,
                    blockNumber: mintReceipt.blockNumber
                }
            }),
            headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*' 
            }
        };
    } catch (error) {
        console.error("❌ NFT Minting Failed:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Failed to mint NFT. User payment was verified but minting failed.",
                details: error.message 
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }
  }

  // =======================================================
  // 2. CHALLENGE LOGIC: Return 402 Payment Required (GET/Default)
  // =======================================================
  else {
    console.log(`🚀 Returning 402 Payment Required for ${resourceUrl}`);

    const paymentMethod = {
        scheme: "exact",
        network: "base",
        maxAmountRequired: MINT_COST_USDC, 
        resource: resourceUrl,
        description: "the hood runs deep in 402. every face got a story. Pay 2 USDC to mint your NFT. by https://x.com/sanukek https://x402hood.xyz",
        mimeType: "application/json",
        image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
        payTo: X402_RECIPIENT_ADDRESS,
        maxTimeoutSeconds: 600,
        asset: USDC_ASSET_ADDRESS,
        outputSchema: {
            input: { 
                type: "http", 
                method: "POST"
            }, 
            output: { 
                message: "string", 
                data: "object" 
            }
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
            'Access-Control-Allow-Headers': 'Content-Type, X-Payment, X-PAYMENT',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        }
    };
  }
};
