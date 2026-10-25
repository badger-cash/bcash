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
 * connections of their own (pool.scanRange), from that height to the tip.
 *
 * A coin from a transaction carrying SLP may carry tokens: it is kept
 * apart, never spent as XEC, so an XEC payment cannot burn a token.
 *
 * The state is sealed with the vault's key (vault.saveState).
 */

const EventEmitter = require('events');
const {BloomFilter} = require('bfilter');
const Outpoint = require('../../lib/primitives/outpoint');
const SLP = require('../../lib/script/slp');
const consensus = require('../../lib/protocol/consensus');

class Coins extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Vault} options.vault
   * @param {SPVNode} options.node
   */

  constructor({vault, node}) {
    super();
    this.vault = vault;
    this.node = node;
    this.network = node.network.type;
    this.keys = new Map();
    this.state = null;
    this.saving = null;
    this.scanning = null;
  }

  /**
   * Load the sealed state, watch every key, and follow the node.
   */

  async open() {
    this.state = await this.vault.loadState() || {
      coins: {},
      txs: {},
      synced: null
    };

    for (const key of this.vault.list())
      this.watch(key);

    this.node.on('tx', tx => this.addTX(tx, -1, null));
    this.node.on('connect', (entry, block) => this.addBlock(entry, block));
    this.node.on('disconnect', entry => this.removeBlock(entry));
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
    for (const tx of block.txs || [])
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

    if (known) {
      // Seen unconfirmed, now in a block (or again unconfirmed).
      if (height !== -1 && known.height !== height) {
        known.height = height;
        known.time = time;
        for (const coin of Object.values(this.state.coins)) {
          if (coin.txid === txid)
            coin.height = height;
        }
        this.save();
        this.emit('change', txid);
      }
      return true;
    }

    const record = {
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

    let touched = false;

    for (const input of tx.inputs) {
      const prev = `${input.prevout.txid()}:${input.prevout.index}`;
      const coin = this.state.coins[prev];
      if (!coin || coin.spent)
        continue;
      coin.spent = txid;
      touch(coin.address).spent += coin.value;
      touched = true;
    }

    const token = tx.outputs.length > 0
      && SLP.fromScript(tx.outputs[0].script).isValidSlp();

    tx.outputs.forEach((output, vout) => {
      const key = this.ours(output);
      if (!key)
        return;

      this.state.coins[`${txid}:${vout}`] = {
        txid,
        vout,
        value: output.value,
        script: output.script.toRaw().toString('hex'),
        address: key.address,
        height,
        coinbase: tx.isCoinbase(),
        token: token && vout > 0,
        spent: null
      };
      touch(key.address).received += output.value;

      // Its spend, in the node's filter: the filter also updates itself
      // on a match, but a scan's does not.
      this.node.pool.watchOutpoint(new Outpoint(tx.hash(), vout));

      touched = true;
    });

    if (!touched)
      return false;

    record.token = token;
    this.state.txs[txid] = record;
    this.save();
    this.emit('change', txid);

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

    await this.node.pool.scanRange({start, end, filter}, (entry, block) => {
      for (const tx of block.txs)
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

    this.saving = this.vault.saveState(this.state).catch((err) => {
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
