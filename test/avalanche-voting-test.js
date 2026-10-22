/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A port of Bitcoin ABC's src/avalanche/test/processor_tests.cpp for the
 * vote items bcash polls: proofs, blocks and transactions (Bitcoin ABC's
 * TxProvider, against a fake mempool). Stake contenders are in
 * avalanche-stakecontenders-test.js. Bitcoin ABC has no other
 * transaction-only processor tests: what its mempool does with votes is
 * not the processor's.
 */

const assert = require('bsert');
const BN = require('bcrypto/lib/bn');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const InvItem = require('../lib/primitives/invitem');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const ProofPool = require('../lib/avalanche/proofpool');
const VoteRecord = require('../lib/avalanche/voterecord');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {Vote, Response, invTypes} = require('../lib/avalanche/protocol');
const {compareIds} = require('../lib/avalanche/proof');
const MTX = require('../lib/primitives/mtx');
const Outpoint = require('../lib/primitives/outpoint');
const Script = require('../lib/script/script');
const {
  pub,
  buildProof,
  randomOutpoint,
  FakeChain,
  MIN_VALID_PROOF_SCORE,
  buildRandomProof
} = require('./util/avalanche');

const {voteStatus, itemTypes} = Processor;
const {FINALIZATION_SCORE, MAX_INFLIGHT_POLL} = VoteRecord;
const {NO_NODE} = PeerManager;

const NEUTRAL = 0xffffffff;
const MAX_ELEMENT_POLL = 1024;

// FINALIZED_ITEMS in processor.js: Bitcoin ABC's filter size.
const FINALIZED_ITEMS = MAX_INFLIGHT_POLL * 20;

let nextNodeId = 0;

class FakePeer {
  constructor() {
    this.id = nextNodeId++;
    this.outbound = true;
    this.address = NetAddress.fromHostname(
      `10.${this.id >> 16 & 255}.${this.id >> 8 & 255}.${this.id & 255}:8333`,
      'main');
    this.localNonce = random.randomBytes(8);
    this.remoteNonce = random.randomBytes(8);
    this.remoteEntropy = 1n;
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
}

// The mempool the processor polls transactions from: what is in it is
// worth polling, as Bitcoin ABC's TestMemPoolEntryHelper entries are.
class FakeMempool {
  constructor() {
    this.txs = new Map();
    // Nothing kept aside as conflicting, nor finalized.
    this.conflicting = {getTX: () => null};
  }

  isAvalancheFinalized() {
    return false;
  }

  add(tx) {
    this.txs.set(tx.hash().toString('hex'), tx);
  }

  remove(tx) {
    this.txs.delete(tx.hash().toString('hex'));
  }

  getTX(hash) {
    return this.txs.get(hash.toString('hex')) || null;
  }

  hasEntry(hash) {
    return this.txs.has(hash.toString('hex'));
  }

  isWorthPolling(hash) {
    return this.hasEntry(hash);
  }
}

/**
 * Bitcoin ABC's AvalancheProcessorTestingSetup: a chain, a mempool, a
 * peer manager, and a processor that needs no stake for a quorum.
 */

class Setup {
  constructor(options = {}) {
    // Steady time: distinct each call, as a steady clock would be.
    this.time = 0;
    this.ms = () => (this.time += 0.001);
    this.now = 1000000;

    this.chain = new FakeChain(100);
    this.chain.initBlocks();

    this.mempool = new FakeMempool();

    this.pm = new PeerManager({
      verifier: new ChainStakeVerifier({
        chain: this.chain,
        confirmations: options.confirmations || 1
      }),
      conflictingProofCooldown: options.conflictingProofCooldown,
      now: () => this.now,
      ms: this.ms
    });

    this.processor = new Processor({
      peerManager: this.pm,
      chain: this.chain,
      isIBD: () => false,
      now: () => this.now,
      ms: this.ms,
      // As Bitcoin ABC's AvalancheTestChain100Setup.
      minQuorumStake: 0,
      minQuorumConnectedStakeRatio: options.minQuorumConnectedStakeRatio || 0,
      minQuorumUnanimousStakeRatio: options.minQuorumUnanimousStakeRatio,
      minAvaproofsNodeCount: 0,
      queryTimeout: options.queryTimeout,
      staleVoteThreshold: options.staleVoteThreshold,
      staleVoteFactor: options.staleVoteFactor,
      preConsensus: true,
      // An SPV node has none.
      mempool: options.noMempool ? null : this.mempool
    });
  }

  advance(ms) {
    this.time += ms;
  }

  // A proof whose coin the chain has, not registered.
  getProof() {
    return buildRandomProof(this.chain, MIN_VALID_PROOF_SCORE);
  }

  connectNode() {
    const peer = new FakePeer();
    this.processor.addPeer(peer);
    return peer;
  }

  // Bitcoin ABC's ConnectNodes: nodes for one registered proof.
  async connectNodes(count = 8) {
    const proof = this.getProof();
    const [ok] = await this.pm.registerProof(proof);
    assert(ok);

    const peers = [];
    for (let i = 0; i < count; i++) {
      const peer = this.connectNode();
      assert(this.pm.addNode(peer.id, proof.id(), MAX_ELEMENT_POLL));
      peers.push(peer);
    }

    return peers;
  }

  runEventLoop() {
    return this.processor.runEventLoop();
  }

  getSuitableNodeToQuery() {
    return this.pm.selectNode();
  }

  getInvsForNextPoll(forPoll = false, max = MAX_ELEMENT_POLL) {
    return this.processor.getInvsForNextPoll(max, forPoll);
  }

  getRound() {
    return this.processor.round;
  }

  registerVotes(nodeId, response) {
    return this.processor.registerVotes(nodeId, response);
  }
}

// Bitcoin ABC's next(): this response, and the next round's after it.
class Responder {
  constructor(round, votes, cooldown = 0) {
    this.round = round;
    this.votes = votes;
    this.cooldown = cooldown;
  }

