/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The coinbase outputs Bitcoin ABC nodes park blocks without: the miner
 * fund (src/minerfund.cpp) and the avalanche staking reward
 * (src/policy/block/stakingrewards.cpp), in the blocks bcash builds and
 * in its getblocktemplate.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const secp256k1 = require('bcrypto/lib/secp256k1');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Output = require('../lib/primitives/output');
const Network = require('../lib/protocol/network');
const Script = require('../lib/script/script');
const policy = require('../lib/mining/coinbasepolicy');
const util = require('../lib/utils/util');

const testnet = Network.get('testnet');
const COWPERTHWAITE = testnet.block.cowperthwaiteHeight;

describe('Coinbase policy', function() {
  it('should take 8% for the miner fund, then 32% from Cowperthwaite', () => {
    const before = {height: COWPERTHWAITE - 2};
    const after = {height: COWPERTHWAITE - 1};
    assert.strictEqual(policy.getMinerFundAmount(testnet, 1000001, before),
      80000);
    assert.strictEqual(policy.getMinerFundAmount(testnet, 1000001, after),
      320000);
  });

  it('should pay the fund and the staking winner', () => {
    const winner = Script.fromPubkeyhash(random.randomBytes(20));
    const outputs = policy.getCoinbaseOutputs({
      network: testnet,
      prev: {height: COWPERTHWAITE},
      reward: 1000000,
      minerFund: true,
      stakingWinner: winner
    });

    assert.strictEqual(outputs.length, 2);
    assert(outputs[0].script.isScripthash());
    assert.bufferEqual(outputs[0].script.getScripthash(),
      policy.MINER_FUND_HASH);
    assert.strictEqual(outputs[0].value, 320000);
    assert.strictEqual(outputs[1].script, winner);
    assert.strictEqual(outputs[1].value, 100000);
  });

  it('should pay neither unless asked, nor the fund before Wellington', () => {
    assert.deepStrictEqual(policy.getCoinbaseOutputs({
      network: testnet,
      prev: {height: COWPERTHWAITE},
      reward: 1000000,
      minerFund: false,
      stakingWinner: null
    }), []);

    const wellington = testnet.block.wellingtonHeight;
    assert.deepStrictEqual(policy.getCoinbaseOutputs({
      network: testnet,
      prev: {height: wellington - 2},
      reward: 1000000,
      minerFund: true,
      stakingWinner: null
    }), []);
  });

  it('should be on by default on mainnet only', () => {
    assert.strictEqual(Network.get('main').coinbasePolicy.minerFund, true);
    assert.strictEqual(Network.get('main').coinbasePolicy.stakingRewards,
      true);
    assert.strictEqual(testnet.coinbasePolicy.minerFund, false);
    assert.strictEqual(Network.get('regtest').coinbasePolicy.minerFund,
      false);
  });
});

// A block with its coinbase outputs replaced, mined again.
function withOutputs(block, outputs) {
  const mtx = MTX.fromTX(block.txs[0]);
  mtx.outputs = outputs.map(o => new Output(o));
  block.txs[0] = mtx.toTX();
  block.merkleRoot = block.createMerkleRoot();
  block.refresh();
  while (!block.verifyPOW()) {
    block.nonce++;
    block.refresh();
  }
  return block;
}

describe('Coinbase policy checks', function() {
  const reward = 1000000;
  const prev = {height: COWPERTHWAITE};
  const fund = policy.getMinerFundScript();
  const other = Script.fromPubkeyhash(random.randomBytes(20));

  it('should find the miner fund paid, as Bitcoin ABC', () => {
    assert(policy.checkMinerFund(testnet,
      [{script: other, value: 680000}, {script: fund, value: 320000}],
      reward, prev));
    // Too little, or elsewhere.
    assert(!policy.checkMinerFund(testnet,
      [{script: fund, value: 319999}], reward, prev));
    assert(!policy.checkMinerFund(testnet,
      [{script: other, value: 1000000}], reward, prev));
    // Not before Wellington.
    assert(policy.checkMinerFund(testnet, [],
      reward, {height: testnet.block.wellingtonHeight - 2}));
  });

  it('should find a staking winner paid, the first or another', () => {
    const winners = [{payout: other},
      {payout: Script.fromPubkeyhash(random.randomBytes(20))}];
    assert(policy.checkStakingReward(
      [{script: other, value: 100000}], reward, winners));
    assert(policy.checkStakingReward(
      [{script: winners[1].payout, value: 100000}], reward, winners));
    assert(!policy.checkStakingReward(
      [{script: other, value: 99999}], reward, winners));
    assert(!policy.checkStakingReward(
      [{script: fund, value: 100000}], reward, winners));
  });
});

