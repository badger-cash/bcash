/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * On networks that allow min-difficulty blocks (testnet), a block stamped
 * more than two target spacings after its parent may use the pow limit.
 * Miner#updateTime moved a template's timestamp forward but kept the bits
 * it was created with, so a template made inside the window kept full
 * difficulty after the window opened. The bits must always be what the
 * chain demands for the template's timestamp, as in Bitcoin ABC's
 * UpdateTime. Checked on a chain of real testnet headers.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Block = require('../lib/primitives/block');
const Miner = require('../lib/mining/miner');
const KeyRing = require('../lib/primitives/keyring');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');
const {twentyMinute: window} = require('./data/testnet-asert-headers');

const network = Network.get('testnet');
const spacing = network.pow.targetSpacing;

const toBlock = hex => Block.fromRaw(
  Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from([0])]));

describe('Miner updateTime', function() {
  this.timeout(30000);

  const headers = window.headers.map(([, h]) => h);
  const chain = new Chain({
    network, memory: true, spv: true,
    anchor: {
      height: window.start,
      headers: headers.slice(0, 12).map(h => Buffer.from(h, 'hex'))
    }
  });
  const miner = new Miner({chain});
  let now, tip;

  before(async () => {
    now = network.now;
    await chain.open();
    for (const header of headers.slice(12))
      assert(await chain.add(toBlock(header), common.flags.VERIFY_POW));
    tip = chain.tip;
    miner.addresses.push(KeyRing.generate().getAddress());
  });

  after(async () => {
    network.now = now;
    await chain.close();
  });

  it('starts at full difficulty inside the window', async () => {
    network.now = () => tip.time + spacing;
    const attempt = await miner.createBlock();
    assert.notStrictEqual(attempt.bits, network.pow.bits);
    assert.strictEqual(attempt.bits, await chain.getTarget(attempt.time, tip));
  });

  it('drops to the pow limit once the time leaves the window', async () => {
    network.now = () => tip.time + spacing;
    const attempt = await miner.createBlock();

    network.now = () => tip.time + spacing * 2 + 1;
    await miner.updateTime(attempt);

    assert.strictEqual(attempt.time, tip.time + spacing * 2 + 1);
    assert.strictEqual(attempt.bits, network.pow.bits);
    assert.strictEqual(attempt.bits, await chain.getTarget(attempt.time, tip));
  });

  it('returns to full difficulty if the time moves back inside', async () => {
    network.now = () => tip.time + spacing * 2 + 1;
    const attempt = await miner.createBlock();
    assert.strictEqual(attempt.bits, network.pow.bits);

    network.now = () => tip.time + spacing;
    await miner.updateTime(attempt);

    assert.strictEqual(attempt.bits, await chain.getTarget(attempt.time, tip));
    assert.notStrictEqual(attempt.bits, network.pow.bits);
  });
});
