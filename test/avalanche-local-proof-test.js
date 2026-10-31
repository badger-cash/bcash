/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A staking node's own proof, as Bitcoin ABC's: our hello carries it once
 * a node has connected in to us; it registers at a new tip; it is shared
 * with no node, served when asked for, never dangling, and its stake
 * counts toward a quorum (abc_p2p_avalanche_peer_discovery.py,
 * abc_p2p_avalanche_quorum.py).
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const KeyRing = require('../lib/primitives/keyring');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {Hello} = require('../lib/avalanche/protocol');
const {makePeerData} = require('../lib/avalanche/peerdata');
const {FakeChain, MIN_VALID_PROOF_SCORE, buildRandomProof} =
  require('./util/avalanche');

let nextId = 0;

class FakePeer {
  constructor(outbound = true) {
    this.id = nextId++;
    this.outbound = outbound;
    this.localNonce = random.randomBytes(8);
    this.remoteNonce = random.randomBytes(8);
    this.remoteEntropy = null;
    this.sent = [];
  }

  hostname() {
    return `10.0.1.${this.id}:8333`;
  }

  send(packet) {
    this.sent.push(packet);
  }

  hellos() {
    return this.sent.filter(p => p.cmd === 'avahello')
      .map(p => Hello.fromRaw(p.data));
  }
}

describe('Avalanche local proof', function() {
  let chain, pm, processor, peerData, now;

  beforeEach(() => {
    now = 1700000000;
    chain = new FakeChain(100);
    chain.tip = {height: 100};
    const masterKey = secp256k1.privateKeyGenerate();
    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 50,
      masterKey);

    peerData = makePeerData({
      proof: proof.toHex(),
      masterKey: KeyRing.fromPrivate(masterKey).toSecret('regtest'),
      network: 'regtest'
    });

    pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain, confirmations: 1}),
      localProof: peerData.proof,
      now: () => now
    });

    processor = new Processor({
      peerManager: pm,
      isIBD: () => false,
      now: () => now,
      minQuorumStake: 0,
      minQuorumConnectedStakeRatio: 0.8,
      minAvaproofsNodeCount: 0,
      peerData
    });
  });

  const id = () => peerData.proof.id();

  it('should hold its proof until a node connects in, then send it', () => {
    const out = new FakePeer(true);
    processor.addPeer(out);
    assert.strictEqual(out.hellos().length, 0);

    const inbound = new FakePeer(false);
    processor.addPeer(inbound);
    assert(processor.canShareProof);

    for (const peer of [out, inbound]) {
      const hellos = peer.hellos();
      assert.strictEqual(hellos.length, 1);
      const [hello] = hellos;
      assert(hello.hasProof());
      assert.bufferEqual(hello.delegation.proofId(), id());

      // As the peer checks it: our nonce first.
      const [valid, reason, pubkey] = hello.verify(peer.localNonce,
        peer.remoteNonce, 1n, 1n);
      assert(valid, reason);
      assert.bufferEqual(pubkey,
        secp256k1.publicKeyCreate(processor.sessionKey, true));
    }
  });

  it('should send hellos without a proof at once', () => {
    processor.peerData = null;
    const peer = new FakePeer(true);
    processor.addPeer(peer);
    const [hello] = peer.hellos();
    assert(!hello.hasProof());
  });

  it('should serve its proof to a peer it said hello to', () => {
    const peer = new FakePeer(false);
    processor.addPeer(peer);
    const state = processor.peers.get(peer.id);
    assert(processor.alreadyHaveProof(id()));
    assert.strictEqual(processor.findProofForGetData(state, id()),
      peerData.proof);
  });

  it('should register it at a new tip, once it may share it', async () => {
    await processor.updatedBlockTip(null);
    assert(!pm.isBoundToPeer(id()));
    assert.deepStrictEqual(processor.getLocalProofState(),
      {verified: false, reason: null});

    processor.addPeer(new FakePeer(false));
    await processor.updatedBlockTip(null);
    assert(pm.isBoundToPeer(id()));
    assert.deepStrictEqual(processor.getLocalProofState(),
      {verified: true, reason: null});

    // Again: already registered, still verified.
    await processor.updatedBlockTip(null);
    assert.deepStrictEqual(processor.getLocalProofState(),
      {verified: true, reason: null});
  });

  it('should share it with no node, and never drop it as dangling',
    async () => {
      processor.addPeer(new FakePeer(false));
      await processor.updatedBlockTip(null);

      assert(pm.getShareableProofs().some(p => p.id().equals(id())));

      now += 3600 * 24;
      await pm.cleanupDanglingProofs();
      assert(pm.isBoundToPeer(id()));
    });

  it('should count its stake as connected for a quorum', async () => {
    processor.addPeer(new FakePeer(false));
    await processor.updatedBlockTip(null);

    // Eight nodes for another staker, with less stake than ours.
    const other = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 50);
    assert((await pm.registerProof(other))[0]);
    for (let i = 0; i < 8; i++)
      assert(pm.addNode(5000 + i, other.id(), 1024));

    // Half the stake has nodes; with ours, all of it.
    assert.strictEqual(pm.getConnectedPeersScore() * 2,
      pm.getTotalPeersScore());
    assert(processor.isQuorumEstablished());
  });
});
