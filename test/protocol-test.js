/* eslint prefer-arrow-callback: "off" */
/* eslint-env mocha */
/* eslint indent: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const util = require('../lib/utils/util');
const NetAddress = require('../lib/net/netaddress');
const Framer = require('../lib/net/framer');
const Parser = require('../lib/net/parser');
const packets = require('../lib/net/packets');
const common = require('../lib/net/common');
const consensus = require('../lib/protocol/consensus');
const MemBlock = require('../lib/primitives/memblock');
const network = Network.get('main');

describe('Protocol', function() {
  const pkg = require('../lib/pkg');
  const agent = `/bcash:${pkg.version}/`;
  let parser, framer;

  beforeEach(() => {
    parser = new Parser('main', () => consensus.MAX_FORK_BLOCK_SIZE);
    framer = new Framer();
  });

  function packetTest(cmd, payload, test) {
    it(`should encode/decode ${cmd}`, (cb) => {
      parser.once('packet', (packet) => {
        try {
          assert.strictEqual(packet.cmd, cmd);
          test(packet);
        } catch (e) {
          cb(e);
          return;
        }
        cb();
      });
      const raw = framer.packet(cmd, payload.toRaw());
      parser.feed(raw);
    });
  }

  const v1 = packets.VersionPacket.fromOptions({
    version: 300,
    services: 1,
    time: network.now(),
    remote: new NetAddress(),
    local: new NetAddress(),
    nonce: Buffer.allocUnsafe(8),
    agent: agent,
    height: 0,
    noRelay: false
  });

  packetTest('version', v1, (payload) => {
    assert.strictEqual(payload.version, 300);
    assert.strictEqual(payload.agent, agent);
    assert.strictEqual(payload.height, 0);
    assert.strictEqual(payload.noRelay, false);
  });

  const v2 = packets.VersionPacket.fromOptions({
    version: 300,
    services: 1,
    time: network.now(),
    remote: new NetAddress(),
    local: new NetAddress(),
    nonce: Buffer.allocUnsafe(8),
    agent: agent,
    height: 10,
    noRelay: true
  });

  packetTest('version', v2, (payload) => {
    assert.strictEqual(payload.version, 300);
    assert.strictEqual(payload.agent, agent);
    assert.strictEqual(payload.height, 10);
    assert.strictEqual(payload.noRelay, true);
  });

  packetTest('verack', new packets.VerackPacket(), (payload) => {
  });

  const hosts = [
    new NetAddress({
      services: 1,
      host: '127.0.0.1',
      port: 8333,
      time: util.now()
    }),
    new NetAddress({
      services: 1,
      host: '::123:456:789a',
      port: 18333,
      time: util.now()
    })
  ];

  packetTest('addr', new packets.AddrPacket(hosts), (payload) => {
    assert(payload.items, 'array');
    assert.strictEqual(payload.items.length, 2);

    assert(payload.items[0].time, 'number');
    assert.strictEqual(payload.items[0].services, 1);
    assert.strictEqual(payload.items[0].host, hosts[0].host);
    assert.strictEqual(payload.items[0].port, hosts[0].port);

    assert(payload.items[1].time, 'number');
    assert.strictEqual(payload.items[1].services, 1);
    assert.strictEqual(payload.items[1].host, hosts[1].host);
    assert.strictEqual(payload.items[1].port, hosts[1].port);
  });

  it('should not limit block like packet size to MAX_MESSAGE', (cb) => {
    const raw = Buffer.alloc(consensus.MAX_FORK_BLOCK_SIZE * 2);
    const block1 = MemBlock.fromRaw(raw);
    const packet = new packets.BlockPacket(block1);

    assert(raw.length > common.MAX_MESSAGE);
    parser.once('packet', (p) => {
      assert.strictEqual(packet.cmd, p.cmd);
      cb();
    });

    const rawpacket = framer.packet(packet.cmd, packet.toRaw());
    parser.feed(rawpacket);
  });

  // A command may fill all 12 bytes of the header with no NUL, as in
  // Bitcoin ABC (Avalanche's getavaproofs and avaproofsreq do).
  it('should frame and parse a 12 character command', (cb) => {
    const payload = Buffer.from([1, 2, 3]);

    parser.once('packet', (packet) => {
      try {
        assert.strictEqual(packet.cmd, 'getavaproofs');
        assert.bufferEqual(packet.data, payload);
      } catch (e) {
        cb(e);
        return;
      }
      cb();
    });

    parser.feed(framer.packet('getavaproofs', payload));
  });

  it('should not frame a 13 character command', () => {
    assert.throws(() => framer.packet('getavaproofsx', Buffer.alloc(0)));
  });

  it('should reject a command with data after its NUL', (cb) => {
    const raw = framer.packet('ping', Buffer.alloc(8));
    raw[4 + 'ping'.length + 1] = 0x61;

    parser.once('error', (e) => {
      assert.strictEqual(e.message, 'Non NULL-padded command.');
      cb();
    });

    parser.feed(raw);
  });

  it('should limit block like packet size to MAX_FORK_BLOCK_SIZE * 2', (cb) => {
    const packetsize = consensus.MAX_FORK_BLOCK_SIZE * 2 + 1;
    const raw = Buffer.alloc(packetsize);
    const block1 = MemBlock.fromRaw(raw);
    const packet = new packets.BlockPacket(block1);

    assert(raw.length > common.MAX_MESSAGE);

    parser.once('error', (e) => {
      assert.strictEqual(e.message, `Packet length too large: ${packetsize}.`);
      cb();
    });

    const rawpacket = framer.packet(packet.cmd, packet.toRaw());
    parser.feed(rawpacket);
  });
});
