/*!
 * peermanager.js - avalanche peer manager for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/peermanager.{h,cpp}.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {Lock} = require('bmutex');
const random = require('bcrypto/lib/random');
const Proof = require('./proof');
const ProofPool = require('./proofpool');
const StakeContenderCache = require('./stakecontendercache');
const {contenderId} = require('./stakingrewards');

/*
 * Constants
 */

// Bitcoin ABC's PEERS_DUMP_VERSION, for avapeers.dat.
const PEERS_DUMP_VERSION = 1;

// A peer with no node this long, in seconds, is dropped as dangling.
const DANGLING_TIMEOUT = 15 * 60;

// Seconds before a proof may replace one it conflicts with.
const CONFLICTING_PROOF_COOLDOWN = 60;

const MAX_IMMATURE_PROOFS = 4000;
const MAX_REMOTE_PROOFS = 100;
const SELECT_PEER_MAX_RETRY = 3;
const SELECT_NODE_MAX_RETRY = 3;

const NO_PEER = -1;
const NO_NODE = -1;

const registrationMode = {
  DEFAULT: 0,
  // Accept the proof even if it conflicts with registered ones.
  FORCE_ACCEPT: 1
};

const rejectionMode = {
  // Keep the proof in the conflicting pool.
  DEFAULT: 0,
  // Forget it.
  INVALIDATE: 1
};

/**
 * Peer Manager
 * The proofs we know, the peers they make, and the nodes that speak for
 * each peer. Picks nodes to poll in proportion to their peer's stake.
 *
 * A peer is a registered proof. A node is a connection that sent a hello
 * delegated from that proof.
 * @alias module:avalanche.PeerManager
 */

class PeerManager {
  /**
   * @param {Object} options
   * @param {Object} options.verifier - Has async verify(proof), returning
   * [valid, reason], as {@link ChainStakeVerifier}.
   * @param {Number} [options.conflictingProofCooldown] - Seconds.
   * @param {Function} [options.now] - Seconds.
   * @param {Function} [options.ms] - Milliseconds, for poll timing.
   */

  constructor(options) {
    assert(options && options.verifier);

    this.verifier = options.verifier;

    // A staking node's own proof: shared with no node, never dangling.
    this.localProof = options.localProof || null;

    // Peers loaded from a dump, not checked yet, by proof id (hex): saved
    // again as they were, so a short run leaves the dump no worse.
    this.unloadedPeers = new Map();

    // Bitcoin ABC's staking pre-consensus: proofs that may win each recent
    // block's staking reward, polled as stake contenders. getTip gives the
    // block a proof registered now contends for the next of.
    this.stakingPreConsensus = Boolean(options.stakingPreConsensus);
    this.getTip = options.getTip || (() => null);
    this.stakeContenderCache = new StakeContenderCache();
    this.conflictingProofCooldown = options.conflictingProofCooldown != null
      ? options.conflictingProofCooldown
      : CONFLICTING_PROOF_COOLDOWN;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.ms = options.ms || (() => Date.now());

    this.locker = new Lock();

    // Proofs waiting to have their coins checked, one at a time.
    this.verifyingProof = false;
    this.verifyWaiting = [];

    this.peers = new Map();
    this.peersByProof = new Map();
    this.nextPeerId = 0;

    this.nodes = new Map();
    this.pendingNodes = new Map();

    this.slots = [];
    this.slotCount = 0;
    this.fragmentation = 0;

    this.totalPeersScore = 0;
    this.connectedPeersScore = 0;

    this.validProofPool = new ProofPool();
    this.conflictingProofPool = new ProofPool();
    this.immatureProofPool = new ProofPool();
    this.danglingProofPool = new ProofPool();

    // Proof id to node id to {present, lastUpdate}.
    this.remoteProofs = new Map();
    // Node id to proof ids, oldest update first.
    this.remoteProofsByNode = new Map();

    this.needMoreNodes = false;

    // Proof ids (hex) marked flaky by hand (setflakyproof).
    this.manualFlaky = new Set();
  }

  /*
   * Nodes
   */

  /**
   * Attach a node to the peer of a proof, or hold it until the proof is
   * registered.
   * @param {Number} nodeId
   * @param {Buffer} proofId
   * @param {Number} maxElements
   * @returns {Boolean} Whether it was attached.
   */

  addNode(nodeId, proofId, maxElements) {
    const peer = this.getPeerByProof(proofId);

    if (!peer) {
      // A node changing to an unknown proof must not stay active.
      this.removeNode(nodeId);
      this.pendingNodes.set(nodeId, {proofId, nodeId, maxElements});
      return false;
    }

    return this.addOrUpdateNode(peer, nodeId, maxElements);
  }

