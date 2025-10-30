// File: netlify/functions/mint.js
const { JsonRpcProvider } = require('ethers');

const NFT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_ADDRESS = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "2000000"; // 2 USDC

const provider = new JsonRpcProvider(process.env.PROVIDER_URL || "https://mainnet.base.org");

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const verifiedMints = new Set();

const findUSDCPayment = async (minter, mintBlock) => {
    console.log(`Searching for USDC payment from ${minter}`);
    
    // Search recent blocks (last 50 blocks before mint)
    const startBlock = Math.max(0, mintBlock - 50);
    
    for (let blockNum = startBlock; blockNum <= mintBlock; blockNum++) {
        try {
            const block = await provider.getBlock(blockNum, true);
            
            for (const txHash of block.transactions) {
                const receipt = await provider.getTransactionReceipt(txHash);
                
                if (!receipt || receipt.status !== 1) continue;
                
                // Check for USDC transfer
                for (const log of receipt.logs) {
                    if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
                        log.topics[0] === TRANSFER_TOPIC) {
                        
                        const from = '0x' + log.topics[1].substring(26);
                        const to = '0x' + log.topics[2].substring(26);
                        const amount = BigInt(log.data);
                        
                        if (from.toLowerCase() === minter.toLowerCase() &&
                            to.toLowerCase() === PAYMENT_ADDRESS.toLowerCase() &&
                            amount >= BigInt(MINT_PRICE)) {
                            
                            console.log(`✅ Found USDC payment: ${txHash}`);
                            return txHash;
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error checking block ${blockNum}:`, error.message);
            continue;
        }
    }
    
    return null;
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

    const xPayment = event.headers['x-payment'] || event.headers['X-Payment'];
    const resourceUrl = `https://${event.headers.host}${event.path}`;

    // Return 402 Payment Required
    if (!xPayment) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Pay 2 USDC and mint NFT yourself",
                instructions: {
                    step1: {
                        description: "Send 2 USDC",
                        to: PAYMENT_ADDRESS,
                        token: USDC_ADDRESS,
                        amount: "2000000", // 2 USDC with 6 decimals
                        network: "Base"
                    },
                    step2: {
                        description: "Mint NFT (you pay gas)",
                        contract: NFT_ADDRESS,
                        function: "mint(address _to, uint256 _mintAmount)",
                        parameters: {
                            _to: "YOUR_WALLET_ADDRESS",
                            _mintAmount: "1"
                        },
                        network: "Base",
                        estimatedGas: "~0.0001 ETH"
                    },
                    step3: {
                        description: "Verify and get confirmation",
                        action: "POST your mint transaction hash to this endpoint"
                    }
                },
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: resourceUrl,
                    description: "the hood runs deep in 402. Pay 2 USDC + mint yourself",
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
                    payTo: PAYMENT_ADDRESS,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 600,
                    outputSchema: {
                        input: { type: "http", method: "POST" },
                        output: { 
                            success: "boolean",
                            message: "string",
                            minter: "string",
                            verified: "boolean"
                        }
                    }
                }],
                nftContract: NFT_ADDRESS,
                paymentAddress: PAYMENT_ADDRESS,
                usdcAddress: USDC_ADDRESS,
                network: "Base"
            }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Verify mint transaction
    try {
        const payloadJson = Buffer.from(xPayment, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("Received payload:", JSON.stringify(payload, null, 2));
        
        // Extract mint transaction hash
        const mintTxHash = payload.transactionHash || 
                          payload.txHash || 
                          payload.hash ||
                          payload.mintTx ||
                          payload.proof?.hash;
        
        if (!mintTxHash) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: "Missing mint transaction hash",
                    hint: "Provide the transaction hash from your mint() call"
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }

        // Check if already verified
        if (verifiedMints.has(mintTxHash.toLowerCase())) {
            return {
                statusCode: 409,
                body: JSON.stringify({ 
                    error: "This mint has already been verified"
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
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
                    error: "Mint transaction failed on-chain"
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }

        // Verify it's an NFT mint from our contract
        const nftMintLog = mintReceipt.logs.find(log => 
            log.address.toLowerCase() === NFT_ADDRESS.toLowerCase() &&
            log.topics[0] === TRANSFER_TOPIC &&
            log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000' // from 0x0 (mint)
        );

        if (!nftMintLog) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    error: "No NFT mint found in this transaction"
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }

        // Get minter address
        const mintTx = await provider.getTransaction(mintTxHash);
        const minter = mintTx.from;

        console.log(`NFT minted to: ${'0x' + nftMintLog.topics[2].substring(26)}`);
        console.log(`Transaction from: ${minter}`);

        // Verify USDC payment from minter
        const paymentTxHash = await findUSDCPayment(minter, mintReceipt.blockNumber);

        if (!paymentTxHash) {
            return {
                statusCode: 403,
                body: JSON.stringify({ 
                    error: "No USDC payment found",
                    hint: `Please send 2 USDC to ${PAYMENT_ADDRESS} before minting`,
                    minter: minter
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }

        console.log(`✅ Verification complete!`);

        // Mark as verified
        verifiedMints.add(mintTxHash.toLowerCase());

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Verified! USDC payment received and NFT minted",
                verified: true,
                data: {
                    minter: minter,
                    nftRecipient: '0x' + nftMintLog.topics[2].substring(26),
                    paymentTx: paymentTxHash,
                    mintTx: mintTxHash,
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
