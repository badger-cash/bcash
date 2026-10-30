/*!
 * rtc.js - WebRTC between pages for bcash
 * Copyright (c) 2026, the bcash contributors (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * Pages connect to each other over WebRTC data channels, as peers. A page
 * cannot be dialed, so it needs others to introduce it:
 *
 * - A page takes a key of its own, and tells its home node (a full node
 *   it reached over WebTransport) it accepts connections: a record it
 *   signs, naming its key and the node. The node adds its certificate
 *   hashes, so any page can dial it, and full nodes pass the record on
 *   to each other, as they pass addresses.
 * - A page that hears of another's record dials that page's home node
 *   over WebTransport, and sends it an offer addressed to the other's
 *   key. The node passes it to the page, and the answer back, and then
 *   the ICE candidates, so each signaling message crosses one node, what
 *   ever the distance between the two pages' homes. Each message is
 *   signed by its sender, so no other page can speak for it.
 * - The data channel, once open, carries the same P2P messages as any
 *   other connection, and each page takes the other as a peer.
 *
 * Nodes that serve pages tell them their STUN port, for finding a path
 * through home routers.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const IP = require('binet');
const bio = require('bufio');
const sha256 = require('bcrypto/lib/sha256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const util = require('../utils/util');

/*
 * Constants
 */

// A record lasts this long (seconds); a page renews it at half that.
const RECORD_LIFETIME = 20 * 60;
const ANNOUNCE_INTERVAL = (RECORD_LIFETIME / 2) * 1000;

// Records a node keeps, and sends in one message.
const MAX_RECORDS = 1000;
const MAX_RTCADDR = 100;
const MAX_RECORD_HASHES = 3;

// A signal's payload (an SDP or an ICE candidate) and its age (seconds).
const MAX_SIGNAL_DATA = 8192;
const MAX_SIGNAL_AGE = 5 * 60;

// A signal is one of these.
const signals = {
  OFFER: 1,
  ANSWER: 2,
  CANDIDATE: 3
};

// STUN servers a page remembers, and uses at once.
const MAX_STUN = 8;
const MAX_STUN_USED = 2;

// How a page finds, and how long it waits.
const DISCOVER_INTERVAL = 15 * 1000;
const DIAL_TIMEOUT = 30 * 1000;
const RETRY_AFTER = 5 * 60 * 1000;

// Data channel: messages of at most this size, and back pressure above
// this much queued.
const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1024 * 1024;

const RECORD_TAG = Buffer.from('bcash rtc record', 'ascii');
const SIGNAL_TAG = Buffer.from('bcash rtc signal', 'ascii');

/**
 * Whether a time (seconds) is fresh enough for a record or signal.
 * @param {Number} time
 * @param {Number} age - The most seconds it may be old.
 * @param {Number} now
 * @returns {Boolean}
 */

function fresh(time, age, now) {
  return time <= now + 10 * 60 && time > now - age;
}

/**
 * The address a page's key stands for in the peer list: a unique local
 * IPv6 address (fd00::/8), which no one can dial.
 * @param {Buffer} key
 * @returns {String}
 */

function keyAddress(key) {
  const raw = sha256.digest(key).slice(0, 16);
  raw[0] = 0xfd;
  return IP.toString(raw);
}

/**
 * RTCRecord: a page's key, its home node's WebTransport endpoint, when,
 * and the page's signature over those; then the home node's certificate
 * hashes, which the node adds.
 */

class RTCRecord {
  constructor(options = {}) {
    this.key = options.key || null;
    this.time = options.time || 0;
    this.host = options.host || '0.0.0.0';
    this.port = options.port || 0;
    this.signature = options.signature || null;
    // [{hash: hex, notAfter: seconds}], from the home node.
    this.hashes = options.hashes || [];
  }

  get id() {
    return this.key.toString('hex');
  }

  get hostname() {
    return IP.toHostname(this.host, this.port);
  }

  get expires() {
    return this.time + RECORD_LIFETIME;
  }

  isRoutable() {
    return IP.isRoutable(IP.toBuffer(this.host));
  }

