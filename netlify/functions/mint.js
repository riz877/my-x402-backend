const { JsonRpcProvider } = require('ethers');

// --- CONFIGURATION ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "2000000"; // 2 USDC (6 decimals)

const { PROVIDER_URL } = process.env;
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");

// Event signatures
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// In-memory storage (untuk production gunakan Redis/Database)
const processedPayments = new Set();

// Verify USDC payment
const verifyUSDCPayment = (receipt, expectedPayer) => {
    for (const log of receipt.logs) {
        // Check if this is USDC contract
        if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
        
        // Check if this is Transfer event
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        
        try {
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            const amount = BigInt(log.data);
            
            console.log('USDC Transfer found:', {
                from,
                to,
                amount: amount.toString()
            });
            
            // Verify: correct sender, correct recipient, correct amount
            if (from.toLowerCase() === expectedPayer.toLowerCase() &&
                to.toLowerCase() === PAYMENT_RECIPIENT.toLowerCase() &&
                amount >= BigInt(MINT_PRICE)) {
                return true;
            }
        } catch (e) {
            console.error('Error parsing USDC log:', e);
            continue;
        }
    }
    return false;
};

// Verify NFT mint
const verifyNFTMint = (receipt, expectedRecipient) => {
    for (const log of receipt.logs) {
        // Check if this is NFT contract
        if (log.address.toLowerCase() !== NFT_CONTRACT_ADDRESS.toLowerCase()) continue;
        
        // Check if this is Transfer event
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        
        try {
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            const tokenId = BigInt(log.topics[3] || log.data).toString();
            
            console.log('NFT Transfer found:', {
                from,
                to,
                tokenId
            });
            
            // NFT mint: from = 0x0 (zero address), to = recipient
            if (from === '0x0000000000000000000000000000000000000000' &&
                to.toLowerCase() === expectedRecipient.toLowerCase()) {
                return tokenId;
            }
        } catch (e) {
            console.error('Error parsing NFT log:', e);
            continue;
        }
    }
    return null;
};

