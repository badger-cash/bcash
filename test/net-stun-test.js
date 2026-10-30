/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The STUN server WebRTC peers ask for their public address (RFC 8489,
 * Binding only). Parsing is checked against RFC 5769's test vectors, and
 * the server by asking it over UDP, as a browser does.
 */

const assert = require('bsert');
const dgram = require('dgram');
const random = require('bcrypto/lib/random');
const {
  MAGIC_COOKIE,
  types,
  attrs,
  Message,
  StunServer,
  readAddress,
  crc32
} = require('../lib/net/stun');
const FullNode = require('../lib/node/fullnode');

// RFC 5769, 2.2 and 2.3: responses carrying XOR-MAPPED-ADDRESS, with
// SOFTWARE, MESSAGE-INTEGRITY and FINGERPRINT.
const RFC5769_IPV4 = Buffer.from(''
  + '0101003c2112a442b7e7a701bc34d686fa87dfae'
  + '8022000b7465737420766563746f7220'
  + '002000080001a147e112a643'
  + '000800142b91f599fd9e90c38c7489f92af9ba53f06be7d7'
  + '80280004c07d4c96', 'hex');

const RFC5769_IPV6 = Buffer.from(''
  + '010100482112a442b7e7a701bc34d686fa87dfae'
  + '8022000b7465737420766563746f7220'
  + '002000140002a1470113a9faa5d3f179bc25f4b5bed2b9d9'
  + '00080014a382954e4be67bf11784c97c8292c275bfe3ed41'
  + '80280004c8fb0b4c', 'hex');

function request(options = {}) {
  const msg = new Message(types.BINDING_REQUEST, random.randomBytes(12));
  if (options.cookie != null)
    msg.cookie = options.cookie;
  for (const [type, value] of options.attrs || [])
    msg.add(type, value);
  return msg;
}

// Ask a server, returning the reply, or null after a wait.
function ask(port, data, host = '127.0.0.1', wait = 300) {
  const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, wait);

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.on('message', (reply) => {
      clearTimeout(timer);
      const local = socket.address();
      socket.close();
      resolve({reply, local});
    });

    socket.bind(0, host, () => socket.send(data, port, host));
  });
}

