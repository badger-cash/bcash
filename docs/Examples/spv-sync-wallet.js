'use strict';

const bcash = require('../..');

bcash.set('testnet');

// SPV chains only store the chain headers.
const chain = new bcash.Chain({
  memory: true,
  spv: true
});

const pool = new bcash.Pool({
  chain: chain,
  spv: true,
  maxOutbound: 8
});

const walletdb = new bcash.wallet.WalletDB({ memory: true });

(async () => {
  await chain.open();
  await pool.open();
  await walletdb.open();

  const wallet = await walletdb.create();

  console.log('Created wallet with address %s', await wallet.receiveAddress());

  // Add our address to the spv filter.
  pool.watchAddress(await wallet.receiveAddress());

  // Connect, start retrieving and relaying txs
  await pool.connect();

  // Start the blockchain sync.
  pool.startSync();

  pool.on('tx', async (tx) => {
    console.log('received TX');

    await walletdb.addTX(tx);
    console.log('Transaction added to walletDB');
  });

  wallet.on('balance', (balance) => {
    console.log('Balance updated.');
    // In XEC, which has 2 decimal places.
    console.log(bcash.Amount.encode(balance.unconfirmed, 2));
  });
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
