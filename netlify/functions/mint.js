// File: netlify/functions/mint.js
const { ethers } = require('ethers');

// --- Konfigurasi Blockchain & Keamanan ---
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const X402_RECIPIENT_ADDRESS = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const BASE_TOKEN_URI = "temp";
// Ganti dengan KUNCI PRIVAT MINTER di Environment Variables Netlify (PENTING!)
const provider = new ethers.JsonRpcProvider(process.env.PROVIDER_URL || "https://mainnet.base.org");
const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

// ABI MINIMAL UNTUK FUNGSI MINT
const NFT_ABI = [{ "inputs": [{ "internalType": "string", "name": "_name", "type": "string" }, { "internalType": "string", "name": "_symbol", "type": "string" }, { "internalType": "string", "name": "_initBaseURI", "type": "string" }, { "internalType": "address", "name": "_usdcTokenAddress", "type": "address" }], "stateMutability": "nonpayable", "type": "constructor" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "address", "name": "owner", "type": "address" }, { "indexed": true, "internalType": "address", "name": "approved", "type": "address" }, { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "Approval", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "address", "name": "owner", "type": "address" }, { "indexed": true, "internalType": "address", "name": "operator", "type": "address" }, { "indexed": false, "internalType": "bool", "name": "approved", "type": "bool" }], "name": "ApprovalForAll", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "address", "name": "previousOwner", "type": "address" }, { "indexed": true, "internalType": "address", "name": "newOwner", "type": "address" }], "name": "OwnershipTransferred", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "address", "name": "from", "type": "address" }, { "indexed": true, "internalType": "address", "name": "to", "type": "address" }, { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "Transfer", "type": "event" }, { "inputs": [{ "internalType": "address[100]", "name": "_users", "type": "address[100]" }], "name": "add100PresaleUsers", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_user", "type": "address" }], "name": "addPresaleUser", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "approve", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "baseExtension", "outputs": [{ "internalType": "string", "name": "", "type": "string" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "baseURI", "outputs": [{ "internalType": "string", "name": "", "type": "string" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "cost", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "getApproved", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "address", "name": "operator", "type": "address" }], "name": "isApprovedForAll", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "maxMintAmount", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "maxSupply", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_to", "type": "address" }, { "internalType": "uint256", "name": "_mintAmount", "type": "uint256" }], "name": "mint", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "name", "outputs": [{ "internalType": "string", "name": "", "type": "string" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "ownerOf", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "bool", "name": "_state", "type": "bool" }], "name": "pause", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "paused", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "presaleCost", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "", "type": "address" }], "name": "presaleWallets", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_user", "type": "address" }], "name": "removePresaleUser", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_user", "type": "address" }], "name": "removeWhitelistUser", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "renounceOwnership", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "safeTransferFrom", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "tokenId", "type": "uint256" }, { "internalType": "bytes", "name": "_data", "type": "bytes" }], "name": "safeTransferFrom", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "operator", "type": "address" }, { "internalType": "bool", "name": "approved", "type": "bool" }], "name": "setApprovalForAll", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "string", "name": "_newBaseExtension", "type": "string" }], "name": "setBaseExtension", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "string", "name": "_newBaseURI", "type": "string" }], "name": "setBaseURI", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "_newCost", "type": "uint256" }], "name": "setCost", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes4", "name": "interfaceId", "type": "bytes4" }], "name": "supportsInterface", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "symbol", "outputs": [{ "internalType": "string", "name": "", "type": "string" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenOfOwnerByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "tokenURI", "outputs": [{ "internalType": "string", "name": "", "type": "string" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "totalSupply", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "from", "type": "address" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "tokenId", "type": "uint256" }], "name": "transferFrom", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "newOwner", "type": "address" }], "name": "transferOwnership", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "usdcToken", "outputs": [{ "internalType": "contract IERC20", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_owner", "type": "address" }], "name": "walletOfOwner", "outputs": [{ "internalType": "uint256[]", "name": "", "type": "uint256[]" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "_user", "type": "address" }], "name": "whitelistUser", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "", "type": "address" }], "name": "whitelisted", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }]

// --- Handler Utama ---
exports.handler = async (event, context) => {
  // Pastikan request method yang diizinkan (x402 scan sering menggunakan GET/OPTIONS/POST)
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

  const xPaymentHeader = event.headers['x-payment'];
  const resourceUrl = `https://${event.headers.host}${event.path}`;

  // ===========================================
  // 1. LOGIKA SUKSES (Ada header X-PAYMENT)
  // ===========================================
  if (xPaymentHeader) {
    console.log("Found X-PAYMENT header. Attempting verification and mint...");

    let recipientAddress;
    let decodedPayload;
    
    // ⚠️ Cobalah membaca body request terlebih dahulu untuk mendapatkan alamat penerima (recipientAddress)
    try {
        const requestBody = JSON.parse(event.body || '{}');
        recipientAddress = requestBody.recipientAddress || requestBody.payerAddress; // Ambil dari body
        if (!recipientAddress) {
            throw new Error("Recipient address not found in request body.");
        }
    } catch (e) {
        console.error("❌ Failed to parse request body:", e.message);
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Invalid request body format or missing recipientAddress." }),
            headers: { 'Content-Type': 'application/json' }
        };
    }

    // ⚠️ Lakukan Verifikasi Payload X-Payment (PENTING: Verifikasi ini masih SIMPLIFIKASI!)
    try {
      const payloadJson = Buffer.from(xPaymentHeader, 'base64').toString('utf8');
      decodedPayload = JSON.parse(payloadJson);
      
      // *** ⚠️ PERINGATAN KRITIS: Di sini Anda harus memverifikasi on-chain bahwa
      //     transaksi 'proof' dalam payload benar-benar sukses dan ke alamat Agent. ***
      
      console.log(`✅ Payment proof accepted for minting to: ${recipientAddress}`);

    } catch (error) {
      console.error("❌ X402 Verification/Payload Failed:", error);
      return {
        // Ganti 403 menjadi 402/403 tergantung kebutuhan, tapi 403 lebih tepat untuk verifikasi gagal
        statusCode: 403, 
        body: JSON.stringify({ error: "Invalid or unverified payment proof." }),
        headers: { 'Content-Type': 'application/json' }
      };
    }

    // PICU MINT NFT
    try {
      const nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, wallet);

      // Gunakan recipientAddress dari body
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
  // ===========================================
  else {
    console.log(`🚀 No X-PAYMENT header found → returning 402 Payment Required for ${resourceUrl}`);

    // Informasi pembayaran (diambil dari config Anda)
    const paymentMethod = {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "2000000", // 2.0 USDC (Asumsi 6 desimal)
      resource: resourceUrl,
      description: "the hood runs deep in 402. every face got a story. by https://x.com/sanukek https://x402hood.xyz",
      mimeType: "application/json",
      image: "https://raw.githubusercontent.com/riz877/pic/refs/heads/main/G4SIxPcXEAAuo7O.jpg",
      payTo: X402_RECIPIENT_ADDRESS,
      maxTimeoutSeconds: 600,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Base)
      outputSchema: {
        // Klien harus mengirimkan alamat yang akan di-mint di body saat POST
        input: { 
            type: "http", 
            method: "POST",
            body: { recipientAddress: "string" } // Indikasi bahwa body perlu alamat
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
      statusCode: 402, // <-- Kunci Utama
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