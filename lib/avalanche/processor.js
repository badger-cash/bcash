/*!
 * processor.js - avalanche processor for bcash
 * Copyright (c) 2026, Marianas Rai Corp (MIT License).
 * Ported from Bitcoin ABC's src/avalanche/processor.{h,cpp} and the
 * avalanche handling in src/net_processing.cpp.
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const random = require('bcrypto/lib/random');
const packets = require('../net/packets');
const InvItem = require('../primitives/invitem');
const Proof = require('./proof');
const {CompactProofs, ProofsRequest} = require('./compactproofs');
const {
  Hello,
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
   * @param {Number} [options.minAvaproofsNodeCount]
   * @param {Number} [options.maxElementPoll]
   * @param {Function} [options.now] - Seconds.
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

    if (connected < Math.round(total * this.minQuorumConnectedScoreRatio))
      return false;

    this.quorumIsEstablished = true;
    this.emit('quorum');

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

  async updatedBlockTip() {
    const registered = await this.peerManager.updatedBlockTip();
    for (const proof of registered)
      this.relayProof(proof.id());
  }

  async cleanupDanglingProofs() {
    const registered = await this.peerManager.cleanupDanglingProofs();
    for (const proof of registered)
      this.log('debug', 'Promoting dangling proof %s.', proof.rid());
  }

  send(peer, cmd, data = Buffer.alloc(0)) {
    peer.send(new packets.UnknownPacket(cmd, data));
  }
}

/*
 * Helpers
 */

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
Processor.MIN_AVAPROOFS_NODE_COUNT = MIN_AVAPROOFS_NODE_COUNT;
Processor.GETAVAPROOFS_INTERVAL = GETAVAPROOFS_INTERVAL;
Processor.GETAVAADDR_INTERVAL = GETAVAADDR_INTERVAL;
Processor.UNCONDITIONAL_RELAY_DELAY = UNCONDITIONAL_RELAY_DELAY;
Processor.PROOF_REQUEST_TIMEOUT = PROOF_REQUEST_TIMEOUT;

module.exports = Processor;
