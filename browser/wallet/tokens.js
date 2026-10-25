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
 *   MINT     Type 1: valid if it spends a mint baton of the token, so
 *            down the baton's chain, MINT by MINT, to the genesis.
 *            Type 2: no baton; valid if it draws on the vault: an input
 *            whose redeem script hashes to the vault script hash its
 *            genesis names (consensus spends a P2SH output only so). A
 *            walk stops at such a MINT, with no parents to fetch.
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
 * merkle proof checks), and its ticker, name and decimals are read. A
 * token seen in a coin is added so, its height asked of a hint (heightOf,
 * as an indexer's word): a wrong one only fails the check, and without
 * one, the token waits to be added by hand.
 *
 * Parents are found by scanning blocks down from the child toward the
 * genesis's height, a filter holding the txids still wanted, and those
 * not in a block are asked of peers' mempools: token transactions are
 * valid unconfirmed, chained on unconfirmed parents, so a token coin can
 * be spent with no confirmation, as XEC can. Only a token's GENESIS must
 * be in a block, to be added.
 *
 * A coin is locked, neither counted nor spent, as XEC or as tokens, until
 * this walk calls it valid. What a peer cannot do is fake a parent (it is
 * named by its txid, and a block's by its merkle proof); what it can do
 * is withhold one. So a transaction short only for want of a parent not
 * found is unproven, not invalid: locked, and checked again in a later
 * session. Verdicts on confirmed transactions are kept; those on an
 * unconfirmed chain hold only while the page runs, and are checked again.
 */

const assert = require('bsert');
const EventEmitter = require('events');
const {BloomFilter} = require('bfilter');
const TX = require('../../lib/primitives/tx');
const SLP = require('../../lib/script/slp');
const {types: packetTypes} = require('../../lib/net/packets');
const hash160 = require('bcrypto/lib/hash160');

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
      documentHash: token.hash || '',
      decimals: token.decimals,
      vault: token.vaultScriptHash
        ? Buffer.from(token.vaultScriptHash).toString('hex') : null
    } : null
  };
}

/**
 * A token, as its genesis defines it: every field of its OP_RETURN, and
 * where it was mined. The genesis itself, whole, is kept with the other
 * transactions fetched (state.slpTXs, by the token id).
 * @param {TX} tx - the genesis.
 * @param {Number} height
 * @param {String|null} block - its block's hash, as displayed.
 * @returns {Object}
 */

function describe(tx, height, block) {
  const record = read(tx);
  assert(record && record.type === 'GENESIS', 'Not an SLP token genesis.');

  return {
    tokenId: record.tokenId,
    height,
    block,
    version: record.version,
    ...record.genesis,
    // Type 1: the output carrying the mint baton, if any.
    batonVout: record.baton,
    baton: record.baton != null,
    quantity: (record.amounts[1] || 0n).toString()
  };
}

/**
 * What an output of a transaction carrying SLP holds: tokens if its SLP
 * data gives it some, or the mint baton; else none, plain XEC (change,
 * and outputs given 0). Read as no token type it knows, it may still hold
 * tokens: kept apart, to be safe.
 * @param {Object|null} record - read(tx).
 * @param {Number} vout
 * @returns {Object} {token (kept apart), slp ({tokenId, amount, baton} or
 *   null)}
 */

function holding(record, vout) {
  if (vout === 0)
    return {token: false, slp: null};

  if (!record || !record.tokenId)
    return {token: true, slp: null};

  const amount = record.amounts[vout] || 0n;
  const baton = record.baton === vout;

  if (amount === 0n && !baton)
    return {token: false, slp: null};

  return {
    token: true,
    slp: {tokenId: record.tokenId, amount: String(amount), baton}
  };
}

const sum = values => values.reduce((a, b) => a + b, 0n);

/**
 * Whether a Type 2 MINT draws on its token's vault: an input whose redeem
 * script (the last push of a P2SH spend) hashes to the vault script hash.
 */

function drawsOnVault(tx, vault) {
  for (const input of tx.inputs) {
    const redeem = input.script.getRedeem();
    if (redeem && hash160.digest(redeem.toRaw()).toString('hex') === vault)
      return true;
  }
  return false;
}

