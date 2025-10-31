const { JsonRpcProvider, Wallet, Contract, Signature, verifyTypedData } = require('ethers');
const axios = require('axios');
const crypto = require('crypto');

// --- NO LONGER 'require' FOR CONFIG ---
// We will use process.env directly

// --- OTHER CONFIGURATIONS ---
const NFT_CONTRACT_ADDRESS = "0x03657531f55ab9b03f5aef07d1af79c070e50366";
const PAYMENT_RECIPIENT = "0x2e6e06f71786955474d35293b09a3527debbbfce";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MINT_PRICE = "1000000"; // 1 USDC

// Get variables from Netlify Environment
const { 
    RELAYER_PRIVATE_KEY,
    CDP_RPC_URL,
    CDP_API_KEY_ID,
    CDP_PRIVATE_KEY,
    CDP_API_URL,
    CDP_PROJECT_ID,
    X402_SERVER_ID
} = process.env;


// --- COLD START FIX (Already good, modified for env vars) ---
let provider;
let backendWallet;

try {
    // Using CDP_RPC_URL from process.env
    if (!CDP_RPC_URL) {
        throw new Error("CDP_RPC_URL environment variable not set");
    }
    provider = new JsonRpcProvider(CDP_RPC_URL);
    
    if (RELAYER_PRIVATE_KEY) {
        backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
        console.log('✅ Wallet initialized on cold start.');
    } else {
        console.warn('⚠️ RELAYER_PRIVATE_KEY not set on cold start.');
    }
} catch (error) {
    console.error(`🔥 COLD START ERROR: ${error.message}. Wallet init will retry on POST.`);
    provider = null; 
    backendWallet = null;
}
// --- END COLD START FIX ---