  next() {
    const response = new Response(this.round, this.cooldown, this.votes);
    this.round += 1n;
    return response;
  }
}

function blockProvider(setup) {
  return {
    name: 'block',
    type: itemTypes.BLOCK,
    invType: invTypes.BLOCK,
    async build() {
      return setup.chain.mine();
    },
    id: entry => entry.hash,
    // Most work first.
    votes(error, items) {
      return items.slice()
        .sort((a, b) => b.chainwork.cmp(a.chainwork))
        .map(e => new Vote(error, e.hash));
    },
    async invalidate(entry) {
      setup.chain.invalid.add(entry.hash);
    }
  };
}

function proofProvider(setup) {
  return {
    name: 'proof',
    type: itemTypes.PROOF,
    invType: invTypes.AVA_PROOF,
    async build() {
      const proof = setup.getProof();
      const [ok] = await setup.pm.registerProof(proof);
      assert(ok);
      return proof;
    },
    id: proof => proof.id(),
    // Highest score first.
    votes(error, items) {
      return items.slice()
        .sort(ProofPool.compareByScore)
        .map(p => new Vote(error, p.id()));
    },
    async invalidate(proof) {
      await setup.pm.rejectProof(proof.id(),
        PeerManager.rejectionMode.INVALIDATE);
    }
  };
}

// Bitcoin ABC's TxProvider: a transaction in the mempool.
function txProvider(setup) {
  return {
    name: 'transaction',
    type: itemTypes.TX,
    invType: invTypes.TX,
    async build() {
      const mtx = new MTX();
      mtx.version = 2;
      mtx.addInput({prevout: new Outpoint(random.randomBytes(32), 0)});
      mtx.addOutput(Script.fromRaw(Buffer.from([0x51])), 100000000);
      const tx = mtx.toTX();
      setup.mempool.add(tx);
      assert(setup.mempool.hasEntry(tx.hash()));
      return tx;
    },
    id: tx => tx.hash(),
    // By txid, as uint256s.
    votes(error, items) {
      return items.slice()
        .sort((a, b) => compareIds(a.hash(), b.hash()))
        .map(tx => new Vote(error, tx.hash()));
    },
    async invalidate(tx) {
      setup.mempool.remove(tx);
      assert(!setup.mempool.hasEntry(tx.hash()));
    }
  };
}

// Bitcoin ABC's TestVoteRecord: accepted, at a confidence.
function testVoteRecord(confidence) {
  const record = new VoteRecord(true);
  record.confidence |= confidence << 1;
  return record;
}

function addVoteRecord(setup, provider, item, record) {
  const hash = provider.id(item);
  const key = `${provider.type}:${hash.toString('hex')}`;
  setup.processor.voteRecords.set(key,
    {type: provider.type, hash, item, record});
}

for (const makeProvider of [blockProvider, proofProvider, txProvider]) {
  describe(`Avalanche voting on a ${makeProvider({}).name}`, function() {
    this.timeout(120000);

    let setup, provider, processor, pm;

    beforeEach(() => {
      setup = new Setup();
      provider = makeProvider(setup);
      processor = setup.processor;
      pm = setup.pm;
    });

    const isPolled = item => processor.isPolled(provider.type,
      item && provider.id(item));
    const isAccepted = item => processor.isAccepted(provider.type,
      item && provider.id(item));
    const getConfidence = item => processor.getConfidence(provider.type,
      item && provider.id(item));
    const addToReconcile = item => processor.addToReconcile(provider.type,
      item);

    // A node votes on what the event loop just polled.
    function voter(nodes) {
      let index = 0;
      const voted = {updates: []};
      voted.vote = async (response) => {
        await setup.runEventLoop();
        const nodeId = nodes[index++ % nodes.length].id;
        const result = await setup.registerVotes(nodeId, response);
        assert(result.ok, `registerVotes failed: ${result.error}`);
        voted.updates = result.updates;
      };
      return voted;
    }

    it('should make updates of every status', async () => {
      const item = await provider.build();
      const statuses = Object.values(voteStatus);
      assert.strictEqual(new Set(statuses).size, 5);
      for (const status of statuses) {
        const update = {type: provider.type, hash: provider.id(item), item,
          status};
        assert.strictEqual(update.item, item);
        assert.strictEqual(update.status, status);
      }
    });

    it('should not reconcile an item twice', async () => {
      const chaintip = setup.chain.tip;
      const item = await provider.build();
      const itemId = provider.id(item);

      assert(await addToReconcile(item));
      assert(!await addToReconcile(item));
      assert(isPolled(item));
      assert(isAccepted(item));

      const nodes = await setup.connectNodes();
      const voted = voter(nodes);

      const finalize = async (id) => {
        const resp = new Responder(setup.getRound(), [new Vote(0, id)]);
        for (let i = 0; i < FINALIZATION_SCORE + 6; i++) {
          await voted.vote(resp.next());
          if (voted.updates.length > 0)
            break;
        }
        assert.strictEqual(voted.updates.length, 1);
        assert.strictEqual(voted.updates[0].status, voteStatus.FINALIZED);
        processor.setRecentlyFinalized(id);
      };

      await finalize(itemId);

      // Finalized items cannot be reconciled for a while.
      assert(!await addToReconcile(item));

      const finalizeNewItem = async () => {
        const another = await provider.build();
        addVoteRecord(setup, provider, another,
          testVoteRecord(FINALIZATION_SCORE - 1));
        await finalize(provider.id(another));
      };

      // Up to the filter's size, it still cannot.
      for (let i = 0; i < FINALIZED_ITEMS; i++) {
        await finalizeNewItem();
        assert(!await addToReconcile(item));
      }

      // Further, it rolls out of the filter.
      for (let i = 0; i < FINALIZED_ITEMS; i++)
        await finalizeNewItem();

      // Roll back the finalization point, so the old block is above it.
      processor.finalizationTip = chaintip;
      assert(await addToReconcile(item));
    });

    it('should handle a null item', async () => {
      assert(!isPolled(null));
      assert(!isAccepted(null));
      assert.strictEqual(getConfidence(null), -1);
      assert(!await addToReconcile(null));

      // Not even with vote records to compare against.
      assert(await addToReconcile(await provider.build()));
      assert(!isPolled(null));
      assert(!isAccepted(null));
      assert.strictEqual(getConfidence(null), -1);
    });

    it('should register votes on an item', async () => {
      let item = await provider.build();
      let itemId = provider.id(item);

      const nodes = await setup.connectNodes();

      assert(!isPolled(item));
      assert(!isAccepted(item));

      assert(await addToReconcile(item));
      let invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.strictEqual(invs[0].type, provider.invType);
      assert.bufferEqual(invs[0].hash, itemId);
      assert(isPolled(item));
      assert(isAccepted(item));

      const voted = voter(nodes);
      const check = (accepted, confidence, count = 0) => {
        assert.strictEqual(isAccepted(item), accepted);
        if (confidence != null)
          assert.strictEqual(getConfidence(item), confidence);
        assert.strictEqual(voted.updates.length, count);
      };

      let resp = new Responder(0n, [new Vote(0, itemId)]);
      for (let i = 0; i < 6; i++) {
        await voted.vote(resp.next());
        check(true, 0);
      }

      // A single neutral vote does not change anything.
      resp = new Responder(setup.getRound(), [new Vote(NEUTRAL, itemId)]);
      await voted.vote(resp.next());
      check(true, 0);

      resp = new Responder(setup.getRound(), [new Vote(0, itemId)]);
      for (let i = 1; i < 7; i++) {
        await voted.vote(resp.next());
        check(true, i);
      }

      // Two neutral votes stall progress.
      resp = new Responder(setup.getRound(), [new Vote(NEUTRAL, itemId)]);
      await voted.vote(resp.next());
      check(true, 6);
      await voted.vote(resp.next());
      check(true, 6);

      resp = new Responder(setup.getRound(), [new Vote(0, itemId)]);
      for (let i = 2; i < 8; i++) {
        await voted.vote(resp.next());
        check(true, 6);
      }

      for (let i = 7; i < FINALIZATION_SCORE; i++) {
        await voted.vote(resp.next());
        check(true, i);
      }

      // Polled until finalized.
      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);

      await voted.vote(resp.next());
      assert.strictEqual(voted.updates.length, 1);
      assert.strictEqual(voted.updates[0].item, item);
      assert.strictEqual(voted.updates[0].status, voteStatus.FINALIZED);

      assert.strictEqual(setup.getInvsForNextPoll().length, 0);

      // Now finalize a rejection.
      item = await provider.build();
      itemId = provider.id(item);
      assert(await addToReconcile(item));

      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);

      resp = new Responder(setup.getRound(), [new Vote(1, itemId)]);
      for (let i = 0; i < 6; i++) {
        await voted.vote(resp.next());
        check(true, null);
      }

      // The state flips.
      await voted.vote(resp.next());
      check(false, null, 1);
      assert.strictEqual(voted.updates[0].item, item);
      assert.strictEqual(voted.updates[0].status, voteStatus.REJECTED);

      for (let i = 1; i < FINALIZATION_SCORE; i++) {
        await voted.vote(resp.next());
        check(false, null);
      }

      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);

      await voted.vote(resp.next());
      check(false, null, 1);
      assert.strictEqual(voted.updates[0].item, item);
      assert.strictEqual(voted.updates[0].status, voteStatus.INVALID);

      assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    });

