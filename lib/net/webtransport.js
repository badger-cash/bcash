/*!
 * webtransport.js - webtransport transport for bcash
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The P2P protocol over WebTransport, for browsers, which cannot open a
 * TCP socket: one bidirectional stream carries the same bytes a TCP
 * socket would, so peers and the pool see a socket like any other. A
 * node serves it with a self-signed certificate a page pins by its hash
 * (serverCertificateHashes), so an IP address is enough, with no domain
 * name or certificate authority. Browsers take such a certificate only
 * with an ECDSA P-256 key and a validity under 2 weeks: the server makes
 * its own, and the next before the current expires.
 *
 * The server needs the optional @fails-components/webtransport (and its
 * native transport); it is loaded only when a node is told to listen.
 */

const assert = require('bsert');
const crypto = require('crypto');
const EventEmitter = require('events');
const bio = require('bufio');
const {encoding} = bio;
const NetAddress = require('./netaddress');
const util = require('../utils/util');

/*
 * Constants
 */

// Browsers require a validity under 14 days; 13, from an hour ago (for
// clocks a little behind).
const CERT_LIFETIME = 13 * 24 * 60 * 60 * 1000;
const CERT_BACKDATE = 60 * 60 * 1000;

// Swap to the next certificate when the current has this little left:
// the next is announced, and pinned by pages, a day ahead.
const CERT_RENEW = 2 * 24 * 60 * 60 * 1000;

const DEFAULT_PATH = '/p2p';

// Entries in one `wtaddr`, as `addr`; endpoints kept; hashes per entry.
const MAX_WTADDR = 1000;
const MAX_WTHOSTS = 1000;
const MAX_WTADDR_HASHES = 4;

/*
 * DER
 */

function len(n) {
  if (n < 0x80)
    return Buffer.from([n]);

  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, body) => tlv(0xa0 | n, body);
const octets = body => tlv(0x04, body);
const bits = body => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const utf8 = str => tlv(0x0c, Buffer.from(str, 'utf8'));

function integer(buf) {
  // Positive: a leading zero if the high bit is set.
  if (buf[0] & 0x80)
    buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];

  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const bytes = [n & 0x7f];
    while ((n >>>= 7) > 0)
      bytes.unshift(0x80 | (n & 0x7f));
    out.push(...bytes);
  }

  return tlv(0x06, Buffer.from(out));
}

function utcTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  const str = pad(d.getUTCFullYear() % 100)
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(str, 'ascii'));
}

function ipBytes(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
    return Buffer.from(host.split('.').map(Number));
  return null;
}

/**
 * Make a certificate a page can pin by hash: self-signed, ECDSA P-256,
 * valid 13 days from an hour ago.
 * @param {Object} [options]
 * @param {String} [options.host] - Name or IPv4, also as its SAN.
 * @param {Number} [options.now] - Milliseconds.
 * @returns {Object} {cert, privKey (PEMs), hash (hex SHA-256 of the DER),
 *   notBefore, notAfter (ms)}
 */

function makeCertificate(options = {}) {
  const host = options.host || 'bcash';
  const now = options.now != null ? options.now : Date.now();
  const notBefore = now - CERT_BACKDATE;
  const notAfter = notBefore + CERT_LIFETIME;

  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  const spki = publicKey.export({type: 'spki', format: 'der'});
  const ecdsaWithSHA256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(host))));

  // subjectAltName: iPAddress, or dNSName. quiche refuses a leaf with
  // neither.
  const ip = ipBytes(host);
  const san = ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(host, 'ascii'));
  const extensions = [seq(oid('2.5.29.17'), octets(seq(san)))];

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    ecdsaWithSHA256,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    explicit(3, seq(...extensions))
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaWithSHA256, bits(signature));

  const pem = (label, body) => `-----BEGIN ${label}-----\n`
    + body.toString('base64').match(/.{1,64}/g).join('\n')
    + `\n-----END ${label}-----\n`;

  return {
    cert: pem('CERTIFICATE', der),
    privKey: privateKey.export({type: 'pkcs8', format: 'pem'}),
    hash: crypto.createHash('sha256').update(der).digest('hex'),
    notBefore,
    notAfter
  };
}

/*
 * Socket
 */

// bcash adds the peer's address to an error's message. A browser's
// WebTransportError is a DOMException, whose message is read-only.
function plainError(err) {
  const isDOM = typeof DOMException !== 'undefined'
    && err instanceof DOMException;

  if (err instanceof Error && !isDOM)
    return err;

  return new Error(err && err.message ? err.message : String(err));
}

