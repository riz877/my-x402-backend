const { JsonRpcProvider, Wallet, Contract, Signature } = require('ethers');
const axios = require('axios');
const crypto = require('crypto');
const FACILITATOR_CONFIG = require('../../facilitator-config');

// --- CONFIGURATION ---
const NFT_CONTRACT_ADDRESS = "0x03657531f55ab9b03f5aef07d1af79c070e50366";
const PAYMENT_RECIPIENT = "0x2e6e06f71786955474d35293b09a3527debbbfce";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "1000000"; // 1 USDC

const { RELAYER_PRIVATE_KEY } = process.env;

// --- PERBAIKAN COLD START DIMULAI DI SINI ---
// Kita ubah 'const' jadi 'let' agar bisa di-handle di 'catch'
let provider;
let backendWallet;

try {
    // Kode asli Anda tetap di sini, di dalam try...catch
    provider = new JsonRpcProvider(FACILITATOR_CONFIG.cdpRpcUrl);
    
    if (RELAYER_PRIVATE_KEY) {
        backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
        console.log('✅ Wallet initialized on cold start.');
    } else {
        console.warn('⚠️ RELAYER_PRIVATE_KEY not set on cold start.');
    }
} catch (error) {
    // Ini adalah TAMBAHAN untuk mencegah crash saat GET
    console.error(`🔥 COLD START ERROR: ${error.message}. Wallet init will retry on POST.`);
    provider = null; // Set ke null agar bisa dicoba lagi nanti
    backendWallet = null;
}
// --- PERBAIKAN COLD START SELESAI ---


// ABIs (Tidak ada perubahan)
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

// =================================================================
// GENERATE COINBASE CDP JWT TOKEN (Tidak ada perubahan)
// =================================================================
function generateCoinbaseJWT() {
    try {
        const header = {
            alg: 'ES256',
            typ: 'JWT',
            kid: FACILITATOR_CONFIG.cdpApiKeyId
        };

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            sub: FACILITATOR_CONFIG.cdpApiKeyId,
            iss: 'coinbase-cloud',
            aud: ['api.developer.coinbase.com'],
            nbf: now,
            exp: now + 120,
            iat: now
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const message = `${encodedHeader}.${encodedPayload}`;

        const privateKeyBuffer = Buffer.from(FACILITATOR_CONFIG.cdpPrivateKey, 'base64');
        
        const sign = crypto.createSign('SHA256');
        sign.update(message);
        sign.end();
        
        const signature = sign.sign({
            key: privateKeyBuffer,
            format: 'der',
            type: 'pkcs8'
        }, 'base64url');

        return `${message}.${signature}`;
    } catch (error) {
        console.error('❌ JWT error:', error.message);
        return null;
    }
}

