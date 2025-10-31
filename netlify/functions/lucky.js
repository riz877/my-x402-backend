const { JsonRpcProvider, Wallet, Contract, Signature } = require('ethers');

// --- KONFIGURASI ---
const NFT_CONTRACT_ADDRESS = "0x03657531f55ab9b03f5aef07d1af79c070e50366"; // Kontrak NFT Anda
const PAYMENT_RECIPIENT = "0x2e6e06f71786955474d35293b09a3527debbbfce"; // Dompet Anda
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC di Base
const MINT_PRICE = "10000"; // 0.10 USDC (karena 6 desimal)
const WIN_CHANCE_PERCENT = 2; // 50% Peluang menang

const { PROVIDER_URL, RELAYER_PRIVATE_KEY } = process.env;
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");

// Backend wallet
let backendWallet;
if (RELAYER_PRIVATE_KEY) {
    backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
}

// ABIs
const USDC_ABI = [
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
    'function balanceOf(address account) view returns (uint256)'
];
const NFT_ABI = [
    'function mint(address to, uint256 amount) public',
    'function totalSupply() public view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const processedAuthorizations = new Set();
const processedMints = new Set();

// Fungsi executeUSDCTransfer
async function executeUSDCTransfer(authorization, signature) {
    try {
        const { from, to, value, validAfter, validBefore, nonce } = authorization;
        console.log('Executing USDC transfer:', { from, to, value, nonce });
        if (!backendWallet) throw new Error('Backend wallet not configured');
        const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, backendWallet);
        const authKey = `${from}-${nonce}`.toLowerCase();
        if (processedAuthorizations.has(authKey)) {
            throw new Error('Authorization already processed');
        }
        if (BigInt(value) < BigInt(MINT_PRICE)) {
            throw new Error(`Insufficient amount: ${value}, required: ${MINT_PRICE}`);
        }
        if (to.toLowerCase() !== PAYMENT_RECIPIENT.toLowerCase()) {
            throw new Error('Invalid payment recipient');
        }
        let sig;
        try {
            sig = Signature.from(signature);
        } catch (e) {
            throw new Error('Invalid signature format');
        }
        const { v, r, s } = sig;
        console.log('Calling transferWithAuthorization...');
        const tx = await usdcContract.transferWithAuthorization(
            from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        const receipt = await tx.wait();
        console.log('Transfer confirmed in block:', receipt.blockNumber);
        processedAuthorizations.add(authKey);
        return { success: true, txHash: receipt.hash, from, amount: value };
    } catch (error) {
        console.error('USDC transfer error:', error);
        throw error;
    }
}

// Fungsi mintNFT
async function mintNFT(recipientAddress) {
    try {
        console.log('Minting NFT to:', recipientAddress);
        if (!backendWallet) throw new Error('Backend wallet not configured');
        const mintKey = recipientAddress.toLowerCase();
        if (processedMints.has(mintKey)) {
            throw new Error('Already minted for this address');
        }
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);
        const balance = await provider.getBalance(backendWallet.address);
        if (balance < BigInt(1e15)) { // 0.001 ETH
            throw new Error('Insufficient gas in backend wallet');
        }
        console.log('Calling mint function...');
        const tx = await nftContract.mint(recipientAddress, 1, { gasLimit: 200000 });
        const receipt = await tx.wait();
        console.log('Mint confirmed in block:', receipt.blockNumber);
        let tokenId;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() &&
                log.topics[0] === TRANSFER_TOPIC &&
                '0x' + log.topics[1].substring(26) === '0x0000000000000000000000000000000000000000') {
                tokenId = BigInt(log.topics[3]).toString();
                break;
            }
        }
        if (!tokenId) {
            tokenId = (await nftContract.totalSupply()).toString();
        }
        processedMints.add(mintKey);
        setTimeout(() => processedMints.delete(mintKey), 3600000);
        return { success: true, tokenId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
    } catch (error) {
        console.error('Mint error:', error);
        throw error;
    }
}

// =================================================================
// HANDLER (FUNGSI UTAMA)
// =================================================================
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

    // --- GET REQUEST: (outputSchema diperbaiki) ---
    if (event.httpMethod === 'GET' || !xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Pay 0.10 USDC to try your luck",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: `https://${event.headers.host}${event.path}`,
                    description: `Try to mint if you think you're lucky enough. ${WIN_CHANCE_PERCENT}% chance!`,
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
                    payTo: PAYMENT_RECIPIENT,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 3600,
                    outputSchema: {
                        // --- PERBAIKAN DIMULAI DISINI ---
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
                        // --- PERBAIKAN SELESAI ---
                        output: { 
                            success: "boolean",
                            message: "string",
                            data: {
                                type: "object",
                                properties: {
                                    lucky: { type: "boolean" },
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
                        autoMint: false,
                        description: "Lucky draw minting upon payment"
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

    // --- POST REQUEST: (Logika minting) ---
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 Received payload:", JSON.stringify(payload, null, 2));

        if (!payload.x402Version || !payload.payload || !payload.payload.authorization || !payload.payload.signature) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: "Invalid x402 payload" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        const { authorization, signature } = payload.payload;
        const userAddress = authorization.from;

        console.log('👤 User address:', userAddress);
        console.log('💰 Payment amount:', authorization.value, 'USDC (expected:', MINT_PRICE, ')');

        // Step 1: Eksekusi transfer USDC
        console.log('Step 1: Executing USDC transfer...');
        const transferResult = await executeUSDCTransfer(authorization, signature);
        console.log('✅ Transfer successful:', transferResult.txHash);

        // Step 2: Tentukan keberuntungan
        console.log('Step 2: Rolling the dice...');
        const winThreshold = WIN_CHANCE_PERCENT / 100; // 0.5
        const roll = Math.random(); // Angka antara 0.0 dan 1.0
        const isLucky = roll < winThreshold;

        console.log(`Roll: ${roll.toFixed(4)}, Threshold: ${winThreshold}, Lucky: ${isLucky}`);

        // Step 3: Minting HANYA jika beruntung
        if (isLucky) {
            console.log('✅ Lucky! Minting NFT...');
            const mintResult = await mintNFT(userAddress);
            console.log('✅ Mint successful: Token #', mintResult.tokenId);

            // Return sukses (Menang)
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    message: "You're lucky! Payment received and NFT minted! 🎉",
                    data: {
                        lucky: true,
                        tokenId: mintResult.tokenId,
                        nftContract: NFT_CONTRACT_ADDRESS,
                        recipient: userAddress,
                        paymentTx: transferResult.txHash,
                        mintTx: mintResult.txHash,
                        blockNumber: mintResult.blockNumber,
                        timestamp: new Date().toISOString()
                    }
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };

        } else {
            console.log('❌ Unlucky. No mint.');

            // Return sukses (Kalah)
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    message: "Sorry, not lucky this time. Better luck next time!",
                    data: {
                        lucky: false,
                        recipient: userAddress,
                        paymentTx: transferResult.txHash,
                        timestamp: new Date().toISOString()
                    }
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

    } catch (error) {
        console.error("❌ Error:", error);
        
        let statusCode = 500;
        let errorMessage = error.message;

        if (error.message.includes('already processed')) statusCode = 409;
        else if (error.message.includes('Insufficient')) statusCode = 402;
        else if (error.message.includes('Invalid')) statusCode = 400;
        else if (error.message.includes('gas')) {
            statusCode = 503;
            errorMessage = 'Service temporarily unavailable (insufficient gas)';
        }

        return {
            statusCode,
            body: JSON.stringify({ success: false, error: errorMessage }),
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        };
    }
};