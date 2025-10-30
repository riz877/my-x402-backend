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

// Initialize Provider and Wallet
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABIs
const NFT_ABI = [
  "function mint(address _to, uint256 _mintAmount)"
];

// TOPIC HASH for Transfer event
const USDC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// --- UTILITY: Extract transaction hash from various formats ---
const extractTxHash = (payload) => {
  console.log("Attempting to extract transaction hash...");
  
  // If it's a string starting with 0x, it's likely the hash itself
  if (typeof payload === 'string' && payload.startsWith('0x')) {
    return payload;
  }
  
  // Try various nested structures
  const locations = [
    payload.transactionHash,
    payload.txHash,
    payload.hash,
    payload.tx,
    payload.txId,
    payload.proof?.transactionHash,
    payload.proof?.txHash,
    payload.proof?.hash,
    payload.data?.transactionHash,
    payload.data?.hash,
    payload.payment?.transactionHash,
    payload.payment?.hash
  ];
  
  for (const loc of locations) {
    if (loc && typeof loc === 'string' && loc.startsWith('0x')) {
      return loc;
    }
  }
  
  return null;
};

// --- UTILITY: Verify USDC Transfer in Receipt ---
const verifyUSDCPayment = (receipt) => {
    console.log("Verifying USDC payment in transaction receipt...");
    
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === USDC_ASSET_ADDRESS.toLowerCase() && 
            log.topics[0] === USDC_TRANSFER_TOPIC) {
            
            const fromAddress = '0x' + log.topics[1].substring(26);
            const toAddress = '0x' + log.topics[2].substring(26);
            const amount = BigInt(log.data);
            
            console.log(`Found Transfer: ${fromAddress} → ${toAddress}, Amount: ${amount.toString()}`);
            
            // Verify: payment went to X402 recipient with correct amount
            if (toAddress.toLowerCase() === X402_RECIPIENT_ADDRESS.toLowerCase() &&
                amount >= BigInt(MINT_COST_USDC)) {
                
                console.log(`✅ Valid USDC payment verified!`);
                return {
                  payer: fromAddress,
                  recipient: toAddress,
                  amount: amount.toString()
                };
            } else {
                console.log(`❌ Transfer doesn't match requirements`);
                console.log(`  Expected recipient: ${X402_RECIPIENT_ADDRESS}`);
                console.log(`  Actual recipient: ${toAddress}`);
                console.log(`  Expected amount: >= ${MINT_COST_USDC}`);
                console.log(`  Actual amount: ${amount.toString()}`);
            }
        }
    }
    
    console.log("❌ No valid USDC transfer found in transaction");
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
  // 1. PAYMENT FLOW: Verify USDC payment & Mint NFT
  // =======================================================
  if (xPaymentHeader && event.httpMethod === 'POST') {
    console.log("=== PAYMENT VERIFICATION STARTED ===");
    console.log("Raw X-Payment header:", xPaymentHeader);

    let txHash;
    let paymentInfo;
    let decodedPayload;

    try {
        // Decode X-Payment header
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        decodedPayload = JSON.parse(payloadJson);
        
        console.log("DECODED PAYLOAD:");
        console.log(JSON.stringify(decodedPayload, null, 2));
        
        // Extract transaction hash
        txHash = extractTxHash(decodedPayload);

        if (!txHash) {
            console.error("Could not find transaction hash in payload");
            console.error("Available keys:", Object.keys(decodedPayload));
            throw new Error("Missing transaction hash in payment proof. Please provide the USDC transfer transaction hash.");
        }

        console.log(`Transaction hash found: ${txHash}`);
        console.log(`Fetching receipt from Base network...`);

        // Get transaction receipt from blockchain
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            throw new Error(`Transaction ${txHash} not found on Base network. Please ensure it's confirmed.`);
        }

        if (receipt.status !== 1) {
            throw new Error(`Transaction ${txHash} failed on-chain (status: ${receipt.status}).`);
        }

        console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`);

        // Verify it's a valid USDC payment to our address
        paymentInfo = verifyUSDCPayment(receipt);
        
        if (!paymentInfo) {
            throw new Error(`Transaction ${txHash} does not contain a valid USDC payment of ${MINT_COST_USDC} (2 USDC) to ${X402_RECIPIENT_ADDRESS}`);
        }

        console.log(`✅ Payment verified from: ${paymentInfo.payer}`);

    } catch (error) {
        console.error("❌ Payment Verification Failed:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: `Payment verification failed: ${error.message}`,
                hint: "Please send 2 USDC to the payment address and provide the transaction hash"
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Mint NFT to the payer
    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
        
        console.log(`Minting NFT to payer: ${paymentInfo.payer}...`);
        
        const mintTx = await nftContract.mint(paymentInfo.payer, 1);
        console.log(`Mint TX sent: ${mintTx.hash}`);
        
        const mintReceipt = await mintTx.wait();
        console.log(`✅ NFT Minted in block ${mintReceipt.blockNumber}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Payment received and NFT minted successfully!",
                data: { 
                    recipient: paymentInfo.payer,
                    paymentTransactionHash: txHash,
                    mintTransactionHash: mintTx.hash,
                    blockNumber: mintReceipt.blockNumber,
                    amountPaid: paymentInfo.amount
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
                error: "USDC payment verified but NFT minting failed. Please contact support.",
                paymentTransactionHash: txHash,
                payer: paymentInfo.payer,
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
