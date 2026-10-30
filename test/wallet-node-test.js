/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A wallet in a process of its own (bwallet): a WalletNode reaching a full
 * node over HTTP through its WalletClient, syncing blocks and seeing its
 * payments.
 */

const assert = require('bsert');
const crypto = require('crypto');
const FullNode = require('../lib/node/fullnode');
const WalletNode = require('../lib/wallet/node');
const WalletClient = require('../lib/wallet/client');
const NodeClient = require('../lib/client/node');

if (process.browser)
  return;

async function waitFor(check, timeout = 10000) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout)
      throw new Error('Timed out.');
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('Wallet node', function() {
  this.timeout(30000);

  const port = 20000 + crypto.randomInt(0, 5000) * 2;

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    apiKey: 'foo',
    httpPort: port
  });

  const wnode = new WalletNode({
    network: 'regtest',
    memory: true,
    workers: false,
    nodePort: port,
    nodeApiKey: 'foo',
    apiKey: 'bar',
    httpPort: port + 1
  });

  before(async () => {
    await node.open();
    await wnode.open();
  });

  after(async () => {
    await wnode.close();
    await node.close();
  });

  it('should reach the node with a WalletClient', () => {
    assert(wnode.client instanceof WalletClient);
    assert(wnode.client instanceof NodeClient);
  });

  it('should sync blocks and see its payments', async () => {
    const wallet = await wnode.wdb.primary;
    const address = await wallet.receiveAddress();

    for (let i = 0; i < 2; i++) {
      const block = await node.miner.mineBlock(node.chain.tip, address);
      await node.chain.add(block);
    }

    await waitFor(() => wnode.wdb.state.height === node.chain.height);

    const balance = await wallet.getBalance();
    assert.strictEqual(balance.coin, 2);
    assert(balance.confirmed > 0);
  });
});
