/*!
 * stun.js - STUN server for bcash
 * Copyright (c) 2026, the bcash contributors (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * A STUN server (RFC 8489, Binding only): a peer behind a home router
 * asks what address its traffic comes from, and is told. WebRTC peers
 * need one to find a path to each other, and a node that serves pages
 * over WebTransport is already reachable, so it answers them too. Each
 * answer is a few bytes longer than its request, and one address is
 * answered a few times a second at most, so the server is of no use as a
 * traffic reflector.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const dgram = require('dgram');
const IP = require('binet');
const bio = require('bufio');

const MAGIC_COOKIE = 0x2112a442;
const HEADER_SIZE = 20;

const types = {
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  BINDING_ERROR: 0x0111
};

const attrs = {
  MAPPED_ADDRESS: 0x0001,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  XOR_MAPPED_ADDRESS: 0x0020,
  FINGERPRINT: 0x8028
};

// Attributes a server understands; any other comprehension-required one
// (type below 0x8000) makes the request fail with 420.
const KNOWN = new Set([
  attrs.MAPPED_ADDRESS,
  attrs.XOR_MAPPED_ADDRESS,
  attrs.FINGERPRINT,
  0x8022 // SOFTWARE
]);

// Requests answered per address: a bucket of this many, refilled at this
// rate per second.
const RATE_BURST = 10;
const RATE_PER_SECOND = 5;
const MAX_TRACKED = 10000;

/**
 * CRC-32 (IEEE), as FINGERPRINT needs; Node's own came in v22.
 */

const CRC_TABLE = new Int32Array(256);

for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++)
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}

