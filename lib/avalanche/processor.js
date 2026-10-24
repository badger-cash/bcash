/*!
 * processor.js - avalanche processor for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/processor.{h,cpp} and the
 * avalanche handling in src/net_processing.cpp.
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const EventEmitter = require('events');
const {Lock} = require('bmutex');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const {RollingFilter} = require('bfilter');
const packets = require('../net/packets');
const InvItem = require('../primitives/invitem');
const util = require('../utils/util');
const Proof = require('./proof');
const {compareIds} = Proof;
const PeerManager = require('./peermanager');
const ProofPool = require('./proofpool');
const VoteRecord = require('./voterecord');
const {selectWinners} = require('./stakingrewards');
const {CompactProofs, ProofsRequest} = require('./compactproofs');
const {
  Hello,
  Poll,
  Response,
  Vote,
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

// Bitcoin ABC's limit on proofs a node may send that fail, though not
// invalid, in an interval (seconds) before it is held to misbehave.
const MAX_INVALID_AVAPROOFS = 10;
const INVALID_AVAPROOFS_INTERVAL = 60 * 60;

// Proof registration failures that count toward it: the proof may yet
// become acceptable, so it is not marked invalid.
const RATE_LIMITED_FAILURES = new Set([
  'utxo-missing-or-spent',
  'immature-proof',
  'conflicting-utxos',
  'rejected-proof',
  'cooldown-not-elapsed'
]);

// Seconds within which an addr answers our getavaaddr.
const AVAADDR_ANSWER_TIMEOUT = 2 * 60;

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
  BLOCK: 1,
  CONTENDER: 2,
  TX: 3
};

// Bitcoin ABC's PROOF_REQUEST_PARAMS: proofs a peer's announcements may
// be kept for, and asked of it at once.
const MAX_PEER_PROOF_ANNOUNCEMENTS = 5000;
const MAX_PEER_PROOF_INFLIGHT = 100;

// Proofs from one peer waiting on their coins: Bitcoin ABC checks a
// peer's proofs one at a time, reading no more from it meanwhile.
const MAX_PEER_PROOFS_VERIFYING = 100;

// Items a getdata of ours may carry (Bitcoin ABC's MAX_GETDATA_SZ).
const MAX_GETDATA = 1000;

// Bitcoin ABC's AVALANCHE_DEFAULT_COOLDOWN: milliseconds a node must wait
// between polls to us, and the wait our responses ask for.
const COOLDOWN = 100;

// Votes that say nothing, as u32: unknown, missing data, pending.
const UNKNOWN = 0xffffffff;
const MISSING = 0xfffffffe;
const PENDING = 0xfffffffd;

// Transactions watched without a mempool, and verdicts kept.
const MAX_WATCHED_TXS = 10000;

// Bitcoin ABC's AVALANCHE_CONTENDER_MAX_POLLABLE: stake contenders polled
// for a block.
const CONTENDER_MAX_POLLABLE = 12;

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
   * @param {Boolean} [options.stakingPreConsensus] - Poll stake contenders,
   * as Bitcoin ABC's -avalanchestakingpreconsensus.
   * @param {Boolean} [options.preConsensus] - Poll mempool transactions,
   * as Bitcoin ABC's -avalanchepreconsensus.
   * @param {Mempool} [options.mempool] - The transactions to poll.
   * @param {Boolean} [options.filterAwarePolling] - Poll only nodes whose
   * vote would count. Bitcoin ABC polls a node by stake, and drops its vote
   * if it was one of an item's last 7 voters: with few nodes, as an SPV
   * node has, most votes are dropped.
   * @param {Boolean} [options.answerPolls] - Answer polls, as Bitcoin ABC
   * does any peer's: a full node. An SPV node cannot judge what it is
   * asked about.
   * @param {Number} [options.cooldown] - Milliseconds a node must wait
   * between polls to us (Bitcoin ABC's -avacooldown).
   * @param {Buffer} [options.sessionKey] - Private key our responses are
   * signed with; random by default.
   * @param {Object} [options.peerData] - A staking node's own proof,
   * delegation and session key (see peerdata.js).
   * @param {Boolean} [options.canShareProof] - Share our proof from the
   * start: Bitcoin ABC waits for an inbound connection, to be reachable.
   * @param {Function} [options.voteRecordSeed] - Seeds for vote records'
   * voter filters, random by default; tests fix them, as Bitcoin ABC's
   * seed their random numbers.
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
    this.discourage = options.discourage || null;

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

    // Proofs whose coins are being checked: not to be fetched or checked
    // again meanwhile. Bitcoin ABC checks a proof at once; an SPV node
    // fetches its coins, and the same proof could arrive from every node
    // that announced it, each banned if it was invalid.
    this.verifying = new Set();

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

    this.filterAwarePolling = Boolean(options.filterAwarePolling);
    this.voteRecordSeed = options.voteRecordSeed || null;

    // Answering polls.
    this.answerPolls = Boolean(options.answerPolls);
    this.cooldown = options.cooldown != null ? options.cooldown : COOLDOWN;
    // A staking node's own proof: shared in our hellos once a node has
    // connected in to us, and registered at each tip.
    this.peerData = options.peerData || null;
    this.sessionKey = this.peerData
      ? this.peerData.sessionKey
      : options.sessionKey || secp256k1.privateKeyGenerate();
    this.canShareProof = Boolean(options.canShareProof);
    this.delayedHellos = new Set();
    this.localProofState = {verified: false, reason: null};
    // Transactions in recent blocks, as Bitcoin ABC's
    // m_recent_confirmed_transactions: voted for once out of the mempool.
    this.recentConfirmed = new RollingFilter(48000, 0.000001);

    this.voteLock = new Lock();
    // Item key to {type, hash, item, record}.
    this.voteRecords = new RecordMap();
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

    // Staking pre-consensus: and the proofs avalanche rejected as winners
    // of one block (Bitcoin ABC's rejectedContenderProofids).
    this.stakingPreConsensus = Boolean(options.stakingPreConsensus);
    this.rejectedContenders = {prevHash: null, ids: new Set()};

    // Whether polls finalized a block since we started: Bitcoin ABC's
    // hasFinalizedTip(), in memory only. The chain keeps its finalized
    // tip across a restart; this does not.
    this.finalizedSinceStart = false;
    // The tip at our first quorum, polled though final from before a
    // restart: once polls finalize it, pre-consensus may begin.
    this.recheckTip = null;

    // Transaction pre-consensus.
    this.preConsensus = Boolean(options.preConsensus);
    this.mempool = options.mempool || null;

    // Without a mempool (SPV), the transactions we were asked to watch,
    // and what polls decided of them: txid (hex) to TX, and to 'final',
    // 'rejected' or 'invalid'.
    this.watchedTxs = new Map();
    this.txStatus = new Map();
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
      // As Bitcoin ABC's rolling filters: what it knows, and what we told
      // it of, by proof id (hex).
      knownProofs: new RollingFilter(10000, 0.000001),
      proofsToSend: new Set(),
      recentlyAnnounced: new RollingFilter(3500, 0.000001),
      compactProofsRequested: false,
      sharedProofs: [],
      lastSharedProofsUpdate: 0,
      nextGetavaproofs: 0,
      nextGetavaaddr: 0,
      lastPoll: -Infinity,
      // Proofs it announced that we track, those we asked it for, those of
      // its we check, and the getdata items waiting to go.
      announcements: 0,
      inflight: 0,
      verifyingProofs: 0,
      proofGetData: []
    });

    // As Bitcoin ABC, latched: a node connected in to us, so we are
    // reachable, and may share our proof. Those waiting get it now.
    if (this.peerData && !peer.outbound && !this.canShareProof) {
      this.canShareProof = true;
      this.sendDelayedHellos();
    }

    this.sendHello(this.peers.get(peer.id));
  }

  /**
   * Say hello: with our proof, delegated to the session key that signs
   * it, if we have one and may share it; if we may not yet, later.
   * @private
   * @param {Object} state
   * @returns {Boolean} Whether our proof went.
   */

  sendHello(state) {
    const {peer} = state;

    if (this.peerData && !this.canShareProof) {
      this.delayedHellos.add(peer.id);
      return false;
    }

    const delegation = this.peerData ? this.peerData.delegation : null;
    const hello = new Hello(delegation, null, this.maxElementPoll);

    // Mirroring how we check theirs: we send no extra entropy, read as 1.
    if (this.peerData) {
      const theirs = peer.remoteEntropy != null ? peer.remoteEntropy : 1n;
      hello.sign(this.sessionKey, peer.localNonce, peer.remoteNonce, 1n,
        theirs);
    }

    peer.send(new packets.UnknownPacket('avahello', hello.toRaw()));

    if (!this.peerData)
      return false;

    // Announced: the peer may ask for it.
    const key = this.peerData.proof.id().toString('hex');
    state.knownProofs.add(key, 'hex');
    state.recentlyAnnounced.add(key, 'hex');

    return true;
  }

  /**
   * Hellos held until we could share our proof.
   * @private
   */

  sendDelayedHellos() {
    if (!this.canShareProof)
      return;

    for (const id of [...this.delayedHellos]) {
      this.delayedHellos.delete(id);
      const state = this.peers.get(id);
      if (state)
        this.sendHello(state);
    }
  }

  /**
   * Register the peers of a dump, as Bitcoin ABC does at its start, and
   * poll them again: the network may have changed meanwhile.
   * @param {Buffer} data
   * @returns {Promise} - Returns Number, those registered.
   */

  async loadPeers(data) {
    const registered = await this.peerManager.loadPeers(data);

    for (const proof of registered)
      await this.addToReconcile(itemTypes.PROOF, proof);

    return registered.length;
  }

  /**
   * Our own proof, if we stake.
   * @returns {Proof|null}
   */

  getLocalProof() {
    return this.peerData ? this.peerData.proof : null;
  }

  isLocalProof(id) {
    return this.peerData != null && this.peerData.proof.id().equals(id);
  }

  /**
   * Register our proof at a new tip, as Bitcoin ABC, once we may share it;
   * note its state.
   * @private
   * @returns {Promise}
   */

  async registerLocalProof() {
    const proof = this.peerData.proof;
    const pm = this.peerManager;
    const [ok, reason] = await pm.registerProof(proof);

    if (ok) {
      this.localProofState = {verified: true, reason: null};
      await this.reconcileOrFinalize(proof);
      return;
    }

    if (reason !== 'proof-already-registered') {
      this.localProofState = {verified: false, reason};
      return;
    }

    const id = proof.id();

    if (pm.isImmature(id))
      this.localProofState = {verified: false, reason: 'immature-proof'};
    else if (pm.isInConflictingPool(id))
      this.localProofState = {verified: false, reason: 'conflicting-utxos'};
    else if (pm.isBoundToPeer(id))
      this.localProofState = {verified: true, reason: null};
  }

  /**
   * Our proof's state, as Bitcoin ABC's getLocalProofRegistrationState.
   * @returns {Object} {verified, reason}
   */

  getLocalProofState() {
    if (!this.peerData)
      return null;

    const id = this.peerData.proof.id();

    if (this.peerManager.isInConflictingPool(id))
      return {verified: false, reason: 'conflicting-utxos'};

    if (this.invalidProofs.has(id.toString('hex')))
      return {verified: false, reason: 'avalanche-invalidated'};

    if (!this.peerManager.isBoundToPeer(id))
      return {...this.localProofState, verified: false};

    return this.localProofState;
  }

  removePeer(peer) {
    if (!this.peers.delete(peer.id))
      return;

    this.delayedHellos.delete(peer.id);

    this.peerManager.removeNode(peer.id);

    for (const [key, req] of this.requests) {
      req.announcers.delete(peer.id);
      // Asked of it, or waiting with nobody else to ask: on, or done.
      if (req.peerId === peer.id || req.announcers.size === 0) {
        if (req.peerId === peer.id)
          req.peerId = -1;
        this.requestProof(key);
      }
    }

    this.flushProofGetData();
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
          await this.receivedProof(state,
            decode(() => Proof.fromRaw(packet.data)));
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
        case 'avapoll':
          await this.handlePoll(state, packet.data);
          break;
      }
    } catch (e) {
      // A message we cannot decode is the peer's doing; our own failures,
      // to fetch coins or read the chain, are not.
      if (!e.malformed) {
        this.log('warning', 'Failed on %s from %s: %s.',
          packet.cmd, peer.hostname(), e.message);
        return;
      }

      this.log('debug', 'Bad %s from %s: %s.',
        packet.cmd, peer.hostname(), e.message);
      this.misbehaving(state, `malformed-${packet.cmd}`);
    }
  }

  misbehaving(state, reason) {
    this.log('debug', 'Misbehaving %s: %s.', state.peer.hostname(), reason);

    // The pool discourages it, as Bitcoin ABC; alone, ban it.
    if (this.discourage)
      this.discourage(state.peer);
    else
      state.peer.increaseBan(100);
  }

  handleHello(state, data) {
    const {peer} = state;

    if (state.pubkey) {
      this.log('debug', 'Ignoring avahello from %s: already a node.',
        peer.hostname());
      return;
    }

    const hello = decode(() => Hello.fromRaw(data));

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

      if (!this.alreadyHaveProof(proofId)) {
        this.addProofAnnouncement(state, proofId);
        this.flushProofGetData();
      }

      this.peerManager.addNode(peer.id, proofId,
        Math.min(hello.maxElements, this.maxElementPoll));
    }

    state.enabled = true;

    this.emit('hello', peer, hello);

    // Ask outbound nodes for avalanche peers and their proofs.
    if (peer.outbound) {
      this.requestAvaAddrs(state);
      if (!this.isIBD())
        this.requestCompactProofs(state);
    }
  }

  /*
   * Proofs
   */

  alreadyHaveProof(proofId) {
    return this.isLocalProof(proofId)
      || this.peerManager.exists(proofId)
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

    state.knownProofs.add(key, 'hex');

    // Its coins cannot be checked yet; it can be fetched again later.
    if (this.isIBD())
      return true;

    const {peer} = state;
    const staker = state.pubkey != null;

    this.deleteRequest(key);

    if (this.alreadyHaveProof(id) || this.verifying.has(key)) {
      if (staker)
        this.peerManager.saveRemoteProof(id, peer.id, true);
      return true;
    }

    // What cannot be valid, whatever its coins, is caught at once.
    const [valid, why] = proof.verify(this.peerManager.verifier.dustThreshold);
    if (!valid) {
      this.setInvalid(id);
      this.misbehaving(state, why);
      return false;
    }

    // Enough of its waiting on their coins: the rest are dropped, to come
    // again from it or another.
    if (state.verifyingProofs >= MAX_PEER_PROOFS_VERIFYING)
      return true;

    this.verifying.add(key);
    state.verifyingProofs += 1;

    let ok, reason, detail;
    try {
      [ok, reason, detail] = await this.peerManager.registerProof(proof);
    } finally {
      this.verifying.delete(key);
      state.verifyingProofs -= 1;
    }

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

    // As Bitcoin ABC: too many failures that may come right in time are
    // also misbehaving.
    if (RATE_LIMITED_FAILURES.has(reason)) {
      const now = this.now();
      const times = (state.invalidProofTimes || [])
        .filter(t => t > now - INVALID_AVAPROOFS_INTERVAL);
      times.push(now);
      state.invalidProofTimes = times;
      if (times.length >= MAX_INVALID_AVAPROOFS) {
        this.misbehaving(state, 'too-many-invalid-avaproofs');
        return false;
      }
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
      if (!state.knownProofs.test(key, 'hex'))
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
        state.knownProofs.add(key, 'hex');
        state.recentlyAnnounced.add(key, 'hex');
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
      state.knownProofs.add(id.toString('hex'), 'hex');
      if (!this.alreadyHaveProof(id) && !this.isIBD())
        this.addProofAnnouncement(state, id);
    }

    this.flushProofGetData();
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

    // Ours, asked for after our hello: as Bitcoin ABC, always served.
    if (!peer)
      return this.isLocalProof(id) ? this.peerData.proof : null;

    if (this.isLocalProof(id))
      return peer.proof;

    // Known long enough for anyone, or announced to this peer.
    if (peer.registrationTime <= this.now() - UNCONDITIONAL_RELAY_DELAY)
      return peer.proof;

    if (state.recentlyAnnounced.test(id.toString('hex'), 'hex'))
      return peer.proof;

    return null;
  }

  addProofAnnouncement(state, id) {
    const key = id.toString('hex');

    if (this.verifying.has(key))
      return;

    let req = this.requests.get(key);

    // As Bitcoin ABC, so many of a peer's announcements are kept.
    const known = req != null && req.announcers.has(state.peer.id);
    if (!known && state.announcements >= MAX_PEER_PROOF_ANNOUNCEMENTS)
      return;

    if (!req) {
      req = {id, announcers: new Set(), tried: new Set(), peerId: -1, time: 0};
      this.requests.set(key, req);
    }

    if (!known) {
      req.announcers.add(state.peer.id);
      state.announcements += 1;
    }

    if (req.peerId === -1)
      this.requestProof(key);
  }

  /**
   * Ask an announcer we have not asked yet for a proof, if one has room
   * for another request; if none has, it waits for a later try. The
   * getdata goes with the next flushProofGetData().
   * @private
   */

  requestProof(key) {
    const req = this.requests.get(key);

    if (!req)
      return;

    if (req.peerId !== -1) {
      const asked = this.peers.get(req.peerId);
      if (asked)
        asked.inflight -= 1;
      req.peerId = -1;
    }

    let waiting = false;

    for (const peerId of req.announcers) {
      if (req.tried.has(peerId))
        continue;

      const state = this.peers.get(peerId);
      if (!state)
        continue;

      if (state.inflight >= MAX_PEER_PROOF_INFLIGHT) {
        waiting = true;
        continue;
      }

      req.tried.add(peerId);
      req.peerId = peerId;
      req.time = this.now();
      state.inflight += 1;
      state.proofGetData.push(req.id);
      return;
    }

    // Nobody left to ask.
    if (!waiting)
      this.deleteRequest(key);
  }

  /**
   * Done with a proof request: its announcers may announce more.
   * @private
   */

  deleteRequest(key) {
    const req = this.requests.get(key);

    if (!req)
      return;

    for (const peerId of req.announcers) {
      const state = this.peers.get(peerId);
      if (state)
        state.announcements -= 1;
    }

    if (req.peerId !== -1) {
      const asked = this.peers.get(req.peerId);
      if (asked)
        asked.inflight -= 1;
    }

    this.requests.delete(key);
  }

  /**
   * Send the proof getdatas requestProof queued, a few to a message.
   * @private
   */

  flushProofGetData() {
    for (const state of this.peers.values()) {
      const ids = state.proofGetData;

      if (ids.length === 0)
        continue;

      state.proofGetData = [];

      for (let i = 0; i < ids.length; i += MAX_GETDATA) {
        const items = ids.slice(i, i + MAX_GETDATA)
          .map(id => new InvItem(invTypes.AVA_PROOF, id));
        state.peer.send(new packets.GetDataPacket(items));
      }
    }
  }

  /**
   * Re-ask for proofs a node did not send in time, and ask for those
   * that waited for room.
   */

  expireProofRequests() {
    const now = this.now();
    for (const [key, req] of this.requests) {
      if (req.peerId === -1 || now - req.time >= PROOF_REQUEST_TIMEOUT)
        this.requestProof(key);
    }

    this.flushProofGetData();
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
    const req = decode(() => ProofsRequest.fromRaw(data));
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

    if (!this.peerManager.latchAvaproofsSent(nodeId))
      return;

    this.avaproofsNodeCounter += 1;

    // The first: now ask every node, as the next periodic round would.
    // Waiting minutes for it held a fresh SPV client short of a quorum.
    if (this.avaproofsNodeCounter === 1)
      this.periodicNetworking();
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
    let connected = this.peerManager.getConnectedPeersScore();

    if (total < this.minQuorumScore)
      return false;

    // As Bitcoin ABC, our own stake counts as connected: we are its node.
    const local = this.peerData
      ? this.peerManager.getPeerByProof(this.peerData.proof.id())
      : null;
    if (local && local.nodeCount === 0)
      connected += local.proof.getScore();

    const ratio = Math.min(this.minQuorumConnectedScoreRatio,
      this.minQuorumUnanimousScoreRatio);

    if (connected < Math.round(total * ratio))
      return false;

    this.quorumIsEstablished = true;
    this.emit('quorum');

    // Bitcoin ABC, keeping no finalized tip across a restart, polls its
    // tip again; bcash keeps it, so polls it again now if it is final from
    // before, rather than wait for the next block to begin pre-consensus.
    const final = this.finalizationTip;
    if (this.chain && this.chain.tip && final && !this.finalizedSinceStart
        && this.chain.tip.height <= final.height) {
      this.recheckTip = this.chain.tip;
      this.addToReconcile(itemTypes.BLOCK, this.chain.tip).catch((err) => {
        this.emit('error', err);
      });
    }

    // Winners now, rather than at the next block; contenders polled even
    // if no winner could be chosen yet.
    const prev = this.chain ? this.chain.tip : null;
    const computed = prev ? this.computeStakingReward(prev) : false;
    if (prev && this.stakingPreConsensus && !computed)
      this.pollStakeContenders(prev);

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
    this.sendDelayedHellos();

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
      this.requestAvaAddrs(state);
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
   * Poll a block that is not our tip: one parked, or with more work on a
   * parked chain, as Bitcoin ABC polls its best chain whether parked or
   * not. Not while syncing.
   * @param {ChainEntry} entry
   * @returns {Promise} - Returns Boolean.
   */

  async reconcileBlock(entry) {
    if (!entry || !this.chain || this.isIBD())
      return false;

    return this.addToReconcile(itemTypes.BLOCK, entry);
  }

  /**
   * Re-check proofs at a new tip.
   * @returns {Promise}
   */

  async updatedBlockTip(tip) {
    if (this.peerData && this.canShareProof)
      await this.registerLocalProof();

    const registered = await this.peerManager.updatedBlockTip();
    for (const proof of registered) {
      this.relayProof(proof.id());
      await this.reconcileOrFinalize(proof);
    }

    // Not while syncing: no quorum polls then, and bcash tells of every
    // block, where Bitcoin ABC tells of a batch, so they would pile up.
    if (tip && this.chain && !this.isIBD()) {
      await this.addToReconcile(itemTypes.BLOCK, tip);
      await this.computeStakingRewardsBelow(tip);
      if (this.stakingPreConsensus)
        await this.promoteAndPollStakeContenders(tip);
    }
  }

  /**
   * Polls finalized a block since we started: pre-consensus begins, on
   * the transactions we watch.
   * @private
   */

  beginPreconsensus() {
    if (this.finalizedSinceStart)
      return;

    this.finalizedSinceStart = true;

    if (this.preConsensus && this.watchedTxs.size > 0)
      this.pollWatchedTransactions().catch(e => this.emit('error', e));
  }

  /**
   * Whether polls finalized a block since we started, as Bitcoin ABC's
   * hasFinalizedTip(): what RTT and transaction pre-consensus wait for.
   * @returns {Boolean}
   */

  hasFinalizedTip() {
    return this.finalizedSinceStart;
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

    const winners = selectWinners(this.peerManager, prev, this.now(),
      {rejected: this.getRejectedContenders(prev.hash)});

    if (!winners)
      return false;

    this.stakingRewards.set(key, {height: prev.height, winners});

    if (this.stakingPreConsensus)
      this.pollStakeContenders(prev);

    // Keep the recent ones only.
    for (const [hash, reward] of this.stakingRewards) {
      if (reward.height < prev.height - STAKING_REWARDS_KEPT)
        this.stakingRewards.delete(hash);
    }

    return true;
  }

  /**
   * Staking reward winners after a new tip and the 3 blocks below it,
   * down to the finalized block, as Bitcoin ABC computes them for each
   * block it connects: after a reorg, or blocks connected at once, those
   * below the tip have theirs too.
   * @private
   * @param {ChainEntry} tip
   * @returns {Promise}
   */

  async computeStakingRewardsBelow(tip) {
    const final = this.finalizationTip;

    for (let height = tip.height; height >= tip.height - 3; height--) {
      const entry = height === tip.height
        ? tip
        : await this.chain.getAncestor(tip, height);

      if (!entry || (final && entry.hash.equals(final.hash)))
        break;

      this.computeStakingReward(entry);
    }
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

  /**
   * Replace the winners of the block after `prev`, as Bitcoin ABC's
   * setStakingRewardWinners: payout scripts alone are set by hand, and
   * kept with the contenders too.
   * @param {ChainEntry} prev
   * @param {Array} winners - [{proofId, payout}] or Script[].
   */

  setStakingRewardWinners(prev, winners) {
    if (winners.length > 0 && !winners[0].payout) {
      if (this.stakingPreConsensus)
        this.peerManager.setStakeContenderWinners(prev, winners);
      winners = winners.map(payout => ({proofId: null, payout}));
    }

    this.stakingRewards.set(prev.hash.toString('hex'),
      {height: prev.height, winners});
  }

  /**
   * Forget the winners and contenders of blocks below a height: those
   * avalanche finalized.
   * @param {Number} minHeight
   */

  cleanupStakingRewards(minHeight) {
    for (const [hash, reward] of this.stakingRewards) {
      if (reward.height < minHeight)
        this.stakingRewards.delete(hash);
    }
    this.peerManager.cleanupStakeContenders(minHeight);
  }

  // Bitcoin ABC keeps the proofs rejected as winners of one block, and
  // forgets them when another is selected.
  getRejectedContenders(prevHash) {
    const rejected = this.rejectedContenders;
    if (!rejected.prevHash || !rejected.prevHash.equals(prevHash)) {
      rejected.prevHash = prevHash;
      rejected.ids = new Set();
    }
    return rejected.ids;
  }

  /*
   * Transaction pre-consensus
   */

  /**
   * Whether mempool transactions are polled: as Bitcoin ABC, once
   * avalanche has finalized a block.
   * @returns {Boolean}
   */

  isPreconsensusActivated() {
    return this.preConsensus && this.hasFinalizedTip();
  }

  /**
   * Poll a transaction we did not get through a mempool, as an SPV node
   * does for its own: once pre-consensus is active, Bitcoin ABC nodes
   * vote on it as they would on a mempool transaction.
   * @param {TX} tx
   * @returns {Promise} - Returns Boolean.
   */

  async watchTransaction(tx) {
    const key = tx.txid();

    if (this.txStatus.has(key))
      return false;

    this.watchedTxs.set(key, tx);

    if (this.watchedTxs.size > MAX_WATCHED_TXS)
      this.watchedTxs.delete(this.watchedTxs.keys().next().value);

    if (!this.isPreconsensusActivated())
      return false;

    return this.addToReconcile(itemTypes.TX, tx);
  }

  /**
   * What polls decided of a transaction: 'final', 'rejected', 'invalid',
   * 'pending' while polled or watched, or 'unknown'.
   * @param {Hash} hash
   * @returns {String}
   */

  getTransactionStatus(hash) {
    const key = util.revHex(hash);

    if (this.txStatus.has(key))
      return this.txStatus.get(key);

    if (this.mempool && this.mempool.isAvalancheFinalized(hash))
      return 'final';

    if (this.watchedTxs.has(key)
        || this.voteRecords.has(itemKey(itemTypes.TX, hash))) {
      return 'pending';
    }

    return 'unknown';
  }

  /**
   * Note what polls decided of a transaction.
   * @private
   */

  setTransactionStatus(tx, status) {
    const key = tx.txid();
    const result = {
      [voteStatus.FINALIZED]: 'final',
      [voteStatus.REJECTED]: 'rejected',
      [voteStatus.INVALID]: 'invalid'
    }[status];

    // Accepted is not final, nor stalled a verdict.
    if (!result)
      return;

    // Rejected may yet be accepted.
    if (result === 'rejected' && this.txStatus.get(key) === 'final')
      return;

    this.txStatus.delete(key);
    this.txStatus.set(key, result);

    if (this.txStatus.size > MAX_WATCHED_TXS)
      this.txStatus.delete(this.txStatus.keys().next().value);

    if (result !== 'rejected')
      this.watchedTxs.delete(key);
  }

  /**
   * Polls began finalizing blocks: start on the transactions we watch.
   * @private
   * @returns {Promise}
   */

  async pollWatchedTransactions() {
    for (const tx of this.watchedTxs.values())
      await this.addToReconcile(itemTypes.TX, tx);
  }

  /**
   * A transaction entered the mempool.
   * @param {TX} tx
   * @returns {Promise}
   */

  async transactionAddedToMempool(tx) {
    if (this.isPreconsensusActivated())
      await this.addToReconcile(itemTypes.TX, tx);
  }

  /*
   * Stake contenders
   */

  /**
   * Bitcoin ABC's getStakeContenderStatus: the peer manager's, or -2,
   * pending, while we have chosen no winner for its block.
   * @param {Hash} id
   * @returns {Number}
   */

  getStakeContenderStatus(id) {
    const {status, prevHash} = this.peerManager.getStakeContenderStatus(id,
      proofId => this.invalidProofs.has(proofId.toString('hex')));

    if (status !== -1) {
      const winners = this.getStakingRewardWinners(prevHash);
      if (!winners || winners.length === 0)
        return -2;
    }

    return status;
  }

  pollStakeContenders(prev) {
    this.promoteAndPollStakeContenders(prev).catch((err) => {
      this.emit('error', err);
    });
  }

  /**
   * Carry the contenders over to the block after `prev`, set our own
   * winners' status, and poll the best of them.
   * @param {ChainEntry} prev
   * @returns {Promise}
   */

  async promoteAndPollStakeContenders(prev) {
    if (!this.isQuorumEstablished())
      return;

    const pm = this.peerManager;
    pm.promoteStakeContendersToBlock(prev);

    const winners = this.getStakingRewardWinners(prev.hash) || [];
    const pollable = pm.setContenderStatusForLocalWinners(prev, winners,
      CONTENDER_MAX_POLLABLE);

    for (const id of pollable)
      await this.addToReconcile(itemTypes.CONTENDER, id);
  }

  /**
   * Avalanche finalized a contender: it joins its block's winners.
   * @param {Hash} id
   * @returns {Promise}
   */

  async finalizeStakeContender(id) {
    const {prevHash, winners} = this.peerManager.finalizeStakeContender(id);

    if (winners.length === 0)
      return;

    const prev = await this.chain.getEntryByHash(prevHash);
    if (prev)
      this.setStakingRewardWinners(prev, winners);
  }

  /**
   * Avalanche rejected a contender. If it was our winner, the winners
   * are those avalanche accepted, or chosen again without it.
   * @param {Hash} id
   * @returns {Promise}
   */

  async rejectStakeContender(id) {
    const pm = this.peerManager;
    const info = pm.getStakeContenderInfo(id);

    pm.rejectStakeContender(id);

    if (!info)
      return;

    const {prevHash, proofId} = info;
    const winners = this.getStakingRewardWinners(prevHash);

    if (!winners || winners.length === 0)
      return;

    const isWinner = w => w.proofId && w.proofId.equals(proofId);

    // Only the first winner matters.
    if (!winners.some(isWinner) || !isWinner(winners[0]))
      return;

    const prev = await this.chain.getEntryByHash(prevHash);
    if (!prev)
      return;

    let next;
    if (pm.hasAcceptedStakeWinner(prevHash)) {
      next = pm.getStakeContenderWinners(prevHash);
    } else {
      const rejected = this.getRejectedContenders(prevHash);
      rejected.add(proofId.toString('hex'));
      next = selectWinners(pm, prev, this.now(), {rejected});
    }

    if (next && next.length > 0)
      this.setStakingRewardWinners(prev, next);
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
    const record = new VoteRecord(accepted,
      this.voteRecordSeed ? this.voteRecordSeed() : null);

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

    if (type === itemTypes.CONTENDER)
      return this.getStakeContenderStatus(item) !== -1;

    if (type === itemTypes.TX) {
      if (this.watchedTxs.has(item.txid()))
        return true;
      return this.mempool != null && this.mempool.isWorthPolling(item.hash());
    }

    if (type === itemTypes.PROOF) {
      // Not immature or discarded ones.
      const id = item.id();
      return this.peerManager.isBoundToPeer(id)
        || this.peerManager.isInConflictingPool(id);
    }

    assert(type === itemTypes.BLOCK);

    if (this.chain.invalid.has(item.hash))
      return false;

    if (this.recheckTip && item.hash.equals(this.recheckTip.hash))
      return true;

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

    if (type === itemTypes.CONTENDER)
      return this.getStakeContenderStatus(item) === 0;

    // Our own, watched: we hold it valid.
    if (type === itemTypes.TX) {
      if (this.watchedTxs.has(item.txid()))
        return true;
      return this.mempool != null && this.mempool.hasEntry(item.hash());
    }

    assert(type === itemTypes.BLOCK);
    return this.chain.isMainChain(item);
  }

  async getItemFromInv(inv) {
    switch (inv.type) {
      case invTypes.AVA_PROOF:
        return [itemTypes.PROOF, this.peerManager.getProof(inv.hash)];
      case invTypes.AVA_STAKE_CONTENDER:
        return [itemTypes.CONTENDER, inv.hash];
      case invTypes.TX: {
        const watched = this.watchedTxs.get(util.revHex(inv.hash));
        if (watched)
          return [itemTypes.TX, watched];
        if (!this.mempool)
          return [itemTypes.TX, null];
        // In the mempool, or kept aside as conflicting.
        const tx = this.mempool.getTX(inv.hash)
          || this.mempool.conflicting.getTX(inv.hash);
        return [itemTypes.TX, tx];
      }
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

  getInvsForNextPoll(maxElements, forPoll, nodeId = null) {
    const invs = [];

    for (const entry of this.sortedRecords()) {
      if (invs.length >= maxElements)
        break;

      // Not items the node's vote would not count on.
      if (nodeId != null && !entry.record.wouldCount(nodeId))
        continue;

      const poll = forPoll
        ? entry.record.registerPoll()
        : entry.record.shouldPoll();

      if (!poll)
        continue;

      invs.push(new InvItem(invTypeOf(entry.type), entry.hash));
    }

    return invs;
  }

  sortedRecords() {
    return this.voteRecords.sorted();
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
      const entry = this.voteRecords.get(itemKey(itemTypeOf(inv.type),
        inv.hash));
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

    const aware = this.filterAwarePolling;

    for (;;) {
      const nodeId = aware
        ? this.peerManager.selectNodeWhere(id => this.wouldCountVote(id))
        : this.peerManager.selectNode();

      if (nodeId === PeerManager.NO_NODE)
        return;

      const node = this.peerManager.getNode(nodeId);
      const invs = this.getInvsForNextPoll(node.maxElements, true,
        aware ? nodeId : null);

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
   * Whether a node's vote would count on any item to poll.
   * @private
   * @param {Number} nodeId
   * @returns {Boolean}
   */

  wouldCountVote(nodeId) {
    for (const {record} of this.voteRecords.values()) {
      if (record.shouldPoll() && record.wouldCount(nodeId))
        return true;
    }
    return false;
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

      const again = this.recheckTip != null
        && update.hash.equals(this.recheckTip.hash);
      if (again)
        this.recheckTip = null;

      const tip = this.finalizationTip;
      if (tip && update.item.height <= tip.height) {
        const ancestor = await this.chain.getAncestor(tip,
          update.item.height);
        if (ancestor && ancestor.hash.equals(update.hash)) {
          // Final from before a restart, and again now: polls work.
          if (again)
            this.beginPreconsensus();
          continue;
        }
      }

      this.finalizationTip = update.item;
      this.beginPreconsensus();

      // As Bitcoin ABC: winners and contenders below it are done with.
      this.cleanupStakingRewards(update.item.height);
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
   * A node polled us: answer each item with our vote, as Bitcoin ABC
   * does, signed by our session key. Before a quorum, every vote is
   * unknown.
   * @private
   * @param {Object} state
   * @param {Buffer} data
   * @returns {Promise}
   */

  async handlePoll(state, data) {
    if (!this.answerPolls)
      return;

    // As Bitcoin ABC: a poll inside the cooldown is dropped, and still
    // counts, so a node polling too often keeps being dropped.
    const now = this.ms();
    const last = state.lastPoll;
    state.lastPoll = now;

    if (now < last + this.cooldown) {
      this.log('debug', 'Ignoring repeated avapoll from %s.',
        state.peer.hostname());
      return;
    }

    // As Bitcoin ABC, its size before its items: the round, then the count.
    const count = decode(() => {
      const br = bio.read(data);
      br.readBytes(8);
      return br.readVarint();
    });

    if (count > this.maxElementPoll) {
      this.misbehaving(state, 'too-many-ava-poll');
      return;
    }

    const poll = decode(() => Poll.fromRaw(data));

    const quorum = this.isQuorumEstablished();
    const votes = [];

    for (const inv of poll.invs) {
      const error = quorum ? await this.getVote(inv) : UNKNOWN;
      votes.push(new Vote(error >>> 0, inv.hash));
    }

    const response = new Response(poll.round, this.cooldown, votes);
    response.sign(this.sessionKey);

    this.send(state.peer, 'avaresponse', response.toRaw());
  }

  /**
   * Our vote on an item, as Bitcoin ABC's: 0 yes, else why not.
   * @param {InvItem} inv
   * @returns {Promise} - Returns Number (u32).
   */

  async getVote(inv) {
    switch (inv.type) {
      case invTypes.BLOCK:
        return this.getBlockVote(inv.hash);
      case invTypes.AVA_PROOF:
        return this.getProofVote(inv.hash);
      case invTypes.TX:
        if (!this.isPreconsensusActivated())
          return UNKNOWN;
        return this.getTxVote(inv.hash);
      case invTypes.AVA_STAKE_CONTENDER:
        if (!this.stakingPreConsensus)
          return UNKNOWN;
        return this.getStakeContenderStatus(inv.hash) >>> 0;
    }
    return UNKNOWN;
  }

  /**
   * Bitcoin ABC's GetAvalancheVoteForBlock: 0 on our chain, 1 invalid,
   * 2 parked, 3 a fork, pending if on our tip, unknown if unknown.
   * @param {Hash} hash
   * @returns {Promise} - Returns Number.
   */

  async getBlockVote(hash) {
    if (!this.chain)
      return UNKNOWN;

    // bcash keeps no entry for an invalid block, only its hash.
    if (this.chain.invalid.has(hash))
      return 1;

    const entry = await this.chain.getEntryByHash(hash);

    if (!entry)
      return UNKNOWN;

    if (await this.chain.isOnParkedChain(entry))
      return 2;

    if (await this.chain.isMainChain(entry))
      return 0;

    const tip = this.chain.tip;
    const fork = await this.chain.findFork(tip, entry);

    if (!fork.hash.equals(tip.hash))
      return 3;

    // On our tip, not connected yet: a full node has its data.
    return PENDING;
  }

  /**
   * Bitcoin ABC's getAvalancheVoteForProof: 0 bound to a peer, 1 invalid,
   * 2 immature, 3 conflicting.
   * @param {Hash} id
   * @returns {Number}
   */

  getProofVote(id) {
    const pm = this.peerManager;

    if (this.invalidProofs.has(id.toString('hex')))
      return 1;

    if (pm.isBoundToPeer(id))
      return 0;

    if (!pm.exists(id))
      return UNKNOWN;

    if (pm.isImmature(id))
      return 2;

    if (pm.isInConflictingPool(id))
      return 3;

    return MISSING;
  }

  /**
   * Bitcoin ABC's GetAvalancheVoteForTx: 0 confirmed, final or polled in
   * the mempool, 1 rejected, 2 conflicting, missing if an orphan, pending
   * if in the mempool unpolled.
   * @param {Hash} hash
   * @returns {Number}
   */

  getTxVote(hash) {
    if (this.recentConfirmed.test(hash))
      return 0;

    const mempool = this.mempool;

    if (!mempool)
      return UNKNOWN;

    if (mempool.rejects.test(hash))
      return 1;

    if (mempool.isAvalancheFinalized(hash))
      return 0;

    if (mempool.hasEntry(hash))
      return this.isPolled(itemTypes.TX, hash) ? 0 : PENDING;

    if (mempool.conflicting.has(hash))
      return 2;

    if (mempool.hasOrphan(hash))
      return MISSING;

    return UNKNOWN;
  }

  /**
   * A block connected: its transactions count as confirmed for votes.
   * @param {Block} block
   */

  blockConnected(block) {
    for (const tx of block.txs)
      this.recentConfirmed.add(tx.hash());
  }

  /**
   * A block disconnected: as Bitcoin ABC, forget them all.
   */

  blockDisconnected() {
    this.recentConfirmed.reset();
  }

  /**
   * A node answered a poll.
   * @private
   */

  async handleResponse(state, data) {
    const response = decode(() => Response.fromRaw(data));

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

    if (update.type === itemTypes.CONTENDER) {
      await this.applyContenderUpdate(update);
      return;
    }

    // For the mempool, which the pool holds.
    if (update.type === itemTypes.TX) {
      this.setTransactionStatus(update.item, update.status);
      this.emit('tx vote', update.item, update.status);
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

  /**
   * Act on what polls decided of a stake contender, as Bitcoin ABC.
   * @private
   */

  async applyContenderUpdate(update) {
    const id = update.item;

    switch (update.status) {
      case voteStatus.ACCEPTED:
        this.peerManager.acceptStakeContender(id);
        break;
      case voteStatus.FINALIZED:
        this.setRecentlyFinalized(id);
        await this.finalizeStakeContender(id);
        break;
      case voteStatus.REJECTED:
      case voteStatus.INVALID:
        await this.rejectStakeContender(id);
        break;
    }
  }

  /**
   * Ask a node for the avalanche nodes it knows.
   * @param {Object} state
   */

  requestAvaAddrs(state) {
    state.avaAddrsRequested = this.now();
    this.send(state.peer, 'getavaaddr');
  }

  /**
   * Whether an addr from a peer answers our getavaaddr: then it lists
   * avalanche nodes, though Bitcoin ABC gives no services for them.
   * Answered once.
   * @param {Peer} peer
   * @returns {Boolean}
   */

  answersAvaAddrs(peer) {
    const state = this.peers.get(peer.id);

    if (!state || !state.avaAddrsRequested)
      return false;

    const asked = state.avaAddrsRequested;
    state.avaAddrsRequested = 0;

    return this.now() - asked <= AVAADDR_ANSWER_TIMEOUT;
  }

  send(peer, cmd, data = Buffer.alloc(0)) {
    peer.send(new packets.UnknownPacket(cmd, data));
  }
}

/*
 * Helpers
 */

function itemHash(type, item) {
  switch (type) {
    case itemTypes.PROOF:
      return item.id();
    case itemTypes.CONTENDER:
      return item;
    case itemTypes.TX:
      return item.hash();
    default:
      return item.hash;
  }
}

function invTypeOf(type) {
  switch (type) {
    case itemTypes.PROOF:
      return invTypes.AVA_PROOF;
    case itemTypes.CONTENDER:
      return invTypes.AVA_STAKE_CONTENDER;
    case itemTypes.TX:
      return invTypes.TX;
    default:
      return invTypes.BLOCK;
  }
}

function itemTypeOf(invType) {
  switch (invType) {
    case invTypes.AVA_PROOF:
      return itemTypes.PROOF;
    case invTypes.AVA_STAKE_CONTENDER:
      return itemTypes.CONTENDER;
    case invTypes.TX:
      return itemTypes.TX;
    default:
      return itemTypes.BLOCK;
  }
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

  // Contenders and transactions by id, as uint256s.
  if (a.type === itemTypes.CONTENDER || a.type === itemTypes.TX)
    return compareIds(a.hash, b.hash);

  const work = b.item.chainwork.cmp(a.item.chainwork);
  if (work !== 0)
    return work;

  return Buffer.compare(a.hash, b.hash);
}

/**
 * Vote records by key, and kept in poll order until one comes or goes,
 * as Bitcoin ABC's ordered VoteMap: each poll, every 10 ms, need not sort
 * them all again, many as a mempool's may be.
 * @ignore
 */

class RecordMap extends Map {
  set(key, value) {
    this.order = null;
    return super.set(key, value);
  }

  delete(key) {
    this.order = null;
    return super.delete(key);
  }

  clear() {
    this.order = null;
    return super.clear();
  }

  sorted() {
    if (!this.order)
      this.order = [...this.values()].sort(compareRecords);
    return this.order;
  }
}

/**
 * Decode what a peer sent: whatever fails in it, a bound, a short read,
 * an absurd length, is the peer's doing, so marked.
 * @ignore
 */

function decode(fn) {
  try {
    return fn();
  } catch (e) {
    e.malformed = true;
    throw e;
  }
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
Processor.MAX_INVALID_AVAPROOFS = MAX_INVALID_AVAPROOFS;
Processor.INVALID_AVAPROOFS_INTERVAL = INVALID_AVAPROOFS_INTERVAL;
Processor.TIME_STEP = TIME_STEP;
Processor.COOLDOWN = COOLDOWN;
Processor.PEER_REPLACEMENT_COOLDOWN = PEER_REPLACEMENT_COOLDOWN;
Processor.voteStatus = voteStatus;
Processor.itemTypes = itemTypes;

module.exports = Processor;
