// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract, isAddress } = require('ethers');

// --- 1. KONFIGURASI DAN SETUP ---
// Konstanta Kritis (Ganti dengan Nilai Sebenarnya jika berbeda)
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const X402_RECIPIENT_ADDRESS = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const USDC_ASSET_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (Base)
const MINT_COST_USDC = BigInt(2000000); // 2.0 USDC (Asumsi 6 desimal)

// Setup Ethers (Pastikan Environment Variables di-set di Netlify)
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
} = process.env;

// Inisialisasi Provider dan Wallet
const provider = new JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABI MINIMAL
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address owner) view returns (uint256)"];
const NFT_ABI = [
  "function mint(address _to, uint256 _mintAmount)",
  // ... Tambahkan ABI yang diperlukan lainnya
];


// --- 2. HANDLER UTAMA ---
exports.handler = async (event, context) => {
  const xPaymentHeader = event.headers['x-payment'];
  const resourceUrl = `https://${event.headers.host}${event.path}`; 

  // LOGIKA CORS/OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT',
        'Access-Control-Allow-Methods': 'GET, OPTIONS, POST'
      }
    };
  }

  // =======================================================
  // 1. LOGIKA SUKSES: Memproses Pembayaran dan Minting (POST)
  // =======================================================
  if (xPaymentHeader) {
    console.log("Found X-PAYMENT header. Attempting verification and mint...");

    let recipientAddress;
    let txHash;
    let decodedPayload;

    // 1.1 Verifikasi Payload X-Payment dan On-Chain
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        decodedPayload = JSON.parse(payloadJson);
        
        // --- 💡 PERBAIKAN: PENCARIAN TXHASH LEBIH AGRESIF ---
        const proof = decodedPayload.proof || decodedPayload; 
        txHash = proof.txHash || proof.transactionHash || decodedPayload.hash || decodedPayload.transactionId;
        // ----------------------------------------------------

        // --- 💡 PERBAIKAN: MENGGUNAKAN ALAMAT PEMBAYAR SEBAGAI PENERIMA MINT ---
        // Jika klien tidak mengirim recipientAddress, kita gunakan alamat dari payload x-payment.
        // Alamat Payer di payload standar x402 adalah decodedPayload.payerAddress
        const payerAddress = decodedPayload.payerAddress || decodedPayload.senderAddress; 
        
        // Coba ambil recipientAddress dari body jika ada, jika tidak, gunakan payerAddress
        try {
             let bodyContent = event.body || '{}';
             if (event.isBase64Encoded) {
                 bodyContent = Buffer.from(bodyContent, 'base64').toString('utf8');
             }
             const requestBody = JSON.parse(bodyContent);
             // Jika body request kosong, ini akan menggunakan payerAddress
             recipientAddress = requestBody.recipientAddress || requestBody.payerAddress || payerAddress;
        } catch (e) {
             // Jika gagal parse body (termasuk body kosong), gunakan payerAddress dari payload
             recipientAddress = payerAddress;
        }

        // Final Check: Harus memiliki alamat penerima yang valid
        if (!recipientAddress || !isAddress(recipientAddress)) {
             throw new Error("Cannot determine a valid recipient address for minting.");
        }
        
        // Periksa apakah txHash ditemukan
        if (!txHash) {
            console.error("Payload received (no txHash):", decodedPayload); 
            throw new Error("Missing transaction hash in payment proof.");
        }

        // Verifikasi On-Chain
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt || receipt.status !== 1) {
            throw new Error(`Transaction ${txHash} not confirmed or failed.`);
        }

        // Pengecekan Log Transfer USDC (Verifikasi yang lebih aman)
        let paymentVerified = false;
        const usdcTransferTopic = '0xddf252ad1be2c89b69c2b068fc378aa1f802820d2e85a14fc3dd2a6797bce35b'; 
        
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDC_ASSET_ADDRESS.toLowerCase() && log.topics[0] === usdcTransferTopic) {
                // Sederhana: Cek apakah ada log transfer USDC dari tx ini
                paymentVerified = true; 
                break;
            }
        }
        
        if (!paymentVerified) {
             throw new Error("Could not find a valid USDC transfer log in the provided transaction proof.");
        }

        console.log(`✅ Payment proof (Tx Hash: ${txHash}) accepted. Minting to: ${recipientAddress}`);

    } catch (error) {
        console.error("❌ X402 Verification/Payload Failed:", error);
        return {
            statusCode: 403,
            body: JSON.stringify({ error: `Invalid or unverified payment proof: ${error.message}` }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    // 1.2 PICU MINT NFT
    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
        
        // Mint ke recipientAddress yang telah diverifikasi
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

  // =======================================================
  // 2. LOGIKA CHALLENGE: Mengembalikan 402 Payment Required (GET/Default)
  // =======================================================
  else {
    console.log(`🚀 No X-PAYMENT header found → returning 402 Payment Required for ${resourceUrl}`);

    const paymentMethod = {
        scheme: "exact",
        network: "base",
        maxAmountRequired: MINT_COST_USDC.toString(), 
        resource: resourceUrl,
        description: "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
        mimeType: "application/json",
        image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
        payTo: X402_RECIPIENT_ADDRESS,
        maxTimeoutSeconds: 600,
        asset: USDC_ASSET_ADDRESS,
        outputSchema: {
            input: { 
                type: "http", 
                method: "POST",
                // HAPUS KEWAJIBAN RECIPIENTADDRESS DI BODY (karena kita akan ambil dari Payer)
                // Jika Agent AI ingin menentukan alamat lain, ia masih bisa mengirimkannya.
                body: { } 
            }, 
            output: { message: "string", data: "object" }
        }
    };

    const x402Response = {
        x402Version: 1,
        error: "Payment Required",
        accepts: [paymentMethod]
    };

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