    it('should register votes on several items', async () => {
      const itemA = await provider.build();
      const idA = provider.id(itemA);
      const itemB = await provider.build();
      const idB = provider.id(itemB);

      const nodes = await setup.connectNodes();

      assert(!isAccepted(itemA));
      assert(!isAccepted(itemB));

      assert(await addToReconcile(itemA));
      let invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, idA);

      const round = setup.getRound();
      await setup.runEventLoop();
      let result = await setup.registerVotes(nodes[0].id,
        new Response(round, 0, [new Vote(0, idA)]));
      assert(result.ok);
      assert.strictEqual(result.updates.length, 0);

      // Start on B after one vote.
      const votes = provider.votes(0, [itemA, itemB]);
      const resp = new Responder(round + 1n, votes);
      assert(await addToReconcile(itemB));
      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 2);
      for (let i = 0; i < invs.length; i++) {
        assert.strictEqual(invs[i].type, provider.invType);
        assert.bufferEqual(invs[i].hash, votes[i].hash);
      }

      for (let i = 0; i < 4 + FINALIZATION_SCORE; i++) {
        const nodeId = setup.getSuitableNodeToQuery();
        await setup.runEventLoop();
        result = await setup.registerVotes(nodeId, resp.next());
        assert(result.ok);
        assert.strictEqual(result.updates.length, 0);
      }

      // Two polls, so the votes land on A and B.
      const first = setup.getSuitableNodeToQuery();
      await setup.runEventLoop();
      const second = setup.getSuitableNodeToQuery();
      await setup.runEventLoop();
      assert.notStrictEqual(first, second);

