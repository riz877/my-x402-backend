const { ethers } = require('ethers');

const {
  PROVIDER_URL,
  RELAYER_PRIVATE_KEY,
  NFT_CONTRACT_ADDRESS
} = process.env;

const usdcAbi = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
];
const nftAbi = [
  "function mint(address _to, uint256 _mintAmount)"
];

const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

module.exports = {
  handler: async (event) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: 'Invalid JSON body' };
    }

    try {
      const auth = body.authorization;
      const resource = body.resource;

      const usdcContract = new ethers.Contract(resource.asset, usdcAbi, relayerWallet);
      const usdcTx = await usdcContract.transferWithAuthorization(
        auth.from, auth.to, auth.value,
        auth.validAfter, auth.validBefore, auth.nonce,
        auth.v, auth.r, auth.s
      );
      await usdcTx.wait();

      const nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, nftAbi, relayerWallet);
      const mintTx = await nftContract.mint(auth.from, 1);
      await mintTx.wait();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Claim successful!',
          usdcTransactionHash: usdcTx.hash,
          mintTransactionHash: mintTx.hash,
        }),
      };
    } catch (err) {
      console.error('Agent failed:', err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message || 'Internal server error.' }),
      };
    }
  },
};
