// File: netlify/functions/mint.js

const { JsonRpcProvider, Wallet, Contract } = require('ethers');

// --- Konfigurasi Lingkungan ---
const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

// URL Block Explorer untuk jaringan Base
const BASE_EXPLORER_URL = 'https://basescan.org/tx/';

// Setup provider dan relayer wallet (pembayar gas)
const provider = new JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);

// ABI kontrak yang dibutuhkan
// ✅ PERBAIKAN: Menggunakan fungsi tunggal dengan tipe yang benar (diasumsikan)
// Fungsi ini menerima *signature* yang sudah terstruktur.
const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
]; 

const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

// **************************** HANDLER FUNCTION ****************************

module.exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers };


  // --- Logika GET: Respon 402 (Permintaan Harga) ---
  if (event.httpMethod === 'GET') {
    console.log("🚀 Function 'mint' triggered (GET) → returning 402 Payment Required...");

    const resourceUrl = `https://${event.headers.host}${event.path}`;

    const paymentMethod = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "2000000", // $2.00
      resource: resourceUrl,
      // Deskripsi dikembalikan
      description: "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
      mimeType: "application/json",
      image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
      payTo: "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2", // Relayer/Penerima Pembayaran
      maxTimeoutSeconds: 600,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
      outputSchema: {
        input: { type: "http", method: "POST" },
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
      headers,
    };
  }


  // --- Logika POST: Pemrosesan Pembayaran & Minting ---
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: 'Invalid JSON body' };
    }

    // Input validation
    if (!body.authorization || !body.resource || !body.resource.asset) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields (authorization/resource.asset)",
          received: body,
        }),
      };
    }

    try {
      const auth = body.authorization;
      const resource = body.resource;

      // 1. Transfer USDC dengan tanda tangan user
      const usdcContract = new Contract(resource.asset, usdcAbi, relayerWallet);
      
      // ✅ PERBAIKAN KRITIS: Memastikan parameter dipanggil sesuai urutan di ABI
      // Tidak perlu perubahan pada urutan pemanggilan karena sudah sesuai dengan ABI string
      // yang Anda definisikan dan kompatibel dengan USDC EIP-3009.
      const usdcTx = await usdcContract.transferWithAuthorization(
        auth.from, 
        auth.to, 
        auth.value,
        auth.validAfter, 
        auth.validBefore, 
        auth.nonce,
        auth.v, 
        auth.r, 
        auth.s // <-- Perintah pemanggilan ini SUDAH BENAR 
      );
      
      console.log("💸 USDC TX sent:", usdcTx.hash);
      await usdcTx.wait();
      console.log("✅ USDC TX confirmed");

      // 2. Mint NFT setelah transfer berhasil
      const nftContract = new Contract(NFT_CONTRACT_ADDRESS, nftAbi, relayerWallet);
      const mintTx = await nftContract.mint(auth.from, 1);
      console.log("🎨 Mint TX sent:", mintTx.hash);
      await mintTx.wait();
      console.log("✅ Mint TX confirmed");
      
      // Generate transaction links
      const usdcTransactionLink = `${BASE_EXPLORER_URL}${usdcTx.hash}`;
      const mintTransactionLink = `${BASE_EXPLORER_URL}${mintTx.hash}`;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Claim successful!',
          usdcTransactionHash: usdcTx.hash,
          mintTransactionHash: mintTx.hash,
          usdcTransactionLink: usdcTransactionLink,
          mintTransactionLink: mintTransactionLink,
        }),
      };
    } catch (err) {
      console.error('❌ Minting failed:', err);
      
      // Menggunakan fallback yang lebih baik untuk pesan error
      let errorMessage = 'Internal server error.';
      if (err.reason) {
          errorMessage = err.reason;
      } else if (err.message && err.message.includes('revert')) {
          // Kasus revert tanpa 'reason' yang jelas
          errorMessage = 'Transaction reverted. Check nonce, validity period, or signature.';
      } else if (err.message) {
          errorMessage = err.message;
      }

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: errorMessage,
        }),
      };
    }
  }

  // Fallback
  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};