      // The next vote finalizes A.
      result = await setup.registerVotes(first, resp.next());
      assert.strictEqual(result.updates.length, 1);
      assert.strictEqual(result.updates[0].item, itemA);
      assert.strictEqual(result.updates[0].status, voteStatus.FINALIZED);

      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, idB);

      // And then B.
      result = await setup.registerVotes(second,
        new Response(resp.round, 0, votes));
      assert.strictEqual(result.updates.length, 1);
      assert.strictEqual(result.updates[0].item, itemB);
      assert.strictEqual(result.updates[0].status, voteStatus.FINALIZED);

      assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    });

    it('should poll and check responses', async () => {
      const item = await provider.build();
      const itemId = provider.id(item);

      assert.strictEqual(setup.getSuitableNodeToQuery(), NO_NODE);

      // A quorum of nodes, and as many peers without avalanche.
      const nodes = await setup.connectNodes();
      const ids = new Set(nodes.map(n => n.id));
      for (let i = 0; i < nodes.length; i++)
        setup.connectNode();

      const nodeId = setup.getSuitableNodeToQuery();
      assert(ids.has(nodeId));

      assert(await addToReconcile(item));
      const invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.strictEqual(invs[0].type, provider.invType);
      assert.bufferEqual(invs[0].hash, itemId);

      const unselected = new Set(ids);
      unselected.delete(nodeId);
      const remaining = unselected.size;

      let round = setup.getRound();
      for (let i = 0; i < remaining; i++) {
        await setup.runEventLoop();
        const next = setup.getSuitableNodeToQuery();
        assert(unselected.has(next));
        unselected.delete(next);
      }

      assert.strictEqual(unselected.size, 0);
      await setup.runEventLoop();
      assert.strictEqual(setup.getSuitableNodeToQuery(), NO_NODE);

      const resp = new Responder(round, [new Vote(0, itemId)]);
      let result = await setup.registerVotes(nodeId, resp.next());
      assert(result.ok);
      assert.strictEqual(result.updates.length, 0);

      // Back among the nodes to poll.
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      const checkError = async (id, response, error) => {
        const r = await setup.registerVotes(id, response);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, error);
        assert.strictEqual(r.updates.length, 0);
      };

      // Unpolled.
      await checkError(nodeId, new Response(resp.round - 1n, 0, resp.votes),
        'unexpected-ava-response');

      round = setup.getRound();
      await setup.runEventLoop();
      assert.strictEqual(setup.getSuitableNodeToQuery(), NO_NODE);

      // 1. Too many votes.
      await setup.runEventLoop();
      await checkError(nodeId, new Response(round, 0,
        [new Vote(0, itemId), new Vote(0, itemId)]),
      'invalid-ava-response-size');
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      // 2. Too few.
      let response = new Response(setup.getRound(), 0, []);
      await setup.runEventLoop();
      await checkError(nodeId, response, 'invalid-ava-response-size');
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      // 3. Not what was polled.
      response = new Response(setup.getRound(), 0, [new Vote()]);
      await setup.runEventLoop();
      await checkError(nodeId, response, 'invalid-ava-response-content');
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      // The item is still polled.
      for (let i = 0; i < MAX_INFLIGHT_POLL; i++) {
        response = new Response(setup.getRound(), 0, [new Vote(0, itemId)]);
        await setup.runEventLoop();
        result = await setup.registerVotes(nodeId, response);
        assert(result.ok);
        assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);
      }

      assert.strictEqual(setup.getInvsForNextPoll().length, 1);

      // 4. Wrong rounds; the poll stands.
      const queryRound = setup.getRound();
      await setup.runEventLoop();
      await checkError(nodeId, new Response(queryRound + 1n, 0, [new Vote()]),
        'unexpected-ava-response');
      await checkError(nodeId, new Response(queryRound - 1n, 0, [new Vote()]),
        'unexpected-ava-response');

      // 5. Another node; the poll stands.
      response = new Response(queryRound, 0, [new Vote(0, itemId)]);
      await checkError(nodeId + 1234, response, 'unexpected-ava-response');

      result = await setup.registerVotes(nodeId, response);
      assert(result.ok);
      assert.strictEqual(result.updates.length, 0);
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      // Votes out of order are rejected...
      const item2 = await provider.build();
      assert(await addToReconcile(item2));
      const votes = provider.votes(0, [item, item2]);
      response = new Response(setup.getRound(), 0, [votes[1], votes[0]]);
      await setup.runEventLoop();
      await checkError(nodeId, response, 'invalid-ava-response-content');
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);

      // ...and in order, accepted.
      response = new Response(setup.getRound(), 0, votes);
      await setup.runEventLoop();
      result = await setup.registerVotes(nodeId, response);
      assert(result.ok);
      assert.strictEqual(result.updates.length, 0);
      assert.strictEqual(setup.getSuitableNodeToQuery(), nodeId);
    });

    it('should not poll an invalid item', async () => {
      const itemA = await provider.build();
      const itemB = await provider.build();
      const nodes = await setup.connectNodes();
      let index = 0;
      const nextNode = () => nodes[index++ % nodes.length].id;

      let votes = provider.votes(0, [itemA, itemB]);

      assert(await addToReconcile(itemA));
      assert(await addToReconcile(itemB));
      let invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 2);
      for (let i = 0; i < invs.length; i++)
        assert.bufferEqual(invs[i].hash, votes[i].hash);

      // Invalid: no longer polled.
      await provider.invalidate(itemB);
      const good = new Response(setup.getRound(), 0,
        [new Vote(0, provider.id(itemA))]);
      await setup.runEventLoop();
      let result = await setup.registerVotes(nextNode(), good);
      assert(result.ok);
      assert.strictEqual(result.updates.length, 0);

      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, provider.id(itemA));

      // Votes with B are rejected.
      let bad = new Response(setup.getRound(), 0, votes);
      await setup.runEventLoop();
      result = await setup.registerVotes(nextNode(), bad);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'invalid-ava-response-size');

      // Vote until avalanche invalidates A.
      votes = provider.votes(1, [itemA]);
      for (let i = 0; i < 4000; i++) {
        const response = new Response(setup.getRound(), 0, votes);
        await setup.runEventLoop();
        result = await setup.registerVotes(nextNode(), response);
        assert(result.ok);
        if (result.updates.length > 0
            && result.updates[0].status === voteStatus.INVALID) {
          break;
        }
      }

      assert.strictEqual(setup.getInvsForNextPoll().length, 0);

      bad = new Response(setup.getRound(), 0, votes);
      await setup.runEventLoop();
      result = await setup.registerVotes(nextNode(), bad);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'unexpected-ava-response');
    });

    it('should time out polls in flight', async () => {
      // Bitcoin ABC waits on a clock; we move it.
      setup = new Setup({queryTimeout: 10});
      provider = makeProvider(setup);

      const item = await provider.build();
      const itemId = provider.id(item);
      assert(await setup.processor.addToReconcile(provider.type, item));
      await setup.connectNodes();

      for (let i = 0; i < 10; i++) {
        const resp = new Responder(setup.getRound(), [new Vote(0, itemId)]);
        let nodeId = setup.getSuitableNodeToQuery();
        await setup.runEventLoop();
        setup.advance(1);
        await setup.runEventLoop();
        let result = await setup.registerVotes(nodeId, resp.next());
        assert(result.ok, result.error);

        // Wait past the timeout.
        nodeId = setup.getSuitableNodeToQuery();
        await setup.runEventLoop();
        setup.advance(10);
        await setup.runEventLoop();
        result = await setup.registerVotes(nodeId, resp.next());
        assert.strictEqual(result.ok, false);
      }
    });

    it('should limit polls in flight', async () => {
      const proof = setup.getProof();
      assert((await pm.registerProof(proof))[0]);

      const nodes = [];
      for (let i = 0; i < MAX_INFLIGHT_POLL + 1; i++) {
        const peer = setup.connectNode();
        assert(pm.addNode(peer.id, proof.id(), MAX_ELEMENT_POLL));
        nodes.push(peer);
      }

      const item = await provider.build();
      const itemId = provider.id(item);
      assert(await addToReconcile(item));

      const rounds = new Map();
      for (let i = 0; i < MAX_INFLIGHT_POLL; i++) {
        const nodeId = setup.getSuitableNodeToQuery();
        assert(!rounds.has(nodeId));
        rounds.set(nodeId, setup.getRound());
        const invs = setup.getInvsForNextPoll();
        assert.strictEqual(invs.length, 1);
        assert.bufferEqual(invs[0].hash, itemId);
        await setup.runEventLoop();
      }

      // Enough in flight: no more polls.
      const suitable = setup.getSuitableNodeToQuery();
      assert.notStrictEqual(suitable, NO_NODE);
      assert.strictEqual(setup.getInvsForNextPoll().length, 0);
      await setup.runEventLoop();
      assert.strictEqual(setup.getSuitableNodeToQuery(), suitable);

      // One answer frees one.
      const [nodeId, round] = rounds.entries().next().value;
      const result = await setup.registerVotes(nodeId,
        new Response(round, 0, [new Vote(0, itemId)]));
      assert(result.ok);

      const invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);
    });

    it('should clear requests in flight', async () => {
      const count = 3;
      const itemInvs = [];
      for (let i = 0; i < count; i++) {
        const item = await provider.build();
        assert(await addToReconcile(item));
        itemInvs.push(new InvItem(provider.invType, provider.id(item)));
      }

      const has = (invs, target) => invs.some(inv => inv.type === target.type
        && inv.hash.equals(target.hash));
      // Bitcoin ABC's {inv: count} map, as a list.
      const repeat = pairs => pairs.flatMap(([inv, n]) => Array(n).fill(inv));

      for (let i = 0; i < MAX_INFLIGHT_POLL; i++)
        assert.strictEqual(setup.getInvsForNextPoll(true).length, count);
      assert.strictEqual(setup.getInvsForNextPoll().length, 0);

      // Room for 1, 2 and 3 more polls.
      processor.clearInflightRequests(repeat([[itemInvs[0], 1],
        [itemInvs[1], 2], [itemInvs[2], 3]]));
      assert.strictEqual(setup.getInvsForNextPoll().length, count);

      assert.strictEqual(setup.getInvsForNextPoll(true).length, count);
      let left = setup.getInvsForNextPoll();
      assert.strictEqual(left.length, 2);
      assert(!has(left, itemInvs[0]));
      assert(has(left, itemInvs[1]));
      assert(has(left, itemInvs[2]));

      assert.strictEqual(setup.getInvsForNextPoll(true).length, 2);
      left = setup.getInvsForNextPoll();
      assert.strictEqual(left.length, 1);
      assert(!has(left, itemInvs[1]));
      assert(has(left, itemInvs[2]));

      assert.strictEqual(setup.getInvsForNextPoll(true).length, 1);
      assert.strictEqual(setup.getInvsForNextPoll().length, 0);

      processor.clearInflightRequests(repeat(itemInvs.map(
        inv => [inv, MAX_INFLIGHT_POLL])));
      for (let i = 0; i < MAX_INFLIGHT_POLL; i++)
        assert.strictEqual(setup.getInvsForNextPoll(true).length, count);
      assert.strictEqual(setup.getInvsForNextPoll().length, 0);

      // Nothing, or an unknown item: no change.
      processor.clearInflightRequests([]);
      processor.clearInflightRequests(repeat([[
        new InvItem(provider.invType, random.randomBytes(32)), 5]]));
      assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    });

    it('should not leak polls in flight to lost nodes', async () => {
      const proof = setup.getProof();
      assert((await pm.registerProof(proof))[0]);

      // More nodes than polls in flight, so one pass could saturate them.
      const nodes = [];
      for (let i = 0; i < 8 + MAX_INFLIGHT_POLL; i++) {
        const peer = setup.connectNode();
        assert(pm.addNode(peer.id, proof.id(), MAX_ELEMENT_POLL));
        nodes.push(peer);
      }

      const item = await provider.build();
      const itemId = provider.id(item);
      assert(await addToReconcile(item));

      // Gone from the pool, still selectable.
      for (const peer of nodes)
        processor.peers.delete(peer.id);

      await setup.runEventLoop();

      let invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);

      // New nodes can still poll it.
      await setup.connectNodes();
      await setup.runEventLoop();
      invs = setup.getInvsForNextPoll();
      assert.strictEqual(invs.length, 1);
      assert.bufferEqual(invs[0].hash, itemId);
    });

    it('should apply voting parameters', async () => {
      const threshold = VoteRecord.VOTE_STALE_MIN_THRESHOLD;
      setup = new Setup({staleVoteThreshold: threshold, staleVoteFactor: 2});
      provider = makeProvider(setup);
      const p = setup.processor;

      // [yes votes, neutral votes]
      const cases = [
        [0, threshold],
        [FINALIZATION_SCORE + 4, FINALIZATION_SCORE - 6]
      ];

      const item = await provider.build();
      const itemId = provider.id(item);
      const nodes = await setup.connectNodes();
      const voted = voter(nodes);

      for (const [yes, neutral] of cases) {
        assert(await p.addToReconcile(provider.type, item));
        let invs = setup.getInvsForNextPoll();
        assert.strictEqual(invs.length, 1);
        assert.bufferEqual(invs[0].hash, itemId);
        assert(p.isAccepted(provider.type, itemId));

        for (let i = 0; i < yes; i++) {
          await voted.vote(new Response(setup.getRound(), 0,
            [new Vote(0, itemId)]));
          assert(p.isAccepted(provider.type, itemId));
          assert.strictEqual(p.getConfidence(provider.type, itemId),
            i >= 6 ? i - 5 : 0);
          assert.strictEqual(voted.updates.length, 0);
        }

        // Up to just before stale.
        for (let i = 0; i < neutral; i++) {
          await voted.vote(new Response(setup.getRound(), 0,
            [new Vote(NEUTRAL, itemId)]));
          assert.strictEqual(voted.updates.length, 0);
        }

        invs = setup.getInvsForNextPoll();
        assert.strictEqual(invs.length, 1);

        await voted.vote(new Response(setup.getRound(), 0,
          [new Vote(NEUTRAL, itemId)]));
        assert.strictEqual(voted.updates.length, 1);
        assert.strictEqual(voted.updates[0].item, item);
        assert.strictEqual(voted.updates[0].status, voteStatus.STALE);

        assert.strictEqual(setup.getInvsForNextPoll().length, 0);
      }
    });
  });
}

