// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract } = require('ethers');

const NFT_CONTRACT_ADDRESS = "0x03657531f55ab9b03f5aef07d1af79c070e50366";
const PAYMENT_ADDRESS = "0x2e6e06f71786955474d35293b09a3527debbbfce";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "1000000"; // 2 USDC

// Lazy/guarded initialization for provider and wallet so GET requests
// that only return a 402 don't crash during module import if env vars
// are missing or the private key is invalid.
let provider;
let wallet;
try {
    provider = new JsonRpcProvider(process.env.PROVIDER_URL || "https://mainnet.base.org");
} catch (e) {
    console.warn('Warning: provider initialization failed:', e.message);
    provider = null;
}

if (process.env.RELAYER_PRIVATE_KEY) {
    try {
        wallet = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    } catch (e) {
        console.warn('Warning: RELAYER_PRIVATE_KEY invalid or provider missing:', e.message);
        wallet = null;
    }
} else {
    wallet = null;
}

const NFT_ABI = [
    "function mint(address _to, uint256 _mintAmount) external"
];

const USDC_ABI = [
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) external",
    "function transfer(address to, uint256 value) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)"
];

const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet);
const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, wallet);

const processedNonces = new Set();

exports.handler = async (event) => {
    // CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, X-Payment',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            }
        };
    }

    const xPayment = event.headers['x-payment'] || event.headers['X-Payment'];
    // event.path can be undefined when invoking the handler locally; prefer
    // event.path -> event.rawPath -> fallback to '/'
    const requestedPath = event.path || event.rawPath || '/';
    const resourceUrl = `https://${event.headers.host}${requestedPath}`;

    // Return 402 Payment Required
    if (!xPayment) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Pay 1 USDC to mint your NFT",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    asset: USDC_ADDRESS,
                    payTo: PAYMENT_ADDRESS,
                    maxAmountRequired: MINT_PRICE,
                    maxTimeoutSeconds: 600,
                    resource: resourceUrl,
                    mimeType: "application/json",
                    description: "the hood runs deep in 402",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg"
                }]
            }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }

    // Process payment
    try {
        let payload;
        
        // Parse X-Payment header
        try {
            const decoded = Buffer.from(xPayment, 'base64').toString('utf8');
            payload = JSON.parse(decoded);
        } catch {
            payload = JSON.parse(xPayment);
        }
        
        console.log("Received x402 payment:", JSON.stringify(payload, null, 2));

        // Extract authorization and signature
        const auth = payload.payload?.authorization || payload.authorization;
        const sig = payload.payload?.signature || payload.signature;

        if (!auth || !sig) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Missing authorization or signature" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        const { from, to, value, validAfter, validBefore, nonce } = auth;

        // Validate payment
        if (to.toLowerCase() !== PAYMENT_ADDRESS.toLowerCase()) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Invalid payment address" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        if (BigInt(value) < BigInt(MINT_PRICE)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: "Insufficient payment",
                    required: MINT_PRICE,
                    received: value
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        // Check for replay
        if (processedNonces.has(nonce)) {
            return {
                statusCode: 409,
                body: JSON.stringify({ error: "Payment already processed" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        console.log(`Processing payment from ${from}...`);

        // Execute USDC transfer
        const transferTx = await usdcContract.transferWithAuthorization(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            sig
        );

        console.log(`Payment tx: ${transferTx.hash}`);
        const transferReceipt = await transferTx.wait();

        if (transferReceipt.status !== 1) {
            throw new Error("Payment transaction failed");
        }

        console.log(`✅ Payment received, minting NFT...`);

        // Mint NFT
        const mintTx = await nftContract.mint(from, 1);
        console.log(`Mint tx: ${mintTx.hash}`);
        
        const mintReceipt = await mintTx.wait();

        if (mintReceipt.status !== 1) {
            throw new Error("Mint transaction failed");
        }

        console.log(`✅ NFT minted successfully`);

        // Mark as processed
        processedNonces.add(nonce);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Payment received and NFT minted",
                recipient: from,
                paymentTx: transferTx.hash,
                mintTx: mintTx.hash,
                explorerUrl: `https://basescan.org/tx/${mintTx.hash}`
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };

    } catch (error) {
        console.error("Error:", error);
        
        let errorMessage = error.message;
        
        // Handle common errors
        if (error.message.includes('used')) {
            errorMessage = "This payment has already been used";
        } else if (error.message.includes('not yet valid')) {
            errorMessage = "Payment authorization not yet valid";
        } else if (error.message.includes('expired')) {
            errorMessage = "Payment authorization expired";
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }
};
