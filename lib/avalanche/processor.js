/*!
 * processor.js - avalanche processor for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/processor.{h,cpp} and the
 * avalanche handling in src/net_processing.cpp.
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const random = require('bcrypto/lib/random');
const packets = require('../net/packets');
const InvItem = require('../primitives/invitem');
const Proof = require('./proof');
const PeerManager = require('./peermanager');
const ProofPool = require('./proofpool');
const VoteRecord = require('./voterecord');
const {selectWinners} = require('./stakingrewards');
const {CompactProofs, ProofsRequest} = require('./compactproofs');
const {
  Hello,
  Poll,
  Response,
  invTypes,
  MAX_ELEMENT_POLL_LEGACY,
  DEFAULT_MAX_ELEMENT_POLL
} = require('./protocol');

/*
 * Constants
 */

// Least stake known, in satoshis, for a usable quorum: 10B XEC.
const MIN_QUORUM_STAKE = 1000000000000;

// Least share of that stake we must have a node for.
const MIN_QUORUM_CONNECTED_STAKE_RATIO = 0.8;

// Not in Bitcoin ABC: with nodes for this much of the stake, polls start,
// and an item may finalize below the ratio above if every staker we have
// a node for voted for it and none against. To mislead us then, an
// attacker must hold all the stake we hear: half of all of it. A node
// that cannot take inbound connections may never see the ratio above,
// as many stakers only connect out. The default is for those (SPV nodes);
// unset, the processor keeps Bitcoin ABC's rule.
const MIN_QUORUM_UNANIMOUS_STAKE_RATIO = 0.5;

// Least nodes that sent us their proofs (avaproofs).
const MIN_AVAPROOFS_NODE_COUNT = 8;

// Least nodes before polling can converge.
const MIN_QUORUM_NODE_COUNT = 8;

// Seconds a peer must wait between requests of each kind.
const GETAVAADDR_INTERVAL = 2 * 60;
const GETAVAPROOFS_INTERVAL = 60;

// Seconds we keep the proofs we sent a peer in avaproofs for it to
// request from.
const AVAPROOFS_TIMEOUT = 2 * 60;

// Seconds before a proof we know may be sent to anyone who asks.
const UNCONDITIONAL_RELAY_DELAY = 2 * 60;

// Seconds before asking another node for a proof one did not send.
const PROOF_REQUEST_TIMEOUT = 60;

// Bitcoin ABC's limit on short ids sharing a bucket.
const MAX_SHORTID_BUCKET = 15;

// Recently invalid proofs we remember, not to fetch them again.
const MAX_INVALID_PROOFS = 100000;

const MAX_ADDR_TO_SEND = 1000;

// Milliseconds a node has to answer a poll.
const QUERY_TIMEOUT = 10000;

// Milliseconds between polls.
const TIME_STEP = 10;

// Seconds before a finalized proof may be replaced.
const PEER_REPLACEMENT_COOLDOWN = 24 * 60 * 60;

// Recently finalized items we remember, not to poll them again.
const FINALIZED_ITEMS = VoteRecord.MAX_INFLIGHT_POLL * 20;

// Blocks back that staking reward winners are kept for.
const STAKING_REWARDS_KEPT = 10;

// Response faults tolerated before they count toward a ban.
const MAX_MESSAGE_FAULTS = 12;

// What polls decide about an item.
const voteStatus = {
  INVALID: 0,
  REJECTED: 1,
  ACCEPTED: 2,
  FINALIZED: 3,
  STALE: 4
};

// What we poll on, in Bitcoin ABC's order: proofs first.
const itemTypes = {
  PROOF: 0,
  BLOCK: 1
};

/**
 * Avalanche Processor
 * Speaks avalanche to the pool's peers: hellos, proof relay and peer
 * addresses, and judges whether we have a quorum.
 * @alias module:avalanche.Processor
 * @extends EventEmitter
 */

class Processor extends EventEmitter {
  /**
   * @param {Object} options
   * @param {PeerManager} options.peerManager
   * @param {Function} options.isIBD - Whether the chain is still syncing.
   * @param {Object} [options.logger]
   * @param {Number} [options.minQuorumStake] - Satoshis.
   * @param {Number} [options.minQuorumConnectedStakeRatio]
   * @param {Number} [options.minQuorumUnanimousStakeRatio] - At or above
   * minQuorumConnectedStakeRatio, polls are as Bitcoin ABC's.
   * @param {Number} [options.minAvaproofsNodeCount]
   * @param {Number} [options.maxElementPoll]
   * @param {Function} [options.now] - Seconds.
   * @param {Chain} [options.chain] - To poll blocks.
   * @param {Function} [options.ms] - Milliseconds, for polls.
   * @param {Number} [options.queryTimeout] - Milliseconds.
   * @param {Number} [options.staleVoteThreshold]
   * @param {Number} [options.staleVoteFactor]
   * @param {Boolean} [options.stakingRewards] - Compute staking reward
   * winners (from Cowperthwaite).
   */

