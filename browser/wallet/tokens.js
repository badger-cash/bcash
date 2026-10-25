/*!
 * tokens.js - a web wallet's SLP tokens, verified by SPV
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * SLP tokens (Token Types 1 and 2), checked here from transactions the
 * wallet proves in blocks itself: no indexer, no server's word for what a
 * coin holds. A transaction is read as bcash's SLP indexer reads it
 * (SLP.getTxRecords), and judged by the indexer's rules:
 *
 *   GENESIS  valid: here, the token's own (its txid is the token id).
 *   MINT     valid if it spends a mint baton of the token; for Type 2, or
 *            an output paying the vault script hash its genesis names.
 *   SEND     valid if its inputs of the token (same id and type) hold at
 *            least what it sends.
 *
 * An input holds tokens only if it spends a token output of a valid
 * transaction of the same token; anything else spending a token coin
 * burns it. So a coin is checked by walking back through its parents to
 * the genesis, or to transactions already checked (each is remembered).
 *
 * A token is added by its genesis txid (the token id) and the height of
 * the block it is in: that block is fetched, the genesis is in it (its
 * merkle proof checks), and its ticker, name and decimals are read.
 *
 * Parents are found by scanning blocks down from the child toward the
 * genesis's height, a filter holding the txids still wanted, and those
 * not in a block are asked of peers' mempools: token transactions are
 * valid unconfirmed, chained on unconfirmed parents, so a token coin can
 * be spent with no confirmation, as XEC can. Only a token's GENESIS must
 * be in a block, to be added. A parent found in neither is older than the
 * token, and holds none of it. With no peer to ask, a transaction short
 * for want of a parent is pending, not invalid, and checked again.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const {BloomFilter} = require('bfilter');
const TX = require('../../lib/primitives/tx');
const SLP = require('../../lib/script/slp');
const {types: packetTypes} = require('../../lib/net/packets');

// Blocks per scan when walking down for parents.
const WINDOW = 2000;

/**
 * What a transaction says of tokens, from bcash's SLP records: null if
 * nothing.
 * @param {TX} tx
 * @returns {Object|null} {type, version, tokenId (hex), amounts: {vout:
 *   BigInt}, baton (vout or null), genesis: {ticker, name, uri, decimals,
 *   vault (hex script hash, Type 2)}}
 */

function read(tx) {
  const {records} = SLP.getTxRecords(tx);

  if (records.length === 0)
    return null;

  const token = records.find(r => r.decimals != null) || null;
  const coins = records.filter(r => r.decimals == null);
  const first = token || coins[0];

  const amounts = {};
  let baton = null;
  let mint = false;

  for (const record of coins) {
    if (record.type === 'BATON') {
      baton = record.vout;
      continue;
    }
    if (record.type === 'MINT')
      mint = true;
    amounts[record.vout] = record.getValueUInt64BE().readBigUInt64BE(0);
  }

  let type = 'SEND';
  if (token)
    type = 'GENESIS';
  else if (mint)
    type = 'MINT';

  return {
    type,
    version: first.version,
    tokenId: Buffer.from(first.tokenId).toString('hex'),
    amounts,
    baton,
    genesis: token ? {
      ticker: token.ticker,
      name: token.name,
      uri: token.uri,
      decimals: token.decimals,
      vault: token.vaultScriptHash
        ? Buffer.from(token.vaultScriptHash).toString('hex') : null
    } : null
  };
}

const sum = values => values.reduce((a, b) => a + b, 0n);

