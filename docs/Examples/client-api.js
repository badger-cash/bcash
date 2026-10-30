'use strict';

const bcash = require('../..');
const random = require('bcrypto/lib/random');
const plugin = bcash.wallet.plugin;
const network = bcash.Network.get('regtest');

const node = new bcash.FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true
});

node.use(plugin);

// The node's HTTP API.
const client = new bcash.NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

// The wallet's HTTP API.
const walletClient = new bcash.WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

async function fundWallet(wdb, wallet, addr) {
  // The API gives addresses as strings: read this one as regtest's.
  addr = bcash.Address.fromString(addr, network);

  // A made-up transaction paying the wallet, spending a made-up outpoint.
  // (A coinbase would not be spendable until it matured.)
  const mtx = new bcash.MTX();
  mtx.addOutpoint(new bcash.Outpoint(random.randomBytes(32), 0));
  mtx.addOutput(addr, 50460);
  mtx.addOutput(addr, 50460);
  mtx.addOutput(addr, 50460);
  mtx.addOutput(addr, 50460);

  const tx = mtx.toTX();

  wallet.once('balance', (balance) => {
    console.log('New Balance:');
    console.log(balance);
  });

  wallet.once('address', (receive) => {
    console.log('New Receiving Address:');
    console.log(receive);
  });

  wallet.once('tx', (details) => {
    console.log('New Wallet TX:');
    console.log(details);
  });

  await wdb.addTX(tx);
  await new Promise(r => setTimeout(r, 300));
}

async function sendTX(wallet, addr, value) {
  const options = {
    rate: 1000,
    outputs: [{
      value: value,
      address: addr
    }]
  };

  const tx = await wallet.send(options);

  return tx.hash;
}

async function callNodeApi() {
  const info = await client.getInfo();

  console.log('Server Info:');
  console.log(info);

  const json = await client.execute('getblocktemplate', []);

  console.log('Block Template (RPC):');
  console.log(json);
}

(async () => {
  const wdb = node.require('walletdb').wdb;

  await node.open();
  await walletClient.open();

  const result = await walletClient.createWallet('test');

  console.log('Wallet:');
  console.log(result);

  // Join the wallet's events with its token, as wallet auth requires.
  const wallet = walletClient.wallet('test', result.token);
  await wallet.open();

  // Fund default account.
  const receive = await wallet.createAddress('default');
  await fundWallet(wdb, wallet, receive.address);

  const balance = await wallet.getBalance('default');

  console.log('Balance:');
  console.log(balance);

  const acct = await wallet.createAccount('foo');

  console.log('Account:');
  console.log(acct);

  // Send to our new account.
  const hash = await sendTX(wallet, acct.receiveAddress, 10000);

  console.log('Sent TX:');
  console.log(hash);

  const tx = await wallet.getTX(hash);

  console.log('Sent TX details:');
  console.log(tx);

  await callNodeApi();

  await wallet.close();
  await walletClient.close();
  await node.close();
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
