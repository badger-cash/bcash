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

  it('should poll filter aware on SPV only', async () => {
    assert((await spvPool()).avalanche.filterAwarePolling);
    assert(!(await pool(true)).avalanche.filterAwarePolling);
  });

  it('should keep 17 avalanche nodes on SPV, with the ratio', async () => {
    const p = await spvPool();
    let ratio = false;
    p.avalanche.hasConnectedRatio = () => ratio;
    assert.strictEqual(p.avalancheOutboundLimit(), 150);
    ratio = true;
    assert.strictEqual(p.avalancheOutboundLimit(), 17);

    // A full node keeps Bitcoin ABC's.
    const full = await pool(true);
    full.avalanche.hasConnectedRatio = () => true;
    assert.strictEqual(full.avalancheOutboundLimit(), 150);
  });

  // Stakers {score, nodes: [ids]}; connections with no node: ids too.
  function trimmer(stakers, others, limit, busy = []) {
    const nodes = new Map();
    const peers = new Map();
    let total = 0;
    stakers.forEach((st, i) => {
      const staker = {peerId: i, nodeCount: st.nodes.length,
        proof: {getScore: () => st.score}};
      peers.set(i, staker);
      total += st.score;
      for (const id of st.nodes) {
        nodes.set(id, {nodeId: id, peerId: i,
          nextRequestTime: busy.includes(id) ? 10 : 0});
      }
    });

    const conns = [...nodes.keys(), ...others].map(id => ({
      id, avalancheOutbound: true, closed: false,
      hostname: () => `10.0.0.${id}:8333`,
      destroy() {
        this.closed = true;
      }
    }));
    conns.forEach((c, i) => (c.next = conns[i + 1] || null));

    const p = {
      options: {spv: true},
      logger: {debug() {}},
      trimmed: new Set(),
      peers: {avalanche: conns.length, head: () => conns[0]},
      avalancheOutboundLimit: () => limit,
      avalanche: {
        minQuorumConnectedScoreRatio: 0.8,
        peerManager: {
          ms: () => 5,
          getNode: id => nodes.get(id) || null,
          peers,
          getTotalPeersScore: () => total,
          getConnectedPeersScore: () => total
        }
      }
    };
    Pool.prototype.trimAvalancheOutbound.call(p);
    return {closed: conns.filter(c => c.closed).map(c => c.id).sort(),
      trimmed: p.trimmed};
  }

  it('should close avalanche nodes past the SPV few, least stake first', () => {
    const stakers = [
      {score: 60, nodes: [1]},
      {score: 20, nodes: [2, 3]},
      {score: 10, nodes: [4]},
      {score: 5, nodes: [5]},
      {score: 5, nodes: [6]}
    ];

    // No node first, then a staker's extra, then the least staked.
    const {closed, trimmed} = trimmer(stakers, [7, 8], 3);
    assert.deepStrictEqual(closed, [2, 5, 6, 7, 8]);
    assert(trimmed.has('10.0.0.7:8333'));

    // Down to the connected ratio, 80 of 100, not below.
    assert.deepStrictEqual(trimmer(stakers, [], 1).closed, [2, 4, 5, 6]);

    // Not a node with a poll out.
    assert.deepStrictEqual(trimmer(stakers, [], 4, [5]).closed, [2, 6]);

    // Nothing past the limit.
    assert.deepStrictEqual(trimmer(stakers, [7], 7).closed, []);
  });

  it('should not dial a trimmed avalanche node again', async () => {
    const p = await pool(true);
    const a = addr('10.0.0.9', NETWORK | AVALANCHE);
    p.hosts.add(a);
    assert.strictEqual(p.getAvalancheHost().hostname, a.hostname);
    p.trimmed.add(a.hostname);
    assert.strictEqual(p.getAvalancheHost(), null);
  });
});

