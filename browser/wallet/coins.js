/*!
 * coins.js - a web wallet's coins and history
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * What the wallet's keys hold, from its SPV node: each key's coins, and
 * every transaction that paid or spent one, as history. Transactions
 * arrive as peers relay them (unconfirmed), and again in blocks; a block
 * that leaves the chain takes its transactions back to unconfirmed.
 *
 * The node's filter holds each key's public key hash (what pays it) and
 * public key (what spends from it). Blocks the wallet has not seen, after
 * a reload or for a key imported with a birth height, are scanned on
 * connections of their own, from that height to the tip: below the
 * chain's anchor too, by headers proven between checkpoints
 * (wallet/history.js).
 *
 * A block orders its transactions by txid, so a child may come before the
 * parent it spends: a block's are taken parents first, and every spend of
 * a transaction kept is remembered, so a coin found after the transaction
 * spending it (an older block, scanned later) is spent on arrival.
 *
 * A coin carrying tokens, as its transaction's SLP data says (or of a
 * token type not read, to be safe), is kept apart, never spent as XEC, so
 * an XEC payment cannot burn a token. A token transaction's change, and
 * an output it gives no tokens, is plain XEC.
 *
 * A key new to this network's state (added on another network, or here
 * while the node was behind) is scanned once from its birth there, and
 * then counted as covered.
 *
 * The state, one per network, is sealed with the vault's key
 * (vault.saveState).
 */

const EventEmitter = require('events');
const {BloomFilter} = require('bfilter');
const Outpoint = require('../../lib/primitives/outpoint');
const SLP = require('../../lib/script/slp');
const {read, holding} = require('./tokens');
const {History} = require('./history');
const consensus = require('../../lib/protocol/consensus');

// What the state is: before 2, spends a block listed before their coins
// were missed; such a state is rebuilt, by a scan from each key's birth.
const STATE_VERSION = 2;

/**
 * A block's transactions, parents before the children spending them (a
 * block's own order is by txid).
 * @param {TX[]} txs
 * @returns {TX[]}
 */

function inOrder(txs) {
  const byID = new Map(txs.map(tx => [tx.txid(), tx]));
  const done = new Set();
  const out = [];

  const visit = (tx) => {
    const txid = tx.txid();
    if (done.has(txid))
      return;
    done.add(txid);
    for (const input of tx.inputs) {
      const parent = byID.get(input.prevout.txid());
      if (parent)
        visit(parent);
    }
    out.push(tx);
  };

  for (const tx of txs)
    visit(tx);

  return out;
}

