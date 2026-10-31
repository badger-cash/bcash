'use strict';
const bcash = require('../..').set('main');
const walletPlugin = bcash.wallet.plugin;

const node = new bcash.FullNode({
  checkpoints: true,
  logLevel: 'info'
});

node.use(walletPlugin);

// We get a lot of errors sometimes,
// usually from peers hanging up on us.
// Just ignore them for now.
node.on('error', (err) => {
  ;
});

// New address we'll be sending to: put an ecash: address here.
const newReceiving = 'ecash:...';

// Start the node
(async () => {
  await node.open();

  const options = {
    id: 'mywallet',
    passphrase: 'foo',
    type: 'pubkeyhash'
  };

  const walletdb = node.require('walletdb').wdb;

  const wallet = await walletdb.create(options);

  console.log('Created wallet with address: %s',
    await wallet.receiveAddress());

  await node.connect();

  // Start syncing the blockchain
  node.startSync();

  // Wait for balance and send it to a new address.
  wallet.once('balance', async (balance) => {
    // Create a transaction, fill
    // it with coins, and sign it.
    const options = {
      subtractFee: true,
      outputs: [{
        address: newReceiving,
        value: balance.unconfirmed
      }]
    };

    const tx = await wallet.createTX(options);
    const stx = await wallet.sign(tx, 'foo');

    console.log('sending tx:');
    console.log(stx);

    await node.sendTX(stx);
    console.log('tx sent!');
  });

  node.chain.on('block', (block) => {
    ;
  });

  node.mempool.on('tx', (tx) => {
    ;
  });

  node.chain.on('full', () => {
    node.mempool.getHistory().then(console.log);
  });
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
