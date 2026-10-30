/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * The web wallet asks each of its peers in turn which of its unconfirmed
 * sends it holds: each answers for itself, so one peer saying notfound
 * does not hide another that has it, and a send only one page holds is
 * told apart from one a full node or two peers hold.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const {Tokens} = require('../browser/wallet/tokens');
const KeyRing = require('../lib/primitives/keyring');
const MTX = require('../lib/primitives/mtx');
const packets = require('../lib/net/packets');

function makeTX() {
  const mtx = new MTX();
  mtx.addInput({prevout: {hash: Buffer.alloc(32, 1), index: 0}});
  mtx.addOutput(KeyRing.generate().getAddress(), 1000);
  return mtx.toTX();
}

// A peer that holds some transactions, and answers a getdata for each.
class FakePeer extends EventEmitter {
  constructor(id, {rtc = false, has = [], silent = false} = {}) {
    super();
    this.id = id;
    this.rtc = rtc;
    this.has = new Map(has.map(tx => [tx.txid(), tx]));
    this.silent = silent;
    this.handshake = true;
    this.destroyed = false;
  }

  answer(hashes) {
    if (this.silent)
      return;
    const missing = [];
    for (const hash of hashes) {
      const txid = Buffer.from(hash).reverse().toString('hex');
      const tx = this.has.get(txid);
      if (tx)
        this.emit('packet', new packets.TXPacket(tx));
      else
        missing.push({hash, type: 1});
    }
    if (missing.length > 0)
      this.emit('packet', new packets.NotFoundPacket(missing));
  }
}

function makeNode(peers) {
  return {
    pool: {
      peers: {
        head: () => peers[0] || null
      },
      getTX: (peer, hashes) => setImmediate(() => peer.answer(hashes))
    }
  };
}

function link(peers) {
  peers.forEach((p, i) => {
    p.next = peers[i + 1] || null;
  });
  return peers;
}

describe('Wallet: who has a send', function() {
  const tx = makeTX();
  const other = makeTX();
  const coins = {state: {txs: {}}, blocks: null};

  it('should count each peer that has it, by its own answer', async () => {
    const peers = link([
      new FakePeer(1, {rtc: true}),
      new FakePeer(2, {rtc: true, has: [tx]}),
      new FakePeer(3, {has: [tx, other]})
    ]);
    const tokens = new Tokens({coins, node: makeNode(peers)});

    const {holders, asked} = await tokens.whoHas([tx.txid(), other.txid()]);
    assert(asked);

    // The first peer's notfound does not hide the others' copies.
    assert.deepStrictEqual(holders.get(tx.txid()),
      [{id: 2, node: false}, {id: 3, node: true}]);
    assert.deepStrictEqual(holders.get(other.txid()), [{id: 3, node: true}]);
  });

  it('should tell a send one page holds', async () => {
    const peers = link([new FakePeer(1, {rtc: true, has: [tx]})]);
    const tokens = new Tokens({coins, node: makeNode(peers)});

    const {holders} = await tokens.whoHas([tx.txid()]);
    assert.deepStrictEqual(holders.get(tx.txid()), [{id: 1, node: false}]);
  });

  it('should give up on a peer that does not answer', async () => {
    const peers = link([
      new FakePeer(1, {silent: true}),
      new FakePeer(2, {has: [tx]})
    ]);
    const tokens = new Tokens({coins, node: makeNode(peers)});

    const {holders} = await tokens.whoHas([tx.txid()], 100);
    assert.deepStrictEqual(holders.get(tx.txid()), [{id: 2, node: true}]);
  });

  it('should say it asked no one, with no peers', async () => {
    const tokens = new Tokens({coins, node: makeNode([])});
    const {asked} = await tokens.whoHas([tx.txid()]);
    assert.strictEqual(asked, false);
  });
});