// ABIs (No change)
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
// GENERATE COINBASE CDP JWT TOKEN (Modified for env vars)
// =================================================================
function generateCoinbaseJWT() {
    try {
        if (!CDP_API_KEY_ID || !CDP_PRIVATE_KEY) {
            throw new Error("Missing CDP_API_KEY_ID or CDP_PRIVATE_KEY");
        }
        
        const header = {
            alg: 'ES256',
            typ: 'JWT',
            kid: CDP_API_KEY_ID // From env
        };

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            sub: CDP_API_KEY_ID, // From env
            iss: 'coinbase-cloud',
            aud: ['api.developer.coinbase.com'],
            nbf: now,
            exp: now + 120,
            iat: now
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const message = `${encodedHeader}.${encodedPayload}`;

        // CDP_PRIVATE_KEY can be provided either as a base64-encoded DER PKCS8
        // blob, or as a PEM string. Normalize both cases to a DER Buffer.
        let privateKeyDerBuffer;
        if (typeof CDP_PRIVATE_KEY === 'string' && CDP_PRIVATE_KEY.includes('-----BEGIN')) {
            // PEM provided: import and export DER PKCS8
            try {
                const keyObj = crypto.createPrivateKey({ key: CDP_PRIVATE_KEY, format: 'pem', type: 'pkcs8' });
                privateKeyDerBuffer = keyObj.export({ format: 'der', type: 'pkcs8' });
            } catch (pemErr) {
                throw new Error('Failed to parse PEM CDP_PRIVATE_KEY: ' + pemErr.message);
            }
        } else {
            // Assume base64-encoded DER
            try {
                privateKeyDerBuffer = Buffer.from(CDP_PRIVATE_KEY, 'base64');
            } catch (b64Err) {
                throw new Error('CDP_PRIVATE_KEY is not valid base64 or PEM');
            }
        }

        const sign = crypto.createSign('SHA256');
        sign.update(message);
        sign.end();

        const signature = sign.sign({
            key: privateKeyDerBuffer,
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
// REPORT TO COINBASE CDP (Modified for env vars)
// =================================================================
async function reportToCoinbaseCDP(transactionData) {
    try {
        console.log('📡 Reporting to Coinbase CDP...');
        
        if (!CDP_API_URL || !CDP_PROJECT_ID) {
            throw new Error("Missing CDP_API_URL or CDP_PROJECT_ID");
        }
        
        const jwt = generateCoinbaseJWT();
        if (!jwt) {
            console.warn('⚠️ JWT generation failed - skipping CDP report');
            return { success: false, error: 'JWT generation failed' };
        }

        const endpoint = `${CDP_API_URL}/v1/projects/${CDP_PROJECT_ID}/events`; // From env
        
        const payload = {
            event_name: 'x402_transaction',
            event_type: transactionData.type,
            network: 'base',
            timestamp: new Date().toISOString(),
            properties: {
                // ... (other properties)
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
                x402_server_id: X402_SERVER_ID // From env
            }
        };

        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwt}`,
                'X-Project-ID': CDP_PROJECT_ID // From env
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
// EXECUTE USDC TRANSFER (Modified for env vars)
// =================================================================
async function executeUSDCTransfer(authorization, signature) {
    const { from, to, value, validAfter, validBefore, nonce } = authorization;

    console.log('💸 Processing USDC transfer:', { from, to, value });

    // --- On-demand check ---
    if (!backendWallet) {
        console.warn('Wallet not initialized. Retrying on-demand...');
        try {
            if (!RELAYER_PRIVATE_KEY) {
                throw new Error('FATAL: RELAYER_PRIVATE_KEY env var not set');
            }
            if (!provider) { 
                if (!CDP_RPC_URL) throw new Error("CDP_RPC_URL not set");
                provider = new JsonRpcProvider(CDP_RPC_URL); // From env
            }
            backendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
            console.log('✅ Wallet initialized on-demand.');
        } catch (initError) {
            console.error('❌ FATAL: On-demand wallet init failed:', initError.message);
            throw new Error('Backend wallet initialization failed on-demand');
        }
    }
    // --- END ADDITION ---

    // ... (rest of the logic is unchanged) ...
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

        // Pre-check payer's USDC balance to provide a clearer error
        try {
            const userBalance = await usdcContract.balanceOf(from);
            if (BigInt(userBalance) < BigInt(value)) {
                throw new Error('Payer has insufficient USDC balance');
            }
        } catch (balErr) {
            // If balanceOf call itself fails, continue and let transferWithAuthorization surface the error
            console.warn('Warning: could not verify payer balance:', balErr.message);
        }

        // Normalize signature: accept hex (0x..) or base64 string
        let sigHex = signature;
        if (typeof sigHex === 'string' && !sigHex.startsWith('0x')) {
            // try base64 -> hex
            try {
                sigHex = '0x' + Buffer.from(sigHex, 'base64').toString('hex');
            } catch (e) {
                // fallback: leave as-is
            }
        }

        // Verify EIP-712 signature server-side before attempting transfer
        try {
            const network = await provider.getNetwork();
            const chainId = network.chainId;

            const domain = {
                name: 'FiatTokenV2',
                version: '1',
                chainId,
                verifyingContract: USDC_ADDRESS
            };

            const types = {
                TransferWithAuthorization: [
                    { name: 'from', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' }
                ]
            };

            const valueObj = {
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            };

            const recovered = await verifyTypedData(domain, types, valueObj, sigHex);
            console.log('🔎 Signature recovered address:', recovered);
            if (recovered.toLowerCase() !== from.toLowerCase()) {
                const err = new Error(`Payment failed: invalid signature (recovered ${recovered} != expected ${from})`);
                err.original = new Error('FiatTokenV2: invalid signature');
                throw err;
            }
        } catch (verr) {
            // If verification error, surface a friendly message
            if (verr.message && verr.message.includes('Failed to parse')) {
                console.warn('Warning: signature parse issue:', verr.message);
            }
            if (verr.message && verr.message.includes('invalid signature')) {
                throw new Error('Payment failed: invalid signature (client signature did not match payer address)');
            }
            // If it's a verifyTypedData or provider error, propagate a friendly message
            if (verr.message && !verr.message.toLowerCase().includes('payer has insufficient')) {
                throw new Error(verr.message);
            }
        }

        const sig = Signature.from(sigHex);
        const { v, r, s } = sig;

        let tx;
        try {
            tx = await usdcContract.transferWithAuthorization(
                from, to, value, validAfter, validBefore, nonce, v, r, s
            );
        } catch (err) {
            // Map common revert reasons to friendlier messages
            const reason = err.reason || err.error?.message || '';
            if (reason.toLowerCase().includes('transfer amount exceeds balance') || reason.toLowerCase().includes('insufficient')) {
                const userErr = new Error('Payment failed: payer has insufficient USDC balance');
                userErr.original = err;
                throw userErr;
            }
            throw err;
        }

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
// MINT NFT (Modified for env vars)
// =================================================================
async function mintNFT(recipientAddress) {
    console.log('🎨 Minting NFT to:', recipientAddress);

    if (!backendWallet) {
        throw new Error('Backend wallet not configured');
    }

    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);
        
        let currentProvider = provider;
        if (!currentProvider) {
            console.warn('Provider not initialized. Retrying on-demand...');
            try {
                if (!CDP_RPC_URL) throw new Error("CDP_RPC_URL not set");
                currentProvider = new JsonRpcProvider(CDP_RPC_URL); // From env
                console.log('✅ Provider initialized on-demand.');
            } catch (initError) {
                console.error('❌ FATAL: On-demand provider init failed:', initError.message);
                throw new Error('Provider initialization failed on-demand');
            }
        }

        const balance = await currentProvider.getBalance(backendWallet.address); 
        console.log('⛽ Gas balance:', (Number(balance) / 1e18).toFixed(4), 'ETH');

        if (balance < BigInt(1e15)) {
            throw new Error('Insufficient gas in backend wallet');
        }
        
        // ... (rest of the logic is unchanged) ...

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
// NETLIFY HANDLER (Modified for env vars)
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

    // GET/HEAD: return the x402 payment descriptor. Don't fail with 500
    // when optional CDP env vars are missing; instead return a 402 so
    // scanners (like x402scan) can read the `accepts` descriptor and
    // register the resource. Include serverId/cdpProjectId only if set.
    if (event.httpMethod === 'GET' || event.httpMethod === 'HEAD' || !xPaymentHeader) {

        // Determine the public host/path that the caller used. Netlify and
        // proxies may set forwarding headers; prefer those so the descriptor
        // reports the pretty URL (e.g. /mint) rather than the internal
        // function path.
        const host = event.headers['x-forwarded-host'] || event.headers['x-original-host'] || event.headers['host'];

        const forwardedPath = event.path || event.rawPath || event.headers['x-nf-path'] || event.headers['x-original-url'] || event.headers['x-forwarded-path'] || '/';
        // Some proxies include the full URL in x-original-url; if so, extract pathname
        let pathOnly = forwardedPath;
        try {
            if (typeof forwardedPath === 'string' && forwardedPath.startsWith('http')) {
                const u = new URL(forwardedPath);
                pathOnly = u.pathname + (u.search || '');
            }
        } catch (e) {
            // ignore and use forwardedPath as-is
        }

        const resource = `https://${host}${pathOnly}`;

        if (!X402_SERVER_ID || !CDP_PROJECT_ID) {
            console.warn("⚠️ Optional env vars X402_SERVER_ID or CDP_PROJECT_ID not set. Returning 402 without CDP metadata.");
        }

        const body = {
            x402Version: 1,
            error: "Payment Required",
            message: "the hood runs deep in 402. Pay 1 USDC to mint NFT",
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
                // Describe the expected POST input so scanners like x402scan
                // can detect that this resource accepts a POST payment payload.
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
                    name: "Hood NFT",
                    contractAddress: NFT_CONTRACT_ADDRESS,
                    paymentAddress: PAYMENT_RECIPIENT,
                    autoMint: true,
                    category: "nft",
                    poweredBy: "Coinbase CDP"
                }
            }]
        };

        if (X402_SERVER_ID) body.serverId = X402_SERVER_ID;
        if (CDP_PROJECT_ID) body.cdpProjectId = CDP_PROJECT_ID;

        // Log the final descriptor so Netlify logs show exactly what we
        // returned (useful when scanners fetch the URL).
        try {
            console.log('x402 descriptor:', JSON.stringify(body));
        } catch (e) {
            console.log('x402 descriptor (stringify failed)');
        }

        return {
            statusCode: 402,
            headers: {
                ...headers,
                'Cache-Control': 'no-cache',
                'X-402-Version': '1',
                'WWW-Authenticate': 'x402'
            },
            body: JSON.stringify(body)
        };
    }

    // ... (Your POST/try-catch block below does not need to be changed) ...
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

        // Quick provider/RPC health-check: if the JsonRpcProvider cannot
        // detect the network or returns non-JSON responses, bail early with
        // a clear 503 so we don't attempt transfers that will fail.
        try {
            if (!provider) {
                if (!CDP_RPC_URL) throw new Error('CDP_RPC_URL not set');
                provider = new JsonRpcProvider(CDP_RPC_URL);
            }
            // getNetwork will throw if the RPC URL is wrong or node is down
            await provider.getNetwork();
        } catch (provErr) {
            console.error('❌ Provider/RPC unreachable:', provErr.message);
            // Try to report the health failure to CDP but don't block on it
            try {
                await reportToCoinbaseCDP({ type: 'health_check_failure', error: provErr.message, status: 'failed' });
            } catch (e) {
                // swallow reporting errors
            }

            return {
                statusCode: 503,
                headers,
                body: JSON.stringify({ success: false, error: 'Blockchain provider unreachable or RPC URL invalid. Check CDP_RPC_URL.' })
            };
        }

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