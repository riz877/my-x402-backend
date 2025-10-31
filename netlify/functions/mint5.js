const { JsonRpcProvider, Wallet, Contract, Signature } = require('ethers');

// --- KONFIGURASI (DIUBAH) ---
const NFT_CONTRACT_ADDRESS = "0x03657531f55ab9b03f5aef07d1af79c070e50366";
const PAYMENT_RECIPIENT = "0x2e6e06f71786955474d35293b09a3527debbbfce";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "5000000"; // 10 USDC (10 * 1,000,000)
const MINT_AMOUNT = 5; // 5 NFT
// --- AKHIR PERUBAHAN ---

const { PROVIDER_URL, RELAYER_PRIVATE_KEY } = process.env;

// Guarded provider and backend wallet initialization
let provider;
let backendWallet;
try {
    provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
} catch (e) {
    console.warn('mint5.js: provider initialization warning:', e.message);
    provider = null;
}

if (RELAYER_PRIVATE_KEY) {
    try {
        backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
    } catch (e) {
        console.warn('mint5.js: RELAYER_PRIVATE_KEY invalid or provider missing:', e.message);
        backendWallet = null;
    }
} else {
    backendWallet = null;
}

// ABIs
const USDC_ABI = [
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

// Fungsi executeUSDCTransfer (Tidak ada perubahan, tapi akan menggunakan MINT_PRICE baru)
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

        // Verifikasi jumlah (sekarang harus $10)
        if (BigInt(value) < BigInt(MINT_PRICE)) {
            throw new Error(`Insufficient amount: ${value}, required: ${MINT_PRICE}`);
        }
        if (to.toLowerCase() !== PAYMENT_RECIPIENT.toLowerCase()) {
            throw new Error('Invalid payment recipient');
        }

        // Pre-check payer balance
        try {
            const userBalance = await usdcContract.balanceOf(from);
            if (BigInt(userBalance) < BigInt(value)) {
                throw new Error('Payer has insufficient USDC balance');
            }
        } catch (balErr) {
            console.warn('Warning: could not verify payer balance:', balErr.message);
        }

        let sig;
        try {
            sig = Signature.from(signature);
        } catch (e) {
            console.error("Invalid signature format:", signature);
            throw new Error('Invalid signature format');
        }
        const { v, r, s } = sig;

        console.log('Calling transferWithAuthorization...');
        let tx;
        try {
            tx = await usdcContract.transferWithAuthorization(
                from, to, value, validAfter, validBefore, nonce, v, r, s
            );
        } catch (err) {
            const reason = err.reason || err.error?.message || '';
            if (String(reason).toLowerCase().includes('transfer amount exceeds balance') || String(reason).toLowerCase().includes('insufficient')) {
                const userErr = new Error('Payment failed: payer has insufficient USDC balance');
                userErr.original = err;
                throw userErr;
            }
            throw err;
        }

        console.log('Transfer tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Transfer confirmed in block:', receipt.blockNumber);

        processedAuthorizations.add(authKey);
        return { success: true, txHash: receipt.hash, from, amount: value };
    } catch (error) {
        console.error('USDC transfer error:', error);
        throw error;
    }
}


// =================================================================
// FUNGSI MINTNFT (DIUBAH)
// =================================================================
async function mintNFT(recipientAddress) {
    try {
        console.log(`Minting ${MINT_AMOUNT} NFTs to:`, recipientAddress); // Log diubah

        if (!backendWallet) {
            throw new Error('Backend wallet not configured');
        }

        // Cek unlimited mint (sudah dihapus dari kode Anda sebelumnya)
        
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);
        const balance = await provider.getBalance(backendWallet.address);
        console.log('Backend wallet balance:', (Number(balance) / 1e18).toFixed(4), 'ETH');

        if (balance < BigInt(1e15)) { // 0.001 ETH
            throw new Error('Insufficient gas in backend wallet');
        }

        // Mint NFT (Jumlah diubah ke MINT_AMOUNT)
        console.log('Calling mint function for 5 NFTs...');
        const tx = await nftContract.mint(recipientAddress, MINT_AMOUNT, { // <-- DIUBAH
            gasLimit: 800000 // Gas limit dinaikkan untuk 5 mint
        });

        console.log('Mint tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('Mint confirmed in block:', receipt.blockNumber);

        // Extract token IDs (jamak)
        let tokenIds = []; // <-- DIUBAH ke array
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() &&
                log.topics[0] === TRANSFER_TOPIC) {
                
                const from = '0x' + log.topics[1].substring(26);
                if (from === '0x0000000000000000000000000000000000000000') {
                    // Tambahkan ID ke array, jangan break
                    tokenIds.push(BigInt(log.topics[3]).toString()); // <-- DIUBAH
                }
            }
        }

        if (tokenIds.length === 0) { // <-- DIUBAH
            // Fallback ini tidak bisa diandalkan, jadi lempar error
            throw new Error('Could not parse token IDs from mint transaction');
        }

        return {
            success: true,
            tokenIds, // <-- DIUBAH
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error('Mint error:', error);
        throw error;
    }
}
// =================================================================
// AKHIR FUNGSI MINTNFT
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

    // --- GET REQUEST (DIUBAH) ---
    if (event.httpMethod === 'GET' || !xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Send x402 payment authorization to mint 5 NFTs", // <-- Diubah
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE, // Otomatis $10
                    resource: `https://${event.headers.host}${event.path}`,
                    description: "the hood runs deep in 402. Pay 10 USDC to mint 5 NFTs", // <-- Diubah
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
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
                                    // --- DIUBAH ---
                                    tokenIds: { type: "array", items: { type: "string" } }, 
                                    // ---
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

    // --- POST REQUEST (DIUBAH) ---
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 Received payload:", JSON.stringify(payload, null, 2));

        if (!payload.x402Version || payload.x402Version !== 1) {
             return { /* ... error handling ... */ };
        }
        if (!payload.payload || !payload.payload.authorization || !payload.payload.signature) {
             return { /* ... error handling ... */ };
        }

        const { authorization, signature } = payload.payload;
        const userAddress = authorization.from;

        console.log('👤 User address:', userAddress);
        console.log('💰 Payment amount:', authorization.value, 'USDC (expected:', MINT_PRICE, ')');

        // Step 1: Execute USDC transfer
        console.log('Step 1: Executing USDC transfer...');
        const transferResult = await executeUSDCTransfer(authorization, signature);
        console.log('✅ Transfer successful:', transferResult.txHash);

        // Step 2: Mint 5 NFTs
        console.log('Step 2: Minting 5 NFTs...');
        const mintResult = await mintNFT(userAddress);
        console.log('✅ Mint successful: Token IDs:', mintResult.tokenIds.join(', ')); // <-- Diubah

        // Return success
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: "Payment received and 5 NFTs minted! 🎉", // <-- Diubah
                data: {
                    tokenIds: mintResult.tokenIds, // <-- Diubah
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
        // ... (Error handling tetap sama) ...
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