/**
 * One WebTransport bidirectional stream, shaped as the net.Socket peers
 * use: 'connect', 'data', 'drain', 'error', 'close'; write(), destroy(),
 * pause(), resume().
 * @extends EventEmitter
 */

class WebTransportSocket extends EventEmitter {
  constructor(remoteAddress, remotePort) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    this.session = null;
    this.writer = null;
    this.reader = null;
    this.paused = false;
    this.wake = null;
    this.destroyed = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    // A peer over WebTransport: a page, counted apart from TCP inbound.
    this.webTransport = true;
  }

  attach(session, stream) {
    this.session = session;
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();

    // A session the other side closed cleanly (code 0) ends the socket;
    // its streams' reads fail, but that is no error.
    this.closedCleanly = false;
    this.sessionClosed = Promise.resolve(session.closed)
      .then((info) => {
        this.closedCleanly = !info || !info.closeCode;
      }, () => {});

    this.read();
  }

  async read() {
    try {
      for (;;) {
        if (this.paused)
          await new Promise(r => (this.wake = r));

        const {value, done} = await this.reader.read();

        if (done)
          break;

        this.bytesRead += value.length;
        this.emit('data', Buffer.from(value.buffer, value.byteOffset,
          value.byteLength));
      }
    } catch (e) {
      // The close may settle a moment after the read fails.
      // Settled once only: a race would resolve again, which bmocha (and
      // Node's multipleResolves) report.
      await new Promise((resolve) => {
        let timer = null;
        const finish = () => {
          if (!timer)
            return;
          clearTimeout(timer);
          timer = null;
          resolve();
        };
        timer = setTimeout(finish, 50);
        this.sessionClosed.then(finish);
      });

      if (!this.destroyed && !this.closedCleanly)
        this.emit('error', plainError(e));
    }

    this.destroy();
  }

  write(data) {
    if (this.destroyed)
      return false;

    this.bytesWritten += data.length;
    this.writer.write(new Uint8Array(data)).catch((e) => {
      if (!this.destroyed)
        this.emit('error', plainError(e));
    });

    // As net.Socket: false while the stream's queue is full, then 'drain'.
    if (this.writer.desiredSize > 0)
      return true;

    this.writer.ready.then(() => this.emit('drain'), () => {});

    return false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
  }

  setNoDelay() {}

  destroy() {
    if (this.destroyed)
      return;

    this.destroyed = true;

    try {
      if (this.session)
        this.session.close();
    } catch (e) {
      ;
    }

    this.emit('close');
  }
}

/**
 * Dial a node over WebTransport, pinning its certificate by hash.
 * @param {Function} WebTransport - The browser's, or the addon's in Node.
 * @param {String} host
 * @param {Number} port
 * @param {String|String[]} hashes - Hex SHA-256 of its certificate(s).
 * @param {String} [path]
 * @returns {WebTransportSocket} - 'connect' once the stream is open.
 */

function connect(WebTransport, host, port, hashes, path = DEFAULT_PATH) {
  assert(typeof WebTransport === 'function');

  if (!Array.isArray(hashes))
    hashes = [hashes];

  const socket = new WebTransportSocket(host, port);
  const name = host.includes(':') ? `[${host}]` : host;

  // With no hashes, the browser checks the certificate as for any site:
  // a seed, by its domain name.
  const options = {};
  if (hashes.length > 0) {
    options.serverCertificateHashes = hashes.map(hex => ({
      algorithm: 'sha-256',
      value: Buffer.from(hex, 'hex')
    }));
  }

  (async () => {
    const wt = new WebTransport(`https://${name}:${port}${path}`, options);
    await wt.ready;

    // Destroyed while dialing (its peer closed): as a TCP socket, it
    // connects to nothing then.
    if (socket.destroyed) {
      wt.close();
      return;
    }

    const stream = await wt.createBidirectionalStream();
    if (socket.destroyed) {
      wt.close();
      return;
    }

    socket.attach(wt, stream);
    socket.emit('connect');
  })().catch((e) => {
    if (socket.destroyed)
      return;
    socket.emit('error', plainError(e));
    socket.destroy();
  });

  return socket;
}

/*
 * Server
 */

/**
 * A WebTransport listener for P2P: each session's first bidirectional
 * stream becomes a socket, emitted as 'connection', as a TCP server's.
 * It makes its own certificate, and swaps to the next before it expires;
 * or, given one (a seed's, for its domain), reloads it when it changes.
 * @extends EventEmitter
 */