  signingHash() {
    const bw = bio.write(RECORD_TAG.length + 33 + 4 + 16 + 2);
    bw.writeBytes(RECORD_TAG);
    bw.writeBytes(this.key);
    bw.writeU32(this.time);
    bw.writeBytes(IP.toBuffer(this.host));
    bw.writeU16(this.port);
    return sha256.digest(bw.render());
  }

  sign(priv) {
    this.signature = secp256k1.sign(this.signingHash(), priv);
    return this;
  }

  verify() {
    if (!this.key || !this.signature)
      return false;
    return secp256k1.verify(this.signingHash(), this.signature, this.key);
  }

  isFresh(now = util.now()) {
    return fresh(this.time, RECORD_LIFETIME, now);
  }

  getSize() {
    return 33 + 4 + 16 + 2 + 64 + 1 + this.hashes.length * 36;
  }

  write(bw) {
    assert(this.hashes.length <= MAX_RECORD_HASHES);
    bw.writeBytes(this.key);
    bw.writeU32(this.time);
    bw.writeBytes(IP.toBuffer(this.host));
    bw.writeU16(this.port);
    bw.writeBytes(this.signature);
    bw.writeU8(this.hashes.length);
    for (const {hash, notAfter} of this.hashes) {
      bw.writeBytes(Buffer.from(hash, 'hex'));
      bw.writeU32(notAfter);
    }
    return bw;
  }

  read(br) {
    this.key = br.readBytes(33);
    this.time = br.readU32();
    this.host = IP.toString(br.readBytes(16));
    this.port = br.readU16();
    this.signature = br.readBytes(64);

    const n = br.readU8();

    if (n > MAX_RECORD_HASHES)
      throw new Error('Too many record hashes.');

    this.hashes = [];
    for (let i = 0; i < n; i++) {
      this.hashes.push({
        hash: br.readBytes(32).toString('hex'),
        notAfter: br.readU32()
      });
    }

    return this;
  }

  encode() {
    return this.write(bio.write(this.getSize())).render();
  }

  static decode(data) {
    const br = bio.read(data);
    const record = new this().read(br);
    if (br.left() !== 0)
      throw new Error('Trailing record data.');
    return record;
  }

  static encodeList(records) {
    if (records.length > MAX_RTCADDR)
      throw new Error('Too many rtcaddr records.');

    let size = 1;
    for (const record of records)
      size += record.getSize();

    const bw = bio.write(size);
    bw.writeU8(records.length);
    for (const record of records)
      record.write(bw);

    return bw.render();
  }

  static decodeList(data) {
    const br = bio.read(data);
    const count = br.readU8();

    if (count > MAX_RTCADDR)
      throw new Error('Too many rtcaddr records.');

    const records = [];
    for (let i = 0; i < count; i++)
      records.push(new this().read(br));

    if (br.left() !== 0)
      throw new Error('Trailing rtcaddr data.');

    return records;
  }
}

/**
 * RTCSignal: an offer, an answer or an ICE candidate, from one page's
 * key to another's, signed by its sender.
 */

class RTCSignal {
  constructor(options = {}) {
    this.to = options.to || null;
    this.from = options.from || null;
    this.time = options.time || 0;
    this.kind = options.kind || 0;
    this.data = options.data || Buffer.alloc(0);
    this.signature = options.signature || null;
  }

  signingHash() {
    const bw = bio.write(SIGNAL_TAG.length + 33 + 33 + 4 + 1
      + bio.sizeVarBytes(this.data));
    bw.writeBytes(SIGNAL_TAG);
    bw.writeBytes(this.to);
    bw.writeBytes(this.from);
    bw.writeU32(this.time);
    bw.writeU8(this.kind);
    bw.writeVarBytes(this.data);
    return sha256.digest(bw.render());
  }

  sign(priv) {
    this.signature = secp256k1.sign(this.signingHash(), priv);
    return this;
  }

  verify() {
    return secp256k1.verify(this.signingHash(), this.signature, this.from);
  }

  isFresh(now = util.now()) {
    return fresh(this.time, MAX_SIGNAL_AGE, now);
  }