  // Private.
  addOrUpdateNode(peer, nodeId, maxElements) {
    const node = this.nodes.get(nodeId);

    if (!node) {
      this.nodes.set(nodeId, {
        nodeId,
        peerId: peer.peerId,
        nextRequestTime: this.ms(),
        avaproofsSent: false,
        lastRound: 0n,
        maxElements
      });
    } else {
      const old = node.peerId;
      node.peerId = peer.peerId;
      assert(this.removeNodeFromPeer(this.peers.get(old)));
    }

    assert(this.addNodeToPeer(peer));

    this.pendingNodes.delete(nodeId);
    this.danglingProofPool.remove(peer.proof.id());

    return true;
  }

  // Private.
  addNodeToPeer(peer) {
    if (peer.nodeCount++ > 0)
      return true;

    // Allocate the peer a slot.
    const score = peer.proof.getScore();
    const start = this.slotCount;
    peer.index = this.slots.length;
    this.slots.push({start, score, peerId: peer.peerId});
    this.slotCount = start + score;
    this.connectedPeersScore += score;

    return true;
  }

  removeNode(nodeId) {
    this.clearRemoteProofs(nodeId);

    if (this.pendingNodes.delete(nodeId))
      return true;

    const node = this.nodes.get(nodeId);

    if (!node)
      return false;

    this.nodes.delete(nodeId);

    assert(this.removeNodeFromPeer(this.peers.get(node.peerId)));

    return true;
  }