describe('Avalanche voting on blocks', function() {
  this.timeout(60000);

  let setup, processor;

  beforeEach(() => {
    setup = new Setup();
    processor = setup.processor;
  });

  const BLOCK = itemTypes.BLOCK;

  it('should keep votes from a node once in a quorum', async () => {
    const block = setup.chain.mine();
    const nodes = await setup.connectNodes();

    assert(!processor.isAccepted(BLOCK, block.hash));
    assert(await processor.addToReconcile(BLOCK, block));

    // A valid round from every node.
    const resp = new Responder(setup.getRound(), [new Vote(0, block.hash)]);
    for (const node of nodes) {
      await setup.runEventLoop();
      assert((await setup.registerVotes(node.id, resp.next())).ok);
    }

    // Poll every node again.
    const first = setup.getSuitableNodeToQuery();
    const rounds = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const nodeId = setup.getSuitableNodeToQuery();
      assert(!rounds.has(nodeId));
      rounds.set(nodeId, setup.getRound());
      await setup.runEventLoop();
    }

    // Only the first can vote now: the others are already in the quorum.
    const confidence = processor.getConfidence(BLOCK, block.hash);
    assert(confidence > 0);

    for (const [nodeId, round] of rounds) {
      if (nodeId === first)
        continue;
      const r = await setup.registerVotes(nodeId,
        new Response(round, 0, [new Vote(0, block.hash)]));
      assert(r.ok);
      assert.strictEqual(processor.getConfidence(BLOCK, block.hash),
        confidence);
    }

    const r = await setup.registerVotes(first,
      new Response(rounds.get(first), 0, [new Vote(0, block.hash)]));
    assert(r.ok);
    assert.strictEqual(processor.getConfidence(BLOCK, block.hash),
      confidence + 1);
  });

  // Bitcoin ABC's event_loop, with the loop's ticks run by hand: bcash's
  // pool runs them from a timer.
  it('should poll every node, then wait out a cooldown', async () => {
    const block = setup.chain.mine();
    const nodes = await setup.connectNodes();

    const nodeId = setup.getSuitableNodeToQuery();
    assert.notStrictEqual(nodeId, NO_NODE);

    const queryRound = setup.getRound();
    assert(await processor.addToReconcile(BLOCK, block));

    for (let i = 0; i < 100; i++) {
      if (setup.getRound() === queryRound + BigInt(nodes.length))
        break;
      await setup.runEventLoop();
    }

    assert.strictEqual(setup.getRound(), queryRound + BigInt(nodes.length));

    // Only the first answers, with a 100ms cooldown.
    const responseRound = setup.getRound();
    const queryTime = setup.time + 100;
    const r = await setup.registerVotes(nodeId,
      new Response(queryRound, 100, [new Vote(0, block.hash)]));
    assert(r.ok);

    for (let i = 0; i < 90; i++) {
      await setup.runEventLoop();
      assert.strictEqual(setup.getRound(), responseRound);
      setup.advance(1);
    }

    setup.advance(10);
    await setup.runEventLoop();
    assert(setup.getRound() > responseRound);
    assert(setup.time >= queryTime);
  });

  it('should stop polling below the finalization tip', async () => {
    // Bitcoin ABC polls 1024 blocks; fewer show the same.
    const count = 30;

    assert.strictEqual(processor.finalizationTip, null);

    const blocks = [];
    for (let i = 0; i < count; i++) {
      const block = setup.chain.mine();
      assert(await processor.addToReconcile(BLOCK, block));
      blocks.push(block);
    }

    let invs = setup.getInvsForNextPoll();
    assert.strictEqual(invs.length, count);
    for (let i = 0; i < count; i++)
      assert.bufferEqual(invs[i].hash, blocks[count - i - 1].hash);

    // Only the 11th from the top accepted; the rest unknown.
    const eleventh = blocks[count - 10 - 1].hash;
    let votes = [];
    for (let i = count; i > 0; i--) {
      const hash = blocks[i - 1].hash;
      votes.push(new Vote(hash.equals(eleventh) ? 0 : NEUTRAL, hash));
    }

    const nodes = await setup.connectNodes();
    let index = 0;
    let updates = [];
    const vote = async () => {
      const response = new Response(setup.getRound(), 0, votes);
      await setup.runEventLoop();
      const r = await setup.registerVotes(nodes[index++ % nodes.length].id,
        response);
      assert(r.ok, r.error);
      updates = r.updates;
    };

    assert.strictEqual(processor.finalizationTip, null);

    let finalized = false;
    for (let i = 0; i < 10000 && !finalized; i++) {
      await vote();
      for (const update of updates) {
        if (update.status === voteStatus.FINALIZED
            && update.hash.equals(eleventh)) {
          finalized = true;
          assert(processor.finalizationTip);
        } else {
          assert.strictEqual(processor.finalizationTip, null);
        }
      }
    }

    assert(finalized);
    assert(processor.finalizationTip);

    // Only the 10 with more work are polled now.
    await processor.clearInvsNotWorthPolling();
    invs = setup.getInvsForNextPoll();
    assert.strictEqual(invs.length, 10);
    for (let i = 0; i < 10; i++)
      assert.bufferEqual(invs[i].hash, blocks[count - i - 1].hash);

    // Ancestors cannot be reconciled.
    for (let i = 0; i < count - 10 - 1; i++)
      assert(!await processor.addToReconcile(BLOCK, blocks[i]));

    // Two tips: one invalidated, then reconsidered, and one on its parent.
    const chain = setup.chain;
    const tip = chain.mine();
    chain.invalid.add(tip.hash);
    const parent = await chain.getEntryByHash(tip.prevBlock);
    chain.setTip(parent);

    const alttip = chain.mine();
    assert(alttip.prevBlock.equals(tip.prevBlock));
    assert(!alttip.hash.equals(tip.hash));

    chain.invalid.remove(tip.hash);
    chain.setTip(tip);

    assert(await processor.addToReconcile(BLOCK, tip));
    assert(await processor.addToReconcile(BLOCK, alttip));
    await processor.clearInvsNotWorthPolling();
    invs = setup.getInvsForNextPoll();
    assert.strictEqual(invs.length, 12);

    // Vote for the tip until it finalizes.
    votes = invs.map(inv => new Vote(inv.hash.equals(tip.hash) ? 0 : NEUTRAL,
      inv.hash));

    let tipFinalized = false;
    for (let i = 0; i < 10000 && !tipFinalized; i++) {
      await vote();
      for (const update of updates) {
        if (update.status === voteStatus.FINALIZED
            && update.hash.equals(tip.hash)) {
          tipFinalized = true;
        }
      }
    }

    assert(tipFinalized);

    // The tip and its ancestors leave the polls; the fork stays until it
    // is invalidated or goes stale.
    await processor.clearInvsNotWorthPolling();
    invs = setup.getInvsForNextPoll();
    assert.strictEqual(invs.length, 1);
    assert.bufferEqual(invs[0].hash, alttip.hash);

    assert(!await processor.addToReconcile(BLOCK, tip));

    // Vote down the fork.
    votes = [new Vote(1, alttip.hash)];
    let invalidated = false;
    for (let i = 0; i < 10000 && !invalidated; i++) {
      await vote();
      for (const update of updates) {
        if (update.status === voteStatus.INVALID
            && update.hash.equals(alttip.hash)) {
          invalidated = true;
        }
      }
    }

    assert(invalidated);
    assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    assert(!await processor.addToReconcile(BLOCK, alttip));
  });

  it('should poll a new tip, and vote yes on it', async () => {
    const block = setup.chain.mine();

    // Not polled until the tip is processed.
    assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    assert(!processor.isAccepted(BLOCK, block.hash));

    await processor.updatedBlockTip(block);

    const invs = setup.getInvsForNextPoll();
    assert.strictEqual(invs.length, 1);
    assert.strictEqual(invs[0].type, invTypes.BLOCK);
    assert.bufferEqual(invs[0].hash, block.hash);
    assert(processor.isAccepted(BLOCK, block.hash));
  });

  it('should not poll new tips while syncing', async () => {
    const block = setup.chain.mine();

    processor.isIBD = () => true;
    await processor.updatedBlockTip(block);
    processor.isIBD = () => false;

    assert.strictEqual(setup.getInvsForNextPoll().length, 0);
    assert(!processor.isPolled(BLOCK, block.hash));
  });

  it('should tell the chain what polls decide', async () => {
    const block = setup.chain.mine();
    const nodes = await setup.connectNodes();
    const sessionKey = secp256k1.privateKeyGenerate();

    for (const node of nodes)
      processor.peers.get(node.id).pubkey = pub(sessionKey);

    const seen = [];
    processor.on('block vote', (entry, status) => seen.push([entry, status]));

    assert(await processor.addToReconcile(BLOCK, block));

    let index = 0;
    for (let i = 0; i < FINALIZATION_SCORE + 6; i++) {
      const node = nodes[index++ % nodes.length];
      const response = new Response(setup.getRound(), 0,
        [new Vote(0, block.hash)]);
      await setup.runEventLoop();
      response.sign(sessionKey);
      await processor.handlePacket(node,
        new packets.UnknownPacket('avaresponse', response.toRaw()));
      if (seen.length > 0)
        break;
    }

    assert.deepStrictEqual(seen, [[block, voteStatus.FINALIZED]]);
    assert.bufferEqual(processor.finalizationTip.hash, block.hash);
  });
});

