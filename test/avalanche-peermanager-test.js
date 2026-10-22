/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's src/avalanche/test/peermanager_tests.cpp,
 * against a fake chain. Not ported: staking rewards and stake contenders
 * (not in bcash yet), avapeers_dump (no peer persistence), the local proof
 * (bcash has no local proof yet), and score_ordering (bcash keeps no peer
 * index by score).
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../lib/protocol/consensus');
const Proof = require('../lib/avalanche/proof');
const ProofPool = require('../lib/avalanche/proofpool');
const PeerManager = require('../lib/avalanche/peermanager');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {Response} = require('../lib/avalanche/protocol');
const {
  FakeChain,
  MIN_VALID_PROOF_SCORE,
  buildProof,
  buildRandomProof,
  randomOutpoint
} = require('./util/avalanche');

const {NO_PEER, NO_NODE, DANGLING_TIMEOUT} = PeerManager;
const {FORCE_ACCEPT} = PeerManager.registrationMode;
const {DEFAULT, INVALIDATE} = PeerManager.rejectionMode;
const {selectPeerImpl} = PeerManager;
const {compareIds} = Proof;

const DUST = Proof.PROOF_DUST_THRESHOLD;
const MAX_ELEMENTS = 1024;

// The highest score a proof can have: MAX_MONEY staked.
const MAX_SCORE = Proof.amountToScore(consensus.MAX_MONEY);

/*
 * Helpers
 */

// ABC's fixture: a chain at height 100, stakes mature after 1 block.
function setup(options = {}) {
  const chain = new FakeChain(100);
  const clock = {time: 1700000000, ms: 1700000000000};

  const verifier = new ChainStakeVerifier({
    chain,
    dustThreshold: DUST,
    confirmations: options.confirmations || 1
  });

  const pm = new PeerManager({
    verifier,
    conflictingProofCooldown: options.cooldown,
    now: () => clock.time,
    ms: () => clock.ms
  });

  return {chain, clock, pm};
}

// ABC's NoCoolDownFixture.
const noCooldown = (options = {}) => setup({...options, cooldown: 0});

function peerIdOf(pm, proof) {
  const peer = pm.getPeerByProof(proof.id());
  return peer ? peer.peerId : NO_PEER;
}

async function registerAndGetPeerId(pm, proof) {
  await pm.registerProof(proof);
  return peerIdOf(pm, proof);
}

function nodeBelongsToPeer(pm, nodeId, peerId) {
  const node = pm.getNode(nodeId);
  return node != null && node.peerId === peerId;
}

function isNodePending(pm, nodeId) {
  return pm.pendingNodes.has(nodeId);
}

function buildProofWithSequence(key, outpoints, sequence) {
  return buildProof({key, outpoints, amount: DUST, sequence, height: 100});
}

// ABC's uint256(i).
function idOf(i) {
  const id = Buffer.alloc(32);
  id[0] = i;
  return id;
}

function getRemoteProof(pm, proofId, nodeId) {
  const remotes = pm.remoteProofs.get(proofId.toString('hex'));
  return remotes ? remotes.get(nodeId) || null : null;
}

const randomInt = max => Math.floor(Math.random() * max);

