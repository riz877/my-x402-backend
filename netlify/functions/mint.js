const { JsonRpcProvider, Wallet, Contract, Signature } = require('ethers'); // Ditambahkan 'Signature'

// --- CONFIGURATION ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "2000000"; // 2 USDC

const { PROVIDER_URL, RELAYER_PRIVATE_KEY } = process.env;
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");

// Backend wallet untuk execute transfers & minting
let backendWallet;
if (RELAYER_PRIVATE_KEY) {
    backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
}

// ABIs
const USDC_ABI = [
    'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) external',
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
    'function balanceOf(address account) view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const NFT_ABI = [
    'function mint(address to, uint256 amount) public',
    'function totalSupply() public view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const processedAuthorizations = new Set();
const processedMints = new Set();

// =================================================================
// FUNGSI INI TELAH DIPERBARUI
// =================================================================
async function executeUSDCTransfer(authorization, signature) {
    try {
        const { from, to, value, validAfter, validBefore, nonce } = authorization;

        console.log('Executing USDC transfer:', {
            from,
            to,
            value,
            nonce
        });

        if (!backendWallet) {
            throw new Error('Backend wallet not configured');
        }

        const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, backendWallet);

        // Check if already processed
        const authKey = `${from}-${nonce}`.toLowerCase();
        if (processedAuthorizations.has(authKey)) {
            throw new Error('Authorization already processed');
        }

        // Verify amount
        if (BigInt(value) < BigInt(MINT_PRICE)) {
            throw new Error(`Insufficient amount: ${value}, required: ${MINT_PRICE}`);
        }

        // Verify recipient
        if (to.toLowerCase() !== PAYMENT_RECIPIENT.toLowerCase()) {
            throw new Error('Invalid payment recipient');
        }

        // --- PERBAIKAN DIMULAI DISINI ---

        // 1. Pecah signature menjadi v, r, s
        let sig;
        try {
            sig = Signature.from(signature);
        } catch (e) {
            console.error("Invalid signature format:", signature);
            throw new Error('Invalid signature format');
        }
        const { v, r, s } = sig;

        // 2. Panggil transferWithAuthorization (BUKAN receiveWithAuthorization)
        console.log('Calling transferWithAuthorization...');
        
        const tx = await usdcContract.transferWithAuthorization(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            v,  // Gunakan v
            r,  // Gunakan r
            s   // Gunakan s
        );

        // --- PERBAIKAN SELESAI ---

        console.log('Transfer tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Transfer confirmed in block:', receipt.blockNumber);

        // Mark as processed
        processedAuthorizations.add(authKey);

        return {
            success: true,
            txHash: receipt.hash,
            from,
            amount: value
        };

    } catch (error) {
        console.error('USDC transfer error:', error);
        throw error;
    }
}
// =================================================================
// AKHIR DARI FUNGSI YANG DIPERBARUI
// =================================================================