  constructor(options) {
    super();

    assert(options && options.peerManager);
    assert(typeof options.isIBD === 'function');

    this.peerManager = options.peerManager;
    this.isIBD = options.isIBD;
    this.logger = options.logger
      ? options.logger.context('avalanche')
      : null;
    this.now = options.now || (() => Math.floor(Date.now() / 1000));

    this.minQuorumScore = Proof.amountToScore(options.minQuorumStake != null
      ? options.minQuorumStake
      : MIN_QUORUM_STAKE);
    this.minQuorumConnectedScoreRatio =
      options.minQuorumConnectedStakeRatio != null
        ? options.minQuorumConnectedStakeRatio
        : MIN_QUORUM_CONNECTED_STAKE_RATIO;
    this.minQuorumUnanimousScoreRatio =
      options.minQuorumUnanimousStakeRatio != null
        ? options.minQuorumUnanimousStakeRatio
        : this.minQuorumConnectedScoreRatio;
    this.minAvaproofsNodeCount = options.minAvaproofsNodeCount != null
      ? options.minAvaproofsNodeCount
      : MIN_AVAPROOFS_NODE_COUNT;
    this.maxElementPoll = options.maxElementPoll || DEFAULT_MAX_ELEMENT_POLL;

    // Peer id to our avalanche state for it.
    this.peers = new Map();

    this.avaproofsNodeCounter = 0;
    this.quorumIsEstablished = false;

    this.invalidProofs = new Set();

    // Proof id to {announcers: Set, peerId, time} of what we fetch.
    this.requests = new Map();

    // Voting.
    this.chain = options.chain || null;
    this.ms = options.ms || (() => Date.now());
    this.queryTimeout = options.queryTimeout || QUERY_TIMEOUT;
    this.staleVoteThreshold = options.staleVoteThreshold
      || VoteRecord.VOTE_STALE_THRESHOLD;
    this.staleVoteFactor = options.staleVoteFactor
      || VoteRecord.VOTE_STALE_FACTOR;

    this.voteLock = new Lock();
    // Item key to {type, hash, item, record}.
    this.voteRecords = new Map();
    // Node id and round to {nodeId, round, timeout, invs}.
    this.queries = new Map();
    this.round = 0n;
    // Hash to the generation it was finalized in, as Bitcoin ABC's
    // rolling filter: the last two generations and the current one.
    this.recentlyFinalized = new Map();
    this.finalizedGeneration = 0;
    this.finalizedThisGeneration = 0;
    this.invalidatedBlocks = new Set();
    this.finalizationTip = null;

    // Staking rewards: block hash (hex) to {height, winners} for the
    // block after it.
    this.stakingRewardsEnabled = Boolean(options.stakingRewards);
    this.stakingRewards = new Map();
  }

  log(level, ...args) {
    if (this.logger)
      this.logger[level](...args);
  }

  /*
   * Peers
   */

  /**
   * A peer finished its handshake: say hello. We have no proof, so ours
   * carries none, and the peer does not check its signature.
   * @param {Peer} peer
   */

  addPeer(peer) {
    this.peers.set(peer.id, {
      peer,
      enabled: false,
      pubkey: null,
      knownProofs: new Set(),
      proofsToSend: new Set(),
      recentlyAnnounced: new Set(),
      compactProofsRequested: false,
      sharedProofs: [],
      lastSharedProofsUpdate: 0,
      nextGetavaproofs: 0,
      nextGetavaaddr: 0
    });

    const hello = new Hello(null, null, this.maxElementPoll);
    peer.send(new packets.UnknownPacket('avahello', hello.toRaw()));
  }

  removePeer(peer) {
    if (!this.peers.delete(peer.id))
      return;

    this.peerManager.removeNode(peer.id);

    for (const [key, req] of this.requests) {
      req.announcers.delete(peer.id);
      if (req.peerId === peer.id)
        this.requestProof(key);
    }
  }

  isAvalancheMessage(cmd) {
    switch (cmd) {
      case 'avahello':
      case 'avapoll':
      case 'avaresponse':
      case 'avaproof':
      case 'getavaaddr':
      case 'getavaproofs':
      case 'avaproofs':
      case 'avaproofsreq':
        return true;
    }
    return false;
  }

  /**
   * Handle an avalanche message.
   * @param {Peer} peer
   * @param {UnknownPacket} packet
   * @returns {Promise}
   */

  async handlePacket(peer, packet) {
    const state = this.peers.get(peer.id);

    if (!state)
      return;

    try {
      switch (packet.cmd) {
        case 'avahello':
          this.handleHello(state, packet.data);
          break;
        case 'avaproof':
          await this.receivedProof(state, Proof.fromRaw(packet.data));
          break;
        case 'getavaproofs':
          this.handleGetProofs(state);
          break;
        case 'avaproofs':
          await this.handleProofs(state, packet.data);
          break;
        case 'avaproofsreq':
          this.handleProofsRequest(state, packet.data);
          break;
        case 'getavaaddr':
          this.handleGetAddr(state);
          break;
        case 'avaresponse':
          await this.handleResponse(state, packet.data);
          break;
      }
    } catch (e) {
      // A message we cannot parse.
      this.log('debug', 'Bad %s from %s: %s.',
        packet.cmd, peer.hostname(), e.message);
      this.misbehaving(state, `malformed-${packet.cmd}`);
    }
  }

  misbehaving(state, reason) {
    this.log('debug', 'Misbehaving %s: %s.', state.peer.hostname(), reason);
    state.peer.increaseBan(100);
  }