class Tokens extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Coins} options.coins - whose state keeps the tokens' too.
   * @param {SPVNode} options.node
   * @param {Function} [options.heightOf] - async (txid) => a block height
   * or null: where to look for a genesis, a hint.
   */

  constructor({coins, node, heightOf = null}) {
    super();
    this.coins = coins;
    this.node = node;
    this.heightOf = heightOf;
    this.checking = null;
    // Tokens asked of the hint this session, and what came of it.
    this.lookups = new Map();
    // Verdicts that are not final (on an unconfirmed chain, or unproven):
    // this session's.
    this.verdicts = new Map();
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

    const token = describe(got.tx, height, got.block);

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

      // Kept before tokens were read: being read now.
      if (coin.slp === undefined)
        continue;

      const info = coin.slp;
      const key = info && info.tokenId ? info.tokenId : 'unsupported';

      if (!byToken.has(key)) {
        byToken.set(key, {
          tokenId: info && info.tokenId,
          token: info && info.tokenId ? this.get(info.tokenId) : null,
          valid: 0n,
          pending: 0n,
          unproven: 0n,
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
   * What each transaction moved of each token, for a key: from its token
   * coins, those it received and those it spent.
   * @returns {Map} txid -> [{tokenId, token, net (BigInt), status}]
   */

  movements(address) {
    const byTX = new Map();
    const add = (txid, coin, sign) => {
      if (!coin.slp || !coin.slp.tokenId)
        return;
      if (!byTX.has(txid))
        byTX.set(txid, new Map());
      const tokens = byTX.get(txid);
      const {tokenId} = coin.slp;
      const entry = tokens.get(tokenId) || {tokenId, net: 0n};
      entry.net += sign * BigInt(coin.slp.amount);
      tokens.set(tokenId, entry);
    };

    for (const coin of Object.values(this.coins.state.coins)) {
      if (coin.address !== address)
        continue;
      add(coin.txid, coin, 1n);
      if (coin.spent)
        add(coin.spent, coin, -1n);
    }

    const result = new Map();
    for (const [txid, tokens] of byTX) {
      result.set(txid, [...tokens.values()].map((entry) => {
        const token = this.get(entry.tokenId);
        const status = token ? this.verdictOf(txid) : 'unknown';
        return {...entry, token, status};
      }));
    }

    return result;
  }

  /**
   * A transaction's verdict: final if kept, else this session's, else
   * pending.
   * @returns {String} valid | invalid | unproven | pending
   */

  verdictOf(txid) {
    const final = this.state.slpValid[txid];
    if (final === true)
      return 'valid';
    if (final === false)
      return 'invalid';
    return this.verdicts.get(txid) || 'pending';
  }

  /**
   * A token coin's standing: valid, pending, unproven, invalid, or unknown
   * (its token not added). Only a valid one is counted, or spent.
   */

  status(coin) {
    const info = coin.slp;
    if (!info || !info.tokenId)
      return 'invalid';
    if (!this.get(info.tokenId))
      return 'unknown';
    return this.verdictOf(coin.txid);
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
    await this.redescribe();
    await this.backfill();
    await this.discover();

    const txids = new Set();
    for (const coin of Object.values(this.coins.state.coins)) {
      if (coin.token && !coin.spent && coin.slp && coin.slp.tokenId
          && this.get(coin.slp.tokenId)
          && this.state.slpValid[coin.txid] == null
          && this.verdicts.get(coin.txid) !== 'unproven') {
        txids.add(coin.txid);
      }
    }

    for (const txid of txids)
      await this.check(txid);
  }

  /**
   * Tokens added before their record held every field of the genesis:
   * described again from the genesis kept whole.
   */

  async redescribe() {
    let changed = false;

    for (const [tokenId, token] of Object.entries(this.state.tokens)) {
      if (token.documentHash !== undefined)
        continue;
      const kept = this.state.slpTXs[tokenId];
      if (!kept)
        continue;

      // Its block's hash, from the chain this page holds.
      let block = kept.block || null;
      if (!block) {
        const hash = await this.node.chain.getHash(token.height);
        block = hash ? Buffer.from(hash).reverse().toString('hex') : null;
      }

      const tx = TX.fromRaw(Buffer.from(kept.raw, 'hex'));
      this.state.tokens[tokenId] = describe(tx, token.height, block);
      changed = true;
    }

    if (changed) {
      this.coins.save();
      this.emit('change');
    }
  }

  /**
   * Token coins kept before the wallet read tokens: known to be token
   * coins, but not which token or how much, nor their transactions. Each
   * transaction is fetched once, from its block or a mempool, and read.
   */

  async backfill() {
    const byTX = new Map();
    for (const coin of Object.values(this.coins.state.coins)) {
      if (coin.token && !coin.spent && coin.slp === undefined)
        byTX.set(coin.txid, coin.height);
    }

    if (byTX.size === 0)
      return;

    for (const [txid, height] of byTX) {
      let got = null;

      if (height !== -1) {
        const found = await this.fetch(new Set([txid]), height, height);
        got = found.get(txid);
      } else {
        const {found} = await this.fetchMempool([txid]);
        got = found.get(txid);
      }

      if (!got)
        continue;

      const record = read(got.tx);
      const ours = this.coins.state.txs[txid];
      if (ours)
        ours.raw = got.tx.toRaw().toString('hex');

      for (const coin of Object.values(this.coins.state.coins)) {
        if (coin.txid !== txid)
          continue;
        const held = holding(record, coin.vout);
        coin.token = held.token;
        coin.slp = held.slp;
      }
    }

    this.coins.save();
    this.emit('change');
  }

  /**
   * Tokens seen in coins but not added: each added from its genesis,
   * where the hint says it is. Once a session each.
   */

  async discover() {
    if (!this.heightOf)
      return;

    const seen = new Set();
    for (const coin of Object.values(this.coins.state.coins)) {
      if (coin.token && !coin.spent && coin.slp && coin.slp.tokenId
          && !this.get(coin.slp.tokenId)) {
        seen.add(coin.slp.tokenId);
      }
    }

    for (const tokenId of seen) {
      let lookup = this.lookups.get(tokenId);

      if (!lookup) {
        lookup = {state: 'looking', height: null};
        this.lookups.set(tokenId, lookup);
        this.emit('change');

        try {
          lookup.height = await this.heightOf(tokenId);
        } catch (e) {
          lookup.height = null;
        }

        lookup.state = lookup.height == null ? 'not found' : 'found';
        this.emit('change');
      }

      // Asked once; added once the chain has that block.
      if (lookup.state !== 'found'
          || lookup.height > this.node.chain.height) {
        continue;
      }

      try {
        await this.add(tokenId, lookup.height);
        lookup.state = 'added';
      } catch (e) {
        lookup.state = `not added: ${e.message}`;
      }
      this.emit('change');
    }
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

        // A Type 2 MINT is decided by its own inputs' redeem scripts.
        if (rec.type === 'MINT' && token.vault)
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

    const result = this.evaluate(txid, token, new Map(), {missing,
      unreachable});

    // Kept only if final: confirmed, and not resting on what was not found.
    if (root.height !== -1 && (result === 'valid' || result === 'invalid'))
      this.decide(txid, result === 'valid');
    else
      this.verdicts.set(txid, result);

    this.emit('change');
    return result;
  }

  /**
   * Decide a transaction of the token, from what is held: 'valid',
   * 'invalid', 'unproven' (short only for a parent not found), or 'pending'
   * (short for a parent no peer could be asked for).
   */

  evaluate(txid, token, memo, {missing, unreachable}) {
    if (memo.has(txid))
      return memo.get(txid);

    const known = this.state.slpValid[txid];
    if (known != null)
      return known ? 'valid' : 'invalid';

    if (txid === token.tokenId)
      return 'valid';

    const held = this.txOf(txid);
    if (!held) {
      if (unreachable.has(txid))
        return 'pending';
      return missing.has(txid) ? 'unproven' : 'invalid';
    }

    // Guard cycles (none exist on a chain, but held data could lie).
    memo.set(txid, 'invalid');

    const record = read(held.tx);
    let result = 'invalid';

    if (record && record.tokenId === token.tokenId
        && record.version === token.version && record.type === 'MINT'
        && token.vault) {
      result = drawsOnVault(held.tx, token.vault) ? 'valid' : 'invalid';
    } else if (record && record.tokenId === token.tokenId
        && record.version === token.version) {
      let have = 0n;
      let unsure = 0n;
      let unproven = 0n;
      let baton = false;
      let batonUnsure = false;
      let batonUnproven = false;

      for (const input of held.tx.inputs) {
        const {index} = input.prevout;
        const parent = input.prevout.txid();
        const parentHeld = this.txOf(parent);

        if (!parentHeld) {
          // In no block down to the genesis, nor a mempool: older than
          // the token, holding none of it; or withheld. Unless no peer
          // could be asked at all.
          if (unreachable.has(parent)) {
            unsure += 1n;
            batonUnsure = true;
          } else if (missing.has(parent)) {
            unproven += 1n;
            batonUnproven = true;
          }
          continue;
        }

        const rec = read(parentHeld.tx);
        if (!rec || rec.tokenId !== token.tokenId
            || rec.version !== token.version)
          continue;

        const standing = this.evaluate(parent, token, memo, {missing,
          unreachable});
        if (standing === 'invalid')
          continue;

        if (standing === 'pending') {
          unsure += 1n;
          if (rec.baton === index)
            batonUnsure = true;
          continue;
        }

        if (standing === 'unproven') {
          unproven += 1n;
          if (rec.baton === index)
            batonUnproven = true;
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
        else if (batonUnproven)
          result = 'unproven';
      } else if (record.type === 'SEND') {
        const out = sum(Object.values(record.amounts));
        if (have >= out)
          result = 'valid';
        else if (unsure > 0n)
          result = 'pending';
        else if (unproven > 0n)
          result = 'unproven';
      }
    }

    memo.set(txid, result);

    // Kept if settled, in a block, and not resting on what was not found:
    // it cannot change. A valid one rests only on found parents, all
    // in blocks below it.
    if ((result === 'valid' || result === 'invalid') && held.height !== -1)
      this.state.slpValid[txid] = result === 'valid';
    else
      this.verdicts.set(txid, result);

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
            const block = entry.rhash();
            found.set(txid, {tx, height: entry.height, block});
            this.state.slpTXs[txid] = {
              raw: tx.toRaw().toString('hex'),
              height: entry.height,
              block
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
exports.holding = holding;
exports.describe = describe;
