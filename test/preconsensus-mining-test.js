/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC's transaction pre-consensus on a node: once active, blocks
 * mined carry only the transactions avalanche finalized
 * (-avalanchepreconsensusmining), and a block spending what a finalized
 * transaction spends is parked (PreConsensusPolicy).
 */

const assert = require('bsert');
const secp256k1 = require('bcrypto/lib/secp256k1');
const FullNode = require('../lib/node/fullnode');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Processor = require('../lib/avalanche/processor');

describe('Pre-consensus mining', function() {
  this.timeout(60000);

  const node = new FullNode({
    network: 'regtest',
    memory: true,
    workers: false,
    listen: false,
    apiKey: 'foo',
    httpPort: 49457,
    port: 49456,
    avalanche: true,
    // Regtest blocks come seconds apart: RTT would park the block below
    // first, as Bitcoin ABC's tests turn it off.
    enableRtt: false
  });

  const {chain, mempool, miner, pool} = node;
  const ring = KeyRing.fromPrivate(secp256k1.privateKeyGenerate());
  const address = ring.getAddress();
  const coins = [];

  // A transaction spending one of our coinbases.
  function spend(coin, fee) {
    const mtx = new MTX();
    mtx.addCoin(coin);
    mtx.addOutput(KeyRing.generate().getAddress(), coin.value - fee);
    mtx.sign(ring);
    return mtx.toTX();
  }

  before(async () => {
    await node.open();

    // Coinbases to us, then past their maturity.
    for (let i = 0; i < 103; i++) {
      const block = await miner.mineBlock(chain.tip, address);
      const entry = await chain.add(block);
      if (i < 3)
        coins.push(Coin.fromTX(block.txs[0], 0, entry.height));
    }

    // Avalanche finalized the tip since starting: pre-consensus is on.
    assert(await chain.finalize(chain.tip));
    pool.avalanche.finalizationTip = chain.tip;
    pool.avalanche.finalizedSinceStart = true;
    assert(pool.avalanche.isPreconsensusActivated());
    assert(node.preConsensusMining());
  });

  after(async () => {
    await node.close();
  });

  let finalized;

  it('should mine only the transactions avalanche finalized', async () => {
    finalized = spend(coins[0], 10000);
    const other = spend(coins[1], 10000);
    await mempool.addTX(finalized);
    await mempool.addTX(other);

    await pool.applyTxVote(finalized, Processor.voteStatus.FINALIZED);
    assert(mempool.isAvalancheFinalized(finalized.hash()));

    const attempt = await miner.createBlock(chain.tip, address);
    const block = attempt.toBlock();
    const hashes = block.txs.slice(1).map(tx => tx.txid());
    assert.deepStrictEqual(hashes, [finalized.txid()]);
  });

  it('should park a block spending what a finalized one spends', async () => {
    // Another spend of the finalized transaction's coin, mined by hand.
    const conflict = spend(coins[0], 20000);

    const attempt = await miner.createBlock(chain.tip, address);
    attempt.items = [];
    attempt.fees = 0;
    assert(attempt.addTX(conflict, await chain.getCoinView(conflict)));
    attempt.refresh();

    let block;
    for (let nonce = 0; ; nonce++) {
      block = attempt.toBlock();
      block.nonce = nonce;
      block.refresh();
      if (block.verifyPOW())
        break;
    }

    // The only policy it breaks.
    assert(node.conflictsFinalized(block));

    const tip = chain.tip;
    await chain.add(block);

    assert(chain.tip.hash.equals(tip.hash));
    assert(chain.isParked(block.hash()));
  });
});