describe('Avalanche voting on proofs', function() {
  this.timeout(60000);

  const PROOF = itemTypes.PROOF;

  it('should poll the proofs with the highest scores', async () => {
    const setup = new Setup();
    const {processor, pm} = setup;

    // Bitcoin ABC fills 1024 elements; a poll of 16 shows the same.
    const max = 16;
    const getInvs = () => setup.getInvsForNextPoll(false, max);

    let score = MIN_VALID_PROOF_SCORE;
    const add = async (s) => {
      const proof = buildRandomProof(setup.chain, s);
      assert((await pm.registerProof(proof))[0]);
      assert(await processor.addToReconcile(PROOF, proof));
      return proof;
    };

    for (let i = 0; i < max; i++) {
      const proof = await add(++score);
      const invs = getInvs();
      assert.strictEqual(invs.length, i + 1);
      assert.strictEqual(invs[0].type, invTypes.AVA_PROOF);
      assert.bufferEqual(invs[0].hash, proof.id());
    }

    // Now a proof is polled only if its score is in the top ones.
    let last;
    for (let i = 0; i < 10; i++) {
      const proof = await add(++score);
      const invs = getInvs();
      assert.strictEqual(invs.length, max);
      assert.bufferEqual(invs[0].hash, proof.id());
      last = proof.id();
    }

    for (let i = 0; i < 10; i++) {
      await add(--score);
      const invs = getInvs();
      assert.strictEqual(invs.length, max);
      assert.bufferEqual(invs[0].hash, last);
    }

    const low = await add(MIN_VALID_PROOF_SCORE);
    const invs = getInvs();
    assert.strictEqual(invs.length, max);
    for (const inv of invs)
      assert(!inv.hash.equals(low.id()));
  });

  it('should record votes on bound and conflicting proofs only', async () => {
    const setup = new Setup({confirmations: 2, conflictingProofCooldown: 0});
    const {processor, pm, chain} = setup;

    assert(!processor.isAccepted(PROOF, null));
    assert.strictEqual(processor.getConfidence(PROOF, null), -1);

    const key = secp256k1.privateKeyGenerate();
    const conflicting = randomOutpoint();
    const immature = randomOutpoint();
    const dust = require('../lib/avalanche/proof').PROOF_DUST_THRESHOLD;
    chain.addCoin(conflicting, key, dust, 10);
    chain.addCoin(immature, key, dust, 100);

    const build = (outpoint, sequence, height = 10) => buildProof({
      key, sequence, outpoints: [outpoint], amount: dust, height
    });

    const conflictingProof = build(conflicting, 1);
    const validProof = build(conflicting, 2);
    const immatureProof = build(immature, 3, 100);
    const all = [conflictingProof, validProof, immatureProof];

    const accepted = p => processor.isAccepted(PROOF, p.id());
    const confidence = p => processor.getConfidence(PROOF, p.id());

    for (const proof of all) {
      assert(!accepted(proof));
      assert.strictEqual(confidence(proof), -1);
      // Not registered: not reconciled.
      assert(!await processor.addToReconcile(PROOF, proof));
    }

    assert((await pm.registerProof(conflictingProof))[0]);
    assert((await pm.registerProof(validProof))[0]);
    assert(!(await pm.registerProof(immatureProof))[0]);
    assert(pm.isBoundToPeer(validProof.id()));
    assert(pm.isInConflictingPool(conflictingProof.id()));
    assert(pm.isImmature(immatureProof.id()));

    assert(await processor.addToReconcile(PROOF, conflictingProof));
    assert(!accepted(conflictingProof));
    assert(!accepted(validProof));
    assert(!accepted(immatureProof));
    assert.strictEqual(confidence(conflictingProof), 0);
    assert.strictEqual(confidence(validProof), -1);
    assert.strictEqual(confidence(immatureProof), -1);

    assert(await processor.addToReconcile(PROOF, validProof));
    assert(!accepted(conflictingProof));
    assert(accepted(validProof));
    assert(!accepted(immatureProof));
    assert.strictEqual(confidence(validProof), 0);

    assert(!await processor.addToReconcile(PROOF, immatureProof));
    assert(!accepted(immatureProof));
    assert.strictEqual(confidence(immatureProof), -1);
  });

  it('should reconcile, or finalize a recently finalized proof', async () => {
    const setup = new Setup({conflictingProofCooldown: 0});
    const {processor, pm, chain} = setup;

    assert(!await processor.reconcileOrFinalize(null));

    const key = secp256k1.privateKeyGenerate();
    const outpoint = randomOutpoint();
    const dust = require('../lib/avalanche/proof').PROOF_DUST_THRESHOLD;
    chain.addCoin(outpoint, key, dust, 100);

    const build = sequence => buildProof({
      key, sequence, outpoints: [outpoint], amount: dust, height: 100
    });

    const proof = build(1);

    // Neither a peer nor conflicting.
    assert(!await processor.reconcileOrFinalize(proof));

    assert((await pm.registerProof(proof))[0]);
    assert(pm.isBoundToPeer(proof.id()));

    assert(await processor.reconcileOrFinalize(proof));
    assert(!await processor.reconcileOrFinalize(proof));

    // Finalized: the peer is.
    processor.setRecentlyFinalized(proof.id());
    assert(processor.isRecentlyFinalized(proof.id()));
    assert(await processor.reconcileOrFinalize(proof));
    assert.strictEqual(pm.getPeerByProof(proof.id()).hasFinalized, true);
    assert(pm.isBoundToPeer(proof.id()));

    // The same stake, a higher sequence.
    const better = build(2);
    assert(!await processor.reconcileOrFinalize(better));

    assert((await pm.registerProof(better))[0]);
    assert(pm.isBoundToPeer(better.id()));
    assert(!pm.isBoundToPeer(proof.id()));
    assert(pm.isInConflictingPool(proof.id()));

    // Recently finalized: not worth polling. The better one is.
    assert(!await processor.reconcileOrFinalize(proof));
    assert(await processor.reconcileOrFinalize(better));
  });

  it('should apply what polls decide to the peer manager', async () => {
    const setup = new Setup();
    const {processor, pm} = setup;

    // One more than a quorum: the one we ban still has a poll out, and a
    // node votes once in any 8.
    const nodes = await setup.connectNodes(9);
    const sessionKey = secp256k1.privateKeyGenerate();
    for (const node of nodes)
      processor.peers.get(node.id).pubkey = pub(sessionKey);

    const proof = setup.getProof();
    assert((await pm.registerProof(proof))[0]);
    assert(await processor.reconcileOrFinalize(proof));

    // Answer as the node the loop polls.
    const respond = async (error, sign = true) => {
      const nodeId = setup.getSuitableNodeToQuery();
      const node = nodes.find(n => n.id === nodeId);
      const response = new Response(setup.getRound(), 0,
        [new Vote(error, proof.id())]);
      await setup.runEventLoop();
      if (sign)
        response.sign(sessionKey);
      await processor.handlePacket(node,
        new packets.UnknownPacket('avaresponse', response.toRaw()));
      return node;
    };

    // An unsigned response is a ban.
    const node = await respond(0, false);
    assert.strictEqual(node.ban, 100);

    for (let i = 0; i < FINALIZATION_SCORE + 6; i++) {
      await respond(0);
      if (!processor.isPolled(PROOF, proof.id()))
        break;
    }

    // Finalized: the peer is too, and kept from replacement for a day.
    assert(processor.isRecentlyFinalized(proof.id()));
    const peer = pm.getPeerByProof(proof.id());
    assert.strictEqual(peer.hasFinalized, true);
    assert.strictEqual(peer.nextPossibleConflictTime,
      setup.now + Processor.PEER_REPLACEMENT_COOLDOWN);
  });
});

