// Menggunakan 'require' (CommonJS) karena ini di Netlify Functions
const express = require('express');
const serverless = require('serverless-http'); // <-- PENTING
const { ethers, Contract, Wallet, Signature } = require('ethers');
const { facilitator } = require('@coinbase/x402'); // <-- Facilitator Coinbase
const { paymentMiddleware } = require('x402-express'); // <-- Middleware Coinbase

// === BAGIAN 1: KONFIGURASI & SEMUA 4 KUNCI ===

// Ambil SEMUA 4 KUNCI dari Environment Variables Netlify
const {
  // Kunci API Coinbase (dari file cdp_api_key.json)
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  
  // Kunci Relayer Anda (dari setup mint.js lama)
  RELAYER_PRIVATE_KEY,
  PROVIDER_URL
} = process.env;

// Cek Kunci Coinbase
if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.warn('PERINGATAN: Kunci API CDP Coinbase tidak diatur. Fasilitator tidak akan terdaftar di Bazaar.');
  // (Anda bisa mengatur ini di Environment Variables Netlify)
}

// Cek Kunci Relayer
if (!RELAYER_PRIVATE_KEY || !PROVIDER_URL) {
    console.error('ERROR FATAL: RELAYER_PRIVATE_KEY atau PROVIDER_URL tidak diatur. Minting akan gagal.');
    // (Ini juga harus diatur di Netlify)
}

// Konstanta
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const MINT_PRICE_USD = "2.00"; // Coinbase perlu format string dolar

const provider = new ethers.JsonRpcProvider(PROVIDER_URL || "https://mainnet.base.org");

// ABIs
const NFT_ABI = [
    'function mint(address to, uint256 amount) public',
    'function totalSupply() public view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// === BAGIAN 2: LOGIKA MINTING (Lazy-loaded) ===

let _cachedBackendWallet = null;

function getBackendWallet() {
    if (_cachedBackendWallet) return _cachedBackendWallet;
    if (!RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY tidak diatur");
    try {
        _cachedBackendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
        console.log("Dompet Relayer (Minting) diinisialisasi, alamat:", _cachedBackendWallet.address);
        return _cachedBackendWallet;
    } catch (e) {
        console.error("Gagal inisialisasi dompet relayer:", e.message);
        throw new Error("RELAYER_PRIVATE_KEY tidak valid");
    }
}

async function mintNFT(recipientAddress) {
  try {
    console.log(`[Mint Logic] Memulai minting NFT ke: ${recipientAddress}`);
    const backendWallet = getBackendWallet();
    const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);

    const balance = await provider.getBalance(backendWallet.address);
    console.log(`[Mint Logic] Saldo Relayer: ${(Number(balance) / 1e18).toFixed(4)} ETH`);
    if (balance < BigInt(1e15)) { // 0.001 ETH
        throw new Error('Gas di dompet relayer tidak mencukupi');
    }

    console.log('[Mint Logic] Memanggil contract.mint()...');
    const tx = await nftContract.mint(recipientAddress, 1, { gasLimit: 200000 });
    const receipt = await tx.wait();
    console.log(`[Mint Logic] Minting dikonfirmasi: ${receipt.hash}`);

    let tokenId = 'unknown';
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() && log.topics[0] === TRANSFER_TOPIC) {
            const from = '0x' + log.topics[1].substring(26);
            if (from === '0x0000000000000000000000000000000000000000') {
                tokenId = BigInt(log.topics[3]).toString();
                break;
            }
        }
    }
    console.log(`[Mint Logic] Token ID didapat: ${tokenId}`);
    return { success: true, tokenId, txHash: receipt.hash };
  } catch (error) {
    console.error('[Mint Logic] Error saat minting:', error.message);
    throw error;
  }
}

// === BAGIAN 3: SERVER EXPRESS ===

const app = express();
app.use(express.json());

// --- A. Middleware Facilitator Coinbase ---
// Ini adalah "API Facilitator" Anda.
// Ini akan melindungi endpoint di bawahnya dan mendaftarkan Anda ke X402 Bazaar.
// Middleware ini akan menangani GET (mengirim 402) dan POST (memverifikasi X-Payment).
//
// CATATAN: URL path ('/') relatif terhadap URL fungsi,
// jadi ini akan melindungi '.../functions/mint'
app.use(
  '/', // Melindungi root dari fungsi ini
  paymentMiddleware(
    PAYMENT_RECIPIENT,
    {
      // Tentukan endpoint mana yang dilindungi
      // 'POST /' berarti metode POST ke '.../functions/mint'
      'POST /': {
        price: `$${MINT_PRICE_USD}`,
        network: 'base',
        config: {
          description: 'the hood runs deep in 402. Pay 2 USDC to mint NFT',
          image: 'https://raw.githubusercontent.com/riz877/pic/refs/heads/main/hood.png',
        },
      },
    },
    facilitator // Menggunakan fasilitator resmi Coinbase
  )
);

// --- B. Route Handler Kustom Anda (Logika Minting) ---
// Kode ini HANYA akan berjalan JIKA `paymentMiddleware` di atas SUKSES
// memverifikasi pembayaran.
app.post('/', async (req, res) => {
  try {
    const userAddress = req.x402?.from; // Alamat pembayar dari middleware
    if (!userAddress) {
      console.error('[Route Handler] Pembayaran terverifikasi, tetapi `req.x402.from` tidak ditemukan!');
      return res.status(400).json({ error: 'Alamat pengguna tidak ditemukan setelah pembayaran.' });
    }

    console.log(`[Route Handler] Pembayaran via Coinbase terverifikasi dari: ${userAddress}.`);
    console.log('[Route Handler] Memulai proses minting kustom...');

    const mintResult = await mintNFT(userAddress);

    console.log(`[Route Handler] SUKSES: Token #${mintResult.tokenId} dicetak untuk ${userAddress}`);
    res.status(200).json({
      success: true,
      message: 'Payment received (via Coinbase) and NFT minted!',
      data: {
        tokenId: mintResult.tokenId,
        mintTx: mintResult.txHash,
      },
    });

  } catch (error) {
    console.error('[Route Handler] Error setelah pembayaran diverifikasi:', error.message);
    res.status(5.03).json({ success: false, error: `Minting failed after payment: ${error.message}` });
  }
});

// === BAGIAN 4: EXPORT HANDLER UNTUK NETLIFY ===
// Bungkus aplikasi Express agar bisa dijalankan oleh Netlify
exports.handler = serverless(app);