  // Private.
  removeNodeFromPeer(peer, count = 1) {
    // A node can outlive its peer while a poll is in flight.
    if (!peer)
      return true;

    assert(count <= peer.nodeCount);

    if (count === 0)
      return false;

    peer.nodeCount -= count;

    if (peer.nodeCount > 0)
      return true;

    // No node left: free its slot.
    const i = peer.index;
    const slot = this.slots[i];
    assert(slot && this.connectedPeersScore >= slot.score);
    this.connectedPeersScore -= slot.score;

    if (i + 1 === this.slots.length) {
      this.slots.pop();
      this.slotCount = this.slots.length > 0
        ? slotStop(this.slots[this.slots.length - 1])
        : 0;
    } else {
      this.fragmentation += slot.score;
      this.slots[i] = {...slot, peerId: NO_PEER};
    }

    return true;
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  getNodeCount() {
    return this.nodes.size;
  }

  getPendingNodeCount() {
    return this.pendingNodes.size;
  }

  updateNextRequestTimeForPoll(nodeId, timeout, round) {
    const node = this.nodes.get(nodeId);

    if (!node)
      return false;

    node.nextRequestTime = timeout;
    node.lastRound = round;

    return true;
  }

  updateNextRequestTimeForResponse(nodeId, response) {
    const node = this.nodes.get(nodeId);

    if (!node)
      return false;

    // A response to an earlier round.
    if (node.lastRound > response.round)
      return false;

    node.nextRequestTime = this.ms() + response.cooldown;
    node.lastRound = response.round;

    return true;
  }

  latchAvaproofsSent(nodeId) {
    const node = this.nodes.get(nodeId);

    if (!node || node.avaproofsSent)
      return false;

    node.avaproofsSent = true;

    return true;
  }

  shouldRequestMoreNodes() {
    const need = this.needMoreNodes;
    this.needMoreNodes = false;
    return need;
  }

  /**
   * Pick a node to poll: a peer by stake, then its node that is free
   * soonest, if it is free now.
   * @returns {Number} Node id, or NO_NODE.
   */

  selectNode() {
    for (let retry = 0; retry < SELECT_NODE_MAX_RETRY; retry++) {
      const peerId = this.selectPeer();

      // Perhaps too fragmented to find one.
      if (peerId === NO_PEER) {
        this.compact();
        continue;
      }

      let best = null;
      for (const node of this.nodes.values()) {
        if (node.peerId !== peerId)
          continue;
        if (!best || node.nextRequestTime < best.nextRequestTime)
          best = node;
      }

      if (best && best.nextRequestTime <= this.ms())
        return best.nodeId;
    }

    this.needMoreNodes = true;

    return NO_NODE;
  }

  /**
   * Pick a node to poll as selectNode does, a peer by stake and then its
   * node free soonest, but among the free nodes accept() takes.
   * @param {Function} accept - Node id to Boolean.
   * @returns {Number} Node id, or NO_NODE.
   */

  selectNodeWhere(accept) {
    const now = this.ms();
    const best = new Map();

    for (const node of this.nodes.values()) {
      if (node.nextRequestTime > now || !accept(node.nodeId))
        continue;
      const other = best.get(node.peerId);
      if (!other || node.nextRequestTime < other.nextRequestTime)
        best.set(node.peerId, node);
    }

    let total = 0;
    for (const peerId of best.keys())
      total += this.peers.get(peerId).proof.getScore();

    if (total === 0) {
      this.needMoreNodes = true;
      return NO_NODE;
    }

    let slot = randomBelow(total);

    for (const [peerId, node] of best) {
      slot -= this.peers.get(peerId).proof.getScore();
      if (slot < 0)
        return node.nodeId;
    }

    return NO_NODE;
  }

  /*
   * Peers
   */

  getPeerByProof(proofId) {
    const peerId = this.peersByProof.get(proofId.toString('hex'));
    return peerId != null ? this.peers.get(peerId) : null;
  }

  selectPeer() {
    if (this.slots.length === 0 || this.slotCount === 0)
      return NO_PEER;

    const max = this.slotCount;

    for (let retry = 0; retry < SELECT_PEER_MAX_RETRY; retry++) {
      const peerId = selectPeerImpl(this.slots, randomBelow(max), max);
      if (peerId !== NO_PEER)
        return peerId;
    }

    return NO_PEER;
  }

  /**
   * Remove the gaps that removed peers left in the slots.
   * @returns {Number} Slot space saved.
   */

  compact() {
    if (this.fragmentation === 0)
      return 0;

    const slots = [];
    let prevStop = 0;

    for (const peer of this.peers.values()) {
      if (peer.nodeCount === 0)
        continue;

      const score = peer.proof.getScore();
      peer.index = slots.length;
      slots.push({start: prevStop, score, peerId: peer.peerId});
      prevStop += score;
    }

    const saved = this.slotCount - prevStop;

    this.slots = slots;
    this.slotCount = prevStop;
    this.fragmentation = 0;

    return saved;
  }

  // Private.
  removePeer(peerId) {
    const peer = this.peers.get(peerId);

    if (!peer)
      return false;

    this.removeNodeFromPeer(peer, peer.nodeCount);

    // Its nodes wait for another proof; those with a poll still timing
    // out stay, so they are not polled too soon if they rejoin.
    const now = this.ms();
    for (const node of [...this.nodes.values()]) {
      if (node.peerId !== peerId)
        continue;

      this.pendingNodes.set(node.nodeId, {
        proofId: peer.proof.id(),
        nodeId: node.nodeId,
        maxElements: node.maxElements
      });

      if (node.nextRequestTime <= now)
        this.nodes.delete(node.nodeId);
    }

    this.validProofPool.remove(peer.proof.id());

    assert(this.totalPeersScore >= peer.proof.getScore());
    this.totalPeersScore -= peer.proof.getScore();

    this.peersByProof.delete(peer.proof.id().toString('hex'));
    this.peers.delete(peerId);

    return true;
  }

  // Private.
  updateNextPossibleConflictTime(peerId, time) {
    const peer = this.peers.get(peerId);

    if (!peer)
      return false;

    peer.nextPossibleConflictTime = Math.max(peer.nextPossibleConflictTime,
      time);

    return peer.nextPossibleConflictTime === time;
  }

  setFinalized(peerId) {
    const peer = this.peers.get(peerId);

    if (!peer)
      return false;

    peer.hasFinalized = true;

    return true;
  }

  /*
   * Proofs
   */

  /**
   * Register a proof: make it a peer, or file it as immature or
   * conflicting.
   * @param {Proof} proof
   * @param {Number} [mode=registrationMode.DEFAULT]
   * @returns {Promise} - Returns [registered, reason].
   */

  async registerProof(proof, mode) {
    // Its coins are checked first, outside the lock, so that votes, tips
    // and rejections need not wait while an SPV node fetches them.
    let verified = null;
    if (!this.exists(proof.id()) && !this.danglingProofPool.has(proof.id()))
      verified = await this.verifyInTurn(proof);

    const unlock = await this.locker.lock();
    try {
      return await this._registerProof(proof, mode, verified);
    } finally {
      unlock();
    }
  }

  // Private.
  /**
   * Check a proof's coins, one proof at a time: first the proofs of nodes
   * waiting on theirs, so an SPV node, slow to fetch coins, counts the
   * nodes it has before proofs it only heard of.
   * @private
   * @param {Proof} proof
   * @returns {Promise} - Returns [valid, reason].
   */

  async verifyInTurn(proof) {
    if (this.verifyingProof)
      await new Promise(resolve => this.verifyWaiting.push({proof, resolve}));

    this.verifyingProof = true;

    try {
      return await this.verifier.verify(proof);
    } finally {
      this.nextToVerify();
    }
  }

  /**
   * @private
   */

  nextToVerify() {
    if (this.verifyWaiting.length === 0) {
      this.verifyingProof = false;
      return;
    }

    const pending = new Set();
    for (const {proofId} of this.pendingNodes.values())
      pending.add(proofId.toString('hex'));

    let i = this.verifyWaiting.findIndex((w) => {
      return pending.has(w.proof.id().toString('hex'));
    });

    if (i === -1)
      i = 0;

    // Handed over: still verifying.
    const [next] = this.verifyWaiting.splice(i, 1);
    next.resolve();
  }

  async _registerProof(proof, mode = registrationMode.DEFAULT,
    verified = null) {
    const id = proof.id();

    const known = () => (mode !== registrationMode.FORCE_ACCEPT
      || !this.conflictingProofPool.has(id)) && this.exists(id);

    if (known())
      return [false, 'proof-already-registered'];

    // Evicted for dangling: look for a node rather than registering it.
    if (this.danglingProofPool.has(id) && !this.hasPendingNode(id)) {
      this.needMoreNodes = true;
      return [false, 'dangling-proof'];
    }

    const [valid, reason] = verified || await this.verifier.verify(proof);

    // It may have been registered while we checked the chain.
    if (known())
      return [false, 'proof-already-registered'];

    if (!valid) {
      if (reason === 'immature-utxo') {
        this.immatureProofPool.addIfPreferred(proof);
        if (this.immatureProofPool.size > MAX_IMMATURE_PROOFS) {
          const lowest = this.immatureProofPool.getLowestScoreProof();
          this.immatureProofPool.remove(lowest.id());
        }
        return [false, 'immature-proof'];
      }

      if (reason === 'utxo-missing-or-spent')
        return [false, 'utxo-missing-or-spent'];

      return [false, 'invalid-proof', reason];
    }

    const now = this.now();
    const nextCooldown = now + this.conflictingProofCooldown;

    const [result, conflicts] = this.validProofPool.addIfNoConflict(proof);

    if (result === ProofPool.status.DUPLICATED)
      return [false, 'proof-already-registered'];

    if (result === ProofPool.status.REJECTED) {
      if (mode !== registrationMode.FORCE_ACCEPT) {
        let bestConflictTime = 0;

        for (const other of conflicts) {
          const peer = this.getPeerByProof(other.id());
          assert(peer);
          bestConflictTime = Math.max(bestConflictTime,
            peer.nextPossibleConflictTime);
          this.updateNextPossibleConflictTime(peer.peerId, nextCooldown);
        }

        if (bestConflictTime > now)
          return [false, 'cooldown-not-elapsed'];

        // Perhaps it beats the proofs it conflicts with.
        const [replaced] = this.validProofPool.addIfPreferred(proof);

        if (replaced !== ProofPool.status.SUCCEED) {
          const [filed] = this.conflictingProofPool.addIfPreferred(proof);
          return filed === ProofPool.status.REJECTED
            ? [false, 'rejected-proof']
            : [false, 'conflicting-utxos'];
        }

        this.moveToConflictingPool(conflicts);
      } else {
        this.conflictingProofPool.remove(id);
        this.moveToConflictingPool(conflicts);
        const [added] = this.validProofPool.addIfNoConflict(proof);
        assert(added === ProofPool.status.SUCCEED);
      }
    }

    // Belt and suspenders: a proof with a peer is not conflicting.
    this.conflictingProofPool.remove(id);

    // A peer with these coins supersedes dangling proofs of them.
    for (const other of this.danglingProofPool.getConflicts(proof))
      this.danglingProofPool.remove(other.id());

    const peer = {
      peerId: this.nextPeerId++,
      proof,
      index: -1,
      nodeCount: 0,
      registrationTime: now,
      nextPossibleConflictTime: nextCooldown,
      hasFinalized: false
    };

    this.peers.set(peer.peerId, peer);
    this.peersByProof.set(id.toString('hex'), peer.peerId);
    this.totalPeersScore += proof.getScore();

    // Attach the nodes that were waiting for this proof.
    for (const pending of [...this.pendingNodes.values()]) {
      if (pending.proofId.equals(id))
        this.addOrUpdateNode(peer, pending.nodeId, pending.maxElements);
    }

    if (this.stakingPreConsensus)
      this.addStakeContender(proof);

    return [true, 'valid'];
  }

  // Private.
  moveToConflictingPool(proofs) {
    for (const proof of proofs) {
      const peer = this.getPeerByProof(proof.id());
      if (peer)
        this.removePeer(peer.peerId);
      this.conflictingProofPool.addIfPreferred(proof);
    }
  }

  /**
   * Drop a proof, pulling back any proofs it conflicted with.
   * @param {Buffer} id
   * @param {Number} [mode=rejectionMode.DEFAULT]
   * @returns {Promise} - Returns Boolean.
   */

  async rejectProof(id, mode) {
    const unlock = await this.locker.lock();
    try {
      return await this._rejectProof(id, mode);
    } finally {
      unlock();
    }
  }

  // Private.
  async _rejectProof(id, mode = rejectionMode.DEFAULT) {
    if (this.danglingProofPool.has(id) && mode === rejectionMode.INVALIDATE) {
      this.danglingProofPool.remove(id);
      return true;
    }

    if (!this.exists(id))
      return false;

    if (this.immatureProofPool.remove(id))
      return true;

    if (mode === rejectionMode.DEFAULT && this.conflictingProofPool.has(id))
      return true;

    if (mode === rejectionMode.INVALIDATE
        && this.conflictingProofPool.remove(id)) {
      return true;
    }

    const peer = this.getPeerByProof(id);
    assert(peer);

    const {proof} = peer;

    if (!this.removePeer(peer.peerId))
      return false;

    for (const {stake} of proof.stakes) {
      const other = this.conflictingProofPool.getByOutpoint(stake.outpoint);
      if (!other)
        continue;
      this.conflictingProofPool.remove(other.id());
      await this._registerProof(other);
    }

    if (mode === rejectionMode.DEFAULT)
      this.conflictingProofPool.addIfPreferred(proof);

    return true;
  }

  /**
   * Re-check proofs against the new tip: drop those that no longer hold,
   * and register immature ones that have matured.
   * @returns {Promise} - Returns Proof[] newly registered.
   */

  async updatedBlockTip() {
    const unlock = await this.locker.lock();
    try {
      return await this._updatedBlockTip();
    } finally {
      unlock();
    }
  }

  // Private.
  async _updatedBlockTip() {
    const invalid = [];
    const immature = [];

    for (const peer of this.peers.values()) {
      const [valid, reason] = await this.verifier.verify(peer.proof);
      if (!valid) {
        if (reason === 'immature-utxo')
          immature.push(peer.proof);
        invalid.push(peer.proof.id());
      }
    }

    for (const proof of this.danglingProofPool.values()) {
      const [valid] = await this.verifier.verify(proof);
      if (!valid)
        invalid.push(proof.id());
    }

    // Before the rescan, so proofs that conflicted with these come back.
    for (const id of invalid)
      await this._rejectProof(id, rejectionMode.INVALIDATE);

    const registered = [];
    for (const proof of this.immatureProofPool.clear()) {
      const [ok] = await this._registerProof(proof);
      if (ok)
        registered.push(proof);
    }

    for (const proof of immature)
      this.immatureProofPool.addIfPreferred(proof);

    return registered;
  }

  /**
   * Drop peers that went without a node too long, unless the network
   * says the proof is present; and pull back dangling proofs it says are.
   * @returns {Promise} - Returns Proof[] registered again.
   */

  async cleanupDanglingProofs() {
    const unlock = await this.locker.lock();
    try {
      return await this._cleanupDanglingProofs();
    } finally {
      unlock();
    }
  }

  // Private.
  async _cleanupDanglingProofs() {
    const now = this.now();
    const newlyDangling = [];

    for (const peer of this.peers.values()) {
      if (peer.nodeCount === 0
          && !this.isLocalProof(peer.proof.id())
          && peer.registrationTime + DANGLING_TIMEOUT <= now
          && this.getRemotePresenceStatus(peer.proof.id()) !== true) {
        newlyDangling.push(peer.proof);
      }
    }

    const registered = [];
    for (const proof of [...this.danglingProofPool.values()]) {
      if (this.getRemotePresenceStatus(proof.id()) !== true)
        continue;
      this.danglingProofPool.remove(proof.id());
      const [ok] = await this._registerProof(proof);
      if (ok)
        registered.push(proof);
    }

    for (const proof of newlyDangling) {
      await this._rejectProof(proof.id(), rejectionMode.INVALIDATE);

      // Its coins have a better peer already.
      if (this.validProofPool.getConflicts(proof).length > 0)
        continue;

      this.danglingProofPool.addIfPreferred(proof);
    }

    // Dangling proofs suggest we need more nodes.
    this.needMoreNodes = newlyDangling.length > 0;

    return registered;
  }

  exists(id) {
    return this.getPeerByProof(id) != null
      || this.conflictingProofPool.has(id)
      || this.immatureProofPool.has(id);
  }

  getProof(id) {
    const peer = this.getPeerByProof(id);
    if (peer)
      return peer.proof;
    return this.conflictingProofPool.get(id)
      || this.immatureProofPool.get(id);
  }

  isBoundToPeer(id) {
    return this.getPeerByProof(id) != null;
  }

  isImmature(id) {
    return this.immatureProofPool.has(id);
  }

  isInConflictingPool(id) {
    return this.conflictingProofPool.has(id);
  }

  isDangling(id) {
    return this.danglingProofPool.has(id);
  }

  // Private.
  hasPendingNode(id) {
    for (const pending of this.pendingNodes.values()) {
      if (pending.proofId.equals(id))
        return true;
    }
    return false;
  }

  /**
   * Proofs we share with other nodes (getavaproofs): those whose peers
   * have a node.
   * @returns {Proof[]}
   */

  /**
   * Our peers, as Bitcoin ABC's dumpPeersToFile writes them: each proof,
   * whether it was finalized, when it registered, and when it may next
   * be replaced by a conflicting one.
   * @returns {Buffer}
   */

  dumpPeers() {
    const peers = [...this.peers.values()];

    // And those loaded but not checked yet, as they were.
    for (const [key, peer] of this.unloadedPeers) {
      if (!this.peersByProof.has(key))
        peers.push(peer);
    }

    const bw = bio.write(16 + peers.reduce((size, peer) => {
      return size + peer.proof.getSize() + 17;
    }, 0));

    bw.writeU64(PEERS_DUMP_VERSION);
    bw.writeU64(peers.length);

    for (const peer of peers) {
      peer.proof.toWriter(bw);
      bw.writeU8(peer.hasFinalized ? 1 : 0);
      bw.writeI64(peer.registrationTime);
      bw.writeI64(peer.nextPossibleConflictTime);
    }

    return bw.render();
  }

  /**
   * Register the peers of a dump, as Bitcoin ABC's loadPeersFromFile: each
   * proof is checked as any, and keeps what we had learned of it.
   * @param {Buffer} data
   * @returns {Promise} - Returns Proof[], those registered.
   */

  async loadPeers(data) {
    const registered = [];
    const loaded = [];
    const br = bio.read(data);

    try {
      if (br.readU64() !== PEERS_DUMP_VERSION)
        return registered;

      const count = br.readU64();

      for (let i = 0; i < count; i++) {
        loaded.push({
          proof: Proof.fromReader(br),
          hasFinalized: br.readU8() === 1,
          registrationTime: br.readI64(),
          nextPossibleConflictTime: br.readI64()
        });
      }
    } catch (e) {
      // A damaged file: what was read so far counts.
    }

    for (const entry of loaded)
      this.unloadedPeers.set(entry.proof.id().toString('hex'), entry);

    for (const entry of loaded) {
      const {proof} = entry;

      let ok;
      try {
        [ok] = await this.registerProof(proof);
      } finally {
        // Checked: a peer now, or not to be saved again.
        this.unloadedPeers.delete(proof.id().toString('hex'));
      }

      if (!ok)
        continue;

      const peer = this.getPeerByProof(proof.id());

      if (!peer)
        continue;

      peer.hasFinalized = entry.hasFinalized;
      peer.registrationTime = entry.registrationTime;
      peer.nextPossibleConflictTime = entry.nextPossibleConflictTime;

      registered.push(proof);
    }

    return registered;
  }

  getShareableProofs() {
    const proofs = [];
    for (const peer of this.peers.values()) {
      if (peer.nodeCount > 0 || this.isLocalProof(peer.proof.id()))
        proofs.push(peer.proof);
    }
    return proofs;
  }

  isLocalProof(id) {
    return this.localProof != null && this.localProof.id().equals(id);
  }

  getTotalPeersScore() {
    return this.totalPeersScore;
  }

  getConnectedPeersScore() {
    return this.connectedPeersScore;
  }

  /*
   * Stake contenders
   */

  addStakeContender(proof) {
    const tip = this.getTip();
    if (tip && proof)
      this.stakeContenderCache.add(tip, proof);
  }

  cleanupStakeContenders(minHeight) {
    this.stakeContenderCache.cleanup(minHeight);
  }

  /**
   * Bitcoin ABC's getStakeContenderStatus: -1 unknown; the cache's vote
   * if not 0; else 2 invalid, 3 conflicting, 4 dangling and not remote,
   * 5 not finalized, 6 registered too recently, or 0.
   * @param {Hash} id - Contender id.
   * @param {Function} isInvalid - (proofId) => Boolean.
   * @returns {Object} {status, prevHash}
   */

  getStakeContenderStatus(id, isInvalid) {
    const info = this.stakeContenderCache.getContenderInfo(id);

    if (!info)
      return {status: -1, prevHash: null};

    const done = status => ({status, prevHash: info.prevHash});

    if (info.voteStatus !== 0)
      return done(info.voteStatus);

    const {proofId} = info;

    if (isInvalid(proofId))
      return done(2);

    if (this.isInConflictingPool(proofId))
      return done(3);

    if (this.isDangling(proofId) && !this.getRemotePresenceStatus(proofId))
      return done(4);

    if (this.isBoundToPeer(proofId)) {
      const peer = this.getPeerByProof(proofId);
      if (!peer || !peer.hasFinalized)
        return done(5);

      const refTime = Math.min(info.prevTime, this.now());
      if (peer.registrationTime >= refTime - 4 * DANGLING_TIMEOUT)
        return done(6);
    }

    return done(0);
  }

  acceptStakeContender(id) {
    this.stakeContenderCache.accept(id);
  }

  /**
   * Finalize a contender: it joins its block's winners.
   * @param {Hash} id
   * @returns {Object} {prevHash, winners}
   */

  finalizeStakeContender(id) {
    const cache = this.stakeContenderCache;
    cache.finalize(id);
    const {prevHash} = cache.getVoteStatus(id);
    return {prevHash, winners: prevHash ? cache.getWinners(prevHash) : []};
  }

  rejectStakeContender(id) {
    this.stakeContenderCache.reject(id);
  }

  getStakeContenderInfo(id) {
    return this.stakeContenderCache.getContenderInfo(id);
  }

  hasAcceptedStakeWinner(prevHash) {
    return this.stakeContenderCache.hasAcceptedWinner(prevHash);
  }

  getStakeContenderWinners(prevHash) {
    return this.stakeContenderCache.getWinners(prevHash);
  }

  promoteStakeContendersToBlock(tip) {
    this.stakeContenderCache.promoteToBlock(tip, (id) => {
      return this.isBoundToPeer(id)
        || (this.isRemotelyPresentProof(id) && this.isDangling(id));
    });
  }

  /**
   * Mark our own winners of the block after `prev` final, and the best
   * contender accepted.
   * @param {ChainEntry} prev
   * @param {Object[]} winners - [{proofId}]
   * @param {Number} maxPollable
   * @returns {Hash[]} The contenders to poll.
   */

  setContenderStatusForLocalWinners(prev, winners, maxPollable) {
    const cache = this.stakeContenderCache;

    for (const winner of winners) {
      if (winner.proofId)
        cache.finalize(contenderId(prev.hash, winner.proofId));
    }

    const pollable = cache.getPollableContenders(prev.hash, maxPollable);

    if (pollable.length > 0)
      cache.accept(pollable[0]);

    return pollable;
  }

  setStakeContenderWinners(prev, payouts) {
    return this.stakeContenderCache.setWinners(prev, payouts);
  }

  /*
   * Remote proofs
   */

  /**
   * Record whether a node has a proof.
   * @param {Buffer} proofId
   * @param {Number} nodeId
   * @param {Boolean} present
   * @returns {Boolean}
   */

  saveRemoteProof(proofId, nodeId, present) {
    const key = proofId.toString('hex');

    // The first time a bound proof is a remote one, make sure it is a
    // contender: promotion keeps only those remote or bound.
    if (present && this.stakingPreConsensus && this.isBoundToPeer(proofId)
        && !this.isRemotelyPresentProof(proofId)) {
      this.addStakeContender(this.getProof(proofId));
    }

    let byNode = this.remoteProofsByNode.get(nodeId);
    if (!byNode) {
      byNode = new Set();
      this.remoteProofsByNode.set(nodeId, byNode);
    }

    // At least MAX_REMOTE_PROOFS a node, up to twice the proofs we have.
    const limit = Math.max(MAX_REMOTE_PROOFS, 2 * this.peers.size);

    // Evict before replacing, as Bitcoin ABC does.
    while (byNode.size >= limit) {
      const oldest = byNode.values().next().value;
      byNode.delete(oldest);
      this.deleteRemoteProof(oldest, nodeId);
    }

    byNode.delete(key);
    byNode.add(key);

    let remotes = this.remoteProofs.get(key);
    if (!remotes) {
      remotes = new Map();
      this.remoteProofs.set(key, remotes);
    }

    remotes.set(nodeId, {present, lastUpdate: this.now()});

    return true;
  }

  getRemoteProofs(nodeId) {
    const byNode = this.remoteProofsByNode.get(nodeId);
    if (!byNode)
      return [];
    return [...byNode].map((key) => {
      const {present, lastUpdate} = this.remoteProofs.get(key).get(nodeId);
      return {proofId: Buffer.from(key, 'hex'), nodeId, present, lastUpdate};
    });
  }

  hasRemoteProofStatus(proofId) {
    return this.remoteProofs.has(proofId.toString('hex'));
  }

  isRemotelyPresentProof(proofId) {
    const remotes = this.remoteProofs.get(proofId.toString('hex'));
    if (!remotes)
      return false;
    for (const {present} of remotes.values()) {
      if (present)
        return true;
    }
    return false;
  }

  clearRemoteProofs(nodeId) {
    const byNode = this.remoteProofsByNode.get(nodeId);
    if (!byNode)
      return;
    for (const key of byNode)
      this.deleteRemoteProof(key, nodeId);
    this.remoteProofsByNode.delete(nodeId);
  }

  // Private.
  deleteRemoteProof(key, nodeId) {
    const remotes = this.remoteProofs.get(key);
    if (!remotes)
      return;
    remotes.delete(nodeId);
    if (remotes.size === 0)
      this.remoteProofs.delete(key);
  }

  /**
   * Whether the network says a proof is present: the stake-weighted
   * reports of our nodes, each peer's score split across its nodes.
   * @param {Buffer} proofId
   * @returns {Boolean|null} Null if inconclusive.
   */

  getRemotePresenceStatus(proofId) {
    const remotes = this.remoteProofs.get(proofId.toString('hex'));

    if (!remotes)
      return null;

    let total = 0;
    let present = 0;
    let missing = 0;

    for (const [nodeId, remote] of remotes) {
      const node = this.nodes.get(nodeId);
      if (!node)
        continue;

      const peer = this.peers.get(node.peerId);
      if (!peer || peer.nodeCount === 0)
        continue;

      const score = peer.proof.getScore() / peer.nodeCount;

      total += score;
      if (remote.present)
        present += score;
      else
        missing += score;
    }

    if (present / total > 0.55)
      return true;

    if (missing / total > 0.55)
      return false;

    return null;
  }

  /**
   * Whether a proof is flaky, so a staking reward winner may be passed
   * over: marked so by hand, without a node, or missing, by the stake of
   * nodes that say so, for more than 30% of all stake. Nodes missing more
   * than 3 proofs are not believed.
   * @param {Buffer} proofId
   * @returns {Boolean}
   */

  isFlaky(proofId) {
    const key = proofId.toString('hex');

    if (this.manualFlaky.has(key))
      return true;

    const own = this.getPeerByProof(proofId);
    if (own && own.nodeCount === 0)
      return true;

    let total = 0;
    let missing = 0;

    for (const peer of this.peers.values()) {
      total += peer.proof.getScore();

      // What this peer's nodes say is missing.
      const lost = new Set();
      for (const node of this.nodes.values()) {
        if (node.peerId !== peer.peerId)
          continue;
        for (const remote of this.getRemoteProofs(node.nodeId)) {
          if (!remote.present)
            lost.add(remote.proofId.toString('hex'));
        }
      }

      if (lost.size > 3)
        continue;

      if (lost.has(key))
        missing += peer.proof.getScore();
    }

    return missing / total > 0.3;
  }

  setFlaky(proofId) {
    const key = proofId.toString('hex');
    const added = !this.manualFlaky.has(key);
    this.manualFlaky.add(key);
    return added;
  }

  unsetFlaky(proofId) {
    return this.manualFlaky.delete(proofId.toString('hex'));
  }

  /**
   * Check the internal accounting, for tests.
   * @returns {Boolean}
   */

  verify() {
    let prevStop = 0;
    let scoreFromSlots = 0;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];

      if (slot.start < prevStop)
        return false;

      prevStop = slotStop(slot);

      if (slot.peerId === NO_PEER)
        continue;

      const peer = this.peers.get(slot.peerId);
      if (!peer || peer.index !== i)
        return false;

      scoreFromSlots += slot.score;
    }