describe('Coinbase policy in mined blocks', function() {
  this.timeout(30000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    apiKey: 'foo',
    httpPort: 49451,
    port: 49450,
    avalanche: true,
    enableMinerFund: true,
    avalancheStakingRewards: true
  });

  const ring = KeyRing.fromPrivate(secp256k1.privateKeyGenerate());
  const address = ring.getAddress();
  const winner = Script.fromPubkeyhash(random.randomBytes(20));

  before(async () => {
    await node.open();
    // A staking winner, as a quorum would select.
    node.pool.avalanche.getStakingRewardWinners = () => [
      {proofId: Buffer.alloc(32, 7), payout: winner}
    ];
    node.pool.avalanche.isStakingRewardsActivated = () => true;
  });

  after(async () => {
    await node.close();
  });

  it('should pay the fund and the winner out of the reward', async () => {
    const block = await node.miner.mineBlock(node.chain.tip, address);
    const [cb] = block.txs;
    const reward = 5000000000;

    assert.strictEqual(cb.outputs.length, 3);
    assert.strictEqual(cb.getOutputValue(), reward);

    const fund = cb.outputs[1];
    assert.bufferEqual(fund.script.getScripthash(), policy.MINER_FUND_HASH);
    assert.strictEqual(fund.value, 0.32 * reward);

    const staking = cb.outputs[2];
    assert.bufferEqual(staking.script.toRaw(), winner.toRaw());
    assert.strictEqual(staking.value, 0.10 * reward);

    assert.strictEqual(cb.outputs[0].value, 0.58 * reward);

    // A valid block.
    assert(await node.chain.add(block));
  });

  it('should tell miners in getblocktemplate, as Bitcoin ABC', async () => {
    const json = await node.rpc.call({
      method: 'getblocktemplate',
      params: []
    }, {});
    assert.strictEqual(json.error, null);

    const {coinbasetxn} = json.result;
    assert.deepStrictEqual(coinbasetxn.minerfund, {
      // As Bitcoin ABC's decodescript gives it.
      addresses: ['ecregtest:prfhcnyqnl5cgrnmlfmms675w93ld7mvvq9jcw0zsn'],
      minimumvalue: 0.32 * 5000000000
    });
    assert.strictEqual(coinbasetxn.stakingrewards.payoutscript.hex,
      winner.toRaw().toString('hex'));
    assert.strictEqual(coinbasetxn.stakingrewards.payoutscript.type,
      'pubkeyhash');
    assert.strictEqual(coinbasetxn.stakingrewards.minimumvalue,
      0.10 * 5000000000);
  });

  it('should answer getstakingreward', async () => {
    const json = await node.rpc.call({
      method: 'getstakingreward',
      params: [node.chain.tip.rhash()]
    }, {});
    assert.strictEqual(json.error, null);
    assert.deepStrictEqual(json.result.map(w => w.proofid),
      [util.revHex(Buffer.alloc(32, 7))]);
    assert.strictEqual(json.result[0].hex, winner.toRaw().toString('hex'));
  });

  // Bitcoin ABC's parking policies: a valid block that does not pay is
  // parked, not connected.
  it('should park a block without the miner fund', async () => {
    const tip = node.chain.tip;
    const good = await node.miner.mineBlock(tip, address);
    const [miner, fund, staking] = good.txs[0].outputs;
    const block = withOutputs(good, [
      {script: miner.script, value: miner.value + fund.value},
      {script: staking.script, value: staking.value}
    ]);

    let parked = null;
    node.chain.once('parked', (entry) => {
      parked = entry;
    });

    await node.chain.add(block);

    assert(node.chain.tip.hash.equals(tip.hash));
    assert(node.chain.isParked(block.hash()));
    assert(parked && parked.hash.equals(block.hash()));

    // Avalanche may unpark it: then it connects, unchecked.
    await node.chain.unpark(parked);
    assert(node.chain.tip.hash.equals(block.hash()));
  });

  it('should park a block paying no staking winner', async () => {
    const tip = node.chain.tip;
    const good = await node.miner.mineBlock(tip, address);
    const [miner, fund, staking] = good.txs[0].outputs;
    const block = withOutputs(good, [
      {script: miner.script, value: miner.value},
      {script: fund.script, value: fund.value},
      {script: Script.fromPubkeyhash(random.randomBytes(20)),
        value: staking.value}
    ]);

    await node.chain.add(block);
    assert(node.chain.tip.hash.equals(tip.hash));
    assert(node.chain.isParked(block.hash()));
  });

  it('should take a block paying another of the winners', async () => {
    const other = Script.fromPubkeyhash(random.randomBytes(20));
    const winners = node.pool.avalanche.getStakingRewardWinners;
    node.pool.avalanche.getStakingRewardWinners = () => [
      {proofId: Buffer.alloc(32, 7), payout: winner},
      {proofId: Buffer.alloc(32, 8), payout: other}
    ];

    try {
      const good = await node.miner.mineBlock(node.chain.tip, address);
      const [miner, fund, staking] = good.txs[0].outputs;
      const block = withOutputs(good, [
        {script: miner.script, value: miner.value},
        {script: fund.script, value: fund.value},
        {script: other, value: staking.value}
      ]);

      assert(await node.chain.add(block));
      assert(node.chain.tip.hash.equals(block.hash()));
    } finally {
      node.pool.avalanche.getStakingRewardWinners = winners;
    }
  });
});

describe('Coinbase policy without avalanche', function() {
  this.timeout(30000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    apiKey: 'foo',
    httpPort: 49453,
    port: 49452,
    enableMinerFund: true
  });

  const address = KeyRing.fromPrivate(secp256k1.privateKeyGenerate())
    .getAddress();

  before(async () => {
    await node.open();
  });

  after(async () => {
    await node.close();
  });

  it('should not park, as bcash without avalanche never does', async () => {
    const good = await node.miner.mineBlock(node.chain.tip, address);
    const [miner, fund] = good.txs[0].outputs;
    const block = withOutputs(good, [
      {script: miner.script, value: miner.value + fund.value}
    ]);

    assert(await node.chain.add(block));
    assert(node.chain.tip.hash.equals(block.hash()));
  });
});

