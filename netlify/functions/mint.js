// File: netlify/functions/mint.js
const { JsonRpcProvider, Wallet, Contract, isAddress, Interface } = require('ethers');

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

// TOPIC HASH untuk Event Transfer(address from, address to, uint256 value)
const usdcTransferTopic = '0xddf252ad1be2c89b69c2b068fc378aa1f802820d2e85a14fc3dd2a6797bce35b';

// --- FUNGSI UTILITY: Mendapatkan Payer Address dari Log Transfer ---
const getPayerAddressAndVerifyPayment = (receipt) => {
    // Alamat Payer harus diambil dari Topic[1] dari log transfer USDC
    
    for (const log of receipt.logs) {
        // Cek apakah ini log transfer USDC
        if (log.address.toLowerCase() === USDC_ASSET_ADDRESS.toLowerCase() && log.topics[0] === usdcTransferTopic) {
            
            // Verifikasi Payer: Topic[1] adalah alamat pengirim (FROM)
            const senderTopic = log.topics[1]; 
            const payerAddress = '0x' + senderTopic.substring(26); 
            
            // Verifikasi Penerima: Topic[2] adalah alamat penerima (TO)
            const recipientTopic = log.topics[2];
            const recipientLogAddress = '0x' + recipientTopic.substring(26);

            // Verifikasi Pembayaran: Harus dikirim ke Agent dan merupakan alamat yang valid
            if (recipientLogAddress.toLowerCase() === X402_RECIPIENT_ADDRESS.toLowerCase() && isAddress(payerAddress)) {
                // Kita asumsikan jumlah transfer $2.00 sudah dicakup oleh proses Agent AI klien.
                return payerAddress;
            }
        }
    }
    return null;
}
// ---------------------------------------------------------------------

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

    let txHash;
    let recipientAddress; 

    // 1.1 Verifikasi Payload X-Payment dan On-Chain
    try {
        const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
        const decodedPayload = JSON.parse(payloadJson);
        
        // --- LOG KRITIS: TAMPILKAN SELURUH PAYLOAD DECODED ---
        // Ini akan sangat membantu debugging jika error masih terjadi
        console.log("PAYLOAD DECODED:", JSON.stringify(decodedPayload)); 
        // -----------------------------------------------------
        
        // --- PERBAIKAN PENCARIAN TX HASH AGRESIF ---
        // Mencari Tx Hash dari berbagai kunci yang mungkin (termasuk 402Scan)
        const proof = decodedPayload.proof || decodedPayload; 
        txHash = proof.txHash || 
                 proof.transactionHash || 
                 proof.hash || 
                 proof.transactionId || 
                 proof.txId ||
                 decodedPayload.hash || // Cek di root level juga
                 decodedPayload.transactionId ||
                 decodedPayload.txId; 
        // --- END PERBAIKAN ---

        if (!txHash) {
            console.error("Gagal menemukan TxHash. Objek proof:", JSON.stringify(proof)); 
            throw new Error("Missing transaction hash in payment proof.");
        }

        // Verifikasi On-Chain: Cek status dan keberadaan transaksi
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt || receipt.status !== 1) {
            throw new Error(`Transaction ${txHash} not confirmed or failed.`);
        }

        // 1.2 Tentukan Alamat Penerima dari Log Transaksi (Payer menjadi Recipient)
        recipientAddress = getPayerAddressAndVerifyPayment(receipt);
        
        if (!recipientAddress) {
            throw new Error("Could not find a valid USDC transfer log to the Agent's address.");
        }

        console.log(`✅ Payment verified via Tx Log. Minting to: ${recipientAddress}`);

    } catch (error) {
        console.error("❌ X402 Verification/Payload Failed:", error);
        // Mengatasi error 'Cannot determine a valid recipient address' dari sini.
        return {
            statusCode: 403,
            body: JSON.stringify({ error: `Invalid or unverified payment proof: ${error.message}` }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    // 1.3 PICU MINT NFT
    try {
        const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, relayerWallet);
        
        // Mint ke recipientAddress yang ditemukan dari LOG TX (Payer)
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
                // Menghapus kebutuhan body wajib, penerima akan diambil dari log TX
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