  handleHello(state, data) {
    const {peer} = state;

    if (state.pubkey) {
      this.log('debug', 'Ignoring avahello from %s: already a node.',
        peer.hostname());
      return;
    }

    const hello = Hello.fromRaw(data);

    // A zero limited id: the peer has no proof.
    if (hello.hasProof()) {
      // ABC reads a missing extra entropy as 1, and we send none.
      const theirs = peer.remoteEntropy != null ? peer.remoteEntropy : 1n;
      const [valid, reason, pubkey] = hello.verify(peer.remoteNonce,
        peer.localNonce, theirs, 1n);

      if (!valid) {
        this.misbehaving(state, reason === 'invalid-avahello-signature'
          ? reason
          : 'invalid-delegation');
        return;
      }

      if (hello.maxElements < MAX_ELEMENT_POLL_LEGACY) {
        this.misbehaving(state, 'avahello-max-elements-too-low');
        return;
      }

      state.pubkey = pubkey;

      const proofId = hello.delegation.proofId();

      if (!this.alreadyHaveProof(proofId))
        this.addProofAnnouncement(state, proofId);

      this.peerManager.addNode(peer.id, proofId,
        Math.min(hello.maxElements, this.maxElementPoll));
    }

    state.enabled = true;

    this.emit('hello', peer, hello);

    // Ask outbound nodes for avalanche peers and their proofs.
    if (peer.outbound) {
      this.send(peer, 'getavaaddr');
      if (!this.isIBD())
        this.requestCompactProofs(state);
    }
  }

  /*
   * Proofs
   */

  alreadyHaveProof(proofId) {
    return this.peerManager.exists(proofId)
      || this.invalidProofs.has(proofId.toString('hex'));
  }

  setInvalid(proofId) {
    const key = proofId.toString('hex');
    this.invalidProofs.delete(key);
    this.invalidProofs.add(key);
    if (this.invalidProofs.size > MAX_INVALID_PROOFS)
      this.invalidProofs.delete(this.invalidProofs.values().next().value);
  }

  /**
   * A proof arrived, by avaproof or prefilled in avaproofs.
   * @private
   * @returns {Promise} - Returns false if the peer sent a bad one.
   */

  async receivedProof(state, proof) {
    const id = proof.id();
    const key = id.toString('hex');

    state.knownProofs.add(key);

    // Its coins cannot be checked yet; it can be fetched again later.
    if (this.isIBD())
      return true;

    const {peer} = state;
    const staker = state.pubkey != null;

    this.requests.delete(key);

    if (this.alreadyHaveProof(id)) {
      if (staker)
        this.peerManager.saveRemoteProof(id, peer.id, true);
      return true;
    }

    const [ok, reason, detail] = await this.peerManager.registerProof(proof);

    if (ok) {
      this.log('debug', 'New avalanche proof %s from %s.',
        proof.rid(), peer.hostname());
      this.relayProof(id);
      await this.reconcileOrFinalize(proof);
      this.emit('proof', proof);
    }

    if (reason === 'invalid-proof') {
      this.setInvalid(id);
      this.misbehaving(state, detail || reason);
      return false;
    }

    if (staker)
      this.peerManager.saveRemoteProof(id, peer.id, true);

    return true;
  }

  /**
   * Announce a proof to the peers that do not know it.
   * @param {Buffer} proofId
   */

  relayProof(proofId) {
    const key = proofId.toString('hex');
    for (const state of this.peers.values()) {
      if (!state.knownProofs.has(key))
        state.proofsToSend.add(key);
    }
  }

  /**
   * Send the proof invs that relayProof queued.
   */

  flushProofInvs() {
    for (const state of this.peers.values()) {
      if (state.proofsToSend.size === 0)
        continue;

      const items = [];
      for (const key of state.proofsToSend) {
        state.knownProofs.add(key);
        state.recentlyAnnounced.add(key);
        items.push(new InvItem(invTypes.AVA_PROOF, Buffer.from(key, 'hex')));
      }

      state.proofsToSend.clear();
      state.peer.send(new packets.InvPacket(items));
    }
  }

  /**
   * A peer announced proofs in an inv.
   * @param {Peer} peer
   * @param {Buffer[]} hashes
   */

  handleProofInv(peer, hashes) {
    const state = this.peers.get(peer.id);

    if (!state)
      return;

    for (const id of hashes) {
      state.knownProofs.add(id.toString('hex'));
      if (!this.alreadyHaveProof(id) && !this.isIBD())
        this.addProofAnnouncement(state, id);
    }
  }

  /**
   * A peer asked for proofs in a getdata.
   * @param {Peer} peer
   * @param {Buffer[]} hashes
   * @returns {Buffer[]} Those we do not have.
   */

  handleProofGetData(peer, hashes) {
    const state = this.peers.get(peer.id);
    const notFound = [];

    for (const id of hashes) {
      const proof = state ? this.findProofForGetData(state, id) : null;
      if (proof)
        this.send(peer, 'avaproof', proof.toRaw());
      else
        notFound.push(id);
    }

    return notFound;
  }

  findProofForGetData(state, id) {
    const peer = this.peerManager.getPeerByProof(id);

    if (!peer)
      return null;

    // Known long enough for anyone, or announced to this peer.
    if (peer.registrationTime <= this.now() - UNCONDITIONAL_RELAY_DELAY)
      return peer.proof;

    if (state.recentlyAnnounced.has(id.toString('hex')))
      return peer.proof;

    return null;
  }

  addProofAnnouncement(state, id) {
    const key = id.toString('hex');

    let req = this.requests.get(key);
    if (!req) {
      req = {id, announcers: new Set(), tried: new Set(), peerId: -1, time: 0};
      this.requests.set(key, req);
    }

    req.announcers.add(state.peer.id);

    if (req.peerId === -1)
      this.requestProof(key);
  }

  /**
   * Ask an announcer we have not asked yet for a proof.
   * @private
   */

