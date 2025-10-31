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

// Use Coinbase CDP RPC
const provider = new JsonRpcProvider(FACILITATOR_CONFIG.cdpRpcUrl);

let backendWallet;
if (RELAYER_PRIVATE_KEY) {
    backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
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

// =================================================================
// GENERATE JWT TOKEN UNTUK COINBASE CDP API
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
            exp: now + 120, // Valid for 2 minutes
            iat: now
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const message = `${encodedHeader}.${encodedPayload}`;

        // Decode private key from base64
        const privateKeyBuffer = Buffer.from(FACILITATOR_CONFIG.cdpPrivateKey, 'base64');
        
        // Sign with ES256 (ECDSA with P-256 and SHA-256)
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
        console.error('❌ JWT generation error:', error);
        return null;
    }
}

// =================================================================
// REPORT TRANSACTION KE COINBASE CDP
// =================================================================
async function reportToCoinbaseCDP(transactionData) {
    try {
        console.log('📡 Reporting to Coinbase CDP Platform...');
        
        const jwt = generateCoinbaseJWT();
        if (!jwt) {
            console.error('Failed to generate JWT token');
            return { success: false, error: 'JWT generation failed' };
        }

        // Coinbase Platform API - Transaction logging
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

        console.log('📤 Sending to:', endpoint);

        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwt}`,
                'X-Project-ID': FACILITATOR_CONFIG.cdpProjectId
            },
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 500 // Accept all non-5xx
        });

        if (response.status >= 400) {
            console.warn(`⚠️ CDP returned ${response.status}:`, response.data);
            return { success: false, status: response.status, data: response.data };
        }

        console.log('✅ Coinbase CDP logged successfully');
        return { success: true, data: response.data };

    } catch (error) {
        if (error.response) {
            console.error('❌ CDP API error:', {
                status: error.response.status,
                data: error.response.data
            });
        } else {
            console.error('❌ CDP error:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// =================================================================
// EXECUTE USDC TRANSFER
// =================================================================
async function executeUSDCTransfer(authorization, signature) {
    try {
        const { from, to, value, validAfter, validBefore, nonce } = authorization;

        console.log('💸 Executing USDC transfer:', { from, to, value, nonce });

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

        // Parse signature
        const sig = Signature.from(signature);
        const { v, r, s } = sig;

        // Execute transfer
        console.log('🔄 Calling transferWithAuthorization...');
        const tx = await usdcContract.transferWithAuthorization(
            from, to, value, validAfter, validBefore, nonce, v, r, s
        );

        console.log('📝 Transfer tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('✅ Transfer confirmed in block:', receipt.blockNumber);

        processedAuthorizations.add(authKey);

        // 🆕 Report to Coinbase CDP
        await reportToCoinbaseCDP({
            type: 'payment',
            txHash: receipt.hash,
            from: from,
            to: to,
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
        console.error('❌ USDC transfer error:', error);
        
        await reportToCoinbaseCDP({
            type: 'payment',
            from: authorization.from,
            to: authorization.to,
            amount: authorization.value,
            asset: USDC_ADDRESS,
            status: 'failed',
            error: error.message
        });
        
        throw error;
    }
}

// =================================================================
// MINT NFT
// =================================================================
async function mintNFT(recipientAddress) {
    try {
        console.log('🎨 Minting NFT to:', recipientAddress);

        if (!backendWallet) {
            throw new Error('Backend wallet not configured');
        }

        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);

        const balance = await provider.getBalance(backendWallet.address);
        console.log('⛽ Backend wallet balance:', (Number(balance) / 1e18).toFixed(4), 'ETH');

        if (balance < BigInt(1e15)) {
            throw new Error('Insufficient gas in backend wallet');
        }

        console.log('🔄 Calling mint function...');
        const tx = await nftContract.mint(recipientAddress, 1, { gasLimit: 200000 });

        console.log('📝 Mint tx sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('✅ Mint confirmed in block:', receipt.blockNumber);

        // Extract token ID
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

        // 🆕 Report to Coinbase CDP
        await reportToCoinbaseCDP({
            type: 'nft_mint',
            txHash: receipt.hash,
            recipient: recipientAddress,
            tokenId: tokenId,
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
        console.error('❌ Mint error:', error);
        
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
// MAIN HANDLER
// =================================================================
exports.handler = async (event) => {
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

    if (event.httpMethod === 'GET' || !xPaymentHeader) {
        return {
            statusCode: 402,
            body: JSON.stringify({
                x402Version: 1,
                error: "Payment Required",
                message: "Send x402 payment authorization to mint NFT",
                cdpProjectId: FACILITATOR_CONFIG.cdpProjectId,
                serverId: FACILITATOR_CONFIG.x402ServerId,
                provider: "Coinbase CDP",
                accepts: [{
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: MINT_PRICE,
                    resource: `https://${event.headers.host}${event.path}`,
                    description: "the hood runs deep in 402. Pay 1 USDC to mint NFT",
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
                                payload: {
                                    type: "object",
                                    properties: {
                                        signature: { type: "string" },
                                        authorization: { type: "object" }
                                    }
                                }
                            }
                        },
                        output: { 
                            success: "boolean",
                            data: { type: "object" }
                        }
                    },
                    extra: {
                        name: "USD Coin",
                        contractAddress: NFT_CONTRACT_ADDRESS,
                        paymentAddress: PAYMENT_RECIPIENT,
                        autoMint: true,
                        poweredBy: "Coinbase CDP"
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

    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        
        console.log("📨 x402 payment received");

        if (!payload.x402Version || payload.x402Version !== 1) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: "Invalid x402 version" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        if (!payload.payload?.authorization || !payload.payload?.signature) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: "Missing authorization or signature" }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        }

        const { authorization, signature } = payload.payload;
        const userAddress = authorization.from;

        console.log('👤 User:', userAddress);
        console.log('💰 Amount:', authorization.value, 'USDC');

        // Step 1: USDC Transfer
        console.log('\n=== STEP 1: USDC TRANSFER ===');
        const transferResult = await executeUSDCTransfer(authorization, signature);
        console.log('✅ Transfer:', transferResult.txHash);

        // Step 2: NFT Mint
        console.log('\n=== STEP 2: NFT MINT ===');
        const mintResult = await mintNFT(userAddress);
        console.log('✅ Mint: Token #', mintResult.tokenId);

        // Step 3: Final Report
        console.log('\n=== STEP 3: FINAL REPORT ===');
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

        console.log('🎉 Transaction complete!');

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
                    timestamp: new Date().toISOString(),
                    provider: "Coinbase CDP"
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
        if (error.message.includes('already processed')) statusCode = 409;
        else if (error.message.includes('Insufficient')) statusCode = 402;
        else if (error.message.includes('Invalid')) statusCode = 400;
        else if (error.message.includes('gas')) statusCode = 503;

        return {
            statusCode,
            body: JSON.stringify({ success: false, error: error.message }),
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        };
    }
};