// Mint NFT
async function mintNFT(recipientAddress) {
    try {
        console.log('Minting NFT to:', recipientAddress);

        if (!backendWallet) {
            throw new Error('Backend wallet not configured');
        }

        

        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);

        // Check gas balance
        const balance = await provider.getBalance(backendWallet.address);
        console.log('Backend wallet balance:', (Number(balance) / 1e18).toFixed(4), 'ETH');

        if (balance < BigInt(1e15)) { // 0.001 ETH
            throw new Error('Insufficient gas in backend wallet');
        }

        // Mint NFT
        console.log('Calling mint function...');
        const tx = await nftContract.mint(recipientAddress, 1, {
            gasLimit: 200000 // Set reasonable gas limit
        });

        console.log('Mint tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Mint confirmed in block:', receipt.blockNumber);

        // Extract token ID from Transfer event
        let tokenId;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() &&
                log.topics[0] === TRANSFER_TOPIC) {
                
                const from = '0x' + log.topics[1].substring(26);
                if (from === '0x0000000000000000000000000000000000000000') {
                    tokenId = BigInt(log.topics[3]).toString();
                    break;
                }
            }
        }

        if (!tokenId) {
            const totalSupply = await nftContract.totalSupply();
            tokenId = totalSupply.toString();
        }

        

        return {
            success: true,
            tokenId,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error('Mint error:', error);
        throw error;
    }
}

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
                message: "Send x402 payment authorization to mint NFT",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: `https://${event.headers.host}${event.path}`,
                    description: "the hood runs deep in 402. Pay 2 USDC to mint NFT",
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/hood.png",
                    payTo: PAYMENT_RECIPIENT,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 3600,
                    outputSchema: {
                        input: { 
                            type: "http", 
                            method: "POST",
                            properties: {
                                x402Version: { type: "number" },
                                scheme: { type: "string" },
                                network: { type: "string" },
                                payload: {
                                    type: "object",
                                    properties: {
                                        signature: { type: "string" },
                                        authorization: {
                                            type: "object",
                                            properties: {
                                                from: { type: "string" },
                                                to: { type: "string" },
                                                value: { type: "string" },
                                                validAfter: { type: "string" },
                                                validBefore: { type: "string" },
                                                nonce: { type: "string" }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        output: { 
                            success: "boolean",
                            message: "string",
                            data: {
                                type: "object",
                                properties: {
                                    tokenId: { type: "string" },
                                    nftContract: { type: "string" },
                                    recipient: { type: "string" },
                                    paymentTx: { type: "string" },
                                    mintTx: { type: "string" }
                                }
                            }
                        }
                    },
                    extra: {
                        name: "USD Coin",
                        version: "2",
                        contractAddress: NFT_CONTRACT_ADDRESS,
                        paymentAddress: PAYMENT_RECIPIENT,
                        autoMint: true,
                        description: "Automatic NFT minting upon payment verification"
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

    // --- POST REQUEST: Process x402 payment ---
    try {
        // Parse X-Payment header
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 Received payload:", JSON.stringify(payload, null, 2));

        // Validate x402 format
        if (!payload.x402Version || payload.x402Version !== 1) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false,
                    error: "Invalid x402 version" 
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        if (!payload.payload || !payload.payload.authorization || !payload.payload.signature) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false,
                    error: "Missing authorization or signature in payload" 
                }),
                headers: { 
                    'Content-Type': 'application/json', 
                    'Access-Control-Allow-Origin': '*' 
                }
            };
        }

        const { authorization, signature } = payload.payload;
        const userAddress = authorization.from;

        console.log('👤 User address:', userAddress);
        console.log('💰 Payment amount:', authorization.value, 'USDC (expected:', MINT_PRICE, ')');

        // Step 1: Execute USDC transfer
        console.log('Step 1: Executing USDC transfer...');
        const transferResult = await executeUSDCTransfer(authorization, signature);
        console.log('✅ Transfer successful:', transferResult.txHash);

        // Step 2: Mint NFT
        console.log('Step 2: Minting NFT...');
        const mintResult = await mintNFT(userAddress);
        console.log('✅ Mint successful: Token #', mintResult.tokenId);

        // Return success
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Payment received and NFT minted! 🎉",
                data: {
                    tokenId: mintResult.tokenId,
                    nftContract: NFT_CONTRACT_ADDRESS,
                    recipient: userAddress,
                    paymentTx: transferResult.txHash,
                    mintTx: mintResult.txHash,
                    blockNumber: mintResult.blockNumber,
                    timestamp: new Date().toISOString()
                }
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };

    } catch (error) {
        console.error("❌ Error:", error);
        
        let statusCode = 500;
        let errorMessage = error.message;

        if (error.message.includes('already processed')) {
            statusCode = 409;
        } else if (error.message.includes('Insufficient')) {
            statusCode = 402;
        } else if (error.message.includes('Invalid')) {
            statusCode = 400;
        } else if (error.message.includes('gas')) {
            statusCode = 503;
            errorMessage = 'Service temporarily unavailable (insufficient gas)';
        }

        return {
            statusCode,
            body: JSON.stringify({ 
                success: false,
                error: errorMessage
            }),
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        };
    }
};