class Tokens extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Coins} options.coins - whose state keeps the tokens' too.
   * @param {SPVNode} options.node
   */

  constructor({coins, node}) {
    super();
    this.coins = coins;
    this.node = node;
    this.checking = null;
  }

  get state() {
    const state = this.coins.state;
    if (!state.tokens)
      state.tokens = {};
    if (!state.slpTXs)
      state.slpTXs = {};
    if (!state.slpValid)
      state.slpValid = {};
    return state;
  }

  list() {
    return Object.values(this.state.tokens);
  }

  get(tokenId) {
    return this.state.tokens[tokenId] || null;
  }

  /**
   * Add a token by its genesis: the block at `height` must hold it.
   * @returns {Promise} the token
   */

  async add(tokenId, height) {
    tokenId = tokenId.trim().toLowerCase();
    assert(/^[0-9a-f]{64}$/.test(tokenId), 'A token id is 64 hex digits.');
    assert((height >>> 0) === height, 'Enter the genesis block\'s height.');

    if (this.state.tokens[tokenId])
      return this.state.tokens[tokenId];

    const anchor = this.node.chain.options.anchor;
    const floor = anchor ? anchor.height + 1 : 0;
    assert(height >= floor, `This wallet's chain starts at ${floor}: a`
      + ' token made before that cannot be checked yet.');
    assert(height <= this.node.chain.height,
      'The wallet has not synced to that block yet.');

    const found = await this.fetch(new Set([tokenId]), height, height);
    const got = found.get(tokenId);
    assert(got, `No such transaction in block ${height}.`);

    const record = read(got.tx);
    assert(record && record.type === 'GENESIS' && record.tokenId === tokenId,
      'That transaction is not an SLP token genesis.');

    const token = {
      tokenId,
      height,
      version: record.version,
      ...record.genesis,
      supply: (record.amounts[1] || 0n).toString(),
      baton: record.baton != null
    };

    this.state.tokens[tokenId] = token;
    this.coins.save();
    this.emit('change');

    this.checkAll().catch(err => this.emit('error', err));

    return token;
  }

  /**
   * The SLP coins of a key, by token, with what they hold and whether
   * they are good.
   * @returns {Object[]} [{tokenId, token, valid, pending, invalid,
   *   unsupported}] amounts in base units (BigInt)
   */

  balances(address) {
    const byToken = new Map();

    for (const coin of this.coins.unspent(address)) {
      if (!coin.token)
        continue;

      const info = coin.slp;
      const key = info && info.tokenId ? info.tokenId : 'unsupported';

      if (!byToken.has(key)) {
        byToken.set(key, {
          tokenId: info && info.tokenId,
          token: info && info.tokenId ? this.get(info.tokenId) : null,
          valid: 0n,
          pending: 0n,
          invalid: 0n,
          coins: 0
        });
      }

      const entry = byToken.get(key);
      const amount = info ? BigInt(info.amount) : 0n;
      const status = this.status(coin);
      entry[status] = (entry[status] || 0n) + amount;
      entry.coins += 1;
    }

    return [...byToken.values()];
  }

  /**
   * A token coin's standing: valid, pending, invalid, or unknown (its
   * token not added).
   */

  status(coin) {
    const info = coin.slp;
    if (!info || !info.tokenId)
      return 'invalid';
    if (!this.get(info.tokenId))
      return 'unknown';
    const valid = this.state.slpValid[coin.txid];
    if (valid === true)
      return 'valid';
    if (valid === false)
      return 'invalid';
    return 'pending';
  }

  /**
   * A key's good coins of a token, to send: valid ones holding tokens,
   * mint batons left out.
   */

  spendable(address, tokenId) {
    return this.coins.unspent(address).filter(c => c.token && c.slp
      && c.slp.tokenId === tokenId && !c.slp.baton
      && BigInt(c.slp.amount) > 0n && this.status(c) === 'valid');
  }

  /**
   * Check every token coin not yet known good or bad, once at a time.
   */

  checkAll() {
    // One running: once it ends, once more, for what came since.
    if (this.checking) {
      this.again = true;
      return this.checking;
    }

    this.again = false;

    // Cleared after the run, never during: a run with nothing to check
    // ends at once, before this is even set.
    this.checking = this.checkPending()
      .finally(() => {
        this.checking = null;
      })
      .then(() => (this.again ? this.checkAll() : null));

    return this.checking;
  }

  async checkPending() {
    const txids = new Set();
    for (const coin of Object.values(this.coins.state.coins)) {
      if (coin.token && !coin.spent && coin.slp && coin.slp.tokenId
          && this.get(coin.slp.tokenId)
          && this.state.slpValid[coin.txid] == null) {
        txids.add(coin.txid);
      }
    }

    for (const txid of txids)
      await this.check(txid);
  }

  /**
   * Check a transaction of ours for its token: walk back to the genesis
   * for what is not known yet, then decide.
   * @returns {Promise} 'valid' | 'invalid' | 'pending'
   */

  async check(txid) {
    const root = this.txOf(txid);
    assert(root, `No transaction ${txid} held.`);

    const record = read(root.tx);
    if (!record || !record.tokenId)
      return this.decide(txid, false);

    const token = this.get(record.tokenId);
    if (!token)
      return 'unknown';

    this.emit('check', {txid, token});

    // Gather what deciding needs: each SLP transaction of the token back
    // to the genesis, and the parents of each (to know what they hold).
    const missing = new Set();
    const unreachable = new Set();
    for (let round = 0; ; round++) {
      const wanted = new Map();
      const seen = new Set();
      const visit = (id) => {
        if (seen.has(id))
          return;
        seen.add(id);

        if (this.state.slpValid[id] != null || id === token.tokenId)
          return;

        const held = this.txOf(id);
        if (!held) {
          if (!missing.has(id))
            wanted.set(id, Infinity);
          return;
        }

        const rec = read(held.tx);
        if (!rec || rec.tokenId !== token.tokenId
            || rec.version !== token.version)
          return;

        for (const input of held.tx.inputs) {
          const parent = input.prevout.txid();
          if (!this.txOf(parent) && !missing.has(parent)) {
            const below = held.height === -1 ? this.node.chain.height
              : held.height;
            wanted.set(parent, Math.min(wanted.get(parent) || Infinity,
              below));
          }
          visit(parent);
        }
      };

      visit(txid);

      if (wanted.size === 0)
        break;

      // Down from the highest child, to the genesis.
      const from = Math.min(this.node.chain.height,
        Math.max(...[...wanted.values()].map(h => (isFinite(h) ? h
          : this.node.chain.height))));
      const found = await this.fetch(new Set(wanted.keys()), from,
        token.height);

      // Not in a block: perhaps in peers' mempools, unconfirmed.
      const rest = [...wanted.keys()].filter(id => !found.has(id));
      const pooled = rest.length > 0
        ? await this.fetchMempool(rest) : {found: new Map(), asked: true};

      for (const id of rest) {
        if (pooled.found.has(id))
          continue;
        missing.add(id);
        if (!pooled.asked)
          unreachable.add(id);
      }

      assert(round < 100000, 'Token walk did not end.');
    }

    const result = this.evaluate(txid, token, new Map(), unreachable);

    if (result !== 'pending')
      this.decide(txid, result === 'valid');

    this.emit('change');
    return result;
  }

  /**
   * Decide a transaction of the token, from what is held: 'valid',
   * 'invalid', or 'pending' (a parent not found could change it).
   */

  evaluate(txid, token, memo, unreachable) {
    if (memo.has(txid))
      return memo.get(txid);

    const known = this.state.slpValid[txid];
    if (known != null)
      return known ? 'valid' : 'invalid';

    if (txid === token.tokenId)
      return 'valid';

    const held = this.txOf(txid);
    if (!held)
      return unreachable.has(txid) ? 'pending' : 'invalid';

    // Guard cycles (none exist on a chain, but held data could lie).
    memo.set(txid, 'invalid');

    const record = read(held.tx);
    let result = 'invalid';

    if (record && record.tokenId === token.tokenId
        && record.version === token.version) {
      let have = 0n;
      let unsure = 0n;
      let baton = false;
      let batonUnsure = false;

      for (const input of held.tx.inputs) {
        const {index} = input.prevout;
        const parent = input.prevout.txid();
        const parentHeld = this.txOf(parent);

        if (!parentHeld) {
          // In no block down to the genesis, nor a mempool: older than
          // the token, holding none of it. Unless no peer could be asked.
          if (unreachable.has(parent)) {
            unsure += 1n;
            batonUnsure = true;
          }
          continue;
        }

        // Type 2: a MINT may draw on its vault, an output paying the
        // script hash its genesis names.
        if (record.type === 'MINT' && token.vault) {
          const output = parentHeld.tx.outputs[index];
          if (output && output.getType() === 'scripthash'
              && output.getHash('hex') === token.vault) {
            baton = true;
          }
        }

        const rec = read(parentHeld.tx);
        if (!rec || rec.tokenId !== token.tokenId
            || rec.version !== token.version)
          continue;

        const standing = this.evaluate(parent, token, memo, unreachable);
        if (standing === 'invalid')
          continue;

        if (standing === 'pending') {
          unsure += 1n;
          if (rec.baton === index)
            batonUnsure = true;
          continue;
        }

        if (rec.baton === index)
          baton = true;
        else if (rec.amounts[index] != null)
          have += rec.amounts[index];
      }

      if (record.type === 'GENESIS') {
        result = 'invalid';
      } else if (record.type === 'MINT') {
        if (baton)
          result = 'valid';
        else if (batonUnsure)
          result = 'pending';
      } else if (record.type === 'SEND') {
        const out = sum(Object.values(record.amounts));
        if (have >= out)
          result = 'valid';
        else if (unsure > 0n)
          result = 'pending';
      }
    }

    memo.set(txid, result);

    // Remember what is settled, and in a block: it cannot change.
    if (result !== 'pending' && held.height !== -1)
      this.state.slpValid[txid] = result === 'valid';

    return result;
  }

  decide(txid, valid) {
    this.state.slpValid[txid] = valid;
    this.coins.save();
    return valid ? 'valid' : 'invalid';
  }

  /**
   * A transaction the wallet holds: one of its own, or one fetched.
   * @returns {Object|null} {tx, height}
   */

  txOf(txid) {
    const kept = this.state.slpTXs[txid];
    if (kept) {
      return {
        tx: TX.fromRaw(Buffer.from(kept.raw, 'hex')),
        height: kept.height
      };
    }

    const ours = this.coins.state.txs[txid];
    if (ours && ours.raw) {
      return {
        tx: TX.fromRaw(Buffer.from(ours.raw, 'hex')),
        height: ours.height
      };
    }

    return null;
  }

  /**
   * Ask peers for transactions in their mempools, by txid: each found is
   * kept, unconfirmed.
   * @param {String[]} txids
   * @param {Number} [timeout=5000] ms
   * @returns {Promise} {found: Map txid -> {tx, height: -1}, asked}
   */

  async fetchMempool(txids, timeout = 5000) {
    const {pool} = this.node;
    const found = new Map();
    const wanted = new Set(txids);

    const peers = [];
    for (let peer = pool.peers.head(); peer; peer = peer.next) {
      if (peer.handshake && !peer.destroyed)
        peers.push(peer);
    }

    if (peers.length === 0)
      return {found, asked: false};

    await new Promise((resolve) => {
      let timer = null;

      function done() {
        clearTimeout(timer);
        pool.removeListener('tx', onTX);
        for (const peer of peers)
          peer.removeListener('packet', onPacket);
        resolve();
      }

      // A peer without it says so: no need to wait out the time.
      function onPacket(packet) {
        if (packet.type !== packetTypes.NOTFOUND)
          return;
        for (const item of packet.items) {
          const txid = Buffer.from(item.hash).reverse().toString('hex');
          wanted.delete(txid);
        }
        if (wanted.size === 0)
          done();
      }

      const kept = this.state.slpTXs;

      function onTX(tx) {
        const txid = tx.txid();
        if (!wanted.has(txid))
          return;
        wanted.delete(txid);
        found.set(txid, {tx, height: -1});
        kept[txid] = {raw: tx.toRaw().toString('hex'), height: -1};
        if (wanted.size === 0)
          done();
      }

      timer = setTimeout(done, timeout);
      pool.on('tx', onTX);
      for (const peer of peers)
        peer.on('packet', onPacket);

      const hashes = txids.map(id => Buffer.from(id, 'hex').reverse());
      for (const peer of peers) {
        try {
          pool.getTX(peer, hashes);
        } catch (e) {
          continue;
        }
      }
    });

    return {found, asked: true};
  }

  /**
   * Find transactions by txid, in blocks from `top` down to `floor`, a
   * window at a time; each found is kept.
   * @returns {Promise} Map txid -> {tx, height}
   */

  async fetch(wanted, top, floor) {
    const found = new Map();
    wanted = new Set(wanted);

    for (let hi = top; hi >= floor && wanted.size > 0; hi -= WINDOW) {
      const lo = Math.max(floor, hi - WINDOW + 1);
      const filter = BloomFilter.fromRate(wanted.size + 10, 0.000001,
        BloomFilter.flags.NONE);

      for (const txid of wanted)
        filter.add(Buffer.from(txid, 'hex').reverse());

      this.emit('walk', {lo, hi, floor, wanted: wanted.size});

      await this.node.pool.scanRange({start: lo, end: hi, filter},
        (entry, block) => {
          for (const tx of block.txs) {
            const txid = tx.txid();
            if (!wanted.has(txid))
              continue;
            wanted.delete(txid);
            found.set(txid, {tx, height: entry.height});
            this.state.slpTXs[txid] = {
              raw: tx.toRaw().toString('hex'),
              height: entry.height
            };
          }
        });
    }

    this.coins.save();

    return found;
  }
}

exports.Tokens = Tokens;
exports.read = read;
