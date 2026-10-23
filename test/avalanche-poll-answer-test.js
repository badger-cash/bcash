/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Answering polls, as Bitcoin ABC's AVAPOLL handler (net_processing.cpp)
 * and its GetAvalancheVoteFor* functions: each item gets our vote, in the
 * order asked, in a response signed by our session key.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const {BufferSet} = require('buffer-map');
const InvItem = require('../lib/primitives/invitem');
const PeerManager = require('../lib/avalanche/peermanager');
const Processor = require('../lib/avalanche/processor');
const ChainStakeVerifier = require('../lib/avalanche/stakeverifier');
const {Poll, Response, invTypes} = require('../lib/avalanche/protocol');
const {FakeChain, MIN_VALID_PROOF_SCORE, buildRandomProof} =
  require('./util/avalanche');

const UNKNOWN = 0xffffffff;
const MISSING = 0xfffffffe;
const PENDING = 0xfffffffd;

let nextId = 0;

class FakePeer {
  constructor() {
    this.id = nextId++;
    this.sent = [];
  }

  hostname() {
    return `10.0.0.${this.id}:8333`;
  }

  send(packet) {
    this.sent.push(packet);
  }
}

// A chain of blocks by hash, a main chain, and a fork off it.
class VoteChain {
  constructor() {
    this.entries = new Map();
    this.main = new Set();
    this.invalid = new BufferSet();
    this.parkedChain = new Set();
    const genesis = this.add(null);
    this.tip = genesis;
    this.main.add(genesis.hash.toString('hex'));
  }

  add(prev) {
    const entry = {
      hash: random.randomBytes(32),
      height: prev ? prev.height + 1 : 0,
      prev
    };
    this.entries.set(entry.hash.toString('hex'), entry);
    return entry;
  }

  extend() {
    this.tip = this.add(this.tip);
    this.main.add(this.tip.hash.toString('hex'));
    return this.tip;
  }

  async getEntryByHash(hash) {
    return this.entries.get(hash.toString('hex')) || null;
  }

  async isMainChain(entry) {
    return this.main.has(entry.hash.toString('hex'));
  }

  async isOnParkedChain(entry) {
    return this.parkedChain.has(entry.hash.toString('hex'));
  }

  async findFork(fork, longer) {
    const seen = new Set();
    for (let e = fork; e; e = e.prev)
      seen.add(e.hash.toString('hex'));
    for (let e = longer; e; e = e.prev) {
      if (seen.has(e.hash.toString('hex')))
        return e;
    }
    return null;
  }
}

// Bitcoin ABC's TestMemPoolEntryHelper-like mempool: what it has.
class VoteMempool {
  constructor() {
    this.entries = new BufferSet();
    this.finalized = new BufferSet();
    this.orphans = new BufferSet();
    this.rejectSet = new BufferSet();
    this.conflictSet = new BufferSet();
    this.rejects = {test: h => this.rejectSet.has(h)};
    this.conflicting = {has: h => this.conflictSet.has(h), getTX: () => null};
  }

  hasEntry(hash) {
    return this.entries.has(hash);
  }

  isAvalancheFinalized(hash) {
    return this.finalized.has(hash);
  }

  hasOrphan(hash) {
    return this.orphans.has(hash);
  }

  isWorthPolling(hash) {
    return this.entries.has(hash);
  }
}

