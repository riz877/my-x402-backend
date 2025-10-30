// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract, Signature } = require('ethers');

// --- CONFIGURATION ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "2000000"; // 2 USDC

const { PROVIDER_URL, RELAYER_PRIVATE_KEY } = process.env;
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

const NFT_ABI = [
  "function mint(address _to, uint256 _mintAmount)",
  "function publicMint(uint256 _mintAmount) payable" // If your contract has this
];

const USDC_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external"
];

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const processedNonces = new Set();

const verifyUSDCTransfer = (receipt, expectedFrom) => {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && 
            log.topics[0] === TRANSFER_TOPIC) {
            
            const from = '0x' + log.topics[1].substring(26);
            const to = '0x' + log.topics[2].substring(26);
            const amount = BigInt(log.data);
            
            if (from.toLowerCase() === expectedFrom.toLowerCase() &&
                to.toLowerCase() === PAYMENT_RECIPIENT.toLowerCase() &&
                amount >= BigInt(MINT_PRICE)) {
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
    const resourceUrl = `https://${event.headers.host}${event.path}`;

    // Return 402 Payment Required
    if (!xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Pay 2 USDC to receive mint approval",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: resourceUrl,
                    description: "the hood runs deep in 402. Pay 2 USDC, get mint approval",
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
                    payTo: PAYMENT_RECIPIENT,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 600,
                    outputSchema: {
                        input: { type: "http", method: "POST" },
                        output: { 
                            message: "string", 
                            mintContract: "string",
                            mintFunction: "string",
                            approved: "boolean"
                        }
                    }
                }]
            }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Process x402 payment
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("x402 Payment payload:", JSON.stringify(payload, null, 2));
        
        if (!payload.payload?.authorization || !payload.payload?.signature) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Invalid payment format" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        const auth = payload.payload.authorization;
        const signature = payload.payload.signature;
        const nonce = auth.nonce;

        // Validate payment details
        if (auth.to.toLowerCase() !== PAYMENT_RECIPIENT.toLowerCase()) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "Payment recipient mismatch" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        if (auth.value !== MINT_PRICE) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: `Incorrect amount. Expected ${MINT_PRICE}` }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Check if already processed
        if (processedNonces.has(nonce)) {
            return {
                statusCode: 409,
                body: JSON.stringify({ error: "Payment already processed" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        const payer = auth.from;
        console.log(`Processing payment from ${payer}`);

        // Execute USDC transfer authorization
        const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, relayerWallet);
        
        console.log("Executing transferWithAuthorization...");
        
        let paymentTx;
        try {
            paymentTx = await usdcContract.transferWithAuthorization(
                auth.from,
                auth.to,
                auth.value,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                signature
            );
            
            console.log(`USDC transfer submitted: ${paymentTx.hash}`);
            
            const receipt = await paymentTx.wait();
            console.log(`✅ USDC transfer confirmed in block ${receipt.blockNumber}`);
            
            // Verify transfer happened
            if (!verifyUSDCTransfer(receipt, payer)) {
                throw new Error("USDC transfer not found in receipt");
            }
            
        } catch (error) {
            console.error("USDC transfer failed:", error);
            
            if (error.message?.includes("authorization is used")) {
                return {
                    statusCode: 409,
                    body: JSON.stringify({ error: "Payment authorization already used" }),
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }
            
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    error: "Payment processing failed",
                    details: error.message 
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Mark nonce as processed
        processedNonces.add(nonce);

        // Payment successful - now mint NFT for the user
        try {
            const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
            
            console.log(`Minting NFT to ${payer}...`);
            
            const mintTx = await nftContract.mint(payer, 1);
            console.log(`Mint tx: ${mintTx.hash}`);
            
            const mintReceipt = await mintTx.wait();
            console.log(`✅ NFT minted in block ${mintReceipt.blockNumber}`);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    message: "Payment received and NFT minted!",
                    approved: true,
                    data: {
                        recipient: payer,
                        paymentTx: paymentTx.hash,
                        mintTx: mintTx.hash,
                        blockNumber: mintReceipt.blockNumber
                    }
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };

        } catch (mintError) {
            console.error("Minting failed:", mintError);
            
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: "Payment received but minting failed",
                    paymentTx: paymentTx.hash,
                    payer: payer,
                    details: mintError.message,
                    note: "Please contact support with payment tx hash"
                }),
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }

    } catch (error) {
        console.error("Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        };
    }
};