  requestProof(key) {
    const req = this.requests.get(key);

    if (!req)
      return;

    req.peerId = -1;

    for (const peerId of req.announcers) {
      if (req.tried.has(peerId))
        continue;

      const state = this.peers.get(peerId);
      if (!state)
        continue;

      req.tried.add(peerId);
      req.peerId = peerId;
      req.time = this.now();

      const item = new InvItem(invTypes.AVA_PROOF, req.id);
      state.peer.send(new packets.GetDataPacket([item]));
      return;
    }

    // Nobody left to ask.
    this.requests.delete(key);
  }

  /**
   * Re-ask for proofs a node did not send in time.
   */

  expireProofRequests() {
    const now = this.now();
    for (const [key, req] of this.requests) {
      if (req.peerId !== -1 && now - req.time >= PROOF_REQUEST_TIMEOUT)
        this.requestProof(key);
    }
  }

  /*
   * Compact proofs
   */

  requestCompactProofs(state) {
    this.send(state.peer, 'getavaproofs');
    state.compactProofsRequested = true;
  }

  handleGetProofs(state) {
    const now = this.now();

    // At most one a minute.
    if (now < state.nextGetavaproofs)
      return;

    state.nextGetavaproofs = now + GETAVAPROOFS_INTERVAL;
    state.lastSharedProofsUpdate = now;
    state.sharedProofs = this.peerManager.getShareableProofs();

    const compact = CompactProofs.fromProofs(state.sharedProofs);
    this.send(state.peer, 'avaproofs', compact.toRaw());
  }

  async handleProofs(state, data) {
    // Only if we asked.
    if (!state.compactProofsRequested) {
      this.log('debug', 'Ignoring unsolicited avaproofs.');
      return;
    }

    state.compactProofsRequested = false;

    let compact;
    try {
      compact = CompactProofs.fromRaw(data);
    } catch (e) {
      this.misbehaving(state, 'avaproofs-bad-indexes');
      return;
    }

    for (const {proof} of compact.prefilled) {
      if (!await this.receivedProof(state, proof))
        return;
    }

    if (compact.shortIds.length === 0)
      return;

    // Short ids fill, in order, the indexes prefilled proofs leave.
    const filled = new Set(compact.prefilled.map(p => p.index));
    const positions = [];
    for (let i = 0; positions.length < compact.shortIds.length; i++) {
      if (!filled.has(i))
        positions.push(i);
    }

    // Short id to the indexes that hold it.
    const buckets = new Map();
    for (const [i, sid] of compact.shortIds.entries()) {
      let bucket = buckets.get(sid);
      if (!bucket) {
        bucket = [];
        buckets.set(sid, bucket);
      }
      bucket.push(positions[i]);
    }

    // Suspicious; do not ban, but stop.
    for (const bucket of buckets.values()) {
      if (bucket.length > MAX_SHORTID_BUCKET)
        return;
    }

    const matched = new Set();
    const statuses = [];

    const match = (proof) => {
      const bucket = buckets.get(compact.sid(proof.id()));

      if (!bucket) {
        statuses.push([proof.id(), false]);
        return;
      }

      // Short id collision: leave it out, and request the indexes.
      if (bucket.length !== 1 || matched.has(bucket[0])) {
        for (const index of bucket)
          matched.delete(index);
        buckets.set(compact.sid(proof.id()), []);
        return;
      }

      matched.add(bucket[0]);
      statuses.push([proof.id(), true]);
    };

    for (const peer of this.peerManager.peers.values())
      match(peer.proof);

    for (const proof of this.peerManager.danglingProofPool.values())
      match(proof);

    const indexes = [];
    for (let i = 0; i < compact.size; i++) {
      if (!filled.has(i) && !matched.has(i))
        indexes.push(i);
    }

    const req = new ProofsRequest(indexes);
    this.send(state.peer, 'avaproofsreq', req.toRaw());

    this.avaproofsSent(state.peer.id);

    // Only stakers' views count.
    if (state.pubkey) {
      this.peerManager.clearRemoteProofs(state.peer.id);
      for (const [id, present] of statuses)
        this.peerManager.saveRemoteProof(id, state.peer.id, present);
    }
  }

  handleProofsRequest(state, data) {
    const req = ProofsRequest.fromRaw(data);
    const shared = state.sharedProofs;

    for (const index of req.indexes) {
      if (index >= shared.length)
        break;
      this.send(state.peer, 'avaproof', shared[index].toRaw());
    }

    state.sharedProofs = [];
  }

  /**
   * Count a node that sent us its proofs, once, outside IBD.
   * @param {Number} nodeId
   */

  avaproofsSent(nodeId) {
    if (this.isIBD())
      return;

    if (this.peerManager.latchAvaproofsSent(nodeId))
      this.avaproofsNodeCounter += 1;
  }

  /*
   * Addresses
   */

  handleGetAddr(state) {
    const now = this.now();

    if (now < state.nextGetavaaddr)
      return;

    state.nextGetavaaddr = now + GETAVAADDR_INTERVAL;

    const items = [];
    for (const other of this.peers.values()) {
      if (!other.enabled || other.peer === state.peer)
        continue;
      items.push(other.peer.address);
      if (items.length >= MAX_ADDR_TO_SEND)
        break;
    }

    if (items.length > 0)
      state.peer.send(new packets.AddrPacket(items));
  }

  /*
   * Quorum
   */

  /**
   * Whether we know enough stake, and have nodes for enough of it, for
   * polls to mean anything. Latched once established, but for the node
   * count.
   * @returns {Boolean}
   */