exports.handler = async (event) => {
    // CORS preflight
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

    // --- GET REQUEST: Return 402 with instructions ---
    if (event.httpMethod === 'GET' || !xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Pay 2 USDC, mint your NFT, then submit proof",
                instructions: {
                    step1: {
                        action: "Send 2 USDC",
                        to: PAYMENT_RECIPIENT,
                        amount: "2 USDC",
                        token: USDC_ADDRESS,
                        network: "Base",
                        note: "Send from the same wallet you'll use to mint"
                    },
                    step2: {
                        action: "Mint your NFT",
                        contract: NFT_CONTRACT_ADDRESS,
                        function: "mint(address _to, uint256 _mintAmount)",
                        parameters: {
                            _to: "Your wallet address",
                            _mintAmount: "1"
                        },
                        network: "Base",
                        note: "Call this function from your contract interface"
                    },
                    step3: {
                        action: "Submit verification",
                        method: "POST to this endpoint",
                        header: "X-Payment: base64(json)",
                        payload: {
                            mintTxHash: "0x... (your mint transaction hash)"
                        }
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
                    maxTimeoutSeconds: 3600, // 1 hour
                    outputSchema: {
                        input: { 
                            type: "http", 
                            method: "POST",
                            properties: {
                                mintTxHash: { type: "string" }
                            }
                        },
                        output: { 
                            success: "boolean",
                            message: "string", 
                            verified: "boolean",
                            tokenId: "string"
                        }
                    },
                    extra: {
                        name: "USD Coin",
                        version: "1",
                        contractAddress: NFT_CONTRACT_ADDRESS,
                        paymentAddress: PAYMENT_RECIPIENT
                    }
                }]
            }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            }
        };
    }

    // --- POST REQUEST: Verify payment + mint ---
    try {
        // Parse X-Payment header
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 Received payload:", JSON.stringify(payload, null, 2));
        
        // Extract mint transaction hash
        const mintTxHash = payload.mintTxHash || 
                          payload.transactionHash || 
                          payload.txHash || 
                          payload.hash;
        
        if (!mintTxHash) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false,
                    error: "Missing mint transaction hash",
                    hint: "Provide 'mintTxHash' in your payload"
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        // Normalize tx hash
        const normalizedTxHash = mintTxHash.toLowerCase();

        // Check if already processed
        if (processedPayments.has(normalizedTxHash)) {
            return {
                statusCode: 409,
                body: JSON.stringify({ 
                    success: false,
                    error: "This mint transaction has already been verified" 
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        console.log(`🔍 Verifying mint transaction: ${mintTxHash}`);

        // Get mint transaction receipt
        const mintReceipt = await provider.getTransactionReceipt(mintTxHash);

        if (!mintReceipt) {
            return {
                statusCode: 404,
                body: JSON.stringify({ 
                    success: false,
                    error: "Mint transaction not found on Base network",
                    hint: "Make sure you're on Base mainnet and transaction is confirmed"
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        if (mintReceipt.status !== 1) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false,
                    error: "Mint transaction failed on-chain" 
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        // Get minter address from transaction
        const mintTx = await provider.getTransaction(mintTxHash);
        const minter = mintTx.from;

        console.log(`👤 Minter address: ${minter}`);

        // Verify NFT was minted
        const tokenId = verifyNFTMint(mintReceipt, minter);
        
        if (!tokenId) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    success: false,
                    error: "No NFT mint found in this transaction",
                    hint: "Make sure you called the mint function on the correct contract"
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        console.log(`✅ NFT mint verified: Token #${tokenId} minted to ${minter}`);

        // Now verify USDC payment
        // Search in recent blocks (mint block ± 1000 blocks ~ 30 minutes on Base)
        let paymentVerified = false;
        let paymentTxHash = null;
        
        const mintBlock = mintReceipt.blockNumber;
        const searchFromBlock = Math.max(0, mintBlock - 1000);
        const searchToBlock = mintBlock;

        console.log(`🔎 Searching for USDC payment from ${minter}`);
        console.log(`   Blocks: ${searchFromBlock} to ${searchToBlock}`);

        // Search for USDC payment
        for (let blockNum = searchToBlock; blockNum >= searchFromBlock; blockNum--) {
            try {
                const block = await provider.getBlock(blockNum, true);
                
                if (!block || !block.transactions) continue;

                // Check each transaction in block
                for (const txHash of block.transactions) {
                    try {
                        const receipt = await provider.getTransactionReceipt(txHash);
                        
                        if (!receipt || receipt.status !== 1) continue;

                        // Check if this transaction has USDC payment from minter
                        if (verifyUSDCPayment(receipt, minter)) {
                            console.log(`✅ Found USDC payment in tx: ${txHash}`);
                            paymentVerified = true;
                            paymentTxHash = txHash;
                            break;
                        }
                    } catch (e) {
                        // Skip failed transactions
                        continue;
                    }
                }
                
                if (paymentVerified) break;

            } catch (e) {
                console.error(`Error checking block ${blockNum}:`, e.message);
                continue;
            }
        }

        if (!paymentVerified) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    success: false,
                    error: "No valid USDC payment found",
                    hint: `Please send 2 USDC to ${PAYMENT_RECIPIENT} from ${minter} within 30 minutes before/after minting`,
                    searched: `Blocks ${searchFromBlock} to ${searchToBlock}`
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        // Mark as processed
        processedPayments.add(normalizedTxHash);

        console.log(`🎉 Full verification successful!`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                verified: true,
                message: "Payment and mint verified successfully! 🎉",
                data: {
                    minter: minter,
                    tokenId: tokenId,
                    nftContract: NFT_CONTRACT_ADDRESS,
                    mintTransaction: mintTxHash,
                    paymentTransaction: paymentTxHash,
                    blockNumber: mintReceipt.blockNumber,
                    timestamp: new Date().toISOString()
                }
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };

    } catch (error) {
        console.error("❌ Verification error:", error);
        
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                success: false,
                error: "Verification failed",
                message: error.message,
                hint: "Please contact support if this persists"
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }
};