// =================================================================
// REPORT TO COINBASE CDP (Tidak ada perubahan)
// =================================================================
async function reportToCoinbaseCDP(transactionData) {
    try {
        console.log('📡 Reporting to Coinbase CDP...');
        
        const jwt = generateCoinbaseJWT();
        if (!jwt) {
            console.warn('⚠️ JWT generation failed - skipping CDP report');
            return { success: false, error: 'JWT generation failed' };
        }

        const endpoint = `${FACILITATOR_CONFIG.cdpApiUrl}/v1/projects/${FACILITATOR_CONFIG.cdpProjectId}/events`;
        
        const payload = {
            event_name: 'x402_transaction',
            event_type: transactionData.type,
            network: 'base',
            timestamp: new Date().toISOString(),
            properties: {
                transaction_hash: transactionData.txHash || 'pending',
                status: transactionData.status,
                from_address: transactionData.from,
                to_address: transactionData.to,
                amount: transactionData.amount,
                asset_address: transactionData.asset || USDC_ADDRESS,
                block_number: transactionData.blockNumber || null,
                nft_contract: transactionData.nftContract || null,
                token_id: transactionData.tokenId || null,
                recipient: transactionData.recipient || null,
                payment_tx: transactionData.paymentTx || null,
                mint_tx: transactionData.mintTx || null,
                error_message: transactionData.error || null,
                x402_server_id: FACILITATOR_CONFIG.x402ServerId
            }
        };

        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwt}`,
                'X-Project-ID': FACILITATOR_CONFIG.cdpProjectId
            },
            timeout: 10000,
            validateStatus: (status) => status < 500
        });

        if (response.status >= 400) {
            console.warn(`⚠️ CDP returned ${response.status}:`, response.data);
            return { success: false, status: response.status };
        }

        console.log('✅ CDP reported successfully');
        return { success: true, data: response.data };

    } catch (error) {
        console.error('❌ CDP report failed:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// =================================================================
// EXECUTE USDC TRANSFER (Modifikasi kecil)
// =================================================================
async function executeUSDCTransfer(authorization, signature) {
    const { from, to, value, validAfter, validBefore, nonce } = authorization;

    console.log('💸 Processing USDC transfer:', { from, to, value });

    // --- TAMBAHAN: Cek jika wallet gagal dibuat saat cold start ---
    if (!backendWallet) {
        console.warn('Wallet not initialized. Retrying on-demand...');
        try {
            if (!RELAYER_PRIVATE_KEY) {
                throw new Error('FATAL: RELAYER_PRIVATE_KEY env var not set');
            }
            if (!provider) { // Jika provider juga gagal
                provider = new JsonRpcProvider(FACILITATOR_CONFIG.cdpRpcUrl);
            }
            backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
            console.log('✅ Wallet initialized on-demand.');
        } catch (initError) {
            console.error('❌ FATAL: On-demand wallet init failed:', initError.message);
            throw new Error('Backend wallet initialization failed on-demand');
        }
    }
    // --- AKHIR TAMBAHAN ---

    // Kode asli Anda
    if (!backendWallet) {
        throw new Error('Backend wallet not configured');
    }

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

    try {
        const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, backendWallet);
        const sig = Signature.from(signature);
        const { v, r, s } = sig;

        const tx = await usdcContract.transferWithAuthorization(
            from, to, value, validAfter, validBefore, nonce, v, r, s
        );

        console.log('📝 Transfer tx:', tx.hash);
        const receipt = await tx.wait();
        console.log('✅ Confirmed in block:', receipt.blockNumber);

        processedAuthorizations.add(authKey);

        await reportToCoinbaseCDP({
            type: 'payment',
            txHash: receipt.hash,
            from, to, 
            amount: value,
            asset: USDC_ADDRESS,
            blockNumber: receipt.blockNumber,
            status: 'confirmed'
        });

        return {
            success: true,
            txHash: receipt.hash,
            from,
            amount: value,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error('❌ Transfer failed:', error.message);
        
        await reportToCoinbaseCDP({
            type: 'payment',
            from, to,
            amount: value,
            asset: USDC_ADDRESS,
            status: 'failed',
            error: error.message
        });
        
        throw error;
    }
}

// =================================================================
// MINT NFT (Modifikasi kecil)
// =================================================================
async function mintNFT(recipientAddress) {
    console.log('🎨 Minting NFT to:', recipientAddress);

    if (!backendWallet) {
        throw new Error('Backend wallet not configured');
    }

    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);
        
        // --- TAMBAHAN: Cek jika provider gagal ---
        let currentProvider = provider;
        if (!currentProvider) {
            console.warn('Provider not initialized. Retrying on-demand...');
            try {
                currentProvider = new JsonRpcProvider(FACILITATOR_CONFIG.cdpRpcUrl);
                console.log('✅ Provider initialized on-demand.');
            } catch (initError) {
                console.error('❌ FATAL: On-demand provider init failed:', initError.message);
                throw new Error('Provider initialization failed on-demand');
            }
        }
        // --- AKHIR TAMBAHAN ---

        const balance = await currentProvider.getBalance(backendWallet.address); // Menggunakan currentProvider
        console.log('⛽ Gas balance:', (Number(balance) / 1e18).toFixed(4), 'ETH');

        if (balance < BigInt(1e15)) {
            throw new Error('Insufficient gas in backend wallet');
        }

        const tx = await nftContract.mint(recipientAddress, 1, { gasLimit: 200000 });
        console.log('📝 Mint tx:', tx.hash);
        
        const receipt = await tx.wait();
        console.log('✅ Minted in block:', receipt.blockNumber);

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

        await reportToCoinbaseCDP({
            type: 'nft_mint',
            txHash: receipt.hash,
            recipient: recipientAddress,
            tokenId,
            nftContract: NFT_CONTRACT_ADDRESS,
            blockNumber: receipt.blockNumber,
            status: 'confirmed'
        });

        return {
            success: true,
            tokenId,
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error('❌ Mint failed:', error.message);
        
        await reportToCoinbaseCDP({
            type: 'nft_mint',
            recipient: recipientAddress,
            nftContract: NFT_CONTRACT_ADDRESS,
            status: 'failed',
            error: error.message
        });
        
        throw error;
    }
}

// =================================================================
// NETLIFY HANDLER (Tidak ada perubahan)
// =================================================================
exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Payment',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers
        };
    }

    const xPaymentHeader = event.headers['x-payment'] || event.headers['X-Payment'];

    // BLOK GET INI SEKARANG AMAN KARENA COLD START CRASH DICEGAH
    if (event.httpMethod === 'GET' || !xPaymentHeader) {
        const resource = `https://${event.headers.host}${event.path}`;
        
        return {
            statusCode: 402,
            headers: {
                ...headers,
                'Cache-Control': 'no-cache',
                'X-402-Version': '1',
                'WWW-Authenticate': 'x402'
            },
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "the hood runs deep in 402. Pay 1 USDC to mint NFT",
                serverId: FACILITATOR_CONFIG.x402ServerId,
                cdpProjectId: FACILITATOR_CONFIG.cdpProjectId,
                provider: "Coinbase CDP",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    minAmountRequired: MINT_PRICE,
                    resource: resource,
                    description: "the hood runs deep in 402. Pay 1 USDC to mint NFT",
                    mimeType: "application/json",
                    image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/hood.png",
                    payTo: PAYMENT_RECIPIENT,
                    asset: USDC_ADDRESS,
                    maxTimeoutSeconds: 3600,
                    extra: {
                        name: "Hood NFT",
                        contractAddress: NFT_CONTRACT_ADDRESS,
                        paymentAddress: PAYMENT_RECIPIENT,
                        autoMint: true,
                        category: "nft",
                        poweredBy: "Coinbase CDP"
                    }
                }]
            })
        };
    }

    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 x402 payment received");

        if (!payload.x402Version || payload.x402Version !== 1) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: "Invalid x402 version" })
            };
        }

        if (!payload.payload?.authorization || !payload.payload?.signature) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: "Missing authorization or signature" })
            };
        }

        const { authorization, signature } = payload.payload;
        const userAddress = authorization.from;

        console.log('👤 User:', userAddress);
        console.log('💰 Amount:', authorization.value);

        console.log('\n=== STEP 1: TRANSFER ===');
        const transferResult = await executeUSDCTransfer(authorization, signature);

        console.log('\n=== STEP 2: MINT ===');
        const mintResult = await mintNFT(userAddress);

        console.log('\n=== STEP 3: REPORT ===');
        await reportToCoinbaseCDP({
            type: 'complete_transaction',
            txHash: mintResult.txHash,
            from: userAddress,
            to: PAYMENT_RECIPIENT,
            amount: authorization.value,
            asset: USDC_ADDRESS,
            nftContract: NFT_CONTRACT_ADDRESS,
            tokenId: mintResult.tokenId,
            recipient: userAddress,
            paymentTx: transferResult.txHash,
            mintTx: mintResult.txHash,
            blockNumber: mintResult.blockNumber,
            status: 'success'
        });

        console.log('🎉 Complete!');

        return {
            statusCode: 200,
            headers,
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
                    timestamp: new Date().toISOString(),
                    cdpReported: true
                }
            })
        };

    } catch (error) {
        console.error("❌ Error:", error.message);
        
        let statusCode = 500;
        if (error.message.includes('already processed')) statusCode = 409;
        else if (error.message.includes('Insufficient')) statusCode = 402;
        else if (error.message.includes('Invalid')) statusCode = 400;
        else if (error.message.includes('gas')) statusCode = 503;

        return {
            statusCode,
            headers,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};