  encode() {
    const bw = bio.write(33 + 33 + 4 + 1 + bio.sizeVarBytes(this.data) + 64);
    bw.writeBytes(this.to);
    bw.writeBytes(this.from);
    bw.writeU32(this.time);
    bw.writeU8(this.kind);
    bw.writeVarBytes(this.data);
    bw.writeBytes(this.signature);
    return bw.render();
  }

  static decode(data) {
    const br = bio.read(data);
    const signal = new this();
    signal.to = br.readBytes(33);
    signal.from = br.readBytes(33);
    signal.time = br.readU32();
    signal.kind = br.readU8();
    signal.data = br.readVarBytes();
    signal.signature = br.readBytes(64);

    if (br.left() !== 0)
      throw new Error('Trailing rtcsignal data.');

    if (signal.data.length > MAX_SIGNAL_DATA)
      throw new Error('Signal too large.');

    if (signal.kind < signals.OFFER || signal.kind > signals.CANDIDATE)
      throw new Error('Unknown signal kind.');

    return signal;
  }
}

/**
 * The records a node knows: the newest per key, none expired, the oldest
 * dropped first past the limit.
 */

class RTCRecords {
  constructor(max = MAX_RECORDS) {
    this.max = max;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  /**
   * Keep a record, if newer than what we have.
   * @param {RTCRecord} record
   * @returns {Boolean} - Whether it was new.
   */

  add(record) {
    const old = this.map.get(record.id);

    if (old && old.time >= record.time)
      return false;

    // Last in the map is the newest.
    this.map.delete(record.id);

    while (this.map.size >= this.max)
      this.map.delete(this.map.keys().next().value);

    this.map.set(record.id, record);

    return true;
  }

  get(id) {
    return this.map.get(id) || null;
  }

  /**
   * The records still fresh, the newest first.
   * @param {Number} [now]
   * @returns {RTCRecord[]}
   */

  toArray(now = util.now()) {
    const out = [];
    for (const record of this.map.values()) {
      if (record.isFresh(now))
        out.push(record);
      else
        this.map.delete(record.id);
    }
    return out.reverse();
  }
}

/**
 * A data channel as a socket, as the peer expects one.
 */

class DataChannelSocket extends EventEmitter {
  constructor(key) {
    super();
    this.rtcKey = key;
    this.remoteAddress = keyAddress(key);
    this.remotePort = 0;
    this.pc = null;
    this.channel = null;
    this.paused = false;
    this.queue = [];
    this.destroyed = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    // A page over WebRTC, counted apart from other peers.
    this.webRTC = true;
  }

  /**
   * Take an open data channel.
   * @param {RTCPeerConnection} pc
   * @param {RTCDataChannel} channel
   */

  attach(pc, channel) {
    this.pc = pc;
    this.channel = channel;

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = HIGH_WATER / 2;

    channel.onmessage = (event) => {
      const data = Buffer.from(event.data);
      this.bytesRead += data.length;
      if (this.paused)
        this.queue.push(data);
      else
        this.emit('data', data);
    };

    channel.onbufferedamountlow = () => this.emit('drain');

    channel.onclose = () => this.destroy();

    channel.onerror = (event) => {
      if (this.destroyed)
        return;
      const err = event && event.error;
      this.emit('error', new Error(err && err.message
        ? err.message : 'Data channel error.'));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed')
        this.destroy();
    };
  }

  /**
   * Tell the peer we are connected, as a TCP socket does.
   */

  open() {
    setTimeout(() => {
      if (!this.destroyed)
        this.emit('connect');
    }, 0);
  }

  write(data) {
    if (this.destroyed)
      return false;

    this.bytesWritten += data.length;

    try {
      for (let i = 0; i < data.length; i += CHUNK_SIZE)
        this.channel.send(new Uint8Array(data.slice(i, i + CHUNK_SIZE)));
    } catch (e) {
      this.emit('error', e);
      return false;
    }

    return this.channel.bufferedAmount < HIGH_WATER;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    while (!this.paused && this.queue.length > 0)
      this.emit('data', this.queue.shift());
  }

  setNoDelay() {}

