'use strict';

const fs = require('fs');
const path = require('path');

const config = {
  SOLARA_API_BASE_URL: process.env.API_BASE_URL || '',
  SOLARA_CONFIG: {
    mode: 'ledger-payout',
    solana: {
      cluster: process.env.SOLANA_CLUSTER || 'mainnet-beta',
      rpcUrl: process.env.SOLANA_RPC_URL || '',
      tokenMint: process.env.SOLR_MINT || '',
      tokenDecimals: Number(process.env.SOLR_DECIMALS || 9),
      adminWalletPublicKey: process.env.ADMIN_WALLET_PUBLIC_KEY || '',
    },
    apiBaseUrl: process.env.API_BASE_URL || '',
  },
};

const out = [
  `window.SOLARA_API_BASE_URL=${JSON.stringify(config.SOLARA_API_BASE_URL)};`,
  `window.SOLARA_CONFIG=${JSON.stringify(config.SOLARA_CONFIG)};`,
  '',
].join('\n');

fs.writeFileSync(path.join(__dirname, '..', 'public', 'runtime-config.js'), out);
console.log('Wrote public/runtime-config.js');
