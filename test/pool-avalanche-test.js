/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC staking nodes often run without NODE_NETWORK. With
 * avalanche on, the pool keeps their addresses for its avalanche
 * connections, and never picks them for its other outbound peers.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const common = require('../lib/net/common');

const {NETWORK, AVALANCHE} = common.services;

async function pool(avalanche) {
  const network = Network.get('testnet');
  const blocks = new BlockStore({network, memory: true});
  const chain = new Chain({network, memory: true, blocks});
  await blocks.open();
  await chain.open();
  const p = new Pool({network, chain, memory: true, listen: false,
    avalanche});
  p.fillOutbound = () => {};
  await p.hosts.open();
  return p;
}

function addr(host, services) {
  const a = NetAddress.fromHostname(`${host}:18333`, 'testnet');
  a.services = services;
  a.time = Math.floor(Date.now() / 1000);
  return a;
}

const fakePeer = {
  address: addr('10.0.0.1', NETWORK),
  addrFilter: {add() {}},
  hostname: () => '10.0.0.1:18333'
};

describe('Pool avalanche addresses', function() {
  it('should keep staking nodes without NODE_NETWORK', async () => {
    const p = await pool(true);
    await p.handleAddr(fakePeer, new packets.AddrPacket([
      addr('51.255.199.24', AVALANCHE),
      addr('51.255.200.103', 0)
    ]));
    assert(p.hosts.map.has('51.255.199.24:18333'));
    assert(!p.hosts.map.has('51.255.200.103:18333'));

    // Its avalanche slots may take it; its other peers may not.
    assert.strictEqual(p.getAvalancheHost().hostname, '51.255.199.24:18333');
    assert.strictEqual(p.getHost(), null);
  });

  it('should take the nodes a getavaaddr answer lists', async () => {
    const p = await pool(true);
    const peer = {...fakePeer, id: 7};

    // Bitcoin ABC lists avalanche nodes with no services.
    p.avalanche.peers.set(peer.id, {peer, avaAddrsRequested: 0});
    p.avalanche.send = () => {};
    p.avalanche.requestAvaAddrs(p.avalanche.peers.get(peer.id));

    const listening = addr('51.255.199.24', 0);
    const natted = NetAddress.fromHostname('51.255.199.25:51234', 'testnet');
    natted.services = 0;
    natted.time = listening.time;
    await p.handleAddr(peer, new packets.AddrPacket([listening, natted]));

    // The one on the default port, as an avalanche node.
    assert(p.hosts.map.has('51.255.199.24:18333'));
    assert(!p.hosts.map.has('51.255.199.25:51234'));
    assert.strictEqual(p.getAvalancheHost().hostname, '51.255.199.24:18333');

    // An addr not answering one lists nothing of the kind.
    await p.handleAddr(peer, new packets.AddrPacket([
      addr('51.255.199.26', 0)
    ]));
    assert(!p.hosts.map.has('51.255.199.26:18333'));
  });

  it('should discourage, not ban, as Bitcoin ABC', async () => {
    const p = await pool(true);
    await p.handleAddr(fakePeer, new packets.AddrPacket([
      addr('51.255.199.24', AVALANCHE)
    ]));

    let destroyed = false;
    p.discourage({
      address: addr('51.255.199.24', AVALANCHE),
      hostname: () => '51.255.199.24:18333',
      destroy() {
        destroyed = true;
      }
    });

    // Disconnected and not dialed again, but its address is kept.
    assert(destroyed);
    assert(p.isDiscouraged('51.255.199.24'));
    assert(p.hosts.map.has('51.255.199.24:18333'));
    assert(!p.hosts.isBanned('51.255.199.24'));
    assert.strictEqual(p.getAvalancheHost(), null);

    // The processor discourages through it.
    assert.strictEqual(typeof p.avalanche.discourage, 'function');
  });

  it('should dial a few avalanche nodes at a time', async () => {
    const p = await pool(true);
    delete p.fillOutbound;
    p.addLoader = () => {};
    p.addOutbound = () => {};
    let dials = 0;
    let refills = 0;
    p.addAvalancheOutbound = () => {
      dials += 1;
    };
    p.refill = () => {
      refills += 1;
    };

    // Eight of the 150 slots, then none until a refill.
    p.fillOutbound();
    assert.strictEqual(dials, 8);
    p.fillOutbound();
    assert.strictEqual(dials, 8);
    assert.strictEqual(refills, 1);

    p.lastAvalancheDials -= 3000;
    p.fillOutbound();
    assert.strictEqual(dials, 16);
  });

  it('should drop them without avalanche', async () => {
    const p = await pool(false);
    await p.handleAddr(fakePeer, new packets.AddrPacket([
      addr('51.255.199.24', AVALANCHE)
    ]));
    assert(!p.hosts.map.has('51.255.199.24:18333'));
  });
});

describe('Pool avalanche messages', function() {
  it('should not hold a peer while a proof is checked', async () => {
    const p = await pool(true);
    const handled = [];

    // A proof whose coins are never fetched.
    p.avalanche.handlePacket = async (peer, packet) => {
      handled.push(packet.cmd);
      if (packet.cmd === 'avaproof')
        await new Promise(() => {});
    };

    await p.handleUnknown(fakePeer,
      new packets.UnknownPacket('avaproof', Buffer.alloc(0)));
    await p.handleUnknown(fakePeer,
      new packets.UnknownPacket('avaresponse', Buffer.alloc(0)));

    assert.deepStrictEqual(handled, ['avaproof', 'avaresponse']);
  });
});

describe('Pool avalanche quorum', function() {
  async function spvPool(options = {}) {
    const network = Network.get('testnet');
    const chain = new Chain({network, memory: true, spv: true});
    await chain.open();
    return new Pool({network, chain, spv: true, memory: true,
      listen: false, avalanche: true, ...options});
  }

  it('should keep Bitcoin ABC\'s rule on a full node', async () => {
    const {avalanche} = await pool(true);
    assert.strictEqual(avalanche.minQuorumUnanimousScoreRatio,
      avalanche.minQuorumConnectedScoreRatio);
  });

  it('should finalize unanimous votes with half the stake on SPV', async () => {
    const {avalanche} = await spvPool();
    assert.strictEqual(avalanche.minQuorumUnanimousScoreRatio, 0.5);
    assert.strictEqual(avalanche.minQuorumConnectedScoreRatio, 0.8);
  });

  it('should take the ratio it is given', async () => {
    const {avalanche} = await spvPool({avaMinQuorumUnanimousStakeRatio: 0.8});
    assert.strictEqual(avalanche.minQuorumUnanimousScoreRatio, 0.8);
  });
});