    if (scoreFromSlots !== this.connectedPeersScore)
      return false;

    let scoreFromAllPeers = 0;
    let scoreFromPeersWithNodes = 0;
    const outpoints = new Set();

    for (const peer of this.peers.values()) {
      const score = peer.proof.getScore();
      scoreFromAllPeers += score;

      for (const {stake} of peer.proof.stakes) {
        if (this.validProofPool.getByOutpoint(stake.outpoint) !== peer.proof)
          return false;

        const key = stake.outpoint.toKey().toString('hex');
        if (outpoints.has(key))
          return false;
        outpoints.add(key);
      }

      let count = 0;
      for (const node of this.nodes.values()) {
        if (node.peerId === peer.peerId)
          count += 1;
      }

      if (count !== peer.nodeCount)
        return false;

      if (peer.nodeCount === 0)
        continue;

      scoreFromPeersWithNodes += score;

      const slot = this.slots[peer.index];
      if (!slot || slot.peerId !== peer.peerId || slot.score !== score)
        return false;
    }

    if (scoreFromAllPeers !== this.totalPeersScore)
      return false;

    if (scoreFromPeersWithNodes !== this.connectedPeersScore)
      return false;

    return this.validProofPool.byOutpoint.size === outpoints.size;
  }
}

/*
 * Helpers
 */

