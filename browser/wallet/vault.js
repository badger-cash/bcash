/*!
 * vault.js - a web wallet's keys, kept encrypted
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The keys, each with a name, one of them in use, kept encrypted with a
 * password: PBKDF2 (SHA-256) derives an AES-GCM key, which also seals the
 * wallet's other state (each network's coins and history), so nothing
 * about the keys is readable without the password.
 *
 * A key is a private key, or a mnemonic (BIP39) and the one address it
 * derives at Cashtab's path, m/44'/1899'/0'/0/0, so a Cashtab phrase opens
 * the same address. Keys belong to no network: the same key is an
 * ecash: address on mainnet and an ectest: one on testnet. Each keeps when
 * it was made, and the height it was born at on each network where that
 * is known (made there, or as the person importing it said): a scan for
 * what it holds starts there.
 *
 * The wallet file is the vault as stored, sealed with its password, keys,
 * phrases and birth heights in it: imported elsewhere, it needs that
 * password, and syncs fast from each key's birth.
 *
 * Storage is a localStorage-like object (getItem, setItem, removeItem);
 * WebCrypto is the browser's, or Node's.
 */

const assert = require('bsert');
const KeyRing = require('../../lib/primitives/keyring');
const HDPrivateKey = require('../../lib/hd/private');
const Mnemonic = require('../../lib/hd/mnemonic');

const VERSION = 2;
const FORMAT = 'bcash-wallet';
const ITERATIONS = 600000;
const PATH = 'm/44\'/1899\'/0\'/0/0';
const NAME = /^[A-Za-z0-9 _.-]{1,32}$/;
const STORE = 'bcash-wallet';
const NETWORKS = ['main', 'testnet', 'regtest', 'simnet'];

const subtle = () => globalThis.crypto.subtle;
const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = str => Buffer.from(str, 'base64');

async function deriveKey(password, salt, iterations) {
  const material = await subtle().importKey('raw',
    Buffer.from(password, 'utf8'), 'PBKDF2', false, ['deriveKey']);

  return subtle().deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations
  }, material, {name: 'AES-GCM', length: 256}, false,
  ['encrypt', 'decrypt']);
}

/**
 * Seal and open JSON with a derived key: {iv, data}, base64.
 */

class Sealer {
  constructor(key) {
    this.key = key;
  }

  async seal(value) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle().encrypt({name: 'AES-GCM', iv}, this.key,
      Buffer.from(JSON.stringify(value), 'utf8'));
    return {iv: b64(iv), data: b64(data)};
  }

  async open(sealed) {
    const data = await subtle().decrypt({
      name: 'AES-GCM',
      iv: unb64(sealed.iv)
    }, this.key, unb64(sealed.data));
    return JSON.parse(Buffer.from(data).toString('utf8'));
  }
}

/**
 * A key as kept before keys left their network (version 1: a WIF and a
 * birth height on the one network of its wallet).
 */

function fromV1(key, network) {
  const ring = KeyRing.fromSecret(key.wif, network);
  return {
    name: key.name,
    type: key.type,
    key: ring.getPrivateKey('hex'),
    phrase: key.phrase || null,
    path: key.path || null,
    created: null,
    born: key.born != null ? {[network]: key.born} : {}
  };
}

/**
 * Open a stored or exported vault with its password.
 * @returns {Promise} {sealer, state}
 */

async function openVault(stored, password) {
  assert(stored && stored.keys && (stored.version === 1
    || stored.version === VERSION), 'Not a bcash wallet.');

  const sealer = new Sealer(await deriveKey(password, unb64(stored.salt),
    stored.iterations));

  let state;
  try {
    state = await sealer.open(stored.keys);
  } catch (e) {
    throw new Error('Wrong password.');
  }

  if (stored.version === 1) {
    state = {
      active: state.active,
      keys: state.keys.map(key => fromV1(key, stored.network))
    };
  }

  return {sealer, state};
}

/**
 * The key a mnemonic derives, at a path.
 */

function phraseRing(phrase, path = PATH) {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(' ');

  let mnemonic;
  try {
    mnemonic = Mnemonic.fromPhrase(words);
  } catch (e) {
    throw new Error('Not a valid recovery phrase (BIP39).');
  }

  const key = HDPrivateKey.fromMnemonic(mnemonic).derivePath(path);

  return KeyRing.fromPrivate(key.privateKey, true);
}

/**
 * A WIF, for any network.
 */

