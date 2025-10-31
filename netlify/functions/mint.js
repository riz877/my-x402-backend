// === SECTION 1: IMPORTS ===
// Using 'import' (ES Module). Ensure your package.json has "type": "module"
import express from 'express';
import { ethers } from 'ethers';
import { facilitator } from '@coinbase/x402'; // This is the Coinbase Facilitator
import { paymentMiddleware } from 'x402-express'; // This is the Coinbase Middleware

// === SECTION 2: CONFIGURATION & VARIABLES ===

// --- Load Environment Variables ---
// Coinbase API Keys & MINTING Relayer Key
const {
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  RELAYER_PRIVATE_KEY,
  PROVIDER_URL,
} = process.env;

// Check for essential variables
if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.warn(
    'WARNING: CDP API Keys are not set. Coinbase facilitator will not function.'
  );
}
if (!RELAYER_PRIVATE_KEY || !PROVIDER_URL) {
  console.error(
    'FATAL ERROR: RELAYER_PRIVATE_KEY or PROVIDER_URL is not set. Minting will fail.'
  );
}

// --- Constants (from mint.js) ---
const NFT_CONTRACT_ADDRESS = '0xaa1b03eea35b55d8c15187fe8f57255d4c179113';
const PAYMENT_RECIPIENT = '0xD95A8764AA0dD4018971DE4Bc2adC09193b8A3c2';
const MINT_PRICE_USD = '2.00'; // Coinbase middleware requires dollar string format

// === SECTION 3: MINTING LOGIC (from mint.js) ===

// Setup Ethers for the relayer wallet
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const backendWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

// Your NFT Contract ABI
const NFT_ABI = [
  'function mint(address to, uint256 amount) public',
  'function totalSupply() public view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

// 'Transfer' Event Topic for finding Token ID
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * This is your custom mintNFT function.
 * This function is called AFTER Coinbase verifies the payment.
 */
async function mintNFT(recipientAddress) {
  try {
    console.log(`[Mint Logic] Starting NFT mint to: ${recipientAddress}`);

    if (!backendWallet) {
      throw new Error('Backend wallet (Relayer) is not configured');
    }

    const nftContract = new ethers.Contract(
      NFT_CONTRACT_ADDRESS,
      NFT_ABI,
      backendWallet
    );

    // Check relayer gas balance
    const balance = await provider.getBalance(backendWallet.address);
    console.log(
      `[Mint Logic] Relayer wallet balance: ${(
        Number(balance) / 1e18
      ).toFixed(5)} ETH`
    );
    if (balance < BigInt(1e15)) {
      // 0.001 ETH
      throw new Error('Insufficient gas in relayer wallet. Minting aborted.');
    }

    // Calling the mint function on your contract
    console.log('[Mint Logic] Calling contract.mint() function...');
    const tx = await nftContract.mint(recipientAddress, 1, {
      gasLimit: 200000, // Set a reasonable gas limit
    });

    console.log(`[Mint Logic] Mint transaction sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[Mint Logic] Mint confirmed in block: ${receipt.blockNumber}`);

    // Extract Token ID from 'Transfer' event
    let tokenId = 'unknown';
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC
      ) {
        const from = '0x' + log.topics[1].substring(26);
        // Check if 'from' is the ZERO address (new mint)
        if (from === '0x0000000000000000000000000000000000000000') {
          tokenId = BigInt(log.topics[3]).toString();
          break;
        }
      }
    }
    console.log(`[Mint Logic] Obtained Token ID: ${tokenId}`);

    return {
      success: true,
      tokenId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error('[Mint Logic] Error during minting:', error.message);
    throw error; // Let the main handler catch this error
  }
}

// === SECTION 4: EXPRESS SERVER (COMBINING) ===

// Initialize Express server
const app = express();
app.use(express.json());

// --- A. Coinbase Facilitator Middleware ---
// This is your "API Facilitator".
// It will protect the endpoint below and register you with the X402 Bazaar.
app.use(
  paymentMiddleware(
    PAYMENT_RECIPIENT, // Your receiving wallet for USDC payments
    {
      // Define which endpoints are protected and their price
      'POST /api/mint': {
        price: `$${MINT_PRICE_USD}`,
        network: 'base',
        // Metadata for X402 Bazaar (from mint.js)
        config: {
          description: 'the hood runs deep in 402. Pay 2 USDC to mint NFT',
          image:
            'https://raw.githubusercontent.com/riz877/pic/refs/heads/main/hood.png',
        },
      },
      // You can add other endpoints here
      // "GET /api/status": { price: "$0.01", network: "base" }
    },
    facilitator // This is the official Coinbase facilitator
  )
);

// --- B. Your Custom Route Handler (Minting Logic) ---
// This code will ONLY run IF the `paymentMiddleware` above SUCCEEDS
// in verifying the payment.
app.post('/api/mint', async (req, res) => {
  try {
    // The Coinbase middleware automatically provides the payer's address
    const userAddress = req.x402?.from;

    if (!userAddress) {
      console.error(
        '[Route Handler] Payment verified, but `req.x402.from` was not found!'
      );
      return res
        .status(400)
        .json({ error: 'User address not found after payment.' });
    }

    console.log(
      `[Route Handler] Payment via Coinbase verified from: ${userAddress}.`
    );
    console.log('[Route Handler] Starting custom minting process...');

    // Call your custom minting function
    const mintResult = await mintNFT(userAddress);

    console.log(
      `[Route Handler] SUCCESS: Token #${mintResult.tokenId} was minted for ${userAddress}`
    );

    // Send a 200 OK success response
    res.status(200).json({
      success: true,
      message: 'Payment received (via Coinbase) and NFT minted!',
      data: {
        tokenId: mintResult.tokenId,
        nftContract: NFT_CONTRACT_ADDRESS,
        recipient: userAddress,
        mintTx: mintResult.txHash,
        blockNumber: mintResult.blockNumber,
        // (You can add paymentTx if available from req.x402)
      },
    });
  } catch (error) {
    console.error(
      '[Route Handler] Error after payment verification:',
      error.message
    );
    // Send error response to the client
    res.status(500).json({
      success: false,
      error: `Minting failed after payment: ${error.message}`,
    });
  }
});

// === SECTION 5: EXPORT FOR VERCEL ===
// This code will be exported as a serverless function
export default app;