  destroy() {
    if (this.destroyed)
      return;

    this.destroyed = true;

    try {
      if (this.channel)
        this.channel.close();
      if (this.pc)
        this.pc.close();
    } catch (e) {
      ;
    }

    this.emit('close');
  }
}

/**
 * A page's WebRTC: its key, its record at its home node, and its
 * connections to other pages, being made and made.
 */

class RTCManager {
  /**
   * @param {Pool} pool
   * @param {Object} options
   * @param {Function} options.RTCPeerConnection
   * @param {Buffer} [options.key] - A private key; default: a new one.
   * @param {Number} [options.maxPeers]
   */

  constructor(pool, options) {
    assert(typeof options.RTCPeerConnection === 'function');

    this.pool = pool;
    this.logger = pool.logger;
    this.RTCPeerConnection = options.RTCPeerConnection;
    this.priv = options.key || secp256k1.privateKeyGenerate();
    this.key = secp256k1.publicKeyCreate(this.priv, true);
    this.id = this.key.toString('hex');
    this.maxPeers = options.maxPeers != null ? options.maxPeers : 4;

    // STUN servers our nodes told us of, newest last: still asked once we
    // are no longer connected to those nodes, as STUN needs no connection.
    this.stun = [];

    // The node peer our record names, and when we last announced.
    this.home = null;
    this.lastAnnounce = 0;

    // By the other page's key (hex): a connection being made.
    this.sessions = new Map();
    // By key: when we last failed to reach a page.
    this.failed = new Map();

    this.timer = null;
  }

  start() {
    if (this.timer)
      return;
    this.timer = setInterval(() => this.tick(), DISCOVER_INTERVAL);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const session of this.sessions.values())
      this.endSession(session, false);
  }

  /**
   * The pages we are connected to over WebRTC, by key.
   * @returns {Set}
   */

  connected() {
    const ids = new Set();
    for (let peer = this.pool.peers.head(); peer; peer = peer.next) {
      if (peer.rtc && peer.rtcKey)
        ids.add(peer.rtcKey.toString('hex'));
    }
    return ids;
  }

  /**
   * The ICE servers our nodes offer: STUN at each, by its address.
   * @returns {Object[]}
   */

  iceServers() {
    // The newest two our nodes told us of, connected to them or not.
    const urls = this.stun.slice(-MAX_STUN_USED);
    return urls.length > 0 ? [{urls}] : [];
  }

  /**
   * Remember a node's STUN server.
   * @param {Peer} peer
   */

  addStun(peer) {
    const {host} = peer.address;
    const name = IP.isIPv6String(host) ? `[${host}]` : host;
    const url = `stun:${name}:${peer.rtcStun}`;

    const i = this.stun.indexOf(url);
    if (i !== -1)
      this.stun.splice(i, 1);

    this.stun.push(url);

    if (this.stun.length > MAX_STUN)
      this.stun.shift();
  }

  /**
   * A node told us it introduces pages.
   * @param {Peer} peer
   */

  handleConfig(peer) {
    if (peer.rtcStun)
      this.addStun(peer);

    if (!this.home)
      this.announce(peer);

    // A connection waiting for this node.
    for (const session of this.sessions.values()) {
      if (session.waiting === peer.hostname())
        this.offer(session, peer);
    }
  }

  /**
   * Tell a node we accept connections.
   * @param {Peer} peer
   */

  announce(peer) {
    const record = new RTCRecord({
      key: this.key,
      time: util.now(),
      host: peer.address.host,
      port: peer.address.port
    });

    record.sign(this.priv);

    this.home = peer;
    this.lastAnnounce = Date.now();

    this.pool.sendRTC(peer, 'rtcannounce', record.encode());
    this.pool.sendRTC(peer, 'getrtcaddr', Buffer.alloc(0));

    this.logger.debug('Announced for WebRTC at %s.', peer.hostname());
  }

  /**
   * A page peer is open: tell it who we are, and ask whom it knows.
   * @param {Peer} peer
   */

  handlePeerOpen(peer) {
    const record = new RTCRecord({
      key: this.key,
      time: util.now(),
      host: '0.0.0.0',
      port: 0
    });

    record.sign(this.priv);

    this.pool.sendRTC(peer, 'rtcannounce', record.encode());
    this.pool.sendRTC(peer, 'getrtcaddr', Buffer.alloc(0));
  }

