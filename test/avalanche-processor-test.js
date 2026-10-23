/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The processor's handling of avalanche messages, following Bitcoin
 * ABC's src/net_processing.cpp, against fake peers.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const Delegation = require('../lib/avalanche/delegation');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {
  CompactProofs,
  ProofsRequest
} = require('../lib/avalanche/compactproofs');
const {Hello, invTypes} = require('../lib/avalanche/protocol');
const {
  pub,
  FakeChain,
  MIN_VALID_PROOF_SCORE
} = require('./util/avalanche');
const {buildRandomProof} = require('./util/avalanche');

class FakePeer {
  constructor(id, outbound = true) {
    this.id = id;
    this.outbound = outbound;
    this.address = NetAddress.fromHostname(`10.0.0.${id}:8333`, 'main');
    this.localNonce = random.randomBytes(8);
    this.remoteNonce = random.randomBytes(8);
    this.remoteEntropy = BigInt(id + 1);
    this.sent = [];
    this.ban = 0;
  }

  hostname() {
    return this.address.hostname;
  }

  send(packet) {
    this.sent.push(packet);
  }

  increaseBan(score) {
    this.ban += score;
  }

  // Commands sent, and the payload of the last of a command.
  cmds() {
    return this.sent.map(p => p.cmd);
  }

  last(cmd) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].cmd === cmd)
        return this.sent[i];
    }
    return null;
  }
}

function unknown(cmd, data = Buffer.alloc(0)) {
  return new packets.UnknownPacket(cmd, data);
}

