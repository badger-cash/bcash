/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Walking headers forward to a trusted block, for blocks below an SPV
 * anchor: each header must build on the one before, and the walk must end
 * at the trusted block.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const random = require('bcrypto/lib/random');
const Chain = require('../lib/blockchain/chain');
const Pool = require('../lib/net/pool');
const Network = require('../lib/protocol/network');
const Headers = require('../lib/primitives/headers');

const network = Network.get('regtest');

// A chain of headers after a starting hash.
function headersAfter(start, count) {
  const headers = [];
  let prev = start;
  for (let i = 0; i < count; i++) {
    const header = new Headers({
      version: 1,
      prevBlock: prev,
      merkleRoot: random.randomBytes(32),
      time: i,
      bits: network.pow.bits,
      nonce: i
    });
    headers.push(header);
    prev = header.hash();
  }
  return headers;
}

// Answers getheaders from a list, at most 2000 at a time.
class FakePeer extends EventEmitter {
  constructor(start, headers) {
    super();
    this.start = start;
    this.headers = headers;
    this.asks = 0;
  }

  sendGetHeaders([locator], stop) {
    this.asks += 1;
    let i = locator.equals(this.start)
      ? 0
      : this.headers.findIndex(h => h.hash().equals(locator)) + 1;
    const items = [];
    for (; i < this.headers.length && items.length < 2000; i++) {
      items.push(this.headers[i]);
      if (this.headers[i].hash().equals(stop))
        break;
    }
    setImmediate(() => this.emit('packet', {cmd: 'headers', items}));
  }
}

describe('Pool header walk', function() {
  let pool;

  before(async () => {
    const chain = new Chain({network, memory: true, spv: true});
    await chain.open();
    pool = new Pool({network, chain, spv: true, memory: true,
      listen: false});
  });

  it('should walk to the stop block, 2000 at a time', async () => {
    const start = random.randomBytes(32);
    const headers = headersAfter(start, 4500);
    const stop = headers[4499].hash();
    const peer = new FakePeer(start, headers);

    const hashes = await pool.walkHeaders(peer, start, stop, 1000);

    assert.strictEqual(hashes.length, 4500);
    assert.bufferEqual(hashes[4499], stop);
    assert.strictEqual(peer.asks, 3);
  });

  it('should reject headers that do not link', async () => {
    const start = random.randomBytes(32);
    const headers = headersAfter(start, 10);
    headers[5] = headersAfter(random.randomBytes(32), 1)[0];
    const peer = new FakePeer(start, headers);

    await assert.rejects(
      pool.walkHeaders(peer, start, headers[9].hash(), 1000),
      /do not link/);
  });

  it('should reject a peer that stops short', async () => {
    const start = random.randomBytes(32);
    const headers = headersAfter(start, 10);
    const peer = new FakePeer(start, headers.slice(0, 5));

    await assert.rejects(
      pool.walkHeaders(peer, start, headers[9].hash(), 1000),
      /no headers before the stop block/);
  });
});