  handleClose(peer) {
    if (peer === this.home) {
      this.home = null;
      for (let p = this.pool.peers.head(); p; p = p.next) {
        if (p !== peer && p.rtcStun != null && p.handshake) {
          this.announce(p);
          break;
        }
      }
    }
  }

  tick() {
    const now = Date.now();

    if (this.home && now - this.lastAnnounce >= ANNOUNCE_INTERVAL)
      this.announce(this.home);
    else if (this.home)
      this.pool.sendRTC(this.home, 'getrtcaddr', Buffer.alloc(0));

    // With room for more, whom our page peers know.
    if (this.connected().size + this.sessions.size < this.maxPeers) {
      for (let peer = this.pool.peers.head(); peer; peer = peer.next) {
        if (peer.rtc && peer.handshake)
          this.pool.sendRTC(peer, 'getrtcaddr', Buffer.alloc(0));
      }
    }

    for (const session of this.sessions.values()) {
      if (now - session.start > DIAL_TIMEOUT) {
        this.logger.debug('WebRTC to %s timed out.', session.id.slice(0, 16));
        this.endSession(session, true);
      }
    }

    for (const [id, time] of this.failed) {
      if (now - time > RETRY_AFTER)
        this.failed.delete(id);
    }
  }

  /**
   * Records a node sent, or a page peer: dial a page we are not connected
   * to. A page peer's are of its own page peers, reached through it.
   * @param {RTCRecord[]} records
   * @param {Peer} [via] - The page peer that sent them.
   */

  handleRecords(records, via = null) {
    const connected = this.connected();
    const local = this.pool.network.type === 'regtest';

    for (const record of records) {
      if (connected.size + this.sessions.size >= this.maxPeers)
        break;

      const id = record.id;

      if (id === this.id || connected.has(id) || this.sessions.has(id))
        continue;

      if (this.failed.has(id))
        continue;

      if (!record.verify() || !record.isFresh())
        continue;

      if (!via) {
        if (!record.isRoutable() && !local)
          continue;

        if (record.hashes.length === 0)
          continue;
      }

      this.dial(record, via);

      // One new connection at a time.
      break;
    }
  }

  newSession(id, key) {
    const session = {
      id,
      key,
      pc: null,
      channel: null,
      peer: null,
      waiting: null,
      remoteSet: false,
      candidates: [],
      outbound: false,
      start: Date.now()
    };
    this.sessions.set(id, session);
    return session;
  }

  endSession(session, failed) {
    if (this.sessions.get(session.id) !== session)
      return;

    this.sessions.delete(session.id);

    if (failed)
      this.failed.set(session.id, Date.now());

    if (session.pc && !session.done) {
      try {
        session.pc.close();
      } catch (e) {
        ;
      }
    }
  }

  /**
   * Dial a page: through a page peer of ours that knows it, or through
   * its home node, which we reach first if need be.
   * @param {RTCRecord} record
   * @param {Peer} [via]
   */

  dial(record, via = null) {
    const session = this.newSession(record.id, record.key);
    session.outbound = true;

    if (via) {
      this.logger.debug('Dialing page %s through page %s.',
        record.id.slice(0, 16), via.rtcKey.toString('hex').slice(0, 16));
      this.offer(session, via);
      return;
    }

    const peer = this.pool.getRTCHome(record);

    if (!peer) {
      this.endSession(session, true);
      return;
    }

    this.logger.debug('Dialing page %s through %s.',
      record.id.slice(0, 16), peer.hostname());

    if (peer.handshake && peer.rtcStun != null) {
      this.offer(session, peer);
      return;
    }

    // Its config comes once it is open.
    session.waiting = peer.hostname();
  }

  createConnection(session, peer) {
    const pc = new this.RTCPeerConnection({iceServers: this.iceServers()});

    session.pc = pc;
    session.peer = peer;

    pc.onicecandidate = (event) => {
      if (!event.candidate)
        return;
      const json = event.candidate.toJSON
        ? event.candidate.toJSON()
        : event.candidate;
      this.signal(session, signals.CANDIDATE, json);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed')
        this.endSession(session, true);
    };

    return pc;
  }

