/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An SPV node asks its peers for what already waits in their mempools for
 * its filter: once synced, and again on each connection. A full node
 * answers with what matches the filter only (BIP 37).
 */

const assert = require('bsert');
const crypto = require('crypto');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');
const Network = require('../lib/protocol/network');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');

const regtest = Network.get('regtest');

describe('Pool mempool request', function() {
  this.timeout(60000);

  // Regtest asks by default; mainnet and testnet do not. As they do.
  let saved;
  before(() => {
    saved = regtest.requestMempool;
    regtest.requestMempool = false;
  });

  after(() => {
    regtest.requestMempool = saved;
  });

  it('should get what waits for its filter, on each connect', async () => {
    const port = 10000 + crypto.randomInt(0, 9000);
    const full = new FullNode({
      network: 'regtest',
      memory: true,
      workers: false,
      bip37: true,
      listen: true,
      host: '127.0.0.1',
      port,
      httpPort: port + 1
    });

    const miner = KeyRing.generate();
    const watched = KeyRing.generate();
    const other = KeyRing.generate();
    let spv = null;

    const until = async (check, what) => {
      for (let i = 0; i < 200 && !check(); i++)
        await new Promise(r => setTimeout(r, 100));
      assert(check(), `Timed out: ${what}`);
    };

    try {
      await full.open();
      await full.connect();

      await full.rpc.call({method: 'generatetoaddress',
        params: [102, miner.getAddress().toString('regtest')]}, {});

      // Pay `to` from a coinbase, into the full node's mempool only.
      const pay = async (height, to) => {
        const block = await full.chain.getBlock(
          await full.chain.getHash(height));
        const mtx = new MTX();
        mtx.addCoin(Coin.fromTX(block.txs[0], 0, height));
        mtx.addOutput(to.getAddress(), 1e8);
        mtx.addOutput(miner.getAddress(),
          block.txs[0].outputs[0].value - 1e8 - 1000);
        mtx.sign(miner);
        const tx = mtx.toTX();
        await full.sendTX(tx);
        assert(full.mempool.has(tx.hash()));
        return tx;
      };

      // Waiting before the SPV node starts: one for it, one not.
      const forUs = await pay(1, watched);
      const notForUs = await pay(2, other);

      spv = new SPVNode({
        network: 'regtest',
        memory: true,
        workers: false,
        only: [`127.0.0.1:${port}`],
        httpPort: port + 2
      });

      const seen = new Set();
      spv.on('tx', tx => seen.add(tx.txid()));

      await spv.open();
      spv.pool.watchAddress(watched.getAddress());
      await spv.connect();
      spv.startSync();

      await until(() => seen.has(forUs.txid()), 'waiting payment');
      await new Promise(r => setTimeout(r, 1000));
      assert(!seen.has(notForUs.txid()),
        'the node sent a transaction the filter does not match');

      // The connection drops; paid before the pool dials again (3 s on):
      // found when it reconnects.
      const first = spv.pool.peers.head();
      first.destroy();
      const whileAway = await pay(3, watched);
      assert(!seen.has(whileAway.txid()));

      await until(() => {
        const peer = spv.pool.peers.head();
        return peer && peer !== first && peer.handshake;
      }, 'reconnect');
      await until(() => seen.has(whileAway.txid()), 'payment while away');
      assert(!seen.has(notForUs.txid()));
    } finally {
      if (spv)
        await spv.close();
      await full.close();
    }
  });
});