function wifRing(text) {
  for (const network of NETWORKS) {
    try {
      return KeyRing.fromSecret(text, network);
    } catch (e) {
      continue;
    }
  }
  throw new Error('Not a recovery phrase, or a private key (WIF).');
}

class Vault {
  /**
   * @param {Object} options
   * @param {Object} options.storage - localStorage-like.
   * @param {Number} [options.iterations]
   */

  constructor({storage, iterations = ITERATIONS}) {
    this.storage = storage;
    this.iterations = iterations;
    this.sealer = null;
    this.state = null;
    this.header = null;
  }

  /**
   * The stored vault: this version's, or one kept per network before.
   */

  stored() {
    const value = this.storage.getItem(STORE);
    if (value)
      return {stored: JSON.parse(value), legacy: null};

    for (const network of NETWORKS) {
      const old = this.storage.getItem(`${STORE}-${network}`);
      if (old)
        return {stored: JSON.parse(old), legacy: network};
    }

    return {stored: null, legacy: null};
  }

  exists() {
    return this.stored().stored != null;
  }

  get unlocked() {
    return this.state != null;
  }

  async create(password) {
    assert(!this.exists(), 'A wallet already exists.');
    assert(typeof password === 'string' && password.length >= 8,
      'The password needs at least 8 characters.');

    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    this.sealer = new Sealer(
      await deriveKey(password, salt, this.iterations));
    this.state = {active: null, keys: []};
    this.header = {
      format: FORMAT,
      version: VERSION,
      salt: b64(salt),
      iterations: this.iterations
    };

    await this.save();
  }

  async unlock(password) {
    const {stored, legacy} = this.stored();
    assert(stored, 'No wallet to unlock.');

    const {sealer, state} = await openVault(stored, password);

    this.sealer = sealer;
    this.state = state;
    this.header = {
      format: FORMAT,
      version: VERSION,
      salt: stored.salt,
      iterations: stored.iterations
    };

    // Kept per network before: moved to this version, its coins with it,
    // sealed as they were (the same salt keeps the same key).
    if (legacy) {
      await this.save();
      const old = this.storage.getItem(`${STORE}-${legacy}-state`);
      if (old)
        this.storage.setItem(`${STORE}-state-${legacy}`, old);
      this.storage.removeItem(`${STORE}-${legacy}`);
      this.storage.removeItem(`${STORE}-${legacy}-state`);
    }
  }

  lock() {
    this.sealer = null;
    this.state = null;
  }

  /**
   * Forget the wallet: its keys, and every network's state.
   */

  destroy() {
    this.lock();
    this.storage.removeItem(STORE);
    for (const network of NETWORKS) {
      this.storage.removeItem(`${STORE}-state-${network}`);
      this.storage.removeItem(`${STORE}-${network}`);
      this.storage.removeItem(`${STORE}-${network}-state`);
    }
  }

  async save() {
    assert(this.unlocked, 'The wallet is locked.');
    const stored = {...this.header, keys: await this.sealer.seal(this.state)};
    this.storage.setItem(STORE, JSON.stringify(stored));
  }

  /**
   * A network's other state (coins, history), sealed with the same key.
   */

  async saveState(network, value) {
    assert(this.unlocked, 'The wallet is locked.');
    this.storage.setItem(`${STORE}-state-${network}`,
      JSON.stringify(await this.sealer.seal(value)));
  }

  async loadState(network) {
    assert(this.unlocked, 'The wallet is locked.');
    const stored = this.storage.getItem(`${STORE}-state-${network}`);
    return stored ? this.sealer.open(JSON.parse(stored)) : null;
  }

  /**
   * The keys as a network shows them: its addresses and birth heights.
   */

  list(network) {
    assert(this.unlocked, 'The wallet is locked.');
    return this.state.keys.map(key => ({
      name: key.name,
      type: key.type,
      address: this.ring(key.name).getAddress().toString(network),
      born: key.born[network] != null ? key.born[network] : null,
      created: key.created,
      active: key.name === this.state.active
    }));
  }

  active(network) {
    return this.list(network).find(k => k.active) || null;
  }

  ring(name = this.state.active) {
    assert(this.unlocked, 'The wallet is locked.');
    const key = this.state.keys.find(k => k.name === name);
    assert(key, `No key named ${name}.`);
    return KeyRing.fromPrivate(Buffer.from(key.key, 'hex'), true);
  }

  /**
   * A new key (a private key), born now: at `height` on `network`.
   */

  async newKey(name, {network, height}) {
    return this.add(KeyRing.generate(), name, {
      type: 'wif',
      created: Date.now(),
      born: {[network]: height}
    }, network);
  }