describe('Avalanche vote map order', function() {
  it('should order proofs by score, then blocks by work', async () => {
    const setup = new Setup();
    const {processor} = setup;
    const count = 100;

    const entries = [];
    for (let i = 1; i <= count; i++) {
      const proof = buildRandomProof(setup.chain, i * MIN_VALID_PROOF_SCORE);
      entries.push({type: itemTypes.PROOF, hash: proof.id(), item: proof,
        record: new VoteRecord(true)});

      const block = {hash: random.randomBytes(32), chainwork: new BN(i)};
      entries.push({type: itemTypes.BLOCK, hash: block.hash, item: block,
        record: new VoteRecord(true)});
    }

    // In random order.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = random.randomRange(0, i + 1);
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }

    processor.voteRecords = new Map(entries.map(e =>
      [`${e.type}:${e.hash.toString('hex')}`, e]));

    const sorted = processor.sortedRecords();

    let lastScore = Infinity;
    for (let i = 0; i < count; i++) {
      assert.strictEqual(sorted[i].type, itemTypes.PROOF);
      const score = sorted[i].item.getScore();
      assert(score < lastScore);
      lastScore = score;
    }

    let lastWork = null;
    for (let i = count; i < 2 * count; i++) {
      assert.strictEqual(sorted[i].type, itemTypes.BLOCK);
      const work = sorted[i].item.chainwork;
      assert(!lastWork || work.lt(lastWork));
      lastWork = work;
    }
  });
});

