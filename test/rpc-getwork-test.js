/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * getwork hands out a header to hash and accepts the solved header back.
 * Submissions were compared to the current attempt with `!==` on the
 * prevBlock hashes, which are Buffers, so every submission was refused.
 */

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const mine = require('../lib/mining/mine');

const key = KeyRing.generate();

const node = new FullNode({
  memory: true,
  network: 'regtest',
  workers: false,
  listen: false,
  coinbaseAddress: [key.getAddress('string', 'regtest')]
});

const {chain} = node;

function swap32(data) {
  for (let i = 0; i < data.length; i += 4)
    data.writeUInt32BE(data.readUInt32LE(i), i);
  return data;
}

async function rpc(method, params = []) {
  const json = await node.rpc.call({method, params, id: '1'}, {});
  assert(!json.error, json.error && json.error.message);
  return json.result;
}

// Solve a getwork unit the way an external miner would.
function solve(work) {
  const data = Buffer.from(work.data, 'hex');
  const header = swap32(Buffer.from(data)).slice(0, 80);
  const target = Buffer.from(work.target, 'hex');
  const nonce = mine(header, target, 0, 0xffffffff);
  assert(nonce !== -1);
  header.writeUInt32LE(nonce, 76);
  swap32(header).copy(data, 0);
  return data.toString('hex');
}

describe('RPC getwork', function() {
  this.timeout(30000);

  before(async () => {
    await node.open();
  });

  after(async () => {
    await node.close();
  });

  let solved;

  it('accepts a solved getwork header', async () => {
    const height = chain.height;
    const work = await rpc('getwork');
    assert.strictEqual(work.height, height + 1);

    solved = solve(work);
    assert.strictEqual(await rpc('getwork', [solved]), true);
    assert.strictEqual(chain.height, height + 1);

    const block = await chain.getBlock(chain.tip.hash);
    assert.strictEqual(
      block.txs[0].outputs[0].getAddress().toString('regtest'),
      key.getAddress('string', 'regtest'));
  });

  it('refuses work for a tip that is no longer current', async () => {
    const height = chain.height;
    assert.strictEqual(await rpc('getwork', [solved]), false);
    assert.strictEqual(chain.height, height);
  });
});