describe('Avalanche Processor', function() {
  let chain, now, pm, processor, ibd;

  beforeEach(() => {
    chain = new FakeChain(100);
    now = 1000000;
    ibd = false;
    pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain, confirmations: 1}),
      now: () => now
    });
    processor = new Processor({
      peerManager: pm,
      isIBD: () => ibd,
      now: () => now,
      minQuorumStake: 0,
      minAvaproofsNodeCount: 0
    });
  });

  // A staking node: its proof, and a hello signed for its connection.
  function staker(peer, proof, sessionKey, maxElements) {
    const dg = Delegation.fromProof(proof);
    dg.addLevel(proof.masterKey, pub(sessionKey));
    const hello = new Hello(dg, null, maxElements);
    // The peer signs with its nonce and entropy first.
    hello.sign(sessionKey, peer.remoteNonce, peer.localNonce,
      peer.remoteEntropy, 1n);
    return hello;
  }

  function stakingProof() {
    const masterKey = secp256k1.privateKeyGenerate();
    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 100,
      masterKey);
    proof.masterKey = masterKey;
    return proof;
  }

  async function connect(peer) {
    processor.addPeer(peer);
    return peer;
  }

  it('should say hello without a proof', async () => {
    const peer = await connect(new FakePeer(1));
    const hello = Hello.fromRaw(peer.last('avahello').data);
    assert.strictEqual(hello.hasProof(), false);
    assert.strictEqual(hello.maxElements, 1024);
  });

  it('should take a staker\'s hello and fetch its proof', async () => {
    const peer = await connect(new FakePeer(1));
    const proof = stakingProof();
    const hello = staker(peer, proof, secp256k1.privateKeyGenerate());

    await processor.handlePacket(peer, unknown('avahello', hello.toRaw()));

    assert.strictEqual(peer.ban, 0);
    // Pending until the proof comes.
    assert.strictEqual(pm.getPendingNodeCount(), 1);
    assert.strictEqual(pm.getNodeCount(), 0);

    const getdata = peer.last('getdata');
    assert(getdata);
    assert.strictEqual(getdata.items[0].type, invTypes.AVA_PROOF);
    assert.bufferEqual(getdata.items[0].hash, proof.id());

    // Outbound: ask for addresses and proofs.
    assert(peer.cmds().includes('getavaaddr'));
    assert(peer.cmds().includes('getavaproofs'));

    await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));

    assert(pm.isBoundToPeer(proof.id()));
    assert.strictEqual(pm.getNodeCount(), 1);
    assert.strictEqual(pm.getPendingNodeCount(), 0);
    assert(pm.verify());
  });

  it('should not ask an inbound node for its proofs', async () => {
    const peer = await connect(new FakePeer(1, false));
    const hello = staker(peer, stakingProof(),
      secp256k1.privateKeyGenerate());
    await processor.handlePacket(peer, unknown('avahello', hello.toRaw()));
    assert(!peer.cmds().includes('getavaaddr'));
    assert(!peer.cmds().includes('getavaproofs'));
  });

  it('should ban a hello signed for another connection', async () => {
    const peer = await connect(new FakePeer(1));
    const other = new FakePeer(2);
    const hello = staker(other, stakingProof(),
      secp256k1.privateKeyGenerate());
    await processor.handlePacket(peer, unknown('avahello', hello.toRaw()));
    assert.strictEqual(peer.ban, 100);
    assert.strictEqual(pm.getPendingNodeCount(), 0);
  });

  it('should ban a hello with too few max elements', async () => {
    const peer = await connect(new FakePeer(1));
    const hello = staker(peer, stakingProof(),
      secp256k1.privateKeyGenerate(), 15);
    await processor.handlePacket(peer, unknown('avahello', hello.toRaw()));
    assert.strictEqual(peer.ban, 100);
  });

  it('should take an older node\'s hello without max elements', async () => {
    const peer = await connect(new FakePeer(1));
    const hello = staker(peer, stakingProof(),
      secp256k1.privateKeyGenerate());
    const raw = hello.toRaw();
    await processor.handlePacket(peer,
      unknown('avahello', raw.slice(0, raw.length - 4)));
    assert.strictEqual(peer.ban, 0);
    const [pending] = pm.pendingNodes.values();
    assert.strictEqual(pending.maxElements, 16);
  });

  it('should relay a new proof and ban for an invalid one', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));

    const proof = stakingProof();
    await processor.handlePacket(a, unknown('avaproof', proof.toRaw()));
    assert(pm.isBoundToPeer(proof.id()));

    processor.flushProofInvs();

    // Only to the peer that did not send it.
    assert.strictEqual(a.last('inv'), null);
    const inv = b.last('inv');
    assert.strictEqual(inv.items[0].type, invTypes.AVA_PROOF);
    assert.bufferEqual(inv.items[0].hash, proof.id());

    // A bad stake signature.
    const bad = stakingProof();
    bad.stakes[0].signature = Buffer.alloc(64, 1);
    await processor.handlePacket(b, unknown('avaproof', bad.toRaw()));
    assert.strictEqual(b.ban, 100);
    assert(processor.alreadyHaveProof(bad.id()));
  });

  // Bitcoin ABC checks a proof at once. An SPV node fetches its coins:
  // the same proof can arrive again meanwhile, from every node that
  // announced it, and only the first is checked.
  it('should check a proof once, banning only its first sender', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));
    const proof = stakingProof();

    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    pm.verifier.verify = async () => {
      await gate;
      return [false, 'expired-proof'];
    };

    const first = processor.handlePacket(a, unknown('avaproof',
      proof.toRaw()));

    // Announced and sent again while it is checked: not fetched, nor
    // held against the sender.
    processor.handleProofInv(b, [proof.id()]);
    assert.strictEqual(b.last('getdata'), null);
    await processor.handlePacket(b, unknown('avaproof', proof.toRaw()));

    release();
    await first;

    assert.strictEqual(a.ban, 100);
    assert.strictEqual(b.ban, 0);
    assert(processor.alreadyHaveProof(proof.id()));
  });

  // Bitcoin ABC's too-many-invalid-avaproofs.
  it('should limit proofs that fail without being invalid', async () => {
    const peer = await connect(new FakePeer(1));
    pm.verifier.verify = async () => [false, 'utxo-missing-or-spent'];

    const max = Processor.MAX_INVALID_AVAPROOFS;
    for (let i = 0; i < max - 1; i++) {
      await processor.handlePacket(peer, unknown('avaproof',
        stakingProof().toRaw()));
    }
    assert.strictEqual(peer.ban, 0);

    // An hour on, the earlier ones no longer count.
    now += Processor.INVALID_AVAPROOFS_INTERVAL;
    await processor.handlePacket(peer, unknown('avaproof',
      stakingProof().toRaw()));
    assert.strictEqual(peer.ban, 0);

    for (let i = 0; i < max - 1; i++) {
      await processor.handlePacket(peer, unknown('avaproof',
        stakingProof().toRaw()));
    }
    assert.strictEqual(peer.ban, 100);
  });

  it('should hold proofs during IBD', async () => {
    ibd = true;
    const peer = await connect(new FakePeer(1));
    const proof = stakingProof();
    await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
    assert(!pm.exists(proof.id()));
  });

  it('should share its proofs as compact proofs', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));

    // A proof with a node, so it is shareable.
    const proof = stakingProof();
    await processor.handlePacket(a, unknown('avahello',
      staker(a, proof, secp256k1.privateKeyGenerate()).toRaw()));
    await processor.handlePacket(a, unknown('avaproof', proof.toRaw()));

    await processor.handlePacket(b, unknown('getavaproofs'));
    const compact = CompactProofs.fromRaw(b.last('avaproofs').data);
    assert.deepStrictEqual(compact.shortIds, [compact.sid(proof.id())]);

    // At most one a minute.
    b.sent = [];
    await processor.handlePacket(b, unknown('getavaproofs'));
    assert.strictEqual(b.last('avaproofs'), null);

    await processor.handlePacket(b, unknown('avaproofsreq',
      new ProofsRequest([0]).toRaw()));
    assert.bufferEqual(b.last('avaproof').data, proof.toRaw());
  });

  it('should request only the proofs it lacks', async () => {
    const peer = await connect(new FakePeer(1));
    const known = stakingProof();
    const missing = stakingProof();

    await processor.handlePacket(peer, unknown('avaproof', known.toRaw()));

    // Unsolicited: ignored.
    const compact = CompactProofs.fromProofs([missing, known]);
    await processor.handlePacket(peer,
      unknown('avaproofs', compact.toRaw()));
    assert.strictEqual(peer.last('avaproofsreq'), null);

    // Its hello makes it a staker, and asks for its proofs.
    const own = stakingProof();
    await processor.handlePacket(peer, unknown('avahello',
      staker(peer, own, secp256k1.privateKeyGenerate()).toRaw()));
    await processor.handlePacket(peer,
      unknown('avaproofs', compact.toRaw()));

    const req = ProofsRequest.fromRaw(peer.last('avaproofsreq').data);
    assert.deepStrictEqual(req.indexes, [0]);

    // It said it has the known proof.
    const remotes = pm.getRemoteProofs(peer.id);
    assert.strictEqual(remotes.length, 1);
    assert.bufferEqual(remotes[0].proofId, known.id());
    assert.strictEqual(remotes[0].present, true);
  });

  it('should count each node that sent its proofs once', async () => {
    const peer = await connect(new FakePeer(1));
    const own = stakingProof();
    await processor.handlePacket(peer, unknown('avahello',
      staker(peer, own, secp256k1.privateKeyGenerate()).toRaw()));
    await processor.handlePacket(peer, unknown('avaproof', own.toRaw()));

    const compact = CompactProofs.fromProofs([own]);

    for (let i = 0; i < 2; i++) {
      processor.periodicNetworking();
      await processor.handlePacket(peer,
        unknown('avaproofs', compact.toRaw()));
    }

    assert.strictEqual(processor.avaproofsNodeCounter, 1);
  });

  it('should fetch an announced proof, and retry elsewhere', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));
    const proof = stakingProof();

    processor.handleProofInv(a, [proof.id()]);
    processor.handleProofInv(b, [proof.id()]);

    assert(a.last('getdata'));
    assert.strictEqual(b.last('getdata'), null);

    now += Processor.PROOF_REQUEST_TIMEOUT;
    processor.expireProofRequests();
    assert(b.last('getdata'));

    await processor.handlePacket(b, unknown('avaproof', proof.toRaw()));
    assert(pm.isBoundToPeer(proof.id()));
    assert.strictEqual(processor.requests.size, 0);
  });

  it('should serve proofs announced or known long enough', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));
    const c = await connect(new FakePeer(3));
    const proof = stakingProof();

    await processor.handlePacket(a, unknown('avaproof', proof.toRaw()));

    // Not announced to c yet, and new.
    const unknownId = random.randomBytes(32);
    assert.deepStrictEqual(processor.handleProofGetData(c, [proof.id()]),
      [proof.id()]);

    processor.flushProofInvs();
    assert.deepStrictEqual(processor.handleProofGetData(b, [proof.id()]), []);
    assert.bufferEqual(b.last('avaproof').data, proof.toRaw());

    now += Processor.UNCONDITIONAL_RELAY_DELAY;
    const d = await connect(new FakePeer(4));
    assert.deepStrictEqual(processor.handleProofGetData(d, [proof.id()]), []);
    assert.deepStrictEqual(processor.handleProofGetData(d, [unknownId]),
      [unknownId]);
  });

  it('should answer getavaaddr with avalanche nodes, rarely', async () => {
    const a = await connect(new FakePeer(1));
    const b = await connect(new FakePeer(2));
    // Connected, but no hello: not an avalanche node.
    await connect(new FakePeer(3));

    await processor.handlePacket(b, unknown('avahello', new Hello().toRaw()));

    await processor.handlePacket(a, unknown('getavaaddr'));
    const addr = a.last('addr');
    assert.deepStrictEqual(addr.items.map(x => x.hostname), [b.hostname()]);

    a.sent = [];
    await processor.handlePacket(a, unknown('getavaaddr'));
    assert.strictEqual(a.last('addr'), null);
  });

  it('should establish quorum and latch it', async () => {
    const peers = [];
    for (let i = 0; i < 8; i++) {
      const peer = await connect(new FakePeer(i + 1));
      const proof = stakingProof();
      await processor.handlePacket(peer, unknown('avahello',
        staker(peer, proof, secp256k1.privateKeyGenerate()).toRaw()));
      await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
      peers.push(peer);

      assert.strictEqual(processor.isQuorumEstablished(), i === 7);
    }

    // Stake without nodes, 8 of 11 connected, does not undo it; too few
    // nodes does.
    for (let i = 0; i < 3; i++) {
      await processor.handlePacket(peers[0], unknown('avaproof',
        stakingProof().toRaw()));
    }
    assert(pm.getConnectedPeersScore() < 0.8 * pm.getTotalPeersScore());
    assert.strictEqual(processor.isQuorumEstablished(), true);

    processor.removePeer(peers[7]);
    assert.strictEqual(processor.isQuorumEstablished(), false);
  });

  it('should need nodes for enough of the stake', async () => {
    // Bitcoin ABC's rule alone.
    processor.minQuorumConnectedScoreRatio = 0.9;
    processor.minQuorumUnanimousScoreRatio = 0.9;

    for (let i = 0; i < 8; i++) {
      const peer = await connect(new FakePeer(i + 1));
      const proof = stakingProof();
      await processor.handlePacket(peer, unknown('avahello',
        staker(peer, proof, secp256k1.privateKeyGenerate()).toRaw()));
      await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
    }

    // One proof with no node: 8 of 9 connected is below 0.9.
    const lone = await connect(new FakePeer(9));
    await processor.handlePacket(lone, unknown('avaproof',
      stakingProof().toRaw()));
    assert.strictEqual(processor.isQuorumEstablished(), false);
  });

  it('should need enough nodes to have sent their proofs', async () => {
    processor.minAvaproofsNodeCount = 1;

    for (let i = 0; i < 8; i++) {
      const peer = await connect(new FakePeer(i + 1));
      const proof = stakingProof();
      await processor.handlePacket(peer, unknown('avahello',
        staker(peer, proof, secp256k1.privateKeyGenerate()).toRaw()));
      await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
    }

    assert.strictEqual(processor.isQuorumEstablished(), false);

    const [state] = processor.peers.values();
    state.compactProofsRequested = true;
    await processor.handlePacket(state.peer, unknown('avaproofs',
      CompactProofs.fromProofs([]).toRaw()));
    // No short ids: not counted, as in ABC.
    assert.strictEqual(processor.isQuorumEstablished(), false);

    state.compactProofsRequested = true;
    const proofs = pm.getShareableProofs();
    await processor.handlePacket(state.peer, unknown('avaproofs',
      CompactProofs.fromProofs(proofs).toRaw()));
    assert.strictEqual(processor.isQuorumEstablished(), true);
  });

  // Bitcoin ABC asks a few nodes for their proofs until one answers, then
  // every node at its next periodic round; bcash at once, not minutes on.
  it('should ask every node once the first sends its proofs', async () => {
    const peers = [];
    for (let i = 0; i < 5; i++) {
      const peer = await connect(new FakePeer(i + 1));
      const proof = stakingProof();
      await processor.handlePacket(peer, unknown('avahello',
        staker(peer, proof, secp256k1.privateKeyGenerate()).toRaw()));
      await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
      peers.push(peer);
    }

    // Not asked yet, as during a sync.
    for (const peer of peers)
      peer.sent.length = 0;
    for (const state of processor.peers.values())
      state.compactProofsRequested = false;

    const asked = () => peers.filter(p => p.last('getavaproofs')).length;

    processor.periodicNetworking();
    assert.strictEqual(asked(), 3);

    // The first proofs from one of them: the rest are asked now.
    const state = [...processor.peers.values()]
      .find(s => s.compactProofsRequested);
    await processor.handlePacket(state.peer, unknown('avaproofs',
      CompactProofs.fromProofs(pm.getShareableProofs()).toRaw()));
    assert.strictEqual(processor.avaproofsNodeCounter, 1);
    assert.strictEqual(asked(), peers.length);
  });

  it('should forget a node when its peer goes', async () => {
    const peer = await connect(new FakePeer(1));
    const proof = stakingProof();
    await processor.handlePacket(peer, unknown('avahello',
      staker(peer, proof, secp256k1.privateKeyGenerate()).toRaw()));
    await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
    assert.strictEqual(pm.getNodeCount(), 1);

    processor.removePeer(peer);
    assert.strictEqual(pm.getNodeCount(), 0);
    assert.strictEqual(processor.peers.size, 0);
  });

  it('should ban a malformed message', async () => {
    const peer = await connect(new FakePeer(1));
    await processor.handlePacket(peer, unknown('avaproof', Buffer.from([1])));
    assert.strictEqual(peer.ban, 100);
  });

  it('should not hold our own failures against a peer', async () => {
    const peer = await connect(new FakePeer(1));
    processor.receivedProof = async () => {
      throw new Error('Database is closed.');
    };
    const proof = stakingProof();
    await processor.handlePacket(peer, unknown('avaproof', proof.toRaw()));
    assert.strictEqual(peer.ban, 0);
  });

  // Bitcoin ABC's PROOF_REQUEST_PARAMS.
  it('should keep and ask for so many of a peer\'s proofs', async () => {
    const peer = await connect(new FakePeer(1));
    const ids = [];
    for (let i = 0; i < 5100; i++)
      ids.push(random.randomBytes(32));

    processor.handleProofInv(peer, ids);

    // 5000 kept; 100 asked for, in one getdata.
    assert.strictEqual(processor.requests.size, 5000);
    const getdatas = peer.sent.filter(p => p.cmd === 'getdata');
    assert.strictEqual(getdatas.length, 1);
    assert.strictEqual(getdatas[0].items.length, 100);

    // Unanswered: asked of nobody else, so dropped; room for the next.
    peer.sent = [];
    now += 60;
    processor.expireProofRequests();
    assert.strictEqual(processor.requests.size, 4900);
    assert.strictEqual(peer.sent.filter(p => p.cmd === 'getdata')[0]
      .items.length, 100);

    // Gone: nothing left of it.
    processor.removePeer(peer);
    assert.strictEqual(processor.requests.size, 0);
  });

  it('should refuse a proof that cannot be valid, before its coins',
    async () => {
      const peer = await connect(new FakePeer(1));
      const proof = stakingProof();
      let checked = 0;
      pm.verifier.verify = async () => {
        checked += 1;
        return [true, 'valid'];
      };
      proof.signature = Buffer.alloc(64);

      assert.strictEqual(await processor.receivedProof(
        processor.peers.get(peer.id), proof), false);
      assert.strictEqual(checked, 0);
      assert(processor.alreadyHaveProof(proof.id()));
    });

  it('should check so many of a peer\'s proofs at once', async function() {
    // 101 signed proofs: slow on the JavaScript backend.
    this.timeout(60000);
    const peer = await connect(new FakePeer(1));
    const state = processor.peers.get(peer.id);

    // Coins that take their time.
    let release;
    const held = new Promise(r => (release = r));
    let checked = 0;
    pm.verifier.verify = async () => {
      checked += 1;
      await held;
      return [false, 'utxo-missing-or-spent'];
    };

    const pending = [];
    for (let i = 0; i < 101; i++)
      pending.push(processor.receivedProof(state, stakingProof()));

    await new Promise(r => setImmediate(r));
    assert.strictEqual(state.verifyingProofs, 100);
    assert.strictEqual(checked, 1);

    release();
    await Promise.all(pending);
    assert.strictEqual(state.verifyingProofs, 0);
    assert.strictEqual(checked, 100);
  });
});