  isQuorumEstablished() {
    if (this.peerManager.getNodeCount() < MIN_QUORUM_NODE_COUNT)
      return false;

    if (this.quorumIsEstablished)
      return true;

    if (this.isIBD())
      return false;

    if (this.avaproofsNodeCounter < this.minAvaproofsNodeCount)
      return false;

    const total = this.peerManager.getTotalPeersScore();
    const connected = this.peerManager.getConnectedPeersScore();

    if (total < this.minQuorumScore)
      return false;

    const ratio = Math.min(this.minQuorumConnectedScoreRatio,
      this.minQuorumUnanimousScoreRatio);

    if (connected < Math.round(total * ratio))
      return false;

    this.quorumIsEstablished = true;
    this.emit('quorum');

    // Winners now, rather than at the next block.
    if (this.chain && this.chain.tip)
      this.computeStakingReward(this.chain.tip);

    return true;
  }

  /*
   * Periodic work
   */

  /**
   * Ask for avalanche addresses and proofs. Bitcoin ABC does this every
   * 2 to 5 minutes.
   */

  periodicNetworking() {
    const quorum = this.isQuorumEstablished();
    const needMore = this.peerManager.shouldRequestMoreNodes();
    const now = this.now();

    const nodes = [];
    for (const state of this.peers.values()) {
      if (state.enabled)
        nodes.push(state);

      if (now > state.lastSharedProofsUpdate + AVAPROOFS_TIMEOUT)
        state.sharedProofs = [];
    }

    if (nodes.length === 0)
      return;

    shuffle(nodes);

    for (const state of nodes) {
      if (quorum && !state.peer.outbound)
        continue;
      this.send(state.peer, 'getavaaddr');
      // Without reason to want more nodes, one asking is enough.
      if (quorum && !needMore)
        break;
    }

    // Proofs cannot be checked before the chain is synced.
    if (this.isIBD())
      return;

    // Many proofs come back the first time: ask only a few.
    const targets = this.avaproofsNodeCounter === 0
      ? nodes.slice(0, 3)
      : nodes;

    for (const state of targets)
      this.requestCompactProofs(state);
  }

  /**
   * Re-check proofs at a new tip.
   * @returns {Promise}
   */

  async updatedBlockTip(tip) {
    const registered = await this.peerManager.updatedBlockTip();
    for (const proof of registered) {
      this.relayProof(proof.id());
      await this.reconcileOrFinalize(proof);
    }

    // Not while syncing: no quorum polls then, and bcash tells of every
    // block, where Bitcoin ABC tells of a batch, so they would pile up.
    if (tip && this.chain && !this.isIBD()) {
      await this.addToReconcile(itemTypes.BLOCK, tip);
      this.computeStakingReward(tip);
    }
  }

  /*
   * Staking rewards
   */

  isStakingRewardsActivated(prev) {
    if (!this.stakingRewardsEnabled || !this.chain || !prev)
      return false;
    const height = this.chain.network.block.cowperthwaiteHeight;
    return height != null && prev.height + 1 >= height;
  }

  /**
   * Select the staking reward winners for the block after `prev`, once
   * we have a quorum, as Bitcoin ABC's computeStakingReward.
   * @param {ChainEntry} prev
   * @returns {Boolean}
   */

  computeStakingReward(prev) {
    if (!this.isStakingRewardsActivated(prev))
      return false;

    if (!this.isQuorumEstablished())
      return false;

    const key = prev.hash.toString('hex');

    if (this.stakingRewards.has(key))
      return true;

    const winners = selectWinners(this.peerManager, prev, this.now());

    if (!winners)
      return false;

    this.stakingRewards.set(key, {height: prev.height, winners});

    // Keep the recent ones only.
    for (const [hash, reward] of this.stakingRewards) {
      if (reward.height < prev.height - STAKING_REWARDS_KEPT)
        this.stakingRewards.delete(hash);
    }

    return true;
  }

  /**
   * The staking reward winners for the block after a block, winner first.
   * @param {Hash} prevHash
   * @returns {Array|null} [{proofId, payout}]
   */

  getStakingRewardWinners(prevHash) {
    const reward = this.stakingRewards.get(prevHash.toString('hex'));
    return reward ? reward.winners : null;
  }

  async cleanupDanglingProofs() {
    const registered = await this.peerManager.cleanupDanglingProofs();
    for (const proof of registered) {
      this.log('debug', 'Promoting dangling proof %s.', proof.rid());
      await this.reconcileOrFinalize(proof);
    }
  }

  /*
   * Voting
   */

  /**
   * Start polling on an item, unless we are already, or it is not worth
   * it.
   * @param {Number} type - itemTypes.
   * @param {Proof|ChainEntry} item
   * @returns {Promise} - Returns Boolean.
   */

  async addToReconcile(type, item) {
    const unlock = await this.voteLock.lock();
    try {
      return await this._addToReconcile(type, item);
    } finally {
      unlock();
    }
  }

  async _addToReconcile(type, item) {
    if (!item)
      return false;

    const hash = itemHash(type, item);
    const key = itemKey(type, hash);

    if (this.voteRecords.has(key))
      return false;

    if (!await this.isWorthPolling(type, item))
      return false;

    const accepted = await this.getLocalAcceptance(type, item);
    const record = new VoteRecord(accepted);

    // Stakers (peer ids) whose nodes voted yes, and no.
    this.voteRecords.set(key, {type, hash, item, record,
      yes: new Set(), no: new Set()});

    return true;
  }

  /**
   * Poll a newly registered proof, unless it was just finalized: then
   * its peer is.
   * @param {Proof} proof
   * @returns {Promise} - Returns Boolean.
   */