// Not in Bitcoin ABC: below the connected ratio, a unanimous vote is
// final; a dissent waits for the ratio.
describe('Avalanche unanimous votes below the connected ratio', function() {
  const {BLOCK} = itemTypes;
  let setup, processor;

  beforeEach(() => {
    setup = new Setup({
      minQuorumConnectedStakeRatio: 0.8,
      minQuorumUnanimousStakeRatio: 0.5
    });
    processor = setup.processor;
  });

  // Stakers with three nodes each, and stakers we have no node for.
  async function stakers(withNodes, without) {
    const nodes = [];
    for (let i = 0; i < withNodes; i++)
      nodes.push(await setup.connectNodes(3));
    for (let i = 0; i < without; i++)
      assert((await setup.pm.registerProof(setup.getProof()))[0]);
    return nodes;
  }

  // Poll until a final update, or the rounds run out: each node votes
  // as vote(nodeId) says.
  async function poll(block, vote, rounds) {
    for (let i = 0; i < rounds; i++) {
      const round = setup.getRound();
      await setup.runEventLoop();
      if (setup.getRound() === round)
        continue;
      // The node it polled.
      const query = [...processor.queries.values()]
        .find(q => q.round === round);
      const {nodeId} = query;
      const r = await setup.registerVotes(nodeId,
        new Response(round, 0, [new Vote(vote(nodeId), block.hash)]));
      assert(r.ok);
      const final = r.updates.find(u => u.status === voteStatus.FINALIZED);
      if (final)
        return final;
    }
    return null;
  }

  it('should poll with nodes for half the stake, not less', async () => {
    // 2 of 5 stakers.
    await stakers(2, 3);
    assert(!processor.isQuorumEstablished());

    // 3 of 5.
    await setup.connectNodes(3);
    assert(processor.isQuorumEstablished());
    assert(!processor.hasConnectedRatio());
  });

  it('should finalize a unanimous vote with 60% of the stake', async () => {
    await stakers(3, 2);
    const block = setup.chain.mine();
    assert(await processor.addToReconcile(BLOCK, block));

    const final = await poll(block, () => 0, 20 * FINALIZATION_SCORE);
    assert(final);
    assert.bufferEqual(final.hash, block.hash);
  });

  it('should hold a vote with a dissent until 80% is connected', async () => {
    const nodes = await stakers(3, 2);
    const block = setup.chain.mine();
    assert(await processor.addToReconcile(BLOCK, block));

    // One node of one staker votes no, once.
    const dissenter = nodes[2][0].id;
    let dissented = false;
    const vote = (nodeId) => {
      if (nodeId === dissenter && !dissented) {
        dissented = true;
        return 1;
      }
      return 0;
    };

    assert.strictEqual(await poll(block, vote, 20 * FINALIZATION_SCORE),
      null);
    assert(dissented);
    assert(processor.getConfidence(BLOCK, block.hash) >= FINALIZATION_SCORE);

    // Nodes for the other stakers: now the vote stands.
    for (const peer of setup.pm.peers.values()) {
      if (peer.nodeCount === 0) {
        const node = setup.connectNode();
        assert(setup.pm.addNode(node.id, peer.proof.id(), MAX_ELEMENT_POLL));
      }
    }
    assert(processor.hasConnectedRatio());

    assert(await poll(block, () => 0, 100));
  });
});

// For SPV clients: a transaction polled without a mempool, as the
// client's own, once polls finalized a block since starting.
describe('Avalanche transactions watched without a mempool', function() {
  let setup, processor;

  beforeEach(async () => {
    setup = new Setup({noMempool: true});
    processor = setup.processor;
    await setup.connectNodes();
  });

  function randomTX() {
    const mtx = new MTX();
    mtx.addInput({prevout: {hash: random.randomBytes(32), index: 0}});
    mtx.addOutput(Script.fromPubkeyhash(random.randomBytes(20)), 1000);
    return mtx.toTX();
  }

  // Poll until a final verdict, each node voting `error`.
  async function poll(tx, error, rounds = 20 * FINALIZATION_SCORE) {
    const updates = [];
    for (let i = 0; i < rounds; i++) {
      const round = setup.getRound();
      await setup.runEventLoop();
      if (setup.getRound() === round)
        continue;
      const {nodeId} = [...processor.queries.values()]
        .find(q => q.round === round);
      const r = await setup.registerVotes(nodeId,
        new Response(round, 0, [new Vote(error, tx.hash())]));
      assert(r.ok);
      // As handleResponse does.
      for (const update of r.updates)
        await processor.applyUpdate(update);
      updates.push(...r.updates);
      if (r.updates.some(u => u.status === voteStatus.FINALIZED
          || u.status === voteStatus.INVALID)) {
        break;
      }
    }
    return updates.map(u => u.status);
  }

  it('should wait for polls to finalize a block, then poll', async () => {
    const tx = randomTX();

    assert(!processor.isPreconsensusActivated());
    assert.strictEqual(await processor.watchTransaction(tx), false);
    assert.strictEqual(processor.getTransactionStatus(tx.hash()), 'pending');

    processor.finalizedSinceStart = true;
    await processor.pollWatchedTransactions();
    const key = `${itemTypes.TX}:${tx.hash().toString('hex')}`;
    assert(processor.voteRecords.has(key));
  });

  it('should find one final', async () => {
    processor.finalizedSinceStart = true;
    const tx = randomTX();
    assert(await processor.watchTransaction(tx));

    const seen = [];
    processor.on('tx vote', (t, status) => seen.push(status));

    assert.deepStrictEqual(await poll(tx, 0), [voteStatus.FINALIZED]);
    assert.strictEqual(processor.getTransactionStatus(tx.hash()), 'final');
    assert.deepStrictEqual(seen, [voteStatus.FINALIZED]);

    // Done with: not polled again.
    assert.strictEqual(await processor.watchTransaction(tx), false);
  });

  it('should find one rejected, then invalid', async () => {
    processor.finalizedSinceStart = true;
    const tx = randomTX();
    assert(await processor.watchTransaction(tx));

    assert.deepStrictEqual(await poll(tx, 1),
      [voteStatus.REJECTED, voteStatus.INVALID]);
    assert.strictEqual(processor.getTransactionStatus(tx.hash()), 'invalid');
  });
});