function slotStop(slot) {
  return slot.start + slot.score;
}

/**
 * Find the peer whose slot holds a point: an interpolated search, then
 * a linear one, as Bitcoin ABC does.
 * @param {Object[]} slots
 * @param {Number} slot
 * @param {Number} max
 * @returns {Number} Peer id, or NO_PEER.
 */

function selectPeerImpl(slots, slot, max) {
  assert(slot <= max);

  let begin = 0;
  let end = slots.length;
  let bottom = 0;
  let top = max;

  const contains = (s, x) => s.start <= x && x < slotStop(s);

  while (end - begin > 8) {
    if (slot < bottom || slot >= top)
      return NO_PEER;

    const i = begin + Math.floor((slot - bottom) * (end - begin)
      / (top - bottom));

    assert(begin <= i && i < end);

    if (contains(slots[i], slot))
      return slots[i].peerId;

    // Undershot.
    if (slot >= slotStop(slots[i])) {
      begin = i + 1;
      if (begin >= end)
        return NO_PEER;
      bottom = slots[begin].start;
      continue;
    }

    // Overshot.
    if (slots[i].start > slot) {
      end = i;
      top = slots[end].start;
      continue;
    }

    return NO_PEER;
  }

  for (let i = begin; i < end; i++) {
    if (contains(slots[i], slot))
      return slots[i].peerId;
  }

  return NO_PEER;
}

// Uniform in [0, max), for max below 2^48.
function randomBelow(max) {
  assert(max > 0 && max < 2 ** 48);
  const limit = Math.floor(2 ** 48 / max) * max;
  for (;;) {
    const x = random.randomBytes(6).readUIntLE(0, 6);
    if (x < limit)
      return x % max;
  }
}

/*
 * Expose
 */

PeerManager.DANGLING_TIMEOUT = DANGLING_TIMEOUT;
PeerManager.CONFLICTING_PROOF_COOLDOWN = CONFLICTING_PROOF_COOLDOWN;
PeerManager.MAX_IMMATURE_PROOFS = MAX_IMMATURE_PROOFS;
PeerManager.MAX_REMOTE_PROOFS = MAX_REMOTE_PROOFS;
PeerManager.NO_PEER = NO_PEER;
PeerManager.NO_NODE = NO_NODE;
PeerManager.PEERS_DUMP_VERSION = PEERS_DUMP_VERSION;
PeerManager.registrationMode = registrationMode;
PeerManager.rejectionMode = rejectionMode;
PeerManager.selectPeerImpl = selectPeerImpl;

module.exports = PeerManager;
