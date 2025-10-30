// File: netlify/functions/mint.js
const { JsonRpcProvider } = require('ethers');

// --- CONFIGURATION ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "2000000"; // 2 USDC

const { PROVIDER_URL } = process.env;
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");

const USDC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NFT_MINT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer event

const processedPayments = new Set();

const verifyUSDCPayment = (receipt) => {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && 
            log.topics[0] === USDC_TRANSFER_TOPIC) {
            
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            const amount = BigInt(log.data);
            
            if (to.toLowerCase() === PAYMENT_RECIPIENT.toLowerCase() &&
                amount >= BigInt(MINT_PRICE)) {
                return from;
            }
        }
    }
    return null;
};

const verifyNFTMint = (receipt, expectedRecipient) => {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() && 
            log.topics[0] === NFT_MINT_TOPIC) {
            
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            
            // NFT mint: from = 0x0 (burn address), to = recipient
            if (from === '0x0000000000000000000000000000000000000000' &&
                to.toLowerCase() === expectedRecipient.toLowerCase()) {
                return true;
            }
        }
    }
    return false;
};

exports.handler = async (event) => {
    // CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, X-Payment',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            }
        };
    }

    const xPaymentHeader = event.headers['x-payment'] || event.headers['X-Payment'];

    // Return 402 with instructions
    if (!xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Send 2 USDC to payment address, then call mint() on NFT contract",
                instructions: {
                    step1: {
                        action: "Send USDC",
                        to: PAYMENT_RECIPIENT,
                        amount: "2 USDC",
                        token: USDC_ADDRESS,
                        network: "Base"
                    },
                    step2: {
                        action: "Call mint function",
                        contract: NFT_CONTRACT_ADDRESS,
                        function: "mint(address _to, uint256 _mintAmount)",
                        parameters: {
                            _to: "YOUR_ADDRESS",
                            _mintAmount: "1"
                        }
                    },
                    step3: {
                        action: "Submit proof",
                        method: "POST to this endpoint",
                        payload: "Transaction hash of your mint transaction"
                    }
                },
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: `https://${event.headers.host}${event.path}`,
                    description: "the hood runs deep in 402. Pay 2 USDC + mint your own NFT",
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
                    payTo: PAYMENT_RECIPIENT,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 600,
                    outputSchema: {
                        input: { type: "http", method: "POST" },
                        output: { message: "string", verified: "boolean" }
                    }
                }]
            }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Verify payment proof
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("Payment proof:", JSON.stringify(payload, null, 2));
        
        // Extract mint transaction hash
        const mintTxHash = payload.transactionHash || 
                          payload.txHash || 
                          payload.hash ||
                          payload.mintTransaction ||
                          payload.proof?.hash;
        
        if (!mintTxHash) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: "Missing mint transaction hash",
                    hint: "Please provide the transaction hash of your NFT mint transaction"
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Check if already verified
        if (processedPayments.has(mintTxHash.toLowerCase())) {
            return {
                statusCode: 409,
                body: JSON.stringify({ error: "This mint has already been verified" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        console.log(`Verifying mint transaction: ${mintTxHash}`);

        // Get mint transaction receipt
        const mintReceipt = await provider.getTransactionReceipt(mintTxHash);

        if (!mintReceipt) {
            return {
                statusCode: 404,
                body: JSON.stringify({ 
                    error: "Mint transaction not found on Base network" 
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        if (mintReceipt.status !== 1) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Mint transaction failed" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Get the minter's address from the transaction
        const mintTx = await provider.getTransaction(mintTxHash);
        const minter = mintTx.from;

        console.log(`Minter address: ${minter}`);

        // Verify NFT was minted to the user
        if (!verifyNFTMint(mintReceipt, minter)) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    error: "No NFT mint found in transaction, or not minted to your address" 
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        console.log(`✅ NFT mint verified for ${minter}`);

        // Now verify they paid 2 USDC
        // Look for USDC payment in recent blocks (within last 100 blocks of mint)
        let paymentVerified = false;
        const mintBlock = mintReceipt.blockNumber;
        const searchFromBlock = Math.max(0, mintBlock - 100);

        console.log(`Searching for USDC payment from ${minter} in blocks ${searchFromBlock} to ${mintBlock}`);

        // Search through recent blocks for USDC payment
        for (let blockNum = searchFromBlock; blockNum <= mintBlock; blockNum++) {
            const block = await provider.getBlock(blockNum, true);
            
            for (const txHash of block.transactions) {
                try {
                    const receipt = await provider.getTransactionReceipt(txHash);
                    const payer = verifyUSDCPayment(receipt);
                    
                    if (payer && payer.toLowerCase() === minter.toLowerCase()) {
                        console.log(`✅ Found USDC payment in tx ${txHash}`);
                        paymentVerified = true;
                        break;
                    }
                } catch (e) {
                    // Skip failed transactions
                    continue;
                }
            }
            
            if (paymentVerified) break;
        }

        if (!paymentVerified) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    error: "No valid USDC payment found",
                    hint: `Please send 2 USDC to ${PAYMENT_RECIPIENT} before minting`
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Mark as processed
        processedPayments.add(mintTxHash.toLowerCase());

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Payment and mint verified successfully!",
                verified: true,
                data: {
                    minter: minter,
                    mintTransaction: mintTxHash,
                    blockNumber: mintReceipt.blockNumber
                }
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };

    } catch (error) {
        console.error("Verification error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Verification failed: " + error.message 
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }
};
