/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * As Bitcoin ABC's m_avalanche_stalled_txids: a transaction whose
 * avalanche vote stalled is announced again, once, to a peer that knew it.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const Peer = require('../lib/net/peer');
const MTX = require('../lib/primitives/mtx');
const Script = require('../lib/script/script');

function peer() {
  const p = Peer.fromOptions({network: 'regtest', hasNonce: () => false});
  p.handshake = true;
  p.sent = [];
  p.send = packet => p.sent.push(packet);
  return p;
}

function tx() {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: random.randomBytes(32), index: 0}});
  mtx.addOutput(Script.fromPubkeyhash(random.randomBytes(20)), 1000);
  return mtx.toTX();
}

// Hashes of the transactions it announced.
function announced(p, t) {
  p.sent = [];
  p.announceTX(t);
  p.flushInv();
  return p.sent.flatMap(packet => packet.items || []).length;
}

describe('Peer stalled transactions', function() {
  it('should announce a stalled transaction again, once', () => {
    const p = peer();
    const t = tx();

    assert.strictEqual(announced(p, t), 1);
    assert.strictEqual(announced(p, t), 0);

    p.markStalled(t.hash());
    assert.strictEqual(announced(p, t), 1);
    assert.strictEqual(announced(p, t), 0);
  });

  it('should keep 100 stalled transactions, the newest', () => {
    const p = peer();
    const txs = [];
    for (let i = 0; i < 101; i++) {
      txs.push(tx());
      p.markStalled(txs[i].hash());
    }
    assert.strictEqual(p.stalledTxs.size, 100);
    assert(!p.stalledTxs.has(txs[0].hash()));
    assert(p.stalledTxs.has(txs[100].hash()));
  });
});