describe('Avalanche PeerManager', function() {
  it('should check proofs of waiting nodes first', async () => {
    const {chain, pm} = setup();
    const proofs = [];
    for (let i = 0; i < 3; i++)
      proofs.push(buildRandomProof(chain, MIN_VALID_PROOF_SCORE));

    // A verifier that checks a proof when told to.
    const order = [];
    const held = new Map();
    const verify = pm.verifier.verify.bind(pm.verifier);
    pm.verifier.verify = (proof) => {
      order.push(proof.id().toString('hex'));
      return new Promise((resolve) => {
        held.set(proof.id().toString('hex'), () => resolve(verify(proof)));
      });
    };
    const release = async (proof) => {
      while (!held.has(proof.id().toString('hex')))
        await new Promise(r => setImmediate(r));
      held.get(proof.id().toString('hex'))();
    };

    const [a, b, c] = proofs;
    const done = proofs.map(p => pm.registerProof(p));

    // A node waits on c: c is checked before b.
    assert(!pm.addNode(7, c.id(), MAX_ELEMENTS));
    await release(a);
    await release(c);
    await release(b);
    await Promise.all(done);

    assert.deepStrictEqual(order,
      [a, c, b].map(p => p.id().toString('hex')));
    assert(pm.getNode(7));
    assert(!pm.verifyingProof);
  });

  this.timeout(60000);

  describe('Peer selection', function() {
    const slot = (start, score, peerId) => ({start, score, peerId});

    it('should select a peer by linear search', () => {
      assert.strictEqual(selectPeerImpl([], 0, 0), NO_PEER);
      assert.strictEqual(selectPeerImpl([], 1, 3), NO_PEER);

      const one = [slot(100, 100, 23)];

      for (const s of [0, 42, 99])
        assert.strictEqual(selectPeerImpl(one, s, 300), NO_PEER);
      for (const s of [100, 142, 199])
        assert.strictEqual(selectPeerImpl(one, s, 300), 23);
      for (const s of [200, 242, 299])
        assert.strictEqual(selectPeerImpl(one, s, 300), NO_PEER);

      const two = [slot(100, 100, 69), slot(300, 100, 42)];

      for (const s of [0, 42, 99])
        assert.strictEqual(selectPeerImpl(two, s, 500), NO_PEER);
      for (const s of [100, 142, 199])
        assert.strictEqual(selectPeerImpl(two, s, 500), 69);
      for (const s of [200, 242, 299])
        assert.strictEqual(selectPeerImpl(two, s, 500), NO_PEER);
      for (const s of [300, 342, 399])
        assert.strictEqual(selectPeerImpl(two, s, 500), 42);
      for (const s of [400, 442, 499])
        assert.strictEqual(selectPeerImpl(two, s, 500), NO_PEER);
    });

    it('should select a peer by dichotomic search', () => {
      // 100 peers of size 1, 1 apart.
      const slots = [];
      let max = 1;
      for (let i = 0; i < 100; i++) {
        slots.push(slot(max, 1, i));
        max += 2;
      }

      assert.strictEqual(selectPeerImpl(slots, 4, max), NO_PEER);

      for (let i = 0; i < 100; i++) {
        assert.strictEqual(selectPeerImpl(slots, 2 * i, max), NO_PEER);
        assert.strictEqual(selectPeerImpl(slots, 2 * i + 1, max), i);
      }

      assert.strictEqual(selectPeerImpl(slots, max, max), NO_PEER);

      // Skewed toward the last.
      slots[99] = {...slots[99], score: 101};
      max = slots[99].start + slots[99].score;
      assert.strictEqual(max, 300);

      for (let i = 0; i < 100; i++) {
        assert.strictEqual(selectPeerImpl(slots, 2 * i, max), NO_PEER);
        assert.strictEqual(selectPeerImpl(slots, 2 * i + 1, max), i);
      }

      for (const s of [200, 256, 299])
        assert.strictEqual(selectPeerImpl(slots, s, max), 99);
      assert.strictEqual(selectPeerImpl(slots, 300, max), NO_PEER);

      // Skewed toward the first.
      for (let i = 0; i < 100; i++)
        slots[i] = {...slots[i], start: slots[i].start + 100};

      const stop0 = slots[0].start + slots[0].score;
      slots[0] = slot(1, stop0 - 1, slots[0].peerId);
      slots[99] = {...slots[99], score: 1};
      max = slots[99].start + slots[99].score;
      assert.strictEqual(max, 300);

      assert.strictEqual(selectPeerImpl(slots, 0, max), NO_PEER);
      assert.strictEqual(selectPeerImpl(slots, 1, max), 0);
      assert.strictEqual(selectPeerImpl(slots, 42, max), 0);

      for (let i = 0; i < 100; i++) {
        assert.strictEqual(selectPeerImpl(slots, 100 + 2 * i + 1, max), i);
        assert.strictEqual(selectPeerImpl(slots, 100 + 2 * i + 2, max),
          NO_PEER);
      }
    });

    it('should select a peer at random', () => {
      for (let c = 0; c < 1000; c++) {
        const size = randomInt(1 << 10) + 1;
        const slots = [];

        let max = randomInt(8);
        for (let i = 0; i < size; i++) {
          const start = max;
          max += randomInt(8);
          const score = randomInt(8);
          max += score;
          slots.push(slot(start, score, i));
        }

        for (let k = 0; k < 100; k++) {
          const s = max > 0 ? randomInt(max) : 0;
          const i = selectPeerImpl(slots, s, max);
          // The peer id is the index here.
          assert(i === NO_PEER
            || (slots[i].start <= s && s < slots[i].start + slots[i].score));
        }
      }
    });
  });

  async function addNodeWithScore(chain, pm, nodeId, score) {
    const proof = buildRandomProof(chain, score);
    assert((await pm.registerProof(proof))[0]);
    assert(pm.addNode(nodeId, proof.id(), MAX_ELEMENTS));
  }

  it('should select nodes in proportion to stake', async () => {
    const {chain, pm} = setup();
    assert.strictEqual(pm.selectNode(), NO_NODE);

    const node0 = 42;
    const node1 = 69;
    const node2 = 37;

    // One peer: always it.
    await addNodeWithScore(chain, pm, node0, MIN_VALID_PROOF_SCORE);
    assert.strictEqual(pm.selectNode(), node0);

    // Two: 1 to 2.
    await addNodeWithScore(chain, pm, node1, 2 * MIN_VALID_PROOF_SCORE);

    let results = {[node0]: 0, [node1]: 0, [node2]: 0};
    for (let i = 0; i < 10000; i++) {
      const n = pm.selectNode();
      assert(n === node0 || n === node1);
      results[n]++;
    }

    assert(Math.abs(2 * results[node0] - results[node1]) < 500);

    // Three: 1 to 2 to 1.
    await addNodeWithScore(chain, pm, node2, MIN_VALID_PROOF_SCORE);

    results = {[node0]: 0, [node1]: 0, [node2]: 0};
    for (let i = 0; i < 10000; i++) {
      const n = pm.selectNode();
      assert(n === node0 || n === node1 || n === node2);
      results[n]++;
    }

    assert(Math.abs(results[node0] - results[node1] + results[node2]) < 500);
  });

  it('should remove peers', async () => {
    const {chain, pm} = setup();
    assert.strictEqual(pm.selectPeer(), NO_PEER);

    const peerIds = [];
    for (let i = 0; i < 4; i++) {
      const p = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      peerIds[i] = await registerAndGetPeerId(pm, p);
      assert(pm.addNode(randomInt(2 ** 32), p.id(), MAX_ELEMENTS));
    }

    assert.strictEqual(pm.slotCount, 40000);
    assert.strictEqual(pm.fragmentation, 0);

    for (let i = 0; i < 100; i++)
      assert(peerIds.slice(0, 4).includes(pm.selectPeer()));

    // A removed peer never shows up.
    assert(pm.removePeer(peerIds[2]));
    assert.strictEqual(pm.slotCount, 40000);
    assert.strictEqual(pm.fragmentation, 10000);

    assert.strictEqual(pm.compact(), 10000);
    assert(pm.verify());
    assert.strictEqual(pm.slotCount, 30000);
    assert.strictEqual(pm.fragmentation, 0);

    for (let i = 0; i < 100; i++) {
      const p = pm.selectPeer();
      assert(p === peerIds[0] || p === peerIds[1] || p === peerIds[3]);
    }

    for (let i = 0; i < 4; i++) {
      const p = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      peerIds[i + 4] = await registerAndGetPeerId(pm, p);
      assert(pm.addNode(randomInt(2 ** 32), p.id(), MAX_ELEMENTS));
    }

    assert.strictEqual(pm.slotCount, 70000);
    assert.strictEqual(pm.fragmentation, 0);

    assert(pm.removePeer(peerIds[0]));
    assert.strictEqual(pm.slotCount, 70000);
    assert.strictEqual(pm.fragmentation, 10000);

    // Removing the last slot does not fragment.
    assert(pm.removePeer(peerIds[7]));
    assert.strictEqual(pm.slotCount, 60000);
    assert.strictEqual(pm.fragmentation, 10000);

    assert.strictEqual(pm.compact(), 10000);
    assert(pm.verify());
    assert.strictEqual(pm.slotCount, 50000);
    assert.strictEqual(pm.fragmentation, 0);

    const left = [peerIds[1], peerIds[3], peerIds[4], peerIds[5], peerIds[6]];
    for (let i = 0; i < 100; i++)
      assert(left.includes(pm.selectPeer()));

    assert(!pm.removePeer(peerIds[0]));
    assert(!pm.removePeer(peerIds[2]));
    assert(!pm.removePeer(peerIds[7]));
    assert(!pm.removePeer(NO_PEER));
  });

  it('should compact slots', async () => {
    const {chain, pm} = setup();

    const peerIds = [];
    for (let i = 0; i < 4; i++) {
      const p = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      peerIds[i] = await registerAndGetPeerId(pm, p);
      assert(pm.addNode(randomInt(2 ** 32), p.id(), MAX_ELEMENTS));
    }

    for (const p of peerIds)
      pm.removePeer(p);

    assert.strictEqual(pm.slotCount, 30000);
    assert.strictEqual(pm.fragmentation, 30000);

    for (let i = 0; i < 100; i++)
      assert.strictEqual(pm.selectPeer(), NO_PEER);

    assert.strictEqual(pm.compact(), 30000);
    assert(pm.verify());
    assert.strictEqual(pm.slotCount, 0);
    assert.strictEqual(pm.fragmentation, 0);
  });

  it('should compact slots of different scores', async () => {
    const {chain, pm} = setup();

    const scores = [10000, 20000, 30000, 40000];
    const peerIds = [];
    for (let i = 0; i < 4; i++) {
      const p = buildRandomProof(chain, scores[i]);
      peerIds[i] = await registerAndGetPeerId(pm, p);
      assert(pm.addNode(randomInt(2 ** 32), p.id(), MAX_ELEMENTS));
    }

    assert.strictEqual(pm.slotCount, 100000);
    assert.strictEqual(pm.fragmentation, 0);

    // A dead slot in the middle.
    assert(pm.removePeer(peerIds[1]));
    assert.strictEqual(pm.slotCount, 100000);
    assert.strictEqual(pm.fragmentation, 20000);

    assert.strictEqual(pm.compact(), 20000);
    assert(pm.verify());
    assert.strictEqual(pm.slotCount, 80000);
    assert.strictEqual(pm.fragmentation, 0);

    // Every point selects a remaining peer, over its range.
    for (let s = 0; s < pm.slotCount; s++) {
      const p = selectPeerImpl(pm.slots, s, pm.slotCount);
      if (s < 10000)
        assert.strictEqual(p, peerIds[0]);
      else if (s < 40000)
        assert.strictEqual(p, peerIds[2]);
      else
        assert.strictEqual(p, peerIds[3]);
    }
  });

  it('should add, select and remove nodes', async () => {
    const {chain, clock, pm} = setup();

    // ABC uses 10000000 * MIN_VALID_PROOF_SCORE, which bcash cannot hold
    // exactly; MAX_SCORE keeps the low score peer below 1 in 200000.
    const proof = buildRandomProof(chain, MAX_SCORE);
    assert((await pm.registerProof(proof))[0]);
    assert.strictEqual(pm.selectNode(), NO_NODE);

    for (let i = 0; i < 4; i++)
      assert(pm.addNode(i, proof.id(), MAX_ELEMENTS));

    let round = 0n;
    const poll = (n) => {
      assert(pm.updateNextRequestTimeForPoll(n, clock.ms, round++));
    };

    for (let i = 0; i < 100; i++) {
      const n = pm.selectNode();
      assert(n >= 0 && n < 4);
      poll(n);
    }

    // A removed node does not show up.
    assert(pm.removeNode(2));

    for (let i = 0; i < 100; i++) {
      const n = pm.selectNode();
      assert(n === 0 || n === 1 || n === 3);
      poll(n);
    }

    // Nor does one polled until tomorrow.
    assert(pm.updateNextRequestTimeForPoll(1, clock.ms + 24 * 3600 * 1000,
      round++));

    for (let i = 0; i < 100; i++) {
      const n = pm.selectNode();
      assert(n === 0 || n === 3);
      poll(n);
    }

    // Move node 3 to a peer that is almost never picked.
    await addNodeWithScore(chain, pm, 3, MIN_VALID_PROOF_SCORE);

    let node3selected = 0;
    for (let i = 0; i < 100; i++) {
      const n = pm.selectNode();
      if (n === 3)
        assert(node3selected++ < 1);
      else
        assert.strictEqual(n, 0);
      poll(n);
    }

    // Responses to earlier rounds do not update the request time.
    for (let i = 0; i < 100; i++) {
      const n = pm.selectNode();
      const last = pm.getNode(n).lastRound;
      const old = BigInt(randomInt(Number(last)));
      assert(!pm.updateNextRequestTimeForResponse(n, new Response(old, 0)));
    }
  });

  it('should bind nodes to peers', async () => {
    const {chain, pm} = setup();

    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    const id = proof.id();

    assert.strictEqual(pm.getNodeCount(), 0);
    assert.strictEqual(pm.getPendingNodeCount(), 0);

    // Nodes with no peer wait.
    for (let i = 0; i < 10; i++) {
      assert(!pm.addNode(i, id, MAX_ELEMENTS));
      assert(isNodePending(pm, i));
      assert.strictEqual(pm.getNodeCount(), 0);
      assert.strictEqual(pm.getPendingNodeCount(), i + 1);
    }

    // The peer binds them all.
    const peerId = await registerAndGetPeerId(pm, proof);
    assert.notStrictEqual(peerId, NO_PEER);
    for (let i = 0; i < 10; i++) {
      assert(!isNodePending(pm, i));
      assert(nodeBelongsToPeer(pm, i, peerId));
    }
    assert.strictEqual(pm.getNodeCount(), 10);
    assert.strictEqual(pm.getPendingNodeCount(), 0);
    assert(pm.verify());

    for (let i = 0; i < 5; i++) {
      assert(pm.removeNode(i));
      assert(!isNodePending(pm, i));
      assert(!nodeBelongsToPeer(pm, i, peerId));
      assert.strictEqual(pm.getNodeCount(), 10 - i - 1);
      assert.strictEqual(pm.getPendingNodeCount(), 0);
    }

    // To a peer that exists.
    for (let i = 0; i < 5; i++) {
      assert(pm.addNode(i, id, MAX_ELEMENTS));
      assert(!isNodePending(pm, i));
      assert(nodeBelongsToPeer(pm, i, peerId));
      assert.strictEqual(pm.getNodeCount(), 5 + i + 1);
      assert.strictEqual(pm.getPendingNodeCount(), 0);
    }

    // From a known proof to an unknown one.
    const alt = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    for (let i = 0; i < 5; i++) {
      assert(!pm.addNode(i, alt.id(), MAX_ELEMENTS));
      assert(isNodePending(pm, i));
      assert(!nodeBelongsToPeer(pm, i, peerId));
      assert.strictEqual(pm.getNodeCount(), 10 - i - 1);
      assert.strictEqual(pm.getPendingNodeCount(), i + 1);
    }

    // From an unknown proof to another.
    const alt2 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    for (let i = 0; i < 5; i++) {
      assert(!pm.addNode(i, alt2.id(), MAX_ELEMENTS));
      assert(isNodePending(pm, i));
      assert.strictEqual(pm.getNodeCount(), 5);
      assert.strictEqual(pm.getPendingNodeCount(), 5);
    }

    // From an unknown proof to a known one.
    for (let i = 0; i < 5; i++) {
      assert(pm.addNode(i, id, MAX_ELEMENTS));
      assert(!isNodePending(pm, i));
      assert(nodeBelongsToPeer(pm, i, peerId));
      assert.strictEqual(pm.getNodeCount(), 5 + i + 1);
      assert.strictEqual(pm.getPendingNodeCount(), 5 - i - 1);
    }

    // Removing the peer makes its nodes wait again.
    assert(pm.removePeer(peerId));
    assert(!pm.exists(id));
    for (let i = 0; i < 10; i++) {
      assert(isNodePending(pm, i));
      assert(!nodeBelongsToPeer(pm, i, peerId));
    }
    assert.strictEqual(pm.getNodeCount(), 0);
    assert.strictEqual(pm.getPendingNodeCount(), 10);
    assert(pm.verify());

    for (let i = 0; i < 10; i++) {
      assert(pm.removeNode(i));
      assert(!isNodePending(pm, i));
      assert.strictEqual(pm.getNodeCount(), 0);
      assert.strictEqual(pm.getPendingNodeCount(), 10 - i - 1);
    }
  });

  it('should rebind nodes when a reorg makes a proof immature', async () => {
    const {chain, pm} = setup({confirmations: 2});

    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE, 99);
    const id = proof.id();

    let peerId = await registerAndGetPeerId(pm, proof);
    assert.notStrictEqual(peerId, NO_PEER);
    assert(pm.verify());

    for (let i = 0; i < 10; i++) {
      assert(pm.addNode(i, id, MAX_ELEMENTS));
      assert(!isNodePending(pm, i));
      assert(nodeBelongsToPeer(pm, i, peerId));
    }

    // Reorg to a shorter chain.
    chain.height = 99;
    await pm.updatedBlockTip();

    assert(pm.isImmature(id));
    assert(!pm.isBoundToPeer(id));
    for (let i = 0; i < 10; i++) {
      assert(isNodePending(pm, i));
      assert(!nodeBelongsToPeer(pm, i, peerId));
    }
    assert(pm.verify());

    // Mature again.
    chain.height = 100;
    await pm.updatedBlockTip();

    assert(!pm.isImmature(id));
    assert(pm.isBoundToPeer(id));

    // A new peer id.
    peerId = peerIdOf(pm, proof);
    assert.notStrictEqual(peerId, NO_PEER);
    for (let i = 0; i < 10; i++) {
      assert(!isNodePending(pm, i));
      assert(nodeBelongsToPeer(pm, i, peerId));
    }
    assert(pm.verify());
  });

  it('should reject proofs that conflict', async () => {
    const {chain, pm} = setup();
    const key = secp256k1.privateKeyGenerate();
    const master = secp256k1.privateKeyGenerate();

    const txid1 = randomOutpoint().hash;
    const txid2 = randomOutpoint().hash;
    const outpoint = (hash, index) => {
      const o = randomOutpoint();
      o.hash = hash;
      o.index = index;
      return o;
    };

    for (let i = 0; i < 10; i++) {
      chain.addCoin(outpoint(txid1, i), key);
      chain.addCoin(outpoint(txid2, i), key);
    }

    const build = outpoints => buildProof({
      key,
      master,
      outpoints,
      amount: DUST,
      height: 100
    });

    const getPeerId = outpoints => registerAndGetPeerId(pm, build(outpoints));

    const peer1 = await getPeerId([outpoint(txid1, 0)]);
    assert.notStrictEqual(peer1, NO_PEER);

    // The same proof, the same peer.
    assert.strictEqual(await getPeerId([outpoint(txid1, 0)]), peer1);

    const peer2 = await getPeerId([outpoint(txid2, 0)]);
    assert(peer2 !== NO_PEER && peer2 !== peer1);

    const peer3 = await getPeerId([outpoint(txid1, 1)]);
    assert(peer3 !== NO_PEER && peer3 !== peer1);

    // No stake, no peer.
    assert.strictEqual(await getPeerId([]), NO_PEER);

    const peer4 = await getPeerId([outpoint(txid1, 2), outpoint(txid2, 2)]);
    assert(peer4 !== NO_PEER && peer4 !== peer1);

    // A duplicated stake.
    {
      const proofMaster = secp256k1.privateKeyGenerate();
      const dup = buildProof({key, master: proofMaster,
        outpoints: [outpoint(txid1, 3)], amount: DUST, height: 100});
      dup.stakes = [dup.stakes[0], dup.stakes[0]];
      dup._limitedId = null;
      dup._id = null;
      dup.signature = secp256k1.schnorrSign(dup.limitedId(), proofMaster);
      assert.deepStrictEqual(await pm.registerProof(dup),
        [false, 'invalid-proof', 'duplicated-stake']);
    }

    // Collisions on the first, the second, and both inputs.
    assert.strictEqual(
      await getPeerId([outpoint(txid1, 0), outpoint(txid2, 4)]), NO_PEER);
    assert.strictEqual(
      await getPeerId([outpoint(txid1, 4), outpoint(txid2, 0)]), NO_PEER);
    assert.strictEqual(
      await getPeerId([outpoint(txid1, 0), outpoint(txid2, 2)]), NO_PEER);
  });

  it('should hold immature proofs', async () => {
    const {chain, pm} = setup({confirmations: 2});
    const key = secp256k1.privateKeyGenerate();
    const immatureHeight = 100;

    const registerImmature = async (proof) => {
      assert.deepStrictEqual(await pm.registerProof(proof),
        [false, 'immature-proof']);
    };

    const checkImmature = (proof, expected) => {
      const id = proof.id();
      assert(pm.exists(id));
      assert.strictEqual(pm.isImmature(id), expected);
      assert.strictEqual(pm.isBoundToPeer(id), !expected);
      const bound = [...pm.peers.values()].some(p => p.proof.id().equals(id));
      assert.strictEqual(bound, !expected);
    };

    const build = (outpoint, amount, sequence) => buildProof({
      key,
      outpoints: [outpoint],
      amount,
      sequence,
      height: immatureHeight
    });

    let immature = [];

    // Fill the pool.
    for (let i = 1; i <= PeerManager.MAX_IMMATURE_PROOFS; i++) {
      const outpoint = randomOutpoint();
      const proof = build(outpoint, i * DUST, 0);
      chain.addCoin(outpoint, key, i * DUST, immatureHeight);
      await registerImmature(proof);
      checkImmature(proof, true);
      immature.push(proof);
    }

    // More evict the lowest score.
    for (let i = 0; i < 100; i++) {
      const outpoint = randomOutpoint();
      const proof = build(outpoint, 200 * DUST, 0);
      chain.addCoin(outpoint, key, 200 * DUST, immatureHeight);
      await registerImmature(proof);
      checkImmature(proof, true);
      immature.push(proof);
      assert(!pm.exists(immature[0].id()));
      immature = immature.slice(1);
    }

    // Replacement still works with the pool full.
    {
      const outpoint = immature[0].stakes[0].stake.outpoint;
      const proof = build(outpoint, 101 * DUST, 1);
      await registerImmature(proof);
      checkImmature(proof, true);
      immature.push(proof);
      assert(!pm.exists(immature[0].id()));
      immature = immature.slice(1);
    }

    // A block matures them all.
    chain.height += 1;
    await pm.updatedBlockTip();
    for (const proof of immature)
      checkImmature(proof, false);
  });

  it('should keep nodes polled until later when their peer goes', async () => {
    const {chain, clock, pm} = setup();

    let proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    let peerId = await registerAndGetPeerId(pm, proof);
    assert.notStrictEqual(peerId, NO_PEER);

    const future = clock.ms + 24 * 3600 * 1000;

    for (let i = 0; i < 10; i++) {
      assert(pm.addNode(i, proof.id(), MAX_ELEMENTS));
      assert(pm.updateNextRequestTimeForPoll(i, future, BigInt(i)));
    }

    assert(pm.removePeer(peerId));

    // The nodes are still there.
    for (let i = 0; i < 10; i++)
      assert(pm.getNode(i));

    proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    peerId = await registerAndGetPeerId(pm, proof);
    assert.notStrictEqual(peerId, NO_PEER);

    // Their poll timeouts carry over.
    for (let i = 0; i < 10; i++) {
      assert(pm.addNode(i, proof.id(), MAX_ELEMENTS));
      assert.strictEqual(pm.getNode(i).nextRequestTime, future);
    }

    assert(pm.removePeer(peerId));

    for (let i = 0; i < 10; i++)
      assert(pm.removeNode(i));
  });

  it('should get registered proofs', async () => {
    const {chain, pm} = setup();

    const proofs = [];
    for (let i = 0; i < 10; i++)
      proofs.push(buildRandomProof(chain, MIN_VALID_PROOF_SCORE));

    for (let i = 0; i < 10; i++) {
      assert((await pm.registerProof(proofs[i]))[0]);
      assert.deepStrictEqual(await pm.registerProof(proofs[i]),
        [false, 'proof-already-registered']);

      for (let added = 0; added <= i; added++) {
        const proof = pm.getProof(proofs[added].id());
        assert(proof);
        assert.bufferEqual(proof.id(), proofs[added].id());
      }
    }

    // No stake: from proof_tests.cpp.
    const bad = Proof.fromHex(''
      + '96527eae083f1f24625f049d9e54bb9a21023beefdde700a6bc02036335b4df141c8b'
      + 'c67bb05a971f5ac2745fd683797dde3002321023beefdde700a6bc02036335b4df141'
      + 'c8bc67bb05a971f5ac2745fd683797dde3ac135da984db510334abe41134e3d4ef09a'
      + 'd006b1152be8bc413182bf6f947eac1f8580fe265a382195aa2d73935cabf86d90a8f'
      + '666d0a62385ae24732eca51575');

    assert.deepStrictEqual(await pm.registerProof(bad),
      [false, 'invalid-proof', 'no-stake']);
  });

  it('should pull back a conflicting proof when its rival is spent',
    async () => {
      const {chain, pm} = noCooldown();
      const key = secp256k1.privateKeyGenerate();

      const conflicting = chain.createUtxo(key);
      const toSend = chain.createUtxo(key);

      const toInvalidate = buildProofWithSequence(key,
        [conflicting, toSend], 20);
      assert((await pm.registerProof(toInvalidate))[0]);

      const proof = buildProofWithSequence(key, [conflicting], 10);
      assert.deepStrictEqual(await pm.registerProof(proof),
        [false, 'conflicting-utxos']);
      assert(pm.isInConflictingPool(proof.id()));

      chain.spendCoin(toSend);
      await pm.updatedBlockTip();

      assert(!pm.exists(toInvalidate.id()));
      assert(!pm.isInConflictingPool(proof.id()));
      assert(pm.isBoundToPeer(proof.id()));
    });

  it('should select the preferred conflicting proof', async () => {
    const {chain, clock} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const conflicting = chain.createUtxo(key, DUST);
    const {compareConflicting} = ProofPool;

    const base = buildProofWithSequence(key, [conflicting], 10);

    const checkPreferred = async (candidate, reference, accepted) => {
      assert.strictEqual(compareConflicting(candidate, reference) < 0,
        accepted);
      assert.strictEqual(compareConflicting(reference, candidate) < 0,
        !accepted);

      const pm = new PeerManager({
        verifier: new ChainStakeVerifier({chain, dustThreshold: DUST,
          confirmations: 1}),
        conflictingProofCooldown: 0,
        now: () => clock.time,
        ms: () => clock.ms
      });

      assert((await pm.registerProof(reference))[0]);
      assert(pm.isBoundToPeer(reference.id()));

      const [ok, reason] = await pm.registerProof(candidate);
      assert.strictEqual(ok, accepted);
      assert.strictEqual(reason === 'conflicting-utxos', !accepted);

      assert.strictEqual(pm.isBoundToPeer(candidate.id()), accepted);
      assert.strictEqual(pm.isInConflictingPool(candidate.id()), !accepted);
      assert.strictEqual(pm.isBoundToPeer(reference.id()), !accepted);
      assert.strictEqual(pm.isInConflictingPool(reference.id()), accepted);
    };

    // Same master: the sequence decides.
    await checkPreferred(buildProofWithSequence(key, [conflicting], 9),
      base, false);
    await checkPreferred(buildProofWithSequence(key, [conflicting], 11),
      base, true);

    const fromAmounts = (master, amounts) => {
      const outpoints = [conflicting];
      for (const amount of amounts)
        outpoints.push(chain.createUtxo(key, amount));
      return buildProof({key, master, outpoints,
        amount: [DUST, ...amounts], sequence: 0, height: 100});
    };

    const multi = fromAmounts(key, [2 * DUST, 2 * DUST]);

    for (const k of [key, secp256k1.privateKeyGenerate()]) {
      // Low amount, then high.
      await checkPreferred(fromAmounts(k, [2 * DUST, DUST]), multi, false);
      await checkPreferred(fromAmounts(k, [2 * DUST, 3 * DUST]), multi, true);
      // Same amount, fewer stakes, then more.
      await checkPreferred(fromAmounts(k, [4 * DUST]), multi, true);
      await checkPreferred(fromAmounts(k, [2 * DUST, DUST, DUST]), multi,
        false);
      // Same amount and stakes: the proof id.
      const similar = fromAmounts(k, [2 * DUST, 2 * DUST]);
      await checkPreferred(similar, multi,
        compareIds(similar.id(), multi.id()) < 0);
    }
  });

  it('should prefer conflicting immature proofs too', async () => {
    const {chain, pm} = setup({confirmations: 2});
    const key = secp256k1.privateKeyGenerate();

    const conflicting = chain.createUtxo(key);
    const mature = chain.createUtxo(key, DUST, 99);

    const immature10 = buildProofWithSequence(key, [conflicting], 10);
    const immature20 = buildProof({key, outpoints: [conflicting, mature],
      amount: DUST, height: [100, 99], sequence: 20});

    assert(!(await pm.registerProof(immature10))[0]);
    assert(pm.isImmature(immature10.id()));

    assert(!(await pm.registerProof(immature20))[0]);
    assert(pm.isImmature(immature20.id()));
    assert(!pm.exists(immature10.id()));

    // A valid proof conflicting with the immature one.
    const proof30 = buildProof({key, outpoints: [mature], amount: DUST,
      height: 99, sequence: 30});
    assert((await pm.registerProof(proof30))[0]);
    assert(pm.isBoundToPeer(proof30.id()));

    // A reorg makes it immature, and the rescan prefers it.
    chain.height = 99;
    await pm.updatedBlockTip();

    assert(!pm.isBoundToPeer(proof30.id()));
    assert(pm.isImmature(proof30.id()));
    assert(!pm.exists(immature20.id()));
  });

  it('should keep the preferred conflicting proof', async () => {
    const {chain, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const conflicting = chain.createUtxo(key);

    const seq10 = buildProofWithSequence(key, [conflicting], 10);
    const seq20 = buildProofWithSequence(key, [conflicting], 20);
    const seq30 = buildProofWithSequence(key, [conflicting], 30);

    assert((await pm.registerProof(seq30))[0]);
    assert(pm.isBoundToPeer(seq30.id()));
    assert(!pm.isInConflictingPool(seq30.id()));

    // Worse than the peer: conflicting.
    assert(!(await pm.registerProof(seq10))[0]);
    assert(pm.isBoundToPeer(seq30.id()));
    assert(!pm.isBoundToPeer(seq10.id()));
    assert(pm.isInConflictingPool(seq10.id()));

    // Worse than the peer but better than seq10, which it evicts.
    assert(!(await pm.registerProof(seq20))[0]);
    assert(pm.isBoundToPeer(seq30.id()));
    assert(!pm.isBoundToPeer(seq20.id()));
    assert(pm.isInConflictingPool(seq20.id()));
    assert(!pm.exists(seq10.id()));
  });

  it('should update the next possible conflict time', async () => {
    const {chain, clock, pm} = noCooldown();
    const now = clock.time;

    for (let i = 0; i < 10; i++)
      assert(!pm.updateNextPossibleConflictTime(randomInt(1000), now));

    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    const peerId = await registerAndGetPeerId(pm, proof);

    const check = (expected) => {
      assert.strictEqual(pm.getPeerByProof(proof.id()).nextPossibleConflictTime,
        expected);
    };

    check(now);

    // Not into the past.
    assert(!pm.updateNextPossibleConflictTime(peerId, now - 1));
    check(now);

    assert(pm.updateNextPossibleConflictTime(peerId, now + 1));
    check(now + 1);
  });

  it('should force a proof to be accepted', async () => {
    const {chain, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const conflicting = chain.createUtxo(key);

    const seq10 = buildProofWithSequence(key, [conflicting], 10);
    const seq20 = buildProofWithSequence(key, [conflicting], 20);
    const seq30 = buildProofWithSequence(key, [conflicting], 30);

    assert((await pm.registerProof(seq30))[0]);
    assert(pm.isBoundToPeer(seq30.id()));
    assert(!pm.isInConflictingPool(seq30.id()));

    assert(!(await pm.registerProof(seq20))[0]);
    assert(pm.isBoundToPeer(seq30.id()));
    assert(pm.isInConflictingPool(seq20.id()));

    // From the conflicting pool...
    assert((await pm.registerProof(seq20, FORCE_ACCEPT))[0]);
    assert(pm.isBoundToPeer(seq20.id()));
    assert(pm.isInConflictingPool(seq30.id()));

    // ...or from nowhere.
    assert(!(await pm.registerProof(seq10))[0]);
    assert(!pm.exists(seq10.id()));

    assert((await pm.registerProof(seq10, FORCE_ACCEPT))[0]);
    assert(pm.isBoundToPeer(seq10.id()));
    assert(!pm.exists(seq20.id()));
    assert(pm.isInConflictingPool(seq30.id()));

    // Again changes nothing.
    for (let i = 0; i < 10; i++) {
      assert(!(await pm.registerProof(seq10))[0]);
      assert(!(await pm.registerProof(seq10, FORCE_ACCEPT))[0]);
      assert(pm.isBoundToPeer(seq10.id()));
      assert(!pm.exists(seq20.id()));
      assert(pm.isInConflictingPool(seq30.id()));
    }

    // Back and forth.
    for (let i = 0; i < 10; i++) {
      assert((await pm.registerProof(seq30, FORCE_ACCEPT))[0]);
      assert(pm.isBoundToPeer(seq30.id()));
      assert(pm.isInConflictingPool(seq10.id()));

      assert((await pm.registerProof(seq10, FORCE_ACCEPT))[0]);
      assert(pm.isBoundToPeer(seq10.id()));
      assert(pm.isInConflictingPool(seq30.id()));
    }
  });

  it('should reject a proof worse than the conflicting one', async () => {
    const {chain, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const conflicting = chain.createUtxo(key);

    const seq10 = buildProofWithSequence(key, [conflicting], 10);
    const seq20 = buildProofWithSequence(key, [conflicting], 20);
    const seq30 = buildProofWithSequence(key, [conflicting], 30);

    assert.deepStrictEqual(await pm.registerProof(seq30), [true, 'valid']);
    assert.deepStrictEqual(await pm.registerProof(seq20),
      [false, 'conflicting-utxos']);
    assert.deepStrictEqual(await pm.registerProof(seq10),
      [false, 'rejected-proof']);
  });

  it('should wait out the conflicting proof cooldown', async () => {
    const cooldown = 100;
    const {chain, clock, pm} = setup({cooldown});
    const key = secp256k1.privateKeyGenerate();
    const conflicting = chain.createUtxo(key);

    const seq20 = buildProofWithSequence(key, [conflicting], 20);
    const seq30 = buildProofWithSequence(key, [conflicting], 30);
    const seq40 = buildProofWithSequence(key, [conflicting], 40);

    assert((await pm.registerProof(seq30))[0]);
    assert(pm.isBoundToPeer(seq30.id()));

    const fails = async (proof, reason) => {
      assert.deepStrictEqual(await pm.registerProof(proof), [false, reason]);
    };

    await fails(seq20, 'cooldown-not-elapsed');
    assert(!pm.exists(seq20.id()));

    // Even for the favorite.
    await fails(seq40, 'cooldown-not-elapsed');
    assert(!pm.exists(seq40.id()));

    clock.time += cooldown;

    await fails(seq20, 'conflicting-utxos');
    assert(pm.isInConflictingPool(seq20.id()));

    // But no other.
    await fails(seq40, 'cooldown-not-elapsed');
    assert(!pm.exists(seq40.id()));
    assert(pm.isInConflictingPool(seq20.id()));

    clock.time += cooldown;

    // It replaces seq30, which evicts seq20 from the conflicting pool.
    assert((await pm.registerProof(seq40))[0]);
    assert(pm.isBoundToPeer(seq40.id()));
    assert(pm.isInConflictingPool(seq30.id()));
    assert(!pm.exists(seq20.id()));
  });

  // Checks shared by the rejection cases.
  function rejecter(pm) {
    return {
      async rejectDefault(id) {
        assert(pm.exists(id));
        const immature = pm.isImmature(id);
        assert(await pm.rejectProof(id, DEFAULT));
        assert(!pm.isBoundToPeer(id));
        assert.strictEqual(pm.exists(id), !immature);
      },
      async rejectInvalidate(id) {
        assert(pm.exists(id));
        assert(await pm.rejectProof(id, INVALIDATE));
      }
    };
  }

  it('should reject proofs', async () => {
    const {chain, pm} = noCooldown({confirmations: 2});
    const key = secp256k1.privateKeyGenerate();

    const conflicting = chain.createUtxo(key, DUST, 99);
    const immatureOutpoint = chain.createUtxo(key);

    const seq10 = buildProof({key, outpoints: [conflicting], amount: DUST,
      height: 99, sequence: 10});
    const seq20 = buildProof({key, outpoints: [conflicting], amount: DUST,
      height: 99, sequence: 20});
    const immature30 = buildProof({key,
      outpoints: [conflicting, immatureOutpoint], amount: DUST,
      height: [99, 100], sequence: 30});

    assert((await pm.registerProof(seq20))[0]);
    assert(!(await pm.registerProof(seq10))[0]);
    assert(!(await pm.registerProof(immature30))[0]);

    assert(pm.isBoundToPeer(seq20.id()));
    assert(pm.isInConflictingPool(seq10.id()));
    assert(pm.isImmature(immature30.id()));

    // Unknown proofs.
    for (let i = 0; i < 10; i++) {
      assert(!(await pm.rejectProof(randomOutpoint().hash, DEFAULT)));
      assert(!(await pm.rejectProof(randomOutpoint().hash, INVALIDATE)));
    }

    const {rejectDefault, rejectInvalidate} = rejecter(pm);

    // From the immature pool.
    await rejectDefault(immature30.id());
    assert(!(await pm.registerProof(immature30))[0]);
    assert(pm.isImmature(immature30.id()));
    await rejectInvalidate(immature30.id());

    // From the conflicting pool.
    await rejectDefault(seq10.id());
    await rejectInvalidate(seq10.id());

    assert(!(await pm.registerProof(seq10))[0]);
    assert(pm.isInConflictingPool(seq10.id()));

    // From the valid pool: the conflicting proof becomes a peer.
    await rejectDefault(seq20.id());
    assert(!pm.isInConflictingPool(seq10.id()));
    assert(pm.isBoundToPeer(seq10.id()));

    // Again, invalidating.
    await rejectInvalidate(seq10.id());
    assert(!pm.isInConflictingPool(seq20.id()));
    assert(pm.isBoundToPeer(seq20.id()));
  });

  it('should ask for more nodes when it needs them', async () => {
    const {chain, clock, pm} = setup();

    const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof))[0]);
    // Not dangling for a while yet.
    assert(!pm.isDangling(proof.id()));

    // No node to select.
    assert.strictEqual(pm.selectNode(), NO_NODE);
    assert(pm.shouldRequestMoreNodes());

    // Once.
    for (let i = 0; i < 10; i++)
      assert(!pm.shouldRequestMoreNodes());

    for (let i = 0; i < 10; i++)
      assert(pm.addNode(i, proof.id(), MAX_ELEMENTS));

    assert(!pm.isDangling(proof.id()));

    const cooldown = clock.ms + 10000;
    let round = 0n;

    // Each node once.
    for (let i = 0; i < 10; i++) {
      const n = pm.selectNode();
      assert.notStrictEqual(n, NO_NODE);
      assert(pm.updateNextRequestTimeForPoll(n, cooldown, round++));
      assert(!pm.shouldRequestMoreNodes());
    }

    // Then none.
    assert.strictEqual(pm.selectNode(), NO_NODE);
    assert(pm.shouldRequestMoreNodes());

    for (let i = 0; i < 10; i++)
      assert(!pm.shouldRequestMoreNodes());

    assert(pm.updateNextRequestTimeForPoll(0, clock.ms, round++));
    assert.notStrictEqual(pm.selectNode(), NO_NODE);
    assert(!pm.shouldRequestMoreNodes());

    // A proof with no node.
    const proof2 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof2))[0]);
    assert(!pm.isDangling(proof2.id()));
    await pm.cleanupDanglingProofs();
    assert(!pm.isDangling(proof2.id()));
    assert(!pm.shouldRequestMoreNodes());

    // After a while it dangles, and we want more nodes.
    clock.time += 15 * 60;
    await pm.cleanupDanglingProofs();
    assert(pm.isDangling(proof2.id()));
    assert(pm.shouldRequestMoreNodes());

    for (let i = 0; i < 10; i++) {
      assert(pm.isDangling(proof2.id()));
      assert(!pm.shouldRequestMoreNodes());
    }

    // Registering it again fails, and asks for nodes.
    assert.deepStrictEqual(await pm.registerProof(proof2),
      [false, 'dangling-proof']);
    assert(pm.isDangling(proof2.id()));
    assert(pm.shouldRequestMoreNodes());

    for (let i = 0; i < 10; i++) {
      assert(pm.isDangling(proof2.id()));
      assert(!pm.shouldRequestMoreNodes());
    }

    // With a node waiting for it, it registers.
    assert(!pm.addNode(11, proof2.id(), MAX_ELEMENTS));
    assert((await pm.registerProof(proof2))[0]);
    clock.time += 15 * 60;
    await pm.cleanupDanglingProofs();
    assert(!pm.isDangling(proof2.id()));
    assert(!pm.shouldRequestMoreNodes());

    // Without it, it dangles again.
    assert(pm.removeNode(11));
    await pm.cleanupDanglingProofs();
    assert(pm.isDangling(proof2.id()));
    assert(pm.shouldRequestMoreNodes());

    // Only invalidating removes it from the dangling pool.
    assert(!(await pm.rejectProof(proof2.id(), DEFAULT)));
    assert(pm.isDangling(proof2.id()));
    assert(await pm.rejectProof(proof2.id(), INVALIDATE));
    assert(!pm.isDangling(proof2.id()));
  });

  it('should track the known score', async () => {
    const {chain, pm} = noCooldown({confirmations: 2});
    const key = secp256k1.privateKeyGenerate();

    const amount1 = DUST;
    const amount2 = 2 * DUST;

    const conflicting = chain.createUtxo(key, amount1, 99);
    const secondary = chain.createUtxo(key, amount2, 99);

    const proof1 = buildProof({key, outpoints: [conflicting, secondary],
      amount: [amount1, amount2], height: 99, sequence: 10});
    const proof2 = buildProof({key, outpoints: [conflicting],
      amount: amount1, height: 99, sequence: 20});

    // Immature.
    const immatureOutpoint = chain.createUtxo(key, amount1);
    const proof3 = buildProof({key, outpoints: [conflicting, immatureOutpoint],
      amount: amount1, height: [99, 100], sequence: 30});

    const score1 = Proof.amountToScore(amount1 + amount2);
    const score2 = Proof.amountToScore(amount1);

    assert.strictEqual(pm.getTotalPeersScore(), 0);
    assert((await pm.registerProof(proof2))[0]);
    assert.strictEqual(pm.getTotalPeersScore(), score2);

    // Failing to add conflicting proofs keeps the score.
    assert(!(await pm.registerProof(proof1))[0]);
    assert(!(await pm.registerProof(proof3))[0]);

    assert(pm.isBoundToPeer(proof2.id()));
    assert(pm.isInConflictingPool(proof1.id()));
    assert(pm.isImmature(proof3.id()));

    assert.strictEqual(pm.getTotalPeersScore(), score2);

    const {rejectDefault, rejectInvalidate} = rejecter(pm);

    // Rejecting immature proofs keeps the score.
    await rejectDefault(proof3.id());
    assert(!(await pm.registerProof(proof3))[0]);
    assert(pm.isImmature(proof3.id()));
    assert.strictEqual(pm.getTotalPeersScore(), score2);
    await rejectInvalidate(proof3.id());
    assert.strictEqual(pm.getTotalPeersScore(), score2);

    // From the conflicting pool.
    await rejectDefault(proof1.id());
    await rejectInvalidate(proof1.id());

    assert(!(await pm.registerProof(proof1))[0]);
    assert(pm.isInConflictingPool(proof1.id()));
    assert.strictEqual(pm.getTotalPeersScore(), score2);

    // From the valid pool: the score follows the promoted proof.
    await rejectDefault(proof2.id());
    assert(!pm.isInConflictingPool(proof1.id()));
    assert(pm.isBoundToPeer(proof1.id()));
    assert.strictEqual(pm.getTotalPeersScore(), score1);

    await rejectInvalidate(proof1.id());
    assert(!pm.isInConflictingPool(proof2.id()));
    assert(pm.isBoundToPeer(proof2.id()));
    assert.strictEqual(pm.getTotalPeersScore(), score2);

    // Another peer.
    const peer2Score = MIN_VALID_PROOF_SCORE;
    const peer2Proof = buildRandomProof(chain, peer2Score, 99);
    const peerId2 = await registerAndGetPeerId(pm, peer2Proof);
    assert.strictEqual(pm.getTotalPeersScore(), score2 + peer2Score);

    assert(!pm.removePeer(1234));
    assert.strictEqual(pm.getTotalPeersScore(), score2 + peer2Score);

    assert(pm.removePeer(peerId2));
    assert.strictEqual(pm.getTotalPeersScore(), score2);
    assert(pm.removePeer(peerIdOf(pm, proof2)));
    assert.strictEqual(pm.getTotalPeersScore(), 0);
  });

  it('should track the connected score', async () => {
    const {chain, pm} = setup();

    const check = (known, connected) => {
      assert.strictEqual(pm.getTotalPeersScore(), known);
      assert.strictEqual(pm.getConnectedPeersScore(), connected);
    };

    check(0, 0);

    // ABC uses 10000000 * MIN_VALID_PROOF_SCORE, past MAX_MONEY.
    const score1 = MAX_SCORE;
    const proof1 = buildRandomProof(chain, score1);
    let peerId1 = await registerAndGetPeerId(pm, proof1);
    check(score1, 0);

    // However many nodes.
    for (let i = 0; i < 10; i++) {
      assert(pm.addNode(i, proof1.id(), MAX_ELEMENTS));
      check(score1, score1);
    }

    for (let i = 0; i < 9; i++) {
      assert(pm.removeNode(i));
      check(score1, score1);
    }

    // Until the last goes.
    assert(pm.removeNode(9));
    check(score1, 0);

    assert(pm.addNode(0, proof1.id(), MAX_ELEMENTS));
    assert(pm.addNode(1, proof1.id(), MAX_ELEMENTS));
    check(score1, score1);

    const score2 = MIN_VALID_PROOF_SCORE;
    const proof2 = buildRandomProof(chain, score2);
    let peerId2 = await registerAndGetPeerId(pm, proof2);
    check(score1 + score2, score1);
    assert(pm.addNode(2, proof2.id(), MAX_ELEMENTS));
    check(score1 + score2, score1 + score2);

    assert(pm.removeNode(0));
    check(score1 + score2, score1 + score2);
    assert(pm.removeNode(1));
    check(score1 + score2, score2);

    assert(pm.removePeer(peerId1));
    check(score2, score2);

    assert(pm.removeNode(2));
    check(score2, 0);

    assert(pm.removePeer(peerId2));
    check(0, 0);

    // Removing peers with their nodes still attached.
    peerId1 = await registerAndGetPeerId(pm, proof1);
    check(score1, 0);
    peerId2 = await registerAndGetPeerId(pm, proof2);
    check(score1 + score2, 0);
    assert(pm.addNode(0, proof1.id(), MAX_ELEMENTS));
    check(score1 + score2, score1);
    assert(pm.addNode(1, proof2.id(), MAX_ELEMENTS));
    check(score1 + score2, score1 + score2);

    assert(pm.removePeer(peerId2));
    check(score1, score1);

    assert(pm.removePeer(peerId1));
    check(0, 0);
  });

  // ABC checks its radix tree of shareable proofs, but registers proofs
  // without nodes there, so its tree stays empty. Here each proof gets a
  // node, so it is shareable.
  it('should share the proofs of peers with nodes', async () => {
    const {chain, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const sequence = 10;
    let nodeId = 0;

    const shared = () => pm.getShareableProofs().map(p => p.rid()).sort();
    const expected = new Map();
    const expect = () => [...expected.keys()].sort();

    const register = async (proof) => {
      const [ok] = await pm.registerProof(proof);
      if (ok)
        pm.addNode(nodeId++, proof.id(), MAX_ELEMENTS);
      return ok;
    };

    for (let i = 0; i < 10; i++) {
      const proof = buildProofWithSequence(key, [chain.createUtxo(key)],
        sequence);
      assert(await register(proof));
      expected.set(proof.rid(), proof);
    }

    assert.deepStrictEqual(shared(), expect());

    // A peer without a node is not shared.
    const lonely = buildProofWithSequence(key, [chain.createUtxo(key)],
      sequence);
    assert((await pm.registerProof(lonely))[0]);
    assert.deepStrictEqual(shared(), expect());

    const added = [];
    const toSpend = [];
    for (let i = 0; i < 10; i++) {
      const outpoint = chain.createUtxo(key);
      const proof = buildProofWithSequence(key, [outpoint], sequence);
      assert(await register(proof));
      added.push(proof);
      toSpend.push(outpoint);
      expected.set(proof.rid(), proof);
    }

    assert.deepStrictEqual(shared(), expect());

    // Spent coins drop their proofs.
    for (const outpoint of toSpend)
      chain.spendCoin(outpoint);

    await pm.updatedBlockTip();

    for (const proof of added)
      assert(expected.delete(proof.rid()));

    assert.deepStrictEqual(shared(), expect());

    const conflicting = [];
    const conflictingOutpoints = [];
    for (let i = 0; i < 10; i++) {
      const outpoint = chain.createUtxo(key);
      const proof = buildProofWithSequence(key, [outpoint], sequence);
      assert(await register(proof));
      conflicting.push(proof);
      conflictingOutpoints.push(outpoint);
      expected.set(proof.rid(), proof);
    }

    assert.deepStrictEqual(shared(), expect());

    // Worse conflicting proofs change nothing; better ones replace.
    for (let i = 0; i < 10; i += 2) {
      assert(!(await register(buildProofWithSequence(key,
        [conflictingOutpoints[i]], sequence - 1))));

      const replacement = buildProofWithSequence(key,
        [conflictingOutpoints[i + 1]], sequence + 1);
      assert(await register(replacement));
      assert(expected.delete(conflicting[i + 1].rid()));
      expected.set(replacement.rid(), replacement);
    }

    assert.deepStrictEqual(shared(), expect());
    assert(pm.verify());
  });

  it('should latch avaproofs sent', async () => {
    const {chain, pm} = setup();

    for (let nodeId = 0; nodeId < 10; nodeId++) {
      // No such node.
      assert(!pm.latchAvaproofsSent(nodeId));

      await addNodeWithScore(chain, pm, nodeId, MIN_VALID_PROOF_SCORE);
      assert(pm.latchAvaproofsSent(nodeId));

      // Already set.
      assert(!pm.latchAvaproofsSent(nodeId));
    }
  });

  it('should clean up dangling proofs', async () => {
    const {chain, clock, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();
    const count = 10;

    const proofs = [];
    const conflicting = [];

    for (let i = 0; i < count; i++) {
      const outpoint = chain.createUtxo(key);
      proofs[i] = buildProofWithSequence(key, [outpoint], 2);
      conflicting[i] = buildProofWithSequence(key, [outpoint], 1);

      assert((await pm.registerProof(proofs[i]))[0]);
      assert(pm.isBoundToPeer(proofs[i].id()));

      assert(!(await pm.registerProof(conflicting[i]))[0]);
      assert(pm.isInConflictingPool(conflicting[i].id()));

      // Odd ones get a node.
      if (i % 2)
        assert(pm.addNode(i, proofs[i].id(), MAX_ELEMENTS));

      assert.strictEqual(pm.getPeerByProof(proofs[i].id()).nodeCount, i % 2);

      clock.time += 1;
    }

    // None has timed out.
    await pm.cleanupDanglingProofs();
    for (let i = 0; i < count; i++) {
      assert(pm.isBoundToPeer(proofs[i].id()));
      assert(pm.isInConflictingPool(conflicting[i].id()));
    }

    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();
    for (let i = 0; i < count; i++) {
      const hasNode = i % 2 === 1;

      // Only the peers without a node go...
      assert.strictEqual(pm.isBoundToPeer(proofs[i].id()), hasNode);
      assert.strictEqual(pm.exists(proofs[i].id()), hasNode);

      // ...and their conflicting proofs come back.
      assert.strictEqual(pm.isInConflictingPool(conflicting[i].id()), hasNode);
      assert.strictEqual(pm.isBoundToPeer(conflicting[i].id()), !hasNode);
    }

    // A node for the first promoted proof.
    assert(pm.addNode(42, conflicting[0].id(), MAX_ELEMENTS));
    assert.strictEqual(pm.getPeerByProof(conflicting[0].id()).nodeCount, 1);

    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();
    for (let i = 0; i < count; i++) {
      const hasNode = i % 2 === 1;

      assert.strictEqual(pm.isBoundToPeer(proofs[i].id()), hasNode);
      assert.strictEqual(pm.exists(proofs[i].id()), hasNode);

      // The promoted proofs without a node go too, but the first.
      assert.strictEqual(pm.exists(conflicting[i].id()), hasNode || i === 0);
      assert.strictEqual(pm.isInConflictingPool(conflicting[i].id()), hasNode);
      assert.strictEqual(pm.isBoundToPeer(conflicting[i].id()), i === 0);
    }

    // Disconnect every node.
    for (let i = 1; i < count; i += 2) {
      assert(pm.removeNode(i));
      assert.strictEqual(pm.getPeerByProof(proofs[i].id()).nodeCount, 0);
    }
    assert(pm.removeNode(42));
    assert.strictEqual(pm.getPeerByProof(conflicting[0].id()).nodeCount, 0);

    await pm.cleanupDanglingProofs();
    for (let i = 0; i < count; i++) {
      const hadNode = i % 2 === 1;

      // Every first proof is gone...
      assert(!pm.exists(proofs[i].id()));

      // ...and the remaining conflicting ones are promoted.
      assert.strictEqual(pm.exists(conflicting[i].id()), hadNode);
      assert(!pm.isInConflictingPool(conflicting[i].id()));
      assert.strictEqual(pm.isBoundToPeer(conflicting[i].id()), hadNode);
    }

    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();

    for (let i = 0; i < count; i++) {
      assert(!pm.exists(proofs[i].id()));
      assert(!pm.exists(conflicting[i].id()));
    }
  });

  it('should not register a proof with a missing coin', async () => {
    const {pm} = setup();
    const proof = buildProof({amount: DUST, height: 100});
    assert.deepStrictEqual(await pm.registerProof(proof),
      [false, 'utxo-missing-or-spent']);
  });

  it('should drop expired proofs', async () => {
    const {chain, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();

    const tipTime = 1700000000;
    chain.mtp = tipTime - 1;

    const utxo = chain.createUtxo(key);
    const toExpire = buildProof({key, outpoints: [utxo], amount: DUST,
      height: 100, sequence: 2, expiration: tipTime + 1});
    const conflicting = buildProof({key, outpoints: [utxo], amount: DUST,
      height: 100, sequence: 1, expiration: tipTime + 2});

    assert((await pm.registerProof(toExpire))[0]);
    assert(pm.isBoundToPeer(toExpire.id()));

    // It expires later but has a lower sequence.
    assert(!(await pm.registerProof(conflicting))[0]);
    assert(pm.isInConflictingPool(conflicting.id()));

    // The tip's median time reaches the expiration.
    chain.mtp = Number(toExpire.expiration);
    await pm.updatedBlockTip();

    assert(!pm.exists(toExpire.id()));
    assert(pm.isBoundToPeer(conflicting.id()));
  });

  it('should save remote proofs', async () => {
    const {chain, clock, pm} = setup();
    const MAX = PeerManager.MAX_REMOTE_PROOFS;

    assert(pm.saveRemoteProof(idOf(0), 0, true));
    assert(pm.saveRemoteProof(idOf(1), 0, false));
    assert(pm.saveRemoteProof(idOf(0), 1, true));
    assert(pm.saveRemoteProof(idOf(1), 1, false));

    const check = (proofId, nodeId, present, lastUpdate) => {
      assert(pm.hasRemoteProofStatus(proofId));
      assert.strictEqual(pm.isRemotelyPresentProof(proofId), present);
      const remote = getRemoteProof(pm, proofId, nodeId);
      assert(remote);
      assert.strictEqual(remote.present, present);
      assert.strictEqual(remote.lastUpdate, lastUpdate);
    };

    check(idOf(0), 0, true, clock.time);
    check(idOf(1), 0, false, clock.time);
    check(idOf(0), 1, true, clock.time);
    check(idOf(1), 1, false, clock.time);

    clock.time += 1;

    // Reversed.
    assert(pm.saveRemoteProof(idOf(0), 0, false));
    assert(pm.saveRemoteProof(idOf(1), 0, true));
    assert(pm.saveRemoteProof(idOf(0), 1, false));
    assert(pm.saveRemoteProof(idOf(1), 1, true));

    check(idOf(0), 0, false, clock.time);
    check(idOf(1), 0, true, clock.time);
    check(idOf(0), 1, false, clock.time);
    check(idOf(1), 1, true, clock.time);

    // Real nodes.
    const proof0 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof0))[0]);
    assert(pm.addNode(0, proof0.id(), MAX_ELEMENTS));
    const proof1 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof1))[0]);
    assert(pm.addNode(1, proof1.id(), MAX_ELEMENTS));

    // Removing a node removes its remote proofs, and only its.
    assert(pm.removeNode(0));
    assert(!getRemoteProof(pm, idOf(0), 0));
    assert(!getRemoteProof(pm, idOf(1), 0));
    check(idOf(0), 1, false, clock.time);
    check(idOf(1), 1, true, clock.time);

    assert(pm.removeNode(1));
    for (const nodeId of [0, 1]) {
      assert(!getRemoteProof(pm, idOf(0), nodeId));
      assert(!getRemoteProof(pm, idOf(1), nodeId));
    }

    assert(pm.saveRemoteProof(idOf(0), 0, true));
    assert(pm.saveRemoteProof(idOf(1), 0, false));
    assert(pm.saveRemoteProof(idOf(0), 1, true));
    pm.clearRemoteProofs(0);
    assert(!getRemoteProof(pm, idOf(0), 0));
    assert(!getRemoteProof(pm, idOf(1), 0));
    check(idOf(0), 1, true, clock.time);

    for (let i = 0; i < MAX; i++) {
      clock.time += 1;
      assert(pm.saveRemoteProof(idOf(i), 0, true));
      check(idOf(i), 0, true, clock.time);
    }

    // The first is still there.
    check(idOf(0), 0, true, clock.time - (MAX - 1));

    // One more evicts it.
    clock.time += 1;
    assert(pm.saveRemoteProof(idOf(MAX), 0, true));
    check(idOf(MAX), 0, true, clock.time);
    assert(!getRemoteProof(pm, idOf(0), 0));
    assert(getRemoteProof(pm, idOf(1), 0));

    // With more proofs, the limit grows: 2 + MAX / 2 - 1 peers.
    const proofs = [];
    for (let i = 0; i < MAX / 2 - 1; i++) {
      const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      assert((await pm.registerProof(proof))[0]);
      proofs.push(proof);
    }
    assert.strictEqual(pm.peers.size, MAX / 2 + 1);

    clock.time += 1;
    assert(pm.saveRemoteProof(idOf(MAX + 1), 0, true));
    check(idOf(MAX + 1), 0, true, clock.time);
    assert(getRemoteProof(pm, idOf(1), 0));

    // And shrinks back.
    assert(await pm.rejectProof(proofs[0].id(), INVALIDATE));
    assert(await pm.rejectProof(proofs[1].id(), INVALIDATE));
    assert.strictEqual(pm.peers.size, MAX / 2 - 1);

    // The next update evicts down to the limit.
    assert(pm.saveRemoteProof(idOf(MAX + 2), 0, true));
    assert(!getRemoteProof(pm, idOf(1), 0));
    assert(!getRemoteProof(pm, idOf(2), 0));
    assert(getRemoteProof(pm, idOf(3), 0));
  });

  it('should weigh remote presence by stake', async () => {
    const {chain, pm} = setup();
    const id = idOf(0);

    assert.strictEqual(pm.getRemotePresenceStatus(id), null);

    // 6/12 of the stakes.
    for (let nodeId = 0; nodeId < 12; nodeId++) {
      const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      assert((await pm.registerProof(proof))[0]);
      assert(pm.addNode(nodeId, proof.id(), MAX_ELEMENTS));
      assert(pm.saveRemoteProof(id, nodeId, nodeId % 2 === 0));
    }

    assert.strictEqual(pm.getRemotePresenceStatus(id), null);

    const save = (present) => {
      for (let nodeId = 0; nodeId < 5; nodeId++)
        assert(pm.saveRemoteProof(id, nodeId, present));
      for (let nodeId = 5; nodeId < 12; nodeId++)
        assert(pm.saveRemoteProof(id, nodeId, !present));
    };

    // 7/12.
    save(false);
    assert.strictEqual(pm.getRemotePresenceStatus(id), true);

    // (ABC's local proof case is not ported.)

    // 5/12.
    save(true);
    assert.strictEqual(pm.getRemotePresenceStatus(id), false);

    // Most nodes agree, but not most of the stake.
    const big = buildRandomProof(chain, 100 * MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(big))[0]);
    assert(pm.addNode(0, big.id(), MAX_ELEMENTS));

    // 7/12 of the nodes, under 10% of the stake: absent.
    save(false);
    assert.strictEqual(pm.getRemotePresenceStatus(id), false);

    // 5/12 of the nodes, over 90% of the stake: present.
    save(true);
    assert.strictEqual(pm.getRemotePresenceStatus(id), true);

    // Clear the peers.
    for (const peerId of [...pm.peers.keys()])
      pm.removePeer(peerId);
    assert.strictEqual(pm.peers.size, 0);

    // Peer 1 has node 0; peer 2 has nodes 1 to 5.
    const proof1 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof1))[0]);
    assert(pm.addNode(0, proof1.id(), MAX_ELEMENTS));

    const proof2 = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof2))[0]);
    for (let nodeId = 1; nodeId < 6; nodeId++)
      assert(pm.addNode(nodeId, proof2.id(), MAX_ELEMENTS));

    assert(pm.saveRemoteProof(id, 0, false));
    for (let nodeId = 1; nodeId < 6; nodeId++)
      assert(pm.saveRemoteProof(id, nodeId, true));

    // 5/6 of the nodes, but 1/2 of the peers' stake.
    assert.strictEqual(pm.getRemotePresenceStatus(id), null);
  });

  it('should pull back dangling proofs the network has', async () => {
    const {chain, clock, pm} = setup();

    const proofs = [];
    for (let i = 0; i < 10; i++) {
      const proof = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      assert((await pm.registerProof(proof))[0]);
      proofs.push(proof);
    }

    // Recent enough.
    await pm.cleanupDanglingProofs();
    for (const proof of proofs) {
      assert(pm.isBoundToPeer(proof.id()));
      assert(!pm.isDangling(proof.id()));
    }

    clock.time += DANGLING_TIMEOUT + 1;

    await pm.cleanupDanglingProofs();
    for (const proof of proofs) {
      assert(!pm.isBoundToPeer(proof.id()));
      assert(pm.isDangling(proof.id()));
    }

    // Remotes that have them.
    for (let nodeId = 0; nodeId < 10; nodeId++) {
      const other = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      assert((await pm.registerProof(other))[0]);
      assert(pm.addNode(nodeId, other.id(), MAX_ELEMENTS));
      for (const proof of proofs)
        assert(pm.saveRemoteProof(proof.id(), nodeId, true));
    }

    for (const proof of proofs)
      assert.strictEqual(pm.getRemotePresenceStatus(proof.id()), true);

    const sameSet = (registered) => {
      assert.deepStrictEqual(registered.map(p => p.rid()).sort(),
        proofs.map(p => p.rid()).sort());
    };

    // They come back as peers.
    let registered = await pm.cleanupDanglingProofs();
    for (const proof of proofs) {
      assert(pm.isBoundToPeer(proof.id()));
      assert(!pm.isDangling(proof.id()));
    }
    sameSet(registered);

    // The remotes drop them.
    for (let nodeId = 0; nodeId < 10; nodeId++) {
      for (const proof of proofs)
        assert(pm.saveRemoteProof(proof.id(), nodeId, false));
    }

    for (const proof of proofs)
      assert.strictEqual(pm.getRemotePresenceStatus(proof.id()), false);

    // Registered too recently to dangle.
    registered = await pm.cleanupDanglingProofs();
    assert.strictEqual(registered.length, 0);
    for (const proof of proofs) {
      assert(pm.isBoundToPeer(proof.id()));
      assert(!pm.isDangling(proof.id()));
    }

    clock.time += DANGLING_TIMEOUT + 1;

    registered = await pm.cleanupDanglingProofs();
    assert.strictEqual(registered.length, 0);
    for (const proof of proofs) {
      assert(!pm.isBoundToPeer(proof.id()));
      assert(pm.isDangling(proof.id()));
    }

    // Once more.
    for (let nodeId = 0; nodeId < 10; nodeId++) {
      for (const proof of proofs)
        assert(pm.saveRemoteProof(proof.id(), nodeId, true));
    }

    registered = await pm.cleanupDanglingProofs();
    for (const proof of proofs) {
      assert(pm.isBoundToPeer(proof.id()));
      assert(!pm.isDangling(proof.id()));
    }
    sameSet(registered);
  });

  it('should invalidate dangling proofs', async () => {
    const {chain, clock, pm} = setup();
    const key = secp256k1.privateKeyGenerate();

    const utxo = chain.createUtxo(key);
    const proof = buildProof({key, outpoints: [utxo], amount: DUST,
      height: 100, sequence: 2, expiration: clock.time + 1000000});

    assert((await pm.registerProof(proof))[0]);
    assert(pm.isBoundToPeer(proof.id()));
    assert(!pm.isDangling(proof.id()));

    // No node: it dangles.
    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();
    assert(!pm.isBoundToPeer(proof.id()));
    assert(!pm.exists(proof.id()));
    assert(pm.isDangling(proof.id()));

    // Spent: it goes.
    chain.spendCoin(utxo);
    await pm.updatedBlockTip();
    assert(!pm.exists(proof.id()));
    assert(!pm.isDangling(proof.id()));

    // The coin back, it registers.
    chain.addCoin(utxo, key);
    assert((await pm.registerProof(proof))[0]);
    assert(pm.isBoundToPeer(proof.id()));
    assert(!pm.isDangling(proof.id()));

    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();
    assert(!pm.isBoundToPeer(proof.id()));
    assert(!pm.exists(proof.id()));
    assert(pm.isDangling(proof.id()));

    // Expired: it goes.
    chain.mtp = Number(proof.expiration);
    await pm.updatedBlockTip();
    assert(!pm.exists(proof.id()));
    assert(!pm.isDangling(proof.id()));
  });

  it('should evict a dangling proof for a preferred peer', async () => {
    const {chain, clock, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();

    const utxo = chain.createUtxo(key);
    const dangling = buildProofWithSequence(key, [utxo], 1);
    const preferred = buildProofWithSequence(key, [utxo], 2);

    assert((await pm.registerProof(dangling))[0]);
    assert(pm.isBoundToPeer(dangling.id()));

    clock.time += DANGLING_TIMEOUT;
    await pm.cleanupDanglingProofs();
    assert(!pm.isBoundToPeer(dangling.id()));
    assert(pm.isDangling(dangling.id()));

    // Dangling coins are not in the valid pool, so the preferred proof
    // registers, and evicts the dangling one.
    assert((await pm.registerProof(preferred))[0]);
    assert(pm.isBoundToPeer(preferred.id()));
    assert(!pm.isDangling(dangling.id()));
    assert(!pm.isDangling(preferred.id()));

    // Which can come back later.
    assert(await pm.rejectProof(preferred.id(), INVALIDATE));
    assert.deepStrictEqual(await pm.registerProof(dangling), [true, 'valid']);
    assert(pm.isBoundToPeer(dangling.id()));
  });

  it('should not park a proof that a pulled back one beats', async () => {
    const {chain, clock, pm} = noCooldown();
    const key = secp256k1.privateKeyGenerate();

    const utxo = chain.createUtxo(key);
    const lowSeq = buildProofWithSequence(key, [utxo], 1);
    const highSeq = buildProofWithSequence(key, [utxo], 2);

    assert((await pm.registerProof(lowSeq))[0]);
    assert(pm.isBoundToPeer(lowSeq.id()));

    // Park the better proof as dangling directly.
    const [added] = pm.danglingProofPool.addIfPreferred(highSeq);
    assert.strictEqual(added, ProofPool.status.SUCCEED);
    assert(pm.isDangling(highSeq.id()));

    // The network has the better one, not the other.
    for (let nodeId = 0; nodeId < 10; nodeId++) {
      const other = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
      assert((await pm.registerProof(other))[0]);
      assert(pm.addNode(nodeId, other.id(), MAX_ELEMENTS));
      assert(pm.saveRemoteProof(highSeq.id(), nodeId, true));
      assert(pm.saveRemoteProof(lowSeq.id(), nodeId, false));
    }

    assert.strictEqual(pm.getRemotePresenceStatus(highSeq.id()), true);
    assert.strictEqual(pm.getRemotePresenceStatus(lowSeq.id()), false);

    clock.time += DANGLING_TIMEOUT;

    const registered = await pm.cleanupDanglingProofs();

    // The better one is back; the other is gone, not parked.
    assert(pm.isBoundToPeer(highSeq.id()));
    assert(registered.includes(highSeq));
    assert(!pm.isBoundToPeer(lowSeq.id()));
    assert(!pm.isDangling(lowSeq.id()));
    assert(!pm.exists(lowSeq.id()));
  });

  it('should not hold the lock while a proof is checked', async () => {
    const {chain, pm} = setup();
    const registered = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    assert(await registerAndGetPeerId(pm, registered) !== NO_PEER);

    // A proof whose coins take a while to fetch, as on an SPV node.
    const slow = buildRandomProof(chain, MIN_VALID_PROOF_SCORE);
    const verify = pm.verifier.verify.bind(pm.verifier);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    pm.verifier.verify = async (proof) => {
      if (proof.id().equals(slow.id()))
        await gate;
      return verify(proof);
    };

    const pending = pm.registerProof(slow);

    // Tips and rejections go on meanwhile.
    await pm.updatedBlockTip();
    assert(await pm.rejectProof(registered.id(), INVALIDATE));

    release();
    const [ok] = await pending;
    assert(ok);
    assert(pm.isBoundToPeer(slow.id()));
  });
});