class Coins extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Vault} options.vault
   * @param {SPVNode} options.node
   */

  constructor({vault, node, blocks = null}) {
    super();
    this.vault = vault;
    this.node = node;
    // Blocks at any height, below the chain's anchor too.
    this.blocks = blocks || new History({node});
    this.network = node.network.type;
    this.closed = false;
    this.keys = new Map();
    this.state = null;
    this.saving = null;
    this.scanning = null;
  }

  /**
   * Load the sealed state, watch every key, and follow the node.
   */

  async open() {
    this.state = await this.vault.loadState(this.network) || {
      version: STATE_VERSION,
      coins: {},
      txs: {},
      spends: {},
      covered: {},
      synced: null
    };

    if (!this.state.covered)
      this.state.covered = {};

    // Kept before spends were taken in any order: rebuilt, each key's
    // history scanned again from its birth. Tokens and their verdicts
    // stay.
    if (this.state.version !== STATE_VERSION) {
      this.state.version = STATE_VERSION;
      this.state.coins = {};
      this.state.txs = {};
      this.state.spends = {};
      this.state.covered = {};
      this.rebuilding = true;
    }

    const fresh = this.state.synced == null;

    for (const key of this.vault.list(this.network)) {
      this.watch(key);
      // A fresh state follows the chain from where it starts: nothing to
      // scan for.
      if (fresh)
        this.state.covered[key.address] = true;
    }

    this.node.on('tx', tx => this.addTX(tx, -1, null));
    this.node.on('connect', (entry, block) => this.addBlock(entry, block));
    this.node.on('disconnect', entry => this.removeBlock(entry));
  }

  /**
   * Keys this network's state has not covered yet: each needs a scan from
   * its birth here (cover).
   */

  uncovered() {
    return this.vault.list(this.network)
      .filter(key => !this.state.covered[key.address]);
  }

  /**
   * Scan for a key from `start` to the tip, then count it covered.
   */

  async cover(key, start) {
    const entry = this.keys.get(this.vault.ring(key.name)
      .getKeyHash('hex'));

    if (this.state.synced != null && start <= this.node.chain.height)
      await this.scan(start, [entry]);

    if (this.closed)
      return;

    this.state.covered[key.address] = true;
    this.save();
  }

  /**
   * Scan a key's history again from `start`: an imported key, its birth
   * found to be earlier than first said.
   */

  async rescan(key, start) {
    const entry = this.keys.get(this.vault.ring(key.name)
      .getKeyHash('hex'));
    await this.scan(start, [entry]);
    if (this.closed)
      return;
    this.state.covered[key.address] = true;
    this.save();
  }

  /**
   * Stop: what is unsaved is saved, and nothing more is taken in.
   */

  async close() {
    this.closed = true;
    this.node.removeAllListeners('tx');
    this.node.removeAllListeners('connect');
    this.node.removeAllListeners('disconnect');
    await this.flush();
  }

  /**
   * Watch a key's coins: in the node's filter, and on this side.
   */

  watch({name, address}) {
    const ring = this.vault.ring(name);
    const hash = ring.getKeyHash();

    this.keys.set(hash.toString('hex'), {
      name,
      address,
      hash,
      publicKey: ring.getPublicKey()
    });

    this.node.pool.watch(hash);
    this.node.pool.watch(ring.getPublicKey());
  }

  /**
   * The key an output pays, if ours.
   */

  ours(output) {
    const hash = output.getHash();
    if (!hash)
      return null;
    return this.keys.get(hash.toString('hex')) || null;
  }

  addBlock(entry, block) {
    for (const tx of inOrder(block.txs || []))
      this.addTX(tx, entry.height, entry.time);

    if (this.state.synced == null || entry.height > this.state.synced)
      this.state.synced = entry.height;

    this.save();
  }

  /**
   * Take a transaction: the coins it pays our keys, and ours it spends.
   * @returns {Boolean} whether it touched a key of ours.
   */

  addTX(tx, height, time) {
    const txid = tx.txid();
    const known = this.state.txs[txid];
    let changed = false;

    if (known && height !== -1 && known.height !== height) {
      // Seen unconfirmed, now in a block (or again unconfirmed).
      known.height = height;
      known.time = time;
      for (const coin of Object.values(this.state.coins)) {
        if (coin.txid === txid)
          coin.height = height;
      }
      changed = true;
    }

    const record = known || {
      txid,
      height,
      time: time || Math.floor(Date.now() / 1000),
      // When the wallet first saw it: the order within a block.
      seen: Date.now(),
      keys: {}
    };

    const touch = (address) => {
      if (!record.keys[address])
        record.keys[address] = {received: 0, spent: 0};
      return record.keys[address];
    };

    let touched = Boolean(known);

    // Its spends of our coins: of those known now, even if it was known
    // before them.
    for (const input of tx.inputs) {
      const prev = `${input.prevout.txid()}:${input.prevout.index}`;
      const coin = this.state.coins[prev];
      if (!coin || coin.spent)
        continue;
      coin.spent = txid;
      touch(coin.address).spent += coin.value;
      touched = true;
      changed = true;
    }

    const token = tx.outputs.length > 0
      && SLP.fromScript(tx.outputs[0].script).isValidSlp();
    // What each output says it holds; whether it does, wallet/tokens.js
    // decides.
    const slpRecord = token ? read(tx) : null;

    tx.outputs.forEach((output, vout) => {
      const key = this.ours(output);
      if (!key)
        return;

      const id = `${txid}:${vout}`;
      if (this.state.coins[id])
        return;

      const held = token ? holding(slpRecord, vout)
        : {token: false, slp: null};

      const coin = {
        txid,
        vout,
        value: output.value,
        script: output.script.toRaw().toString('hex'),
        address: key.address,
        height,
        coinbase: tx.isCoinbase(),
        token: held.token,
        slp: held.slp,
        spent: null
      };
      this.state.coins[id] = coin;
      touch(key.address).received += output.value;

      // Spent already, by a transaction seen before this coin was.
      const spender = this.state.spends[id];
      if (spender && this.state.txs[spender]) {
        coin.spent = spender;
        const by = this.state.txs[spender];
        if (!by.keys[key.address])
          by.keys[key.address] = {received: 0, spent: 0};
        by.keys[key.address].spent += coin.value;
      } else {
        // Its spend, in the node's filter: the filter also updates itself
        // on a match, but a scan's does not.
        this.node.pool.watchOutpoint(new Outpoint(tx.hash(), vout));
      }

      touched = true;
      changed = true;
    });

    if (!touched)
      return false;

    if (!known) {
      record.token = token;
      // A token transaction's raw form: what checking it walks back from.
      if (token)
        record.raw = tx.toRaw().toString('hex');
      this.state.txs[txid] = record;

      // What it spends, for a coin of ours found after it.
      for (const input of tx.inputs) {
        this.state.spends[`${input.prevout.txid()}:${input.prevout.index}`]
          = txid;
      }
    }

    if (changed || !known) {
      this.save();
      this.emit('change', txid);
    }

    return true;
  }

  /**
   * A block left the chain: its transactions are unconfirmed again.
   */

  removeBlock(entry) {
    let changed = false;

    for (const tx of Object.values(this.state.txs)) {
      if (tx.height === entry.height) {
        tx.height = -1;
        changed = true;
      }
    }

    for (const coin of Object.values(this.state.coins)) {
      if (coin.height === entry.height)
        coin.height = -1;
    }

    if (this.state.synced != null && this.state.synced >= entry.height)
      this.state.synced = entry.height - 1;

    if (changed) {
      this.save();
      this.emit('change', null);
    }
  }

  /**
   * Scan blocks the wallet has not seen, from `start` to the tip, for
   * `keys` (all, by default): on connections of their own, as the tip
   * moves on.
   * @returns {Promise}
   */

  async scan(start, keys = [...this.keys.values()]) {
    const end = this.node.chain.height;

    if (start > end || keys.length === 0)
      return;

    const filter = BloomFilter.fromRate(keys.length * 2 + 1000, 0.0001,
      BloomFilter.flags.NONE);

    for (const key of keys) {
      filter.add(key.hash);
      filter.add(key.publicKey);
    }

    // Our coins, for what spends them.
    for (const coin of Object.values(this.state.coins)) {
      if (!coin.spent)
        filter.add(Outpoint.fromOptions({
          hash: Buffer.from(coin.txid, 'hex').reverse(),
          index: coin.vout
        }).toRaw());
    }

    this.emit('scan', {start, end, height: start - 1});

    await this.blocks.scanBlocks({start, end, filter}, (entry, block) => {
      for (const tx of inOrder(block.txs))
        this.addTX(tx, entry.height, entry.time);
      this.emit('scan', {start, end, height: entry.height});
    });

    this.emit('scan', {start, end, height: end, done: true});
  }

  /**
   * Catch up after a reload: from the last block the wallet saw.
   */

  async catchUp() {
    if (this.state.synced == null) {
      this.state.synced = this.node.chain.height;
      this.save();
      return;
    }

    const start = this.state.synced + 1;
    await this.scan(start);

    if (this.node.chain.height > this.state.synced)
      this.state.synced = this.node.chain.height;

    this.save();
  }

  /**
   * A key's coins, unspent: spendable XEC, and those kept apart for the
   * tokens they may carry.
   */

  unspent(address) {
    return Object.values(this.state.coins)
      .filter(c => c.address === address && !c.spent);
  }

  spendable(address) {
    const tip = this.node.chain.height;
    return this.unspent(address)
      .filter(c => !c.token && !this.immature(c, tip));
  }

  /**
   * A coinbase coin, not yet spendable: 100 blocks deep.
   */

  immature(coin, tip = this.node.chain.height) {
    return coin.coinbase && (coin.height === -1
      || tip - coin.height + 1 < consensus.COINBASE_MATURITY);
  }

  balance(address) {
    let confirmed = 0;
    let unconfirmed = 0;
    let locked = 0;
    let immature = 0;

    for (const coin of this.unspent(address)) {
      if (coin.token)
        locked += coin.value;
      else if (this.immature(coin))
        immature += coin.value;
      else if (coin.height === -1)
        unconfirmed += coin.value;
      else
        confirmed += coin.value;
    }

    return {confirmed, unconfirmed, locked, immature,
      total: confirmed + unconfirmed};
  }

  /**
   * A key's history, newest first: each transaction's net to it.
   */

  history(address) {
    return Object.values(this.state.txs)
      .filter(tx => tx.keys[address])
      .map((tx) => {
        const {received, spent} = tx.keys[address];
        return {
          txid: tx.txid,
          height: tx.height,
          time: tx.time,
          seen: tx.seen,
          net: received - spent,
          token: Boolean(tx.token)
        };
      })
      .sort((a, b) => {
        const ah = a.height === -1 ? Infinity : a.height;
        const bh = b.height === -1 ? Infinity : b.height;
        return bh - ah || b.seen - a.seen;
      });
  }

  /**
   * Save, at most once at a time: the latest state wins.
   */

  save() {
    if (this.saving) {
      this.dirty = true;
      return;
    }

    const saved = this.vault.saveState(this.network, this.state);

    this.saving = saved.catch((err) => {
      this.emit('error', err);
    }).then(() => {
      this.saving = null;
      if (this.dirty) {
        this.dirty = false;
        this.save();
      }
    });
  }

  async flush() {
    while (this.saving)
      await this.saving;
  }
}

exports.Coins = Coins;
exports.inOrder = inOrder;
exports.STATE_VERSION = STATE_VERSION;
