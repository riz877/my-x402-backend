// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract } = require('ethers');

// Setup Ethers (diambil dari agent.js)
// Pastikan Environment Variables ini di-set di Netlify
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

const provider = new JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABI (diambil dari agent.js)
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint26 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
];
const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

// Handler utama
exports.handler = async (event, context) => {
    // ... (Logika CORS/OPTIONS dan variabel di atas tidak berubah) ...

    const xPaymentHeader = event.headers['x-payment'];
    const resourceUrl = `https://${event.headers.host}${event.path}`;

    // ===========================================
    // 1. LOGIKA SUKSES (Ada header X-PAYMENT)
    // ===========================================
    if (xPaymentHeader) {
        console.log("Found X-PAYMENT header. Attempting verification and mint...");

        let recipientAddress;
        let decodedPayload;

        // 1.1 Ambil Alamat Penerima (dari Body) - LOGIKA PERBAIKAN DI SINI
        try {
            let bodyContent = event.body || '{}';
            
            // 💡 PERBAIKAN: Cek jika body di-encode Base64, lalu decode
            if (event.isBase64Encoded) {
                bodyContent = Buffer.from(bodyContent, 'base64').toString('utf8');
            }

            const requestBody = JSON.parse(bodyContent);
            recipientAddress = requestBody.recipientAddress || requestBody.payerAddress;

            if (!recipientAddress || !ethers.isAddress(recipientAddress)) {
                throw new Error("Invalid or missing recipientAddress in request body.");
            }
        } catch (e) {
            console.error("❌ Failed to parse request body:", e.message);
            // KEMBALIKAN ERROR YANG LEBIH AKURAT
            return {
                statusCode: 400,
                body: JSON.stringify({ error: `Invalid JSON body: ${e.message}` }),
                headers: { 'Content-Type': 'application/json' }
            };
        }

        // 1.2 Verifikasi Payload X-Payment (Payload ini membawa bukti transaksi)
        try {
            // ... (Logika verifikasi X-Payment/Tx Hash tidak diubah, karena masalah saat ini adalah BODY) ...
            const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
            decodedPayload = JSON.parse(payloadJson);
            
            const txHash = decodedPayload.proof?.txHash || decodedPayload.txHash || decodedPayload.hash;

            if (!txHash) {
                console.error("Payload received:", decodedPayload); 
                throw new Error("Missing transaction hash in payment proof. Cannot verify payment.");
            }
            
            // ... (Lanjutan Verifikasi On-Chain) ...
            const receipt = await provider.getTransactionReceipt(txHash);
            // ... (Logika pengecekan receipt dan log transfer USDC) ...
            
            let paymentVerified = false;
            // Cek log USDC di sini
            // ... (Logika pengecekan log transfer USDC) ...
            
            if (!paymentVerified) {
                throw new Error("Could not find USDC payment log in the provided transaction proof.");
            }

            console.log(`✅ Payment proof (Tx Hash: ${txHash}) accepted for minting to: ${recipientAddress}`);

        } catch (error) {
            console.error("❌ X402 Verification/Payload Failed:", error);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: `Invalid or unverified payment proof: ${error.message}` }),
                headers: { 'Content-Type': 'application/json' }
            };
        }

        // ... (Logika PICU MINT NFT) ...
        try {
            const nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet);
            const tx = await nftContract.mint(recipientAddress, 1); 
            await tx.wait(); 

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "NFT Minted Successfully!",
                    data: { recipient: recipientAddress, transactionHash: tx.hash }
                }),
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            };
        } catch (error) {
            console.error("❌ Minting Transaction Failed:", error);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: "Failed to execute NFT minting transaction." }),
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }

    // ===========================================
    // 2. LOGIKA CHALLENGE (Tidak ada header X-PAYMENT)
    // ... (Logika 402 Challenge tidak berubah) ...
    else {
        // ... (Kode 402 Challenge) ...
        // ...
        return {
            statusCode: 402, 
            body: JSON.stringify(x402Response),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT',
                'Access-Control-Allow-Methods': 'GET, OPTIONS, POST'
            }
        };
    }
};