describe('Avalanche answering polls', function() {
  let time, chain, mempool, pm, processor, peer;

  beforeEach(() => {
    time = 1000000;
    chain = new VoteChain();
    mempool = new VoteMempool();

    const coins = new FakeChain(100);
    pm = new PeerManager({
      verifier: new ChainStakeVerifier({chain: coins, confirmations: 1}),
      ms: () => time
    });
    pm.coinChain = coins;

    processor = new Processor({
      peerManager: pm,
      chain,
      isIBD: () => false,
      ms: () => time,
      minQuorumStake: 0,
      minQuorumConnectedStakeRatio: 0,
      minAvaproofsNodeCount: 0,
      preConsensus: true,
      mempool,
      answerPolls: true
    });

    peer = new FakePeer();
    processor.addPeer(peer);
  });

  // A quorum: eight nodes for one proof.
  async function quorum() {
    const proof = buildRandomProof(pm.coinChain, MIN_VALID_PROOF_SCORE);
    assert((await pm.registerProof(proof))[0]);
    for (let i = 0; i < 8; i++)
      assert(pm.addNode(1000 + i, proof.id(), 1024));
    processor.finalizedSinceStart = true;
    assert(processor.isQuorumEstablished());
    return proof;
  }

  // Poll with these items; the response we sent, or null.
  async function poll(invs, round = 7n) {
    peer.sent = [];
    await processor.handlePacket(peer, {
      cmd: 'avapoll',
      data: new Poll(round, invs).toRaw()
    });
    time += Processor.COOLDOWN;
    const packet = peer.sent.find(p => p.cmd === 'avaresponse');
    return packet ? Response.fromRaw(packet.data) : null;
  }

  const votes = response => response.votes.map(v => v.error);
  const block = entry => new InvItem(invTypes.BLOCK, entry.hash);

  it('should answer in order, signed by the session key', async () => {
    await quorum();
    const a = chain.extend();
    const unknown = new InvItem(invTypes.BLOCK, random.randomBytes(32));

    const response = await poll([block(a), unknown], 42n);
    assert.strictEqual(response.round, 42n);
    assert.strictEqual(response.cooldown, Processor.COOLDOWN);
    assert.deepStrictEqual(votes(response), [0, UNKNOWN]);
    assert.bufferEqual(response.votes[0].hash, a.hash);

    const pubkey = secp256k1.publicKeyCreate(processor.sessionKey, true);
    assert(response.verify(pubkey));
  });

  it('should vote unknown on everything before a quorum', async () => {
    const a = chain.extend();
    assert.deepStrictEqual(votes(await poll([block(a)])), [UNKNOWN]);
  });

  it('should vote on blocks as Bitcoin ABC', async () => {
    await quorum();
    const base = chain.extend();
    const tip = chain.extend();

    // Built on our tip, not connected yet; and a fork off the base.
    const next = chain.add(tip);
    const fork = chain.add(base);

    const parked = chain.add(tip);
    chain.parkedChain.add(parked.hash.toString('hex'));

    const invalid = random.randomBytes(32);
    chain.invalid.add(invalid);

    const response = await poll([
      block(base), block(tip), block(next), block(fork), block(parked),
      new InvItem(invTypes.BLOCK, invalid)
    ]);
    assert.deepStrictEqual(votes(response), [0, 0, PENDING, 3, 2, 1]);
  });

  it('should vote on proofs as Bitcoin ABC', async () => {
    const bound = await quorum();
    const unknown = random.randomBytes(32);
    const invalid = random.randomBytes(32);
    processor.invalidProofs.add(invalid.toString('hex'));

    const proof = id => new InvItem(invTypes.AVA_PROOF, id);
    const response = await poll([
      proof(bound.id()), proof(unknown), proof(invalid)
    ]);
    assert.deepStrictEqual(votes(response), [0, UNKNOWN, 1]);
  });

  it('should vote on transactions as Bitcoin ABC', async () => {
    await quorum();
    const ids = {};
    for (const name of ['confirmed', 'rejected', 'finalized', 'polled',
      'unpolled', 'conflicting', 'orphan', 'unknown']) {
      ids[name] = random.randomBytes(32);
    }

    processor.blockConnected({txs: [{hash: () => ids.confirmed}]});
    mempool.rejectSet.add(ids.rejected);
    mempool.finalized.add(ids.finalized);
    mempool.entries.add(ids.polled);
    mempool.entries.add(ids.unpolled);
    mempool.conflictSet.add(ids.conflicting);
    mempool.orphans.add(ids.orphan);
    processor.voteRecords.set(`3:${ids.polled.toString('hex')}`, {});

    const tx = id => new InvItem(invTypes.TX, id);
    const response = await poll(Object.values(ids).map(tx));
    assert.deepStrictEqual(votes(response),
      [0, 1, 0, 0, PENDING, 2, MISSING, UNKNOWN]);

    // A block disconnected: confirmed ones are forgotten.
    processor.blockDisconnected();
    assert.deepStrictEqual(votes(await poll([tx(ids.confirmed)])), [UNKNOWN]);
  });

  it('should drop a poll inside the cooldown, still counting it', async () => {
    await quorum();
    const a = chain.extend();

    assert(await poll([block(a)]));

    // Within 100 ms: no answer, and the wait starts again.
    time -= Processor.COOLDOWN - 50;
    assert.strictEqual(await poll([block(a)]), null);
    time -= Processor.COOLDOWN - 60;
    assert.strictEqual(await poll([block(a)]), null);
    time += 100;
    assert(await poll([block(a)]));
  });

  it('should not answer a poll of too many items', async () => {
    await quorum();
    let bad = null;
    processor.misbehaving = (state, reason) => {
      bad = reason;
    };
    const invs = [];
    for (let i = 0; i < processor.maxElementPoll + 1; i++)
      invs.push(new InvItem(invTypes.BLOCK, random.randomBytes(32)));
    assert.strictEqual(await poll(invs), null);
    assert.strictEqual(bad, 'too-many-ava-poll');
  });

  it('should not answer at all without answerPolls (SPV)', async () => {
    await quorum();
    processor.answerPolls = false;
    assert.strictEqual(await poll([block(chain.extend())]), null);
  });
});