  async offer(session, peer) {
    session.waiting = null;

    try {
      const pc = this.createConnection(session, peer);
      const channel = pc.createDataChannel('bcash', {ordered: true});

      session.channel = channel;
      channel.onopen = () => this.opened(session);

      const desc = await pc.createOffer();
      await pc.setLocalDescription(desc);

      this.signal(session, signals.OFFER, {type: desc.type, sdp: desc.sdp});
    } catch (e) {
      this.logger.debug('WebRTC offer failed: %s.', e.message);
      this.endSession(session, true);
    }
  }

  signal(session, kind, json) {
    if (!session.peer || session.peer.destroyed)
      return;

    const signal = new RTCSignal({
      to: session.key,
      from: this.key,
      time: util.now(),
      kind,
      data: Buffer.from(JSON.stringify(json), 'utf8')
    });

    signal.sign(this.priv);

    this.pool.sendRTC(session.peer, 'rtcsignal', signal.encode());
  }

  /**
   * A signal for us, from a node that carried it.
   * @param {Peer} peer
   * @param {RTCSignal} signal
   */

  async handleSignal(peer, signal) {
    if (!signal.to.equals(this.key))
      return;

    const id = signal.from.toString('hex');

    let json;
    try {
      json = JSON.parse(signal.data.toString('utf8'));
    } catch (e) {
      return;
    }

    let session = this.sessions.get(id);

    try {
      switch (signal.kind) {
        case signals.OFFER: {
          if (this.connected().has(id))
            return;

          if (session) {
            // Both dialed: the lower key's offer stands.
            if (session.outbound && this.id < id)
              return;
            this.endSession(session, false);
          }

          if (this.connected().size + this.sessions.size >= this.maxPeers)
            return;

          session = this.newSession(id, signal.from);

          const pc = this.createConnection(session, peer);

          pc.ondatachannel = (event) => {
            session.channel = event.channel;
            if (event.channel.readyState === 'open')
              this.opened(session);
            else
              event.channel.onopen = () => this.opened(session);
          };

          await pc.setRemoteDescription(json);
          await this.remoteSet(session);

          const desc = await pc.createAnswer();
          await pc.setLocalDescription(desc);

          this.signal(session, signals.ANSWER,
            {type: desc.type, sdp: desc.sdp});
          break;
        }

        case signals.ANSWER: {
          if (!session || !session.outbound || session.remoteSet)
            return;
          await session.pc.setRemoteDescription(json);
          await this.remoteSet(session);
          break;
        }

        case signals.CANDIDATE: {
          if (!session || !session.pc)
            return;
          if (!session.remoteSet) {
            session.candidates.push(json);
            return;
          }
          await session.pc.addIceCandidate(json);
          break;
        }
      }
    } catch (e) {
      this.logger.debug('WebRTC signal failed: %s.', e.message);
      if (session)
        this.endSession(session, true);
    }
  }

  async remoteSet(session) {
    session.remoteSet = true;
    const candidates = session.candidates;
    session.candidates = [];
    for (const candidate of candidates)
      await session.pc.addIceCandidate(candidate);
  }

  /**
   * The data channel is open: a peer.
   * @param {Object} session
   */

  opened(session) {
    if (this.sessions.get(session.id) !== session)
      return;

    session.done = true;
    this.sessions.delete(session.id);

    if (this.connected().has(session.id)) {
      session.pc.close();
      return;
    }

    const socket = new DataChannelSocket(session.key);
    socket.attach(session.pc, session.channel);

    this.logger.info('WebRTC open with page %s (%s).',
      session.id.slice(0, 16), session.outbound ? 'outbound' : 'inbound');

    this.pool.addRTCPeer(socket, session.outbound);
  }
}

/*
 * Expose
 */

exports.RECORD_LIFETIME = RECORD_LIFETIME;
exports.MAX_RTCADDR = MAX_RTCADDR;
exports.MAX_SIGNAL_DATA = MAX_SIGNAL_DATA;
exports.signals = signals;
exports.keyAddress = keyAddress;
exports.RTCRecord = RTCRecord;
exports.RTCSignal = RTCSignal;
exports.RTCRecords = RTCRecords;
exports.DataChannelSocket = DataChannelSocket;
exports.RTCManager = RTCManager;
