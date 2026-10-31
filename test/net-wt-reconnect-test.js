/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A page whose only WebTransport node drops it, and refuses it for a while
 * (full, or restarting), connects again on its own once the node takes it
 * back: it does not wait for a reload. Needs the optional
 * @fails-components/webtransport.
 */

const assert = require('bsert');
const crypto = require('crypto');

describe('WebTransport reconnect', function() {
  this.timeout(90000);

  let addon = null;
  before(async function() {
    try {
      addon = await import('@fails-components/webtransport');
    } catch (e) {
      this.skip();
    }
  });

  it('should reconnect after its node refused it', async () => {
    const FullNode = require('../lib/node/fullnode');
    const SPVNode = require('../lib/node/spvnode');

    const base = 20000 + crypto.randomInt(0, 10000);
    const full = new FullNode({
      network: 'regtest',
      memory: true,
      workers: false,
      bip37: true,
      listen: false,
      httpPort: base + 1,
      wtPort: base,
      wtHost: '127.0.0.1'
    });

    const until = async (check, what, ms = 30000) => {
      const end = Date.now() + ms;
      while (!check() && Date.now() < end)
        await new Promise(r => setTimeout(r, 100));
      assert(check(), `Timed out: ${what}`);
    };

    const connected = (node) => {
      const peer = node.pool.peers.head();
      return Boolean(peer && peer.handshake);
    };

    let spv = null;

    try {
      await full.open();
      await full.connect();

      const [current, next] = full.pool.wt.getHashes();
      spv = new SPVNode({
        network: 'regtest',
        memory: true,
        workers: false,
        httpPort: base + 2,
        webTransport: addon.WebTransport,
        wtSeeds: [{host: '127.0.0.1', port: base,
          hashes: [current.hash, next.hash]}]
      });

      await spv.open();
      await spv.connect();
      await until(() => connected(spv), 'first connection');

      // The node drops the page and takes no page for 8 s.
      full.pool.options.wtMaxInbound = 0;
      for (let peer = full.pool.peers.head(); peer; peer = peer.next)
        peer.destroy();
      await until(() => !connected(spv), 'dropped');

      await new Promise(r => setTimeout(r, 8000));
      assert(!connected(spv), 'connected while the node refused pages');

      // Taken back: the page is in again, with no reload.
      full.pool.options.wtMaxInbound = 64;
      await until(() => connected(spv), 'reconnection', 25000);
    } finally {
      if (spv)
        await spv.close();
      await full.close();
    }
  });
});
