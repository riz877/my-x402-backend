/*
================================================================================
THIS IS THE COINBASE FACILITATOR (EXPRESS + SERVERLESS)
This code uses Coinbase's `paymentMiddleware` to get listed on x402scan
and also includes your custom `mintNFT` logic.

It is "lazy-loaded" to prevent crashing on the 402 (GET) request.
================================================================================
*/

// === SECTION 1: IMPORTS ===
// Use 'require' (CommonJS) for Netlify Functions
const express = require('express');
const serverless = require('serverless-http'); // Required to run Express on Netlify
const { ethers, Contract, Wallet } = require('ethers');
const { facilitator } = require('@coinbase/x402'); // The official Coinbase Facilitator
const { paymentMiddleware } = require('x402-express'); // The Coinbase Middleware

// === SECTION 2: CONSTANTS (SAFE TO DEFINE GLOBALLY) ===
// NO 'new Wallet()' or 'new Provider()' here! This is critical.
const NFT_CONTRACT_ADDRESS = "0xaa1b03eea35b55d8c15187fe8f57255d4c179113";
const PAYMENT_RECIPIENT = "0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2";
const MINT_PRICE_USD = "2.00"; // Coinbase middleware needs this format

// ABIs
const NFT_ABI = [
    'function mint(address to, uint256 amount) public',
    'function totalSupply() public view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';


// === SECTION 3: MINTING LOGIC (LAZY-LOADED) ===
// This cache variable will store the wallet after the first POST request
let _cachedBackendWallet = null;

/**
 * This function initializes the Provider and Wallet ON-DEMAND.
 * It is ONLY called by the POST handler, never by the GET handler.
 * This prevents the startup crash that causes the "No 402 Response" error.
 */
function getBackendWallet() {
    // 1. If already initialized, return the cached wallet
    if (_cachedBackendWallet) {
        return _cachedBackendWallet;
    }

    // 2. Get the environment variables from Netlify
    const { RELAYER_PRIVATE_KEY, PROVIDER_URL } = process.env;

    // 3. Check if they exist
    if (!RELAYER_PRIVATE_KEY || !PROVIDER_URL) {
        console.error("FATAL: RELAYER_PRIVATE_KEY or PROVIDER_URL is not set in Netlify.");
        throw new Error("Relayer (Minting) configuration is incomplete.");
    }

    // 4. Try to initialize the provider and wallet
    try {
        // Provider is initialized HERE
        const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
        // Wallet is initialized HERE
        _cachedBackendWallet = new Wallet(RELAYER_PRIVATE_KEY, provider);
        
        console.log("Relayer (Minting) Wallet initialized. Address:", _cachedBackendWallet.address);
        return _cachedBackendWallet;
    } catch (e) {
        console.error("Failed to initialize relayer wallet:", e.message);
        throw new Error("RELAYER_PRIVATE_KEY or PROVIDER_URL is invalid.");
    }
}

/**
 * Your custom minting logic. This code is unchanged.
 * It now calls `getBackendWallet()` to safely get the relayer.
 */
async function mintNFT(recipientAddress) {
  try {
    console.log(`[Mint Logic] Starting NFT mint to: ${recipientAddress}`);
    
    // Call the lazy-load function
    const backendWallet = getBackendWallet();
    const nftContract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, backendWallet);

    // Check relayer balance
    const balance = await backendWallet.provider.getBalance(backendWallet.address);
    console.log(`[Mint Logic] Relayer Balance: ${(Number(balance) / 1e18).toFixed(4)} ETH`);
    if (balance < BigInt(1e15)) { // 0.001 ETH
        throw new Error('Insufficient gas in relayer wallet');
    }

    // Call mint
    console.log('[Mint Logic] Calling contract.mint()...');
    const tx = await nftContract.mint(recipientAddress, 1, { gasLimit: 200000 });
    const receipt = await tx.wait();
    console.log(`[Mint Logic] Mint confirmed: ${receipt.hash}`);

    // Find Token ID
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
    console.log(`[Mint Logic] Token ID found: ${tokenId}`);
    return { success: true, tokenId, txHash: receipt.hash };
  } catch (error) {
    console.error('[Mint Logic] Error during minting:', error.message);
    throw error; // Let the main POST handler catch it
  }
}

// === SECTION 4: EXPRESS SERVER SETUP ===

const app = express(); // Initialize Express

// --- A. Coinbase Facilitator Middleware (THE IMPORTANT PART) ---
// This middleware runs FIRST. It handles the GET request for the 402 check.
// It will NOT call `getBackendWallet()`, so it will NOT crash.
// It uses your CDP_API_KEY_ID and CDP_API_KEY_SECRET from env vars.
app.use(
  '/', // Protect the root of this function (e.g., .../functions/mint)
  paymentMiddleware(
    PAYMENT_RECIPIENT, // Where the USDC payment goes
    {
      // Define which route is protected
      // 'POST /' means the POST method to '.../functions/mint'
      'POST /': {
        price: `$${MINT_PRICE_USD}`,
        network: 'base',
        config: {
          description: 'the hood runs deep in 402. Pay 2 USDC to mint NFT',
          image: 'https://raw.githubusercontent.com/riz877/pic/refs/heads/main/hood.png',
        },
      },
    },
    facilitator // Use the official Coinbase facilitator
  )
);

// --- B. Your Custom Mint Handler (The POST Request) ---
// This code ONLY runs AFTER the `paymentMiddleware` has successfully
// verified the payment from the user.
app.post('/', async (req, res) => {
  try {
    // The middleware gives us the payer's address
    const userAddress = req.x402?.from;
    if (!userAddress) {
      console.error('[Route Handler] Payment verified, but `req.x402.from` was not found!');
      return res.status(400).json({ error: 'User address not found after payment.' });
    }

    console.log(`[Route Handler] Payment verified via Coinbase from: ${userAddress}.`);
    
    // THIS is where your relayer wallet is finally loaded
    console.log('[Route Handler] Initiating custom mint process...');
    const mintResult = await mintNFT(userAddress); // Call your mint logic

    console.log(`[Route Handler] SUCCESS: Token #${mintResult.tokenId} minted for ${userAddress}`);
    res.status(200).json({
      success: true,
      message: 'Payment received (via Coinbase) and NFT minted!',
      data: {
        tokenId: mintResult.tokenId,
        mintTx: mintResult.txHash,
      },
    });

  } catch (error) {
    console.error('[Route Handler] Error after payment verification:', error.message);
    // Handle errors from `mintNFT` (like "Insufficient gas")
    let statusCode = error.message.includes('gas') || error.message.includes('config') ? 503 : 500;
    res.status(statusCode).json({ success: false, error: `Minting failed after payment: ${error.message}` });
  }
});

// === SECTION 5: EXPORT HANDLER FOR NETLIFY ===
// Wrap the Express app with `serverless-http`
exports.handler = serverless(app);