function crc32(data) {
  let crc = -1;
  for (let i = 0; i < data.length; i++)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * The FINGERPRINT value of a message whose last attribute it is.
 * @param {Buffer} msg - The message up to the FINGERPRINT attribute.
 * @returns {Number}
 */

function fingerprint(msg) {
  return (crc32(msg) ^ 0x5354554e) >>> 0;
}

/**
 * A STUN message: its type, transaction ID and attributes.
 */

class Message {
  constructor(type, id) {
    this.type = type;
    this.id = id;
    this.cookie = MAGIC_COOKIE;
    this.attrs = [];
  }

  /**
   * Whether the request came from a client that knows the magic cookie
   * (RFC 5389 and later); the others take a plain MAPPED-ADDRESS.
   * @returns {Boolean}
   */

  get modern() {
    return this.cookie === MAGIC_COOKIE;
  }

  add(type, value) {
    this.attrs.push({type, value});
    return this;
  }

  get(type) {
    for (const attr of this.attrs) {
      if (attr.type === type)
        return attr.value;
    }
    return null;
  }

  /**
   * Parse a message, or return null for anything that is not one.
   * @param {Buffer} data
   * @returns {Message|null}
   */

  static decode(data) {
    if (data.length < HEADER_SIZE || data.length % 4 !== 0)
      return null;

    const br = bio.read(data);
    const type = br.readU16BE();

    // The first two bits of any STUN message are zero.
    if (type & 0xc000)
      return null;

    const length = br.readU16BE();

    if (length !== data.length - HEADER_SIZE)
      return null;

    const cookie = br.readU32BE();
    const id = br.readBytes(12);
    const msg = new Message(type, id);
    msg.cookie = cookie;

    while (br.left() > 0) {
      if (br.left() < 4)
        return null;

      const attrType = br.readU16BE();
      const attrLength = br.readU16BE();
      const padded = (attrLength + 3) & ~3;

      if (br.left() < padded)
        return null;

      const value = br.readBytes(attrLength);
      br.seek(padded - attrLength);

      // FINGERPRINT covers the message before it, and must be last.
      if (attrType === attrs.FINGERPRINT) {
        if (attrLength !== 4 || br.left() !== 0)
          return null;
        const body = data.slice(0, br.offset - 8);
        if (value.readUInt32BE(0) !== fingerprint(body))
          return null;
      }

      msg.attrs.push({type: attrType, value});
    }

    return msg;
  }

  /**
   * Serialize, with a FINGERPRINT last if asked.
   * @param {Boolean} [sign] - Add a FINGERPRINT.
   * @returns {Buffer}
   */

  encode(sign = false) {
    let size = HEADER_SIZE;

    for (const {value} of this.attrs)
      size += 4 + ((value.length + 3) & ~3);

    if (sign)
      size += 8;

    const bw = bio.write(size);
    bw.writeU16BE(this.type);
    bw.writeU16BE(size - HEADER_SIZE);
    bw.writeU32BE(this.cookie);
    bw.writeBytes(this.id);

    for (const {type, value} of this.attrs) {
      bw.writeU16BE(type);
      bw.writeU16BE(value.length);
      bw.writeBytes(value);
      bw.fill(0, (4 - value.length % 4) % 4);
    }

    if (sign) {
      // The message so far, with its length already counting this.
      const body = bw.data.slice(0, size - 8);
      bw.writeU16BE(attrs.FINGERPRINT);
      bw.writeU16BE(4);
      bw.writeU32BE(fingerprint(body));
    }

    return bw.render();
  }
}

/**
 * The class of a message type: 0 request, 1 indication, 2 success, 3 error.
 * @param {Number} type
 * @returns {Number}
 */

function classOf(type) {
  return ((type & 0x0100) >> 7) | ((type & 0x0010) >> 4);
}

/**
 * The method of a message type, with its class bits removed.
 * @param {Number} type
 * @returns {Number}
 */

function methodOf(type) {
  return (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
}

/**
 * The message type of a method and class.
 * @param {Number} method
 * @param {Number} cls
 * @returns {Number}
 */

function typeOf(method, cls) {
  return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2)
    | ((cls & 1) << 4) | ((cls & 2) << 7);
}

/**
 * An address attribute's value: family, port, address, XORed with the
 * cookie and transaction ID for XOR-MAPPED-ADDRESS.
 * @param {String} host
 * @param {Number} port
 * @param {Message} msg
 * @param {Boolean} xor
 * @returns {Buffer}
 */

function addressValue(host, port, msg, xor) {
  let raw = IP.toBuffer(host);

  if (IP.isIPv4(raw))
    raw = raw.slice(12);

  const value = Buffer.alloc(4 + raw.length);
  value[0] = 0;
  value[1] = raw.length === 4 ? 0x01 : 0x02;
  value.writeUInt16BE(port, 2);
  raw.copy(value, 4);

  if (xor) {
    // The port with the cookie's top half, the address with the cookie
    // and then the transaction ID.
    const key = Buffer.alloc(16);
    key.writeUInt32BE(MAGIC_COOKIE, 0);
    msg.id.copy(key, 4);
    value[2] ^= key[0];
    value[3] ^= key[1];
    for (let i = 0; i < raw.length; i++)
      value[4 + i] ^= key[i];
  }

  return value;
}

/**
 * Read an address attribute's value, undoing the XOR if asked.
 * @param {Buffer} value
 * @param {Message} msg
 * @param {Boolean} xor
 * @returns {Object} - {host, port}
 */

function readAddress(value, msg, xor) {
  assert(value.length === 8 || value.length === 20);

  const raw = Buffer.from(value.slice(4));
  let port = value.readUInt16BE(2);

  if (xor) {
    const key = Buffer.alloc(16);
    key.writeUInt32BE(MAGIC_COOKIE, 0);
    msg.id.copy(key, 4);
    port ^= key.readUInt16BE(0);
    for (let i = 0; i < raw.length; i++)
      raw[i] ^= key[i];
  }

  return {host: IP.toString(raw), port};
}

/**
 * An ERROR-CODE attribute's value.
 * @param {Number} code
 * @param {String} reason
 * @returns {Buffer}
 */

function errorValue(code, reason) {
  const text = Buffer.from(reason, 'utf8');
  const value = Buffer.alloc(4 + text.length);
  value[2] = (code / 100) | 0;
  value[3] = code % 100;
  text.copy(value, 4);
  return value;
}

/**
 * STUN server: answers Binding requests over UDP.
 * @alias module:net.StunServer
 */

class StunServer extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {Number} [options.burst] - Requests answered an address at once.
   * @param {Number} [options.rate] - Then per second.
   */

  constructor(options = {}) {
    super();
    this.socket = null;
    this.burst = options.burst != null ? options.burst : RATE_BURST;
    this.rate = options.rate != null ? options.rate : RATE_PER_SECOND;
    // Per address: the requests left to it and when that was last reckoned.
    this.buckets = new Map();
    this.answered = 0;
    this.refused = 0;
  }

  /**
   * Listen.
   * @param {Number} port - 0 for any.
   * @param {String} [host] - Default: every address, IPv4 and IPv6.
   * @returns {Promise}
   */

  listen(port, host) {
    assert(!this.socket, 'Already listening.');
    assert((port & 0xffff) === port);

    const type = host && IP.isIPv4String(host) ? 'udp4' : 'udp6';
    const socket = dgram.createSocket({type, ipv6Only: false});

    this.socket = socket;

    socket.on('message', (data, rinfo) => {
      try {
        this.handle(data, rinfo);
      } catch (e) {
        this.emit('error', e);
      }
    });

    socket.on('error', err => this.emit('error', err));

    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, host, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * The bound address, as dgram gives it: {address, port, family}.
   * @returns {Object|null}
   */

  address() {
    return this.socket ? this.socket.address() : null;
  }

  /**
   * Whether an address may have another answer now.
   * @private
   * @param {String} host
   * @returns {Boolean}
   */

  allow(host) {
    const now = Date.now();
    let bucket = this.buckets.get(host);

    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED) {
        // Forget the address longest unseen.
        this.buckets.delete(this.buckets.keys().next().value);
      }
      bucket = {left: this.burst, time: now};
    } else {
      // Move it to the back, so the front holds the longest unseen.
      this.buckets.delete(host);
      bucket.left = Math.min(this.burst,
        bucket.left + (now - bucket.time) / 1000 * this.rate);
      bucket.time = now;
    }

    this.buckets.set(host, bucket);

    if (bucket.left < 1)
      return false;

    bucket.left -= 1;

    return true;
  }

  /**
   * Answer a datagram, if it is a Binding request we may answer.
   * @private
   * @param {Buffer} data
   * @param {Object} rinfo
   */

  handle(data, rinfo) {
    const msg = Message.decode(data);

    // Not STUN, or an indication or a response: nothing to say.
    if (!msg || classOf(msg.type) !== 0)
      return;

    if (!this.allow(rinfo.address)) {
      this.refused += 1;
      return;
    }

    const signed = msg.get(attrs.FINGERPRINT) !== null;
    let reply;

    if (methodOf(msg.type) !== methodOf(types.BINDING_REQUEST)) {
      // An error response of the request's own method.
      reply = new Message(typeOf(methodOf(msg.type), 3), msg.id);
      reply.add(attrs.ERROR_CODE, errorValue(400, 'Bad Request'));
    } else {
      const unknown = [];

      for (const {type} of msg.attrs) {
        if (type < 0x8000 && !KNOWN.has(type))
          unknown.push(type);
      }

      if (unknown.length > 0) {
        const value = Buffer.alloc(unknown.length * 2);
        unknown.forEach((type, i) => value.writeUInt16BE(type, i * 2));
        reply = new Message(types.BINDING_ERROR, msg.id);
        reply.add(attrs.ERROR_CODE, errorValue(420, 'Unknown Attribute'));
        reply.add(attrs.UNKNOWN_ATTRIBUTES, value);
      } else {
        reply = new Message(types.BINDING_SUCCESS, msg.id);
        if (msg.modern) {
          reply.add(attrs.XOR_MAPPED_ADDRESS,
            addressValue(rinfo.address, rinfo.port, msg, true));
        } else {
          reply.add(attrs.MAPPED_ADDRESS,
            addressValue(rinfo.address, rinfo.port, msg, false));
        }
      }
    }

    reply.cookie = msg.cookie;

    this.answered += 1;
    this.socket.send(reply.encode(signed), rinfo.port, rinfo.address);
  }

  /**
   * Stop listening.
   * @returns {Promise}
   */

  close() {
    const socket = this.socket;

    if (!socket)
      return Promise.resolve();

    this.socket = null;
    this.buckets.clear();

    return new Promise(resolve => socket.close(resolve));
  }
}

/*
 * Expose
 */

exports.MAGIC_COOKIE = MAGIC_COOKIE;
exports.types = types;
exports.attrs = attrs;
exports.Message = Message;
exports.StunServer = StunServer;
exports.readAddress = readAddress;
exports.crc32 = crc32;
