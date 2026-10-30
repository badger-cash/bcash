/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Full nodes keep peers among the nodes that pass pages' records on (the
 * PAGES service bit), so records reach each such node whichever nodes lie
 * between them: of seven nodes it knows, a node with two outbound slots
 * dials the one saying PAGES. bcash nodes without the bit stand in for
 * other nodes, such as Bitcoin ABC's.
 */

const assert = require('bsert');
const crypto = require('crypto');
const common = require('../lib/net/common');
const NetAddress = require('../lib/net/netaddress');
const FullNode = require('../lib/node/fullnode');
const SPVNode = require('../lib/node/spvnode');

const {services} = common;

describe('Pages peering', function() {
  this.timeout(60000);

  it('should say PAGES as a full node, not as SPV', () => {
    const full = new FullNode({network: 'regtest', memory: true});
    assert(full.pool.options.services & services.PAGES);
    assert(full.pool.options.services & services.NETWORK);

    const spv = new SPVNode({network: 'regtest', memory: true});
    assert(!(spv.pool.options.services & services.PAGES));

    // Unless told otherwise, as the nodes below are.
    const plain = new FullNode({network: 'regtest', memory: true,
      services: services.NETWORK});
    assert.strictEqual(plain.pool.options.services, services.NETWORK);
  });

  it('should keep a peer among the nodes saying PAGES', async () => {
    const base = 20000 + crypto.randomInt(0, 5000) * 2;
    const nodes = [];

    const until = async (check, what, ms = 30000) => {
      const end = Date.now() + ms;
      while (!check() && Date.now() < end)
        await new Promise(r => setTimeout(r, 100));
      assert(check(), `Timed out: ${what}`);
    };

    try {
      // Six nodes without the bit, and one with it.
      const others = [];
      for (let i = 0; i < 7; i++) {
        const pages = i === 6;
        const node = new FullNode({
          network: 'regtest',
          memory: true,
          workers: false,
          listen: true,
          host: '127.0.0.1',
          port: base + i * 2,
          httpPort: base + i * 2 + 1,
          only: ['127.0.0.1:1'],
          services: pages
            ? services.NETWORK | services.PAGES
            : services.NETWORK
        });
        nodes.push(node);
        others.push({port: base + i * 2, pages});
        await node.open();
        await node.connect();
      }

      // The node, knowing all seven, with two outbound slots.
      const node = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        listen: false,
        maxOutbound: 2,
        httpPort: base + 21
      });
      nodes.push(node);
      await node.open();

      for (const {port, pages} of others) {
        const addr = NetAddress.fromHost('127.0.0.1', port, 'regtest');
        addr.services = pages
          ? services.NETWORK | services.PAGES
          : services.NETWORK;
        node.pool.hosts.add(addr);
      }

      await node.connect();

      const pagesHost = `127.0.0.1:${base + 12}`;
      await until(() => {
        const peer = node.pool.peers.get(pagesHost);
        return peer && peer.handshake;
      }, 'connected to the node saying PAGES');

      // Every outbound peer answered, so each is judged.
      await until(() => {
        let open = 0;
        for (let p = node.pool.peers.head(); p; p = p.next) {
          if (p.outbound && p.handshake)
            open += 1;
        }
        return open === 2;
      }, 'both outbound peers open');

      // It passes records on; the others do not.
      const peer = node.pool.peers.get(pagesHost);
      assert(node.pool.isRTCRelay(peer));
      for (let p = node.pool.peers.head(); p; p = p.next) {
        if (p !== peer && p.handshake)
          assert(!node.pool.isRTCRelay(p));
      }
    } finally {
      for (const node of nodes)
        await node.close();
    }
  });
});