describe('STUN', function() {
  describe('messages', function() {
    it('should compute CRC-32 as IEEE does', () => {
      assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
      assert.strictEqual(crc32(Buffer.alloc(0)), 0);
    });

    it('should read RFC 5769\'s IPv4 response', () => {
      const msg = Message.decode(RFC5769_IPV4);
      assert(msg, 'FINGERPRINT should check');
      assert.strictEqual(msg.type, types.BINDING_SUCCESS);
      assert.strictEqual(msg.id.toString('hex'), 'b7e7a701bc34d686fa87dfae');

      const addr = readAddress(msg.get(attrs.XOR_MAPPED_ADDRESS), msg, true);
      assert.deepStrictEqual(addr, {host: '192.0.2.1', port: 32853});
    });

    it('should read RFC 5769\'s IPv6 response', () => {
      const msg = Message.decode(RFC5769_IPV6);
      assert(msg, 'FINGERPRINT should check');

      const addr = readAddress(msg.get(attrs.XOR_MAPPED_ADDRESS), msg, true);
      assert.deepStrictEqual(addr, {
        host: '2001:db8:1234:5678:11:2233:4455:6677',
        port: 32853
      });
    });

    it('should refuse a message with a bad FINGERPRINT', () => {
      const bad = Buffer.from(RFC5769_IPV4);
      bad[bad.length - 1] ^= 1;
      assert.strictEqual(Message.decode(bad), null);

      // A changed byte the fingerprint covers.
      const changed = Buffer.from(RFC5769_IPV4);
      changed[40] ^= 1;
      assert.strictEqual(Message.decode(changed), null);
    });

    it('should refuse what is not STUN', () => {
      assert.strictEqual(Message.decode(Buffer.alloc(19)), null);
      // QUIC and DTLS share UDP ports with STUN: a first byte from 20 up.
      const quic = Buffer.alloc(40);
      quic[0] = 0xc3;
      assert.strictEqual(Message.decode(quic), null);
      // A length that does not match.
      const msg = request().encode();
      assert.strictEqual(Message.decode(msg.slice(0, 16)), null);
      assert.strictEqual(Message.decode(Buffer.concat([msg, Buffer.alloc(4)])),
        null);
    });

    it('should write what it reads, with a FINGERPRINT', () => {
      const msg = request({attrs: [[0x8022, Buffer.from('bcash')]]});
      const data = msg.encode(true);
      assert.strictEqual(data.length % 4, 0);

      const back = Message.decode(data);
      assert(back);
      assert.strictEqual(back.type, types.BINDING_REQUEST);
      assert.bufferEqual(back.id, msg.id);
      assert.strictEqual(back.get(0x8022).toString(), 'bcash');
      assert(back.get(attrs.FINGERPRINT));
    });
  });

  describe('server', function() {
    const server = new StunServer({burst: 50});
    let port = 0;

    before(async () => {
      await server.listen(0, '127.0.0.1');
      port = server.address().port;
    });

    after(async () => {
      await server.close();
    });

    it('should tell a client its address', async () => {
      const req = request();
      const {reply, local} = await ask(port, req.encode());

      const msg = Message.decode(reply);
      assert.strictEqual(msg.type, types.BINDING_SUCCESS);
      assert.strictEqual(msg.cookie, MAGIC_COOKIE);
      assert.bufferEqual(msg.id, req.id);

      const addr = readAddress(msg.get(attrs.XOR_MAPPED_ADDRESS), msg, true);
      assert.deepStrictEqual(addr, {host: '127.0.0.1', port: local.port});

      // Unsigned, as the request was.
      assert.strictEqual(msg.get(attrs.FINGERPRINT), null);
    });

    it('should sign its answer to a signed request', async () => {
      const {reply} = await ask(port, request().encode(true));
      const msg = Message.decode(reply);
      assert(msg, 'its FINGERPRINT should check');
      assert(msg.get(attrs.FINGERPRINT));
    });

    it('should tell an RFC 3489 client in a MAPPED-ADDRESS', async () => {
      const req = request({cookie: 0x01020304});
      const {reply, local} = await ask(port, req.encode());

      const msg = Message.decode(reply);
      assert.strictEqual(msg.type, types.BINDING_SUCCESS);
      assert.strictEqual(msg.cookie, 0x01020304);
      assert.strictEqual(msg.get(attrs.XOR_MAPPED_ADDRESS), null);

      const addr = readAddress(msg.get(attrs.MAPPED_ADDRESS), msg, false);
      assert.deepStrictEqual(addr, {host: '127.0.0.1', port: local.port});
    });

    it('should refuse an attribute it must understand', async () => {
      const req = request({attrs: [[0x0006, Buffer.from('user')]]});
      const {reply} = await ask(port, req.encode());

      const msg = Message.decode(reply);
      assert.strictEqual(msg.type, types.BINDING_ERROR);
      const code = msg.get(attrs.ERROR_CODE);
      assert.strictEqual(code[2] * 100 + code[3], 420);
      assert.strictEqual(msg.get(attrs.UNKNOWN_ATTRIBUTES).readUInt16BE(0),
        0x0006);
    });

    it('should answer another method with 400', async () => {
      // An Allocate request: TURN, which it does not do.
      const req = new Message(0x0003, random.randomBytes(12));
      const {reply} = await ask(port, req.encode());

      const msg = Message.decode(reply);
      assert.strictEqual(msg.type, 0x0113);
      const code = msg.get(attrs.ERROR_CODE);
      assert.strictEqual(code[2] * 100 + code[3], 400);
    });

    it('should not answer responses, indications or noise', async () => {
      const response = new Message(types.BINDING_SUCCESS,
        random.randomBytes(12));
      const indication = new Message(0x0011, random.randomBytes(12));

      assert.strictEqual(await ask(port, response.encode()), null);
      assert.strictEqual(await ask(port, indication.encode()), null);
      assert.strictEqual(await ask(port, random.randomBytes(64)), null);
    });
  });

  describe('limits', function() {
    it('should answer an address a few times a second at most', async () => {
      const server = new StunServer({burst: 3, rate: 0});
      await server.listen(0, '127.0.0.1');
      const {port} = server.address();

      try {
        for (let i = 0; i < 3; i++)
          assert(await ask(port, request().encode()));
        assert.strictEqual(await ask(port, request().encode()), null);
        assert.strictEqual(server.refused, 1);
      } finally {
        await server.close();
      }
    });

    it('should answer with a few bytes more than it was sent', async () => {
      const server = new StunServer();
      await server.listen(0, '127.0.0.1');
      const {port} = server.address();

      try {
        const data = request().encode();
        const {reply} = await ask(port, data);
        assert(reply.length <= data.length + 12);
      } finally {
        await server.close();
      }
    });
  });

  describe('node', function() {
    it('should answer on its stun-port', async () => {
      const port = 20000 + (random.randomInt() % 20000);
      const node = new FullNode({
        network: 'regtest',
        memory: true,
        workers: false,
        listen: false,
        httpPort: port + 1,
        stunPort: port,
        stunHost: '127.0.0.1'
      });

      await node.open();
      await node.connect();

      try {
        const {reply} = await ask(port, request().encode());
        const msg = Message.decode(reply);
        assert.strictEqual(msg.type, types.BINDING_SUCCESS);
      } finally {
        await node.disconnect();
        await node.close();
      }

      // Closed with the node.
      assert.strictEqual(await ask(port, request().encode()), null);
    });
  });
});