  async reconcileOrFinalize(proof) {
    if (!proof)
      return false;

    if (this.isRecentlyFinalized(proof.id())) {
      const peer = this.peerManager.getPeerByProof(proof.id());
      if (peer)
        return this.peerManager.setFinalized(peer.peerId);
    }

    return this.addToReconcile(itemTypes.PROOF, proof);
  }

  isAccepted(type, hash) {
    if (!hash)
      return false;
    const entry = this.voteRecords.get(itemKey(type, hash));
    return entry ? entry.record.isAccepted() : false;
  }

  getConfidence(type, hash) {
    if (!hash)
      return -1;
    const entry = this.voteRecords.get(itemKey(type, hash));
    return entry ? entry.record.getConfidence() : -1;
  }

  isPolled(type, hash) {
    if (!hash)
      return false;
    return this.voteRecords.has(itemKey(type, hash));
  }

  isRecentlyFinalized(hash) {
    return this.recentlyFinalized.has(hash.toString('hex'));
  }

  setRecentlyFinalized(hash) {
    // A generation holds half the filter's elements; starting one forgets
    // the generation three back.
    const perGeneration = Math.floor((FINALIZED_ITEMS + 1) / 2);

    if (this.finalizedThisGeneration === perGeneration) {
      this.finalizedThisGeneration = 0;
      this.finalizedGeneration += 1;
      const forget = this.finalizedGeneration - 3;
      for (const [key, generation] of this.recentlyFinalized) {
        if (generation <= forget)
          this.recentlyFinalized.delete(key);
      }
    }

    this.finalizedThisGeneration += 1;
    this.recentlyFinalized.set(hash.toString('hex'), this.finalizedGeneration);
  }

  async isWorthPolling(type, item) {
    if (this.isRecentlyFinalized(itemHash(type, item)))
      return false;

    if (type === itemTypes.PROOF) {
      // Not immature or discarded ones.
      const id = item.id();
      return this.peerManager.isBoundToPeer(id)
        || this.peerManager.isInConflictingPool(id);
    }

    assert(type === itemTypes.BLOCK);

    if (this.chain.invalid.has(item.hash))
      return false;

    // Not blocks the network finalized, or below.
    const tip = this.finalizationTip;
    if (tip && item.height <= tip.height) {
      const ancestor = await this.chain.getAncestor(tip, item.height);
      if (ancestor && ancestor.hash.equals(item.hash))
        return false;
    }

    // Blocks avalanche invalidated are never polled again.
    return !this.invalidatedBlocks.has(item.hash.toString('hex'));
  }

  async getLocalAcceptance(type, item) {
    if (type === itemTypes.PROOF)
      return this.peerManager.isBoundToPeer(item.id());

    assert(type === itemTypes.BLOCK);
    return this.chain.isMainChain(item);
  }

  async getItemFromInv(inv) {
    switch (inv.type) {
      case invTypes.AVA_PROOF:
        return [itemTypes.PROOF, this.peerManager.getProof(inv.hash)];
      case invTypes.BLOCK:
        if (!this.chain)
          return [itemTypes.BLOCK, null];
        return [itemTypes.BLOCK, await this.chain.getEntryByHash(inv.hash)];
    }
    return [-1, null];
  }

  /**
   * Items to poll, best first: proofs by score, then blocks by work.
   * @param {Number} maxElements
   * @param {Boolean} forPoll - Count the poll in flight.
   * @returns {InvItem[]}
   */

  getInvsForNextPoll(maxElements, forPoll) {
    const invs = [];

    for (const entry of this.sortedRecords()) {
      if (invs.length >= maxElements)
        break;

      const poll = forPoll
        ? entry.record.registerPoll()
        : entry.record.shouldPoll();

      if (!poll)
        continue;

      const type = entry.type === itemTypes.PROOF
        ? invTypes.AVA_PROOF
        : invTypes.BLOCK;

      invs.push(new InvItem(type, entry.hash));
    }

    return invs;
  }

  sortedRecords() {
    return [...this.voteRecords.values()].sort(compareRecords);
  }

  clearTimedoutRequests() {
    const now = this.ms();
    const timedOut = [];

    for (const [key, query] of this.queries) {
      if (query.timeout < now) {
        timedOut.push(...query.invs);
        this.queries.delete(key);
      }
    }

    this.clearInflightRequests(timedOut);
  }

  clearInflightRequests(invs) {
    for (const inv of invs) {
      const type = inv.type === invTypes.AVA_PROOF
        ? itemTypes.PROOF
        : itemTypes.BLOCK;
      const entry = this.voteRecords.get(itemKey(type, inv.hash));
      if (entry)
        entry.record.clearInflightRequest(1);
    }
  }

  async clearInvsNotWorthPolling() {
    for (const [key, entry] of [...this.voteRecords]) {
      if (!await this.isWorthPolling(entry.type, entry.item))
        this.voteRecords.delete(key);
    }
  }

  /**
   * Send a poll, if we have a quorum, a node free to answer, and items to
   * poll. Bitcoin ABC runs this every 10 milliseconds.
   * @returns {Promise}
   */

  async runEventLoop() {
    if (!this.isQuorumEstablished())
      return;

    const unlock = await this.voteLock.lock();
    try {
      await this._runEventLoop();
    } finally {
      unlock();
    }
  }