  /**
   * A new recovery phrase (12 words), born now.
   * @returns {Promise} {name, address, phrase}
   */

  async newPhrase(name, {network, height}) {
    const phrase = new Mnemonic({bits: 128}).getPhrase();
    const key = await this.add(phraseRing(phrase), name, {
      type: 'mnemonic',
      phrase,
      path: PATH,
      created: Date.now(),
      born: {[network]: height}
    }, network);
    return {...key, phrase};
  }

  /**
   * A key from text: a recovery phrase, or a WIF. `height`, the block on
   * `network` it was made at if known, saves a scan from the start.
   */

  async importText(text, name, {network, height = null}) {
    text = text.trim();

    const born = height != null ? {[network]: height} : {};

    if (text.split(/\s+/).length >= 12) {
      const phrase = text.toLowerCase().split(/\s+/).join(' ');
      return this.add(phraseRing(phrase), name, {
        type: 'mnemonic',
        phrase,
        path: PATH,
        created: null,
        born
      }, network);
    }

    return this.add(wifRing(text), name, {
      type: 'wif',
      created: null,
      born
    }, network);
  }

  /**
   * The wallet file: the vault as stored, sealed with its password.
   * @returns {String} JSON
   */

  exportFile() {
    assert(this.unlocked, 'The wallet is locked.');
    return this.storage.getItem(STORE);
  }

  /**
   * Take the keys of a wallet file, opened with its password. Keys already
   * here are skipped; a name already taken gets a number.
   * @returns {Promise} [{name}] added
   */

  async importFile(text, password) {
    assert(this.unlocked, 'The wallet is locked.');

    let stored;
    try {
      stored = JSON.parse(text);
    } catch (e) {
      throw new Error('Not a bcash wallet file.');
    }

    assert(stored && stored.format === FORMAT, 'Not a bcash wallet file.');

    const {state} = await openVault(stored, password);
    const added = [];

    for (const key of state.keys) {
      if (this.state.keys.some(k => k.key === key.key))
        continue;

      let name = key.name;
      for (let i = 2; this.state.keys.some(k => k.name === name); i++)
        name = `${key.name} ${i}`;

      this.state.keys.push({...key, name});
      added.push({name});
    }

    if (!this.state.active && this.state.keys.length > 0)
      this.state.active = this.state.keys[0].name;

    await this.save();

    return added;
  }

  async add(ring, name, {type, phrase = null, path = null, created, born},
    network) {
    assert(this.unlocked, 'The wallet is locked.');

    name = name ? name.trim() : this.nextName();
    assert(NAME.test(name),
      'A name is 1 to 32 letters, digits, spaces, or _ . -');
    assert(!this.state.keys.some(k => k.name === name),
      `A key is already named ${name}.`);

    const key = ring.getPrivateKey('hex');
    assert(!this.state.keys.some(k => k.key === key),
      'That key is already in the wallet.');

    for (const height of Object.values(born))
      assert(height == null || (height >>> 0) === height, 'Bad birth height.');

    this.state.keys.push({name, type, key, phrase, path, created, born});

    if (!this.state.active)
      this.state.active = name;

    await this.save();

    return {name, address: ring.getAddress().toString(network)};
  }

  async use(name) {
    assert(this.unlocked, 'The wallet is locked.');
    assert(this.state.keys.some(k => k.name === name), `No key named ${name}.`);
    this.state.active = name;
    await this.save();
  }

  /**
   * Record a key's birth height on a network, once found.
   */

  async setBorn(name, network, height) {
    const key = this.state.keys.find(k => k.name === name);
    assert(key, `No key named ${name}.`);
    key.born[network] = height;
    await this.save();
  }

  /**
   * A key's secrets, to back them up: only with the password again.
   * @returns {Promise} {wif (for `network`), phrase, path}
   */

  async reveal(name, password, network) {
    const {stored} = this.stored();
    const {state} = await openVault(stored, password);
    const key = state.keys.find(k => k.name === name);
    assert(key, `No key named ${name}.`);
    const ring = KeyRing.fromPrivate(Buffer.from(key.key, 'hex'), true);
    return {wif: ring.toSecret(network), phrase: key.phrase, path: key.path};
  }

  nextName() {
    for (let i = 1; ; i++) {
      const name = `key${i}`;
      if (!this.state.keys.some(k => k.name === name))
        return name;
    }
  }
}

exports.Vault = Vault;
exports.phraseRing = phraseRing;
exports.PATH = PATH;
exports.ITERATIONS = ITERATIONS;