class WebTransportServer extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {String} [options.host] - Name for the certificate.
   * @param {String} [options.path]
   * @param {Function} [options.load] - Loads the server module.
   * @param {Function} [options.certificate] - Loads a certificate to
   * serve in place of its own: async () => ({cert, privKey}), PEM.
   */

  constructor(options = {}) {
    super();
    this.host = options.host || null;
    this.certificate = options.certificate || null;
    this.path = options.path || DEFAULT_PATH;
    this.load = options.load
      || (() => import('@fails-components/webtransport'));
    this.module = null;
    this.server = null;
    this.port = 0;
    this.bind = null;
    this.current = null;
    this.next = null;
    this.timer = null;
    this.closed = true;
  }

  /**
   * The certificate hashes to announce: the current, then the next.
   * @returns {Object[]} [{hash, notAfter}]
   */

  getHashes() {
    // A browser pins only its own kind of certificate.
    if (this.certificate)
      return [];

    return [this.current, this.next]
      .filter(Boolean)
      .map(({hash, notAfter}) => ({hash, notAfter}));
  }

  address() {
    return {address: this.bind, port: this.port};
  }

  async listen(port, host) {
    assert(this.closed, 'Already listening.');

    try {
      this.module = await this.load();
    } catch (e) {
      throw new Error('WebTransport needs the optional dependency'
        + ' @fails-components/webtransport: ' + e.message);
    }

    this.port = port;
    this.bind = host || '0.0.0.0';
    this.closed = false;

    if (this.certificate) {
      this.current = await this.loadCertificate();
    } else {
      const name = this.host
        || (host && host !== '0.0.0.0' ? host : 'bcash');
      const now = Date.now();
      this.current = makeCertificate({host: name, now});
      this.next = makeCertificate({host: name, now: now + CERT_LIFETIME
        - CERT_RENEW - CERT_BACKDATE});
    }

    await this.start();

    this.timer = setInterval(() => {
      this.maybeRotate().catch(e => this.emit('error', e));
    }, 60 * 60 * 1000);

    this.emit('listening', this.address());
  }

  async start() {
    const {Http3Server} = this.module;
    const {cert, privKey} = this.current;

    this.server = new Http3Server({
      port: this.port,
      host: this.bind,
      secret: crypto.randomBytes(32).toString('hex'),
      cert,
      privKey
    });

    this.server.startServer();
    await this.server.ready;
    this.accept(this.server);
  }

  accept(server) {
    (async () => {
      const sessions = server.sessionStream(this.path).getReader();

      for (;;) {
        const {value: session, done} = await sessions.read();

        if (done)
          break;

        this.acceptSession(session).catch(() => {});
      }
    })().catch((e) => {
      if (!this.closed)
        this.emit('error', e);
    });
  }

  async acceptSession(session) {
    await session.ready;

    const streams = session.incomingBidirectionalStreams.getReader();
    const {value: stream, done} = await streams.read();

    if (done || this.closed)
      return;

    const [ip, port] = splitAddress(session.peerAddress);
    const socket = new WebTransportSocket(ip, port);
    socket.attach(session, stream);

    this.emit('connection', socket);
  }

  /**
   * Swap to the next certificate when the current nears its end, and
   * make the one after. The listener restarts on the new certificate:
   * peers connected on the old one reconnect.
   * @returns {Promise}
   */

  async maybeRotate(now = Date.now()) {
    if (this.closed)
      return false;

    if (this.certificate)
      return this.maybeReload();

    if (this.current.notAfter - now > CERT_RENEW)
      return false;

    const name = this.host || 'bcash';
    this.current = this.next;
    this.next = makeCertificate({host: name, now: now + CERT_LIFETIME
      - CERT_RENEW - CERT_BACKDATE});

    this.server.stopServer();
    await this.start();

    this.emit('rotate', this.getHashes());

    return true;
  }

  async loadCertificate() {
    const {cert, privKey} = await this.certificate();
    assert(typeof cert === 'string' && typeof privKey === 'string');
    return {cert, privKey};
  }

  /**
   * Serve a given certificate anew once it changes (renewed).
   * @returns {Promise}
   */

  async maybeReload() {
    const loaded = await this.loadCertificate();

    if (loaded.cert === this.current.cert
        && loaded.privKey === this.current.privKey) {
      return false;
    }

    this.current = loaded;

    this.server.stopServer();
    await this.start();

    this.emit('reload');

    return true;
  }

  async close() {
    if (this.closed)
      return;

    this.closed = true;

    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.server) {
      this.server.stopServer();
      this.server = null;
    }
  }
}