  async _runEventLoop() {
    this.clearTimedoutRequests();

    await this.clearInvsNotWorthPolling();

    for (;;) {
      const nodeId = this.peerManager.selectNode();

      if (nodeId === PeerManager.NO_NODE)
        return;

      const node = this.peerManager.getNode(nodeId);
      const invs = this.getInvsForNextPoll(node.maxElements, true);

      if (invs.length === 0)
        return;

      const state = this.peers.get(nodeId);

      if (state) {
        const round = this.round++;
        const timeout = this.ms() + this.queryTimeout;

        this.queries.set(queryKey(nodeId, round),
          {nodeId, round, timeout, invs});
        this.peerManager.updateNextRequestTimeForPoll(nodeId, timeout, round);

        const poll = new Poll(round, invs);
        state.peer.send(new packets.UnknownPacket('avapoll', poll.toRaw()));

        return;
      }

      // Lost contact with it.
      this.peerManager.removeNode(nodeId);
      this.clearInflightRequests(invs);
    }
  }

  /**
   * Count a node's votes.
   * @param {Number} nodeId
   * @param {Response} response
   * @returns {Promise} - Returns {ok, updates, disconnect, error}.
   */

  async registerVotes(nodeId, response) {
    const unlock = await this.voteLock.lock();
    try {
      return await this._registerVotes(nodeId, response);
    } finally {
      unlock();
    }
  }

  async _registerVotes(nodeId, response) {
    const updates = [];

    // When it may be polled again.
    this.peerManager.updateNextRequestTimeForResponse(nodeId, response);

    // It may have timed out; not a reason to disconnect.
    const key = queryKey(nodeId, response.round);
    const query = this.queries.get(key);

    if (!query) {
      return {ok: false, updates, disconnect: false,
        error: 'unexpected-ava-response'};
    }

    this.queries.delete(key);

    const {invs} = query;
    const {votes} = response;

    if (votes.length !== invs.length) {
      this.clearInflightRequests(invs);
      return {ok: false, updates, disconnect: true,
        error: 'invalid-ava-response-size'};
    }

    for (let i = 0; i < invs.length; i++) {
      if (!invs[i].hash.equals(votes[i].hash)) {
        this.clearInflightRequests(invs);
        return {ok: false, updates, disconnect: true,
          error: 'invalid-ava-response-content'};
      }
    }

    // One vote an item, in vote map order.
    const items = new Map();

    for (let i = 0; i < invs.length; i++) {
      const [type, item] = await this.getItemFromInv(invs[i]);

      if (!item)
        continue;

      if (!await this.isWorthPolling(type, item))
        continue;

      const k = itemKey(type, invs[i].hash);
      if (!items.has(k))
        items.set(k, votes[i]);
    }

    const keys = [...items.keys()].filter(k => this.voteRecords.has(k));
    keys.sort((a, b) => compareRecords(this.voteRecords.get(a),
      this.voteRecords.get(b)));

    for (const k of keys) {
      const entry = this.voteRecords.get(k);
      const {record} = entry;
      const vote = items.get(k);

      this.countVoter(entry, nodeId, vote.error);

      const changed = record.registerVote(nodeId, vote.error);

      // A final item held for unanimity is looked at again with each vote.
      if (!changed && !(entry.held && record.hasFinalized())) {
        // Drop stale items; seen again, they get a new vote.
        const held = entry.held
          && record.successfulVotes > this.staleVoteThreshold;
        if (held
            || record.isStale(this.staleVoteThreshold, this.staleVoteFactor)) {
          updates.push({...entry, status: voteStatus.STALE});
          this.voteRecords.delete(k);
        }
        continue;
      }

      if (!record.hasFinalized()) {
        updates.push({...entry, status: record.isAccepted()
          ? voteStatus.ACCEPTED
          : voteStatus.REJECTED});
        continue;
      }

      // Below the connected ratio, only a unanimous vote is final: until
      // then it is polled on, and a dissent waits for the ratio.
      if (!this.canFinalize(entry)) {
        entry.held = true;
        continue;
      }

      updates.push({...entry, status: record.isAccepted()
        ? voteStatus.FINALIZED
        : voteStatus.INVALID});
      this.voteRecords.delete(k);
    }

    for (const update of updates) {
      if (update.type !== itemTypes.BLOCK)
        continue;

      // Never poll an invalidated block again.
      if (update.status === voteStatus.INVALID) {
        this.invalidatedBlocks.add(update.hash.toString('hex'));
        continue;
      }

      if (update.status !== voteStatus.FINALIZED)
        continue;

      const tip = this.finalizationTip;
      if (tip && update.item.height <= tip.height) {
        const ancestor = await this.chain.getAncestor(tip,
          update.item.height);
        if (ancestor && ancestor.hash.equals(update.hash))
          continue;
      }

      this.finalizationTip = update.item;
    }

    return {ok: true, updates, disconnect: false, error: null};
  }

  /**
   * Note which staker a node's vote on an item came from, and which way.
   * Neutral votes say nothing.
   * @private
   */

  countVoter(entry, nodeId, error) {
    if (!entry.yes || (error & 0x80000000) !== 0)
      return;

    const node = this.peerManager.getNode(nodeId);

    if (!node)
      return;

    if (error === 0)
      entry.yes.add(node.peerId);
    else
      entry.no.add(node.peerId);
  }

  /**
   * Whether nodes for enough of the stake are connected for any vote
   * to be final, as Bitcoin ABC's quorum.
   * @returns {Boolean}
   */

  hasConnectedRatio() {
    const total = this.peerManager.getTotalPeersScore();
    const connected = this.peerManager.getConnectedPeersScore();
    return connected >= Math.round(total * this.minQuorumConnectedScoreRatio);
  }

  /**
   * Whether an item's final vote stands: with the connected ratio; or,
   * with nodes for the unanimous ratio, if every staker we have a node
   * for voted its way and none the other.
   * @private
   * @param {Object} entry
   * @returns {Boolean}
   */

