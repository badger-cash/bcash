/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC staking nodes often run without NODE_NETWORK. With
 * avalanche on, the pool keeps their addresses for its avalanche
 * connections, and never picks them for its other outbound peers.
 */

const assert = require('bsert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Chain = require('../lib/blockchain/chain');
const BlockStore = require('../lib/blockstore/level');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const common = require('../lib/net/common');
const Processor = require('../lib/avalanche/processor');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');

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

  it('should dial first the avalanche nodes most peers list', async () => {
    const p = await pool(true);

    // A full host list takes no more: these are kept apart.
    p.hosts.add = () => false;

    const most = '51.255.199.30:18333';
    const fewer = '51.255.199.31:18333';
    for (let id = 1; id <= 3; id++) {
      const items = [addr('51.255.199.30', NETWORK | AVALANCHE)];
      if (id === 1)
        items.push(addr('51.255.199.31', NETWORK | AVALANCHE));
      // Not ours to dial: off the default port, or not avalanche.
      const off = NetAddress.fromHostname('51.255.199.32:51234', 'testnet');
      off.services = AVALANCHE;
      off.time = items[0].time;
      items.push(off, addr('51.255.199.33', NETWORK));
      await p.handleAddr({...fakePeer, id}, new packets.AddrPacket(items));
    }

    assert.strictEqual(p.avalancheHosts.size, 2);
    assert.strictEqual(p.getAvalancheHost().hostname, most);
    assert.strictEqual(p.getAvalancheHost().hostname, fewer);

    // Tried: not again for 10 minutes.
    assert.strictEqual(p.getAvalancheHost(), null);
    p.avalancheHosts.get(most).tried -= 601;
    assert.strictEqual(p.getAvalancheHost().hostname, most);

    // Nor once trimmed.
    p.avalancheHosts.get(most).tried -= 601;
    p.trimmed.add(most);
    assert.strictEqual(p.getAvalancheHost(), null);
  });

  it('should refuse an addr of more than 1000, as Bitcoin ABC', async () => {
    const p = await pool(true);
    let discouraged = false;
    p.discourage = () => {
      discouraged = true;
    };
    const items = [];
    for (let i = 0; i < 1001; i++)
      items.push(addr(`51.${i >> 8}.${i & 255}.9`, NETWORK | AVALANCHE));
    await p.handleAddr({...fakePeer, id: 1}, new packets.AddrPacket(items));
    assert(discouraged);
    assert.strictEqual(p.avalancheHosts.size, 0);
  });

  it('should keep the avalanche nodes most peers list, when full',
    async () => {
      const p = await pool(true);
      p.hosts.add = () => false;

      // Listed by three peers.
      for (let id = 1; id <= 3; id++) {
        await p.handleAddr({...fakePeer, id}, new packets.AddrPacket([
          addr('51.255.199.40', NETWORK | AVALANCHE)
        ]));
      }

      // One peer's addrs, past the cap of 2000.
      for (let n = 0; n < 3; n++) {
        const items = [];
        for (let i = 0; i < 1000; i++) {
          const j = n * 1000 + i;
          items.push(addr(`52.${j >> 8}.${j & 255}.9`, NETWORK | AVALANCHE));
        }
        await p.handleAddr({...fakePeer, id: 9}, new packets.AddrPacket(items));
      }

      assert.strictEqual(p.avalancheHosts.size, 2000);
      assert(p.avalancheHosts.has('51.255.199.40:18333'));
    });

  it('should take a discouraged peer only while slots are left',
    async () => {
      const p = await pool(true);
      p.discouraged.add('51.255.199.50');
      let added = 0;
      p.addInbound = () => {
        added += 1;
      };
      const socket = ip => ({
        remoteAddress: ip,
        remotePort: 40000,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        }
      });

      p.options.maxInbound = 8;
      p.peers.inbound = 0;
      const early = socket('51.255.199.50');
      p.handleSocket(early);
      assert(!early.destroyed);

      // One slot left: not the discouraged, still others.
      p.peers.inbound = 7;
      const late = socket('51.255.199.50');
      p.handleSocket(late);
      assert(late.destroyed);
      const other = socket('51.255.199.51');
      p.handleSocket(other);
      assert(!other.destroyed);
      assert.strictEqual(added, 2);
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

  it('should dial less often while dials add no stake', async () => {
    const p = await pool(true);
    delete p.fillOutbound;
    p.addLoader = () => {};
    p.addOutbound = () => {};
    p.refill = () => {};
    let dials = 0;
    p.addAvalancheOutbound = () => {
      dials += 1;
    };

    // Stake we can reach, and all the stake known.
    const pm = p.avalanche.peerManager;
    let connected = 100;
    let total = 1000;
    pm.getConnectedPeersScore = () => connected;
    pm.getTotalPeersScore = () => total;

    // A round each time the wait is over.
    const round = () => {
      p.lastAvalancheDials -= p.avalancheDialInterval;
      p.fillOutbound();
    };

    round();
    assert.strictEqual(dials, 8);
    assert.strictEqual(p.avalancheDialInterval, 3000);

    // Rounds that add nothing: the wait doubles, up to 5 minutes.
    const waits = [];
    for (let i = 0; i < 9; i++) {
      round();
      waits.push(p.avalancheDialInterval);
    }
    assert.deepStrictEqual(waits, [6000, 12000, 24000, 48000, 96000,
      192000, 300000, 300000, 300000]);
    assert.strictEqual(dials, 80);

    // Before the wait is over, no dial.
    p.lastAvalancheDials = Date.now();
    p.fillOutbound();
    assert.strictEqual(dials, 80);

    // A round that finds stake: back to a few seconds.
    connected = 150;
    round();
    assert.strictEqual(p.avalancheDialInterval, 3000);

    round();
    assert.strictEqual(p.avalancheDialInterval, 6000);

    // New stake known, maybe on nodes not dialed yet: the same.
    total = 1200;
    round();
    assert.strictEqual(p.avalancheDialInterval, 3000);

    // A proof that comes and goes counts once: it went, and came back.
    total = 1000;
    round();
    assert.strictEqual(p.avalancheDialInterval, 6000);
    total = 1200;
    round();
    assert.strictEqual(p.avalancheDialInterval, 12000);
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

  it('should announce and poll again our own stalled transaction', async () => {
    const p = await spvPool();
    const ava = p.avalanche;
    const mtx = new MTX();
    mtx.addInput({prevout: {hash: Buffer.alloc(32, 1), index: 0}});
    mtx.addOutput(new Script(), 1000);
    const tx = mtx.toTX();

    const did = [];
    p.markStalled = () => did.push('marked');
    p.broadcast = async () => did.push('broadcast');
    const watch = ava.watchTransaction.bind(ava);
    ava.watchTransaction = async (t) => {
      did.push('watched');
      return watch(t);
    };
    p.on('tx stale', () => did.push('stale'));

    // Not ours: nothing.
    ava.emit('tx vote', tx, Processor.voteStatus.STALE);
    assert.deepStrictEqual(did, []);

    await watch(tx);
    ava.emit('tx vote', tx, Processor.voteStatus.STALE);
    assert.deepStrictEqual(did, ['marked', 'broadcast', 'watched', 'stale']);
  });

  it('should save avalanche peers at a stop, and load them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcash-avapeers-'));
    try {
      const file = path.join(dir, 'avapeers.dat');
      const p = await pool(true);
      p.options.avaPeersFile = file;

      // No file yet: nothing.
      let given = null;
      p.avalanche.loadPeers = async (data) => {
        given = data;
        return 1;
      };
      await p.loadAvalanchePeers();
      assert.strictEqual(given, null);

      p.avalanche.peerManager.dumpPeers = () => Buffer.from('peers');
      await p.dumpAvalanchePeers();
      assert(!fs.existsSync(file + '.new'));
      await p.loadAvalanchePeers();
      assert.bufferEqual(given, Buffer.from('peers'));
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('should keep the file in the data directory, unless told not',
    async () => {
      const FullNode = require('../lib/node/fullnode');
      const options = {network: 'regtest', workers: false, avalanche: true};
      assert.strictEqual(new FullNode({...options, memory: true})
        .avaPeersFile(), null);
      const prefix = path.join(os.tmpdir(), 'bcash-avapeers-prefix');
      assert.strictEqual(new FullNode({...options, memory: false, prefix})
        .avaPeersFile(), path.join(prefix, 'regtest', 'avapeers.dat'));
      assert.strictEqual(new FullNode({...options, memory: false, prefix,
        persistAvapeers: false}).avaPeersFile(), null);
    });

  it('should say NODE_AVALANCHE only when it stakes', async () => {
    const network = Network.get('testnet');
    const chain = new Chain({network, memory: true, spv: true});
    const peerData = {proof: {id: () => Buffer.alloc(32)}};
    const full = (more) => {
      const blocks = new BlockStore({network, memory: true});
      return new Pool({network, memory: true, avalanche: true,
        chain: new Chain({network, memory: true, blocks}), ...more});
    };

    assert.strictEqual(full().options.services & AVALANCHE, 0);
    assert.strictEqual(full({avalanchePeerData: peerData}).options.services
      & AVALANCHE, AVALANCHE);

    assert.throws(() => new Pool({network, chain, spv: true, memory: true,
      avalanche: true, avalanchePeerData: peerData}),
    {message: 'An SPV node cannot stake.'});
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
  function trimmer(stakers, others, limit, busy = [], share = 1,
    {pending = [], young = []} = {}) {
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

    // Open long enough to have said hello, but the young.
    const conns = [...nodes.keys(), ...others].map(id => ({
      id, avalancheOutbound: true, closed: false,
      time: young.includes(id) ? Date.now() : 1,
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
          pendingNodes: new Map(pending.map(id => [id, {nodeId: id}])),
          peers,
          getTotalPeersScore: () => total,
          getConnectedPeersScore: () => Math.round(total * share)
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

    // Down to 5% over the connected ratio, 85 of 100, not below.
    assert.deepStrictEqual(trimmer(stakers, [], 1).closed, [2, 5, 6]);

    // Not a node with a poll out.
    assert.deepStrictEqual(trimmer(stakers, [], 4, [5]).closed, [2, 6]);

    // Nothing past the limit.
    assert.deepStrictEqual(trimmer(stakers, [7], 7).closed, []);

    // Between the ratio and the margin, those that cost no stake still go.
    assert.deepStrictEqual(trimmer(stakers, [7, 8], 1, [], 0.82).closed,
      [2, 7, 8]);
  });

  it('should spare a connection whose node may yet be a staker\'s', () => {
    const stakers = [
      {score: 60, nodes: [1]},
      {score: 20, nodes: [2, 3]},
      {score: 20, nodes: [4]}
    ];

    // 7 said hello and its proof is being checked; 8 has just opened.
    // Neither goes; 9, open a while and no node, does.
    const {closed} = trimmer(stakers, [7, 8, 9], 3, [], 1,
      {pending: [7], young: [8]});
    assert.deepStrictEqual(closed, [2, 9]);
  });

  it('should dial trimmed avalanche nodes again short of the ratio',
    async () => {
      const p = await pool(true);
      p.options.spv = true;
      let ratio = true;
      p.avalanche.hasConnectedRatio = () => ratio;
      p.trimmed.add('10.0.0.9:18333');

      // With the ratio, they stay trimmed.
      p.forgetTrimmed();
      assert(p.trimmed.has('10.0.0.9:18333'));

      // Proofs learned since dropped us below it: dial them again.
      ratio = false;
      p.forgetTrimmed();
      assert.strictEqual(p.trimmed.size, 0);
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