/**
 * A node's WebTransport endpoint, as `wtaddr` carries it: its address and
 * services as in `addr`, with the WebTransport port, and the hashes of its
 * certificates, current then next, each with when it expires (seconds).
 * Per entry: services (8), IP (16), port (2, big endian), a count of
 * hashes (1), then each hash (32) and its expiry (4).
 */

class WTAddr {
  constructor(addr, hashes) {
    assert(addr instanceof NetAddress);
    assert(Array.isArray(hashes));
    this.addr = addr;
    this.hashes = hashes;
    // When we last dialed it (seconds).
    this.lastAttempt = 0;
  }

  get expires() {
    let max = 0;
    for (const {notAfter} of this.hashes)
      max = Math.max(max, notAfter);
    return max;
  }

  /**
   * The hashes still valid, hex, for a dial.
   * @param {Number} [now] - Seconds.
   * @returns {String[]}
   */

  validHashes(now = util.now()) {
    return this.hashes
      .filter(({notAfter}) => notAfter > now)
      .map(({hash}) => hash);
  }

  static encode(list) {
    if (list.length > MAX_WTADDR)
      throw new Error('Too many wtaddr entries.');

    let size = encoding.sizeVarint(list.length);
    for (const {hashes} of list)
      size += 26 + 1 + hashes.length * 36;

    const bw = bio.write(size);
    bw.writeVarint(list.length);

    for (const {addr, hashes} of list) {
      assert(hashes.length <= MAX_WTADDR_HASHES);
      addr.toWriter(bw, false);
      bw.writeU8(hashes.length);
      for (const {hash, notAfter} of hashes) {
        bw.writeBytes(Buffer.from(hash, 'hex'));
        bw.writeU32(notAfter);
      }
    }

    return bw.render();
  }

  static decode(data) {
    const br = bio.read(data);
    const count = br.readVarint();

    if (count > MAX_WTADDR)
      throw new Error('Too many wtaddr entries.');

    const list = [];

    for (let i = 0; i < count; i++) {
      const addr = NetAddress.fromReader(br, false);
      const n = br.readU8();

      if (n > MAX_WTADDR_HASHES)
        throw new Error('Too many wtaddr hashes.');

      const hashes = [];
      for (let j = 0; j < n; j++) {
        hashes.push({
          hash: br.readBytes(32).toString('hex'),
          notAfter: br.readU32()
        });
      }

      list.push(new WTAddr(addr, hashes));
    }

    if (br.left() !== 0)
      throw new Error('Trailing wtaddr data.');

    return list;
  }
}

/**
 * The WebTransport endpoints a node has heard of, by host and port: the
 * newest per endpoint, and none that has expired.
 */

class WTHosts {
  constructor(max = MAX_WTHOSTS) {
    this.map = new Map();
    this.max = max;
  }

  get size() {
    return this.map.size;
  }

  get(hostname) {
    return this.map.get(hostname) || null;
  }

  /**
   * @param {WTAddr} entry
   * @param {Number} [now] - Seconds.
   * @returns {Boolean} Whether it was new, or newer.
   */

  add(entry, now = util.now()) {
    if (entry.addr.port === 0 || entry.expires <= now)
      return false;

    const key = entry.addr.hostname;
    const old = this.map.get(key);

    if (old && old.expires >= entry.expires)
      return false;

    this.map.delete(key);
    this.map.set(key, entry);

    // The oldest heard goes first.
    if (this.map.size > this.max)
      this.map.delete(this.map.keys().next().value);

    return true;
  }

  toArray(now = util.now()) {
    const items = [];

    for (const [key, entry] of this.map) {
      if (entry.expires <= now) {
        this.map.delete(key);
        continue;
      }
      items.push(entry);
    }

    return items;
  }
}

/*
 * Helpers
 */

function splitAddress(addr = '') {
  const i = addr.lastIndexOf(':');

  if (i === -1)
    return [addr || '0.0.0.0', 0];

  const host = addr.slice(0, i).replace(/^\[|\]$/g, '');

  return [host, Number(addr.slice(i + 1))];
}

/*
 * Expose
 */

exports.CERT_LIFETIME = CERT_LIFETIME;
exports.CERT_RENEW = CERT_RENEW;
exports.DEFAULT_PATH = DEFAULT_PATH;
exports.makeCertificate = makeCertificate;
exports.WebTransportSocket = WebTransportSocket;
exports.WebTransportServer = WebTransportServer;
exports.connect = connect;
exports.WTAddr = WTAddr;
exports.WTHosts = WTHosts;
exports.MAX_WTADDR = MAX_WTADDR;