  canFinalize(entry) {
    if (this.hasConnectedRatio())
      return true;

    const pm = this.peerManager;
    const total = pm.getTotalPeersScore();
    const connected = pm.getConnectedPeersScore();

    if (connected < Math.round(total * this.minQuorumUnanimousScoreRatio))
      return false;

    const accepted = entry.record.isAccepted();
    const agree = accepted ? entry.yes : entry.no;
    const disagree = accepted ? entry.no : entry.yes;

    if (!agree || disagree.size > 0)
      return false;

    for (const peer of pm.peers.values()) {
      if (peer.nodeCount > 0 && !agree.has(peer.peerId))
        return false;
    }

    return true;
  }

  /**
   * A node answered a poll.
   * @private
   */

  async handleResponse(state, data) {
    const response = Response.fromRaw(data);

    // Signed by the session key its hello delegated to.
    if (!state.pubkey || !response.verify(state.pubkey)) {
      this.misbehaving(state, 'invalid-ava-response-signature');
      return;
    }

    const now = this.now();
    const result = await this.registerVotes(state.peer.id, response);

    if (!result.ok) {
      if (result.disconnect) {
        this.misbehaving(state, result.error);
        return;
      }

      // Perhaps a network outage: tolerate some.
      state.faultCounter = (state.faultCounter || 0) + 1;
      state.lastFault = now;

      if (state.faultCounter > MAX_MESSAGE_FAULTS) {
        state.faultScore = (state.faultScore || 0) + 2;
        if (state.faultScore > 100)
          this.misbehaving(state, result.error);
        return;
      }
    }

    // An hour without faults forgives them.
    if (now > (state.lastFault || 0) + 3600)
      state.faultCounter = 0;

    for (const update of result.updates)
      await this.applyUpdate(update);
  }

  /**
   * Act on what polls decided: proofs here; blocks are for the chain,
   * which listens for 'block vote'.
   * @private
   */

  async applyUpdate(update) {
    this.emit('vote', update);

    if (update.type === itemTypes.BLOCK) {
      this.emit('block vote', update.item, update.status);
      return;
    }

    const pm = this.peerManager;
    const proof = update.item;
    const id = proof.id();

    switch (update.status) {
      case voteStatus.INVALID:
        this.setInvalid(id);
        await pm.rejectProof(id, PeerManager.rejectionMode.INVALIDATE);
        break;
      case voteStatus.STALE:
        await pm.rejectProof(id, PeerManager.rejectionMode.INVALIDATE);
        break;
      case voteStatus.REJECTED:
        await pm.rejectProof(id, PeerManager.rejectionMode.DEFAULT);
        break;
      case voteStatus.FINALIZED:
      case voteStatus.ACCEPTED: {
        let cooldown = this.now();
        if (update.status === voteStatus.FINALIZED) {
          this.setRecentlyFinalized(id);
          cooldown += PEER_REPLACEMENT_COOLDOWN;
        }

        await pm.registerProof(proof,
          PeerManager.registrationMode.FORCE_ACCEPT);

        const peer = pm.getPeerByProof(id);
        if (peer) {
          pm.updateNextPossibleConflictTime(peer.peerId, cooldown);
          if (update.status === voteStatus.FINALIZED)
            pm.setFinalized(peer.peerId);
        }
        break;
      }
    }
  }

  send(peer, cmd, data = Buffer.alloc(0)) {
    peer.send(new packets.UnknownPacket(cmd, data));
  }
}

/*
 * Helpers
 */

function itemHash(type, item) {
  return type === itemTypes.PROOF ? item.id() : item.hash;
}

function itemKey(type, hash) {
  return `${type}:${hash.toString('hex')}`;
}

function queryKey(nodeId, round) {
  return `${nodeId}:${round}`;
}

// Bitcoin ABC's VoteMapComparator: proofs by score, then blocks with the
// most work first.
function compareRecords(a, b) {
  if (a.type !== b.type)
    return a.type - b.type;

  if (a.type === itemTypes.PROOF)
    return ProofPool.compareByScore(a.item, b.item);

  const work = b.item.chainwork.cmp(a.item.chainwork);
  if (work !== 0)
    return work;

  return Buffer.compare(a.hash, b.hash);
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = random.randomRange(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/*
 * Expose
 */

Processor.MIN_QUORUM_STAKE = MIN_QUORUM_STAKE;
Processor.MIN_QUORUM_CONNECTED_STAKE_RATIO = MIN_QUORUM_CONNECTED_STAKE_RATIO;
Processor.MIN_QUORUM_UNANIMOUS_STAKE_RATIO = MIN_QUORUM_UNANIMOUS_STAKE_RATIO;
Processor.MIN_AVAPROOFS_NODE_COUNT = MIN_AVAPROOFS_NODE_COUNT;
Processor.GETAVAPROOFS_INTERVAL = GETAVAPROOFS_INTERVAL;
Processor.GETAVAADDR_INTERVAL = GETAVAADDR_INTERVAL;
Processor.UNCONDITIONAL_RELAY_DELAY = UNCONDITIONAL_RELAY_DELAY;
Processor.PROOF_REQUEST_TIMEOUT = PROOF_REQUEST_TIMEOUT;
Processor.QUERY_TIMEOUT = QUERY_TIMEOUT;
Processor.TIME_STEP = TIME_STEP;
Processor.PEER_REPLACEMENT_COOLDOWN = PEER_REPLACEMENT_COOLDOWN;
Processor.voteStatus = voteStatus;
Processor.itemTypes = itemTypes;

module.exports = Processor;
