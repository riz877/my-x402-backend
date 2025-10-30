// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract, isAddress, keccak256, toUtf8Bytes, AbiCoder } = require('ethers');

// --- 1. CONFIGURATION AND SETUP ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const X402_RECIPIENT_ADDRESS = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ASSET_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (Base)
const MINT_COST_USDC = "2000000"; // 2.0 USDC (6 decimals)
const BASE_CHAIN_ID = 8453;

// Setup Ethers
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
} = process.env;

// Initialize Provider and Wallet
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABIs
const NFT_ABI = [
  "function mint(address _to, uint256 _mintAmount)"
];

const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external",
  "function balanceOf(address account) view returns (uint256)",
  "function name() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)"
];

// TOPIC HASH for Transfer event
const USDC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// --- UTILITY: Verify USDC Transfer in Receipt ---
const verifyUSDCPayment = (receipt, expectedFrom) => {
    console.log("Verifying USDC payment in transaction receipt...");
    
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === USDC_ASSET_ADDRESS.toLowerCase() && 
            log.topics[0] === USDC_TRANSFER_TOPIC) {
            
            const fromAddress = '0x' + log.topics[1].substring(26);
            const toAddress = '0x' + log.topics[2].substring(26);
            const amount = BigInt(log.data);
            
            console.log(`Found Transfer: ${fromAddress} → ${toAddress}, Amount: ${amount.toString()}`);
            
            // Verify: correct sender, correct recipient, correct amount
            if (fromAddress.toLowerCase() === expectedFrom.toLowerCase() &&
                toAddress.toLowerCase() === X402_RECIPIENT_ADDRESS.toLowerCase() &&
                amount >= BigInt(MINT_COST_USDC)) {
                
                console.log(`✅ Valid USDC payment verified!`);
                return {
                  payer: fromAddress,
                  recipient: toAddress,
                  amount: amount.toString()
                };
            }
        }
    }
    
    return null;
}

// --- 2. MAIN HANDLER ---
exports.handler = async (event, context) => {
  const xPaymentHeader = event.headers['x-payment'] || event.headers['X-Payment'];
  const resourceUrl = `https://${event.headers.host}${event.path}`; 

  // CORS/OPTIONS
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
  // 1. PAYMENT FLOW: Execute ERC-3009 & Mint NFT
  // =======================================================
  if (xPaymentHeader && event.httpMethod === 'POST') {
    console.log("=== PAYMENT VERIFICATION STARTED ===");

    let userAddress;
    let usdcTxHash;
    let authData;
    let signature;
    let decodedPayload;

    try {
        // Decode X-Payment header
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        decodedPayload = JSON.parse(payloadJson);
        
        console.log("DECODED PAYLOAD:");
        console.log(JSON.stringify(decodedPayload, null, 2));
        
        // Extract authorization data
        if (!decodedPayload.payload || !decodedPayload.payload.authorization) {
            throw new Error("Missing authorization data in payment proof");
        }
        
        authData = decodedPayload.payload.authorization;
        signature = decodedPayload.payload.signature;
        
        userAddress = authData.from;
        
        console.log(`User Address: ${userAddress}`);
        console.log(`Payment To: ${authData.to}`);
        console.log(`Amount: ${authData.value}`);
        console.log(`Nonce: ${authData.nonce}`);
        console.log(`Signature: ${signature}`);
        
        // Verify authorization details
        if (authData.to.toLowerCase() !== X402_RECIPIENT_ADDRESS.toLowerCase()) {
            throw new Error("Authorization recipient does not match expected address");
        }
        
        if (authData.value !== MINT_COST_USDC) {
            throw new Error(`Incorrect payment amount. Expected ${MINT_COST_USDC}, got ${authData.value}`);
        }
        
        if (!isAddress(userAddress)) {
            throw new Error("Invalid user address");
        }

        console.log("✅ Authorization data validated");

    } catch (error) {
        console.error("❌ Payment Proof Validation Failed:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: `Invalid payment proof: ${error.message}`
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Execute the USDC transfer using transferWithAuthorization (bytes signature version)
    try {
        const usdcContract = new Contract(USDC_ASSET_ADDRESS, USDC_ABI, relayerWallet);
        
        console.log("Executing transferWithAuthorization with bytes signature...");
        
        // Use the signature as-is (bytes format)
        const tx = await usdcContract.transferWithAuthorization(
            authData.from,
            authData.to,
            authData.value,
            authData.validAfter,
            authData.validBefore,
            authData.nonce,
            signature  // Pass signature as bytes directly
        );
        
        usdcTxHash = tx.hash;
        console.log(`USDC Transfer TX sent: ${usdcTxHash}`);
        
        const receipt = await tx.wait();
        console.log(`✅ USDC Transfer confirmed in block ${receipt.blockNumber}`);
        
        // Verify the transfer in the receipt
        const paymentInfo = verifyUSDCPayment(receipt, userAddress);
        
        if (!paymentInfo) {
            throw new Error("USDC transfer not found in transaction receipt");
        }
        
    } catch (error) {
        console.error("❌ USDC Transfer Failed:", error);
        
        // Try receiveWithAuthorization as fallback
        if (error.message && error.message.includes("invalid signature")) {
            console.log("Trying receiveWithAuthorization as fallback...");
            
            try {
                const usdcContract = new Contract(USDC_ASSET_ADDRESS, USDC_ABI, relayerWallet);
                
                const tx = await usdcContract.receiveWithAuthorization(
                    authData.from,
                    authData.to,
                    authData.value,
                    authData.validAfter,
                    authData.validBefore,
                    authData.nonce,
                    signature
                );
                
                usdcTxHash = tx.hash;
                console.log(`USDC Transfer TX sent (receiveWithAuthorization): ${usdcTxHash}`);
                
                const receipt = await tx.wait();
                console.log(`✅ USDC Transfer confirmed in block ${receipt.blockNumber}`);
                
                const paymentInfo = verifyUSDCPayment(receipt, userAddress);
                
                if (!paymentInfo) {
                    throw new Error("USDC transfer not found in transaction receipt");
                }
            } catch (fallbackError) {
                console.error("❌ Fallback also failed:", fallbackError);
                
                return {
                    statusCode: 403,
                    body: JSON.stringify({ 
                        error: "Invalid signature. The x402 client may be using an incompatible signing method.",
                        details: fallbackError.message
                    }),
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
        } else {
            // Other errors
            if (error.message && error.message.includes("authorization is used")) {
                return {
                    statusCode: 409,
                    body: JSON.stringify({ 
                        error: "This payment authorization has already been used"
                    }),
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    error: "Failed to execute USDC transfer",
                    details: error.message
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }
    }

    // Mint NFT to user
    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
        
        console.log(`Minting NFT to ${userAddress}...`);
        
        const mintTx = await nftContract.mint(userAddress, 1);
        console.log(`Mint TX sent: ${mintTx.hash}`);
        
        const mintReceipt = await mintTx.wait();
        console.log(`✅ NFT Minted in block ${mintReceipt.blockNumber}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Payment received and NFT minted successfully!",
                data: { 
                    recipient: userAddress,
                    usdcTransferHash: usdcTxHash,
                    mintTransactionHash: mintTx.hash,
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
                error: "USDC payment succeeded but NFT minting failed. Please contact support.",
                usdcTransferHash: usdcTxHash,
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
  // 2. CHALLENGE: Return 402 Payment Required
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
