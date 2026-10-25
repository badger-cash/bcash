/*!
 * vault.js - a web wallet's keys, kept encrypted
 * Copyright (c) 2026, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

/*
 * The keys, each with a name, one of them in use, kept encrypted with a
 * password: PBKDF2 (SHA-256) derives an AES-GCM key, which also seals the
 * wallet's other state (its coins and history), so nothing about the keys
 * is readable without the password.
 *
 * A key is a WIF, or a mnemonic (BIP39) and the one address it derives at
 * Cashtab's path, m/44'/1899'/0'/0/0, so a Cashtab phrase opens the same
 * address. Each key keeps the height it was born at (made here, or as the
 * person importing it says): a scan for what it holds starts there.
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

const VERSION = 1;
const FORMAT = 'bcash-wallet';
const ITERATIONS = 600000;
const PATH = 'm/44\'/1899\'/0\'/0/0';
const NAME = /^[A-Za-z0-9 _.-]{1,32}$/;

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
 * Open a stored or exported vault with its password.
 * @returns {Promise} {sealer, state}
 */

async function openVault(stored, password) {
  assert(stored && stored.version === VERSION && stored.keys,
    'Not a bcash wallet.');

  const sealer = new Sealer(await deriveKey(password, unb64(stored.salt),
    stored.iterations));

  try {
    return {sealer, state: await sealer.open(stored.keys)};
  } catch (e) {
    throw new Error('Wrong password.');
  }
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

class Vault {
  /**
   * @param {Object} options
   * @param {String} options.network
   * @param {Object} options.storage - localStorage-like.
   * @param {Number} [options.iterations]
   */

  constructor({network, storage, iterations = ITERATIONS}) {
    this.network = network;
    this.storage = storage;
    this.iterations = iterations;
    this.name = `bcash-wallet-${network}`;
    this.sealer = null;
    this.state = null;
    this.header = null;
  }

  exists() {
    return this.storage.getItem(this.name) != null;
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
      network: this.network,
      salt: b64(salt),
      iterations: this.iterations
    };

    await this.save();
  }

  async unlock(password) {
    const stored = JSON.parse(this.storage.getItem(this.name));
    const {sealer, state} = await openVault(stored, password);

    this.sealer = sealer;
    this.state = state;
    this.header = {
      format: FORMAT,
      version: stored.version,
      network: this.network,
      salt: stored.salt,
      iterations: stored.iterations
    };
  }

  lock() {
    this.sealer = null;
    this.state = null;
  }

  /**
   * Forget the wallet: its keys, and the state sealed with them.
   */

  destroy() {
    this.lock();
    this.storage.removeItem(this.name);
    this.storage.removeItem(`${this.name}-state`);
  }

  async save() {
    assert(this.unlocked, 'The wallet is locked.');
    const stored = {...this.header, keys: await this.sealer.seal(this.state)};
    this.storage.setItem(this.name, JSON.stringify(stored));
  }

  /**
   * The wallet's other state (coins, history), sealed with the same key.
   */

  async saveState(value) {
    assert(this.unlocked, 'The wallet is locked.');
    this.storage.setItem(`${this.name}-state`,
      JSON.stringify(await this.sealer.seal(value)));
  }

  async loadState() {
    assert(this.unlocked, 'The wallet is locked.');
    const stored = this.storage.getItem(`${this.name}-state`);
    return stored ? this.sealer.open(JSON.parse(stored)) : null;
  }

  list() {
    assert(this.unlocked, 'The wallet is locked.');
    return this.state.keys.map(({name, type, address, born}) => ({
      name,
      type,
      address,
      born,
      active: name === this.state.active
    }));
  }

  active() {
    assert(this.unlocked, 'The wallet is locked.');
    return this.state.keys.find(k => k.name === this.state.active) || null;
  }

  ring(name = this.state.active) {
    assert(this.unlocked, 'The wallet is locked.');
    const key = this.state.keys.find(k => k.name === name);
    assert(key, `No key named ${name}.`);
    return KeyRing.fromSecret(key.wif, this.network);
  }

  /**
   * A new key (a WIF), born at `height`: it can hold nothing from before.
   */

  async newKey(name, height) {
    return this.add(KeyRing.generate(), name, {type: 'wif', born: height});
  }

  /**
   * A new recovery phrase (12 words), born at `height`.
   * @returns {Promise} {name, address, phrase}
   */

  async newPhrase(name, height) {
    const phrase = new Mnemonic({bits: 128}).getPhrase();
    const key = await this.add(phraseRing(phrase), name, {
      type: 'mnemonic',
      phrase,
      path: PATH,
      born: height
    });
    return {...key, phrase};
  }

  /**
   * A key from text: a recovery phrase, or a WIF. `born`, the height it
   * was made at if known, saves a scan from the start of the chain.
   */

  async importText(text, name, born = null) {
    text = text.trim();

    if (text.split(/\s+/).length >= 12) {
      const phrase = text.toLowerCase().split(/\s+/).join(' ');
      return this.add(phraseRing(phrase), name, {
        type: 'mnemonic',
        phrase,
        path: PATH,
        born
      });
    }

    let ring;
    try {
      ring = KeyRing.fromSecret(text, this.network);
    } catch (e) {
      throw new Error('Not a recovery phrase, or a private key (WIF) for'
        + ' this network.');
    }

    return this.add(ring, name, {type: 'wif', born});
  }

  /**
   * The wallet file: the vault as stored, sealed with its password.
   * @returns {String} JSON
   */

  exportFile() {
    assert(this.unlocked, 'The wallet is locked.');
    return this.storage.getItem(this.name);
  }

  /**
   * Take the keys of a wallet file, opened with its password. Keys already
   * here are skipped; a name already taken gets a number.
   * @returns {Promise} [{name, address}] added
   */

  async importFile(text, password) {
    assert(this.unlocked, 'The wallet is locked.');

    let stored;
    try {
      stored = JSON.parse(text);
    } catch (e) {
      throw new Error('Not a bcash wallet file.');
    }

    assert(stored.format === FORMAT, 'Not a bcash wallet file.');
    assert(stored.network === this.network,
      `That wallet is for ${stored.network}, not ${this.network}.`);

    const {state} = await openVault(stored, password);
    const added = [];

    for (const key of state.keys) {
      if (this.state.keys.some(k => k.address === key.address))
        continue;

      let name = key.name;
      for (let i = 2; this.state.keys.some(k => k.name === name); i++)
        name = `${key.name} ${i}`;

      this.state.keys.push({...key, name});
      added.push({name, address: key.address});
    }

    if (!this.state.active && this.state.keys.length > 0)
      this.state.active = this.state.keys[0].name;

    await this.save();

    return added;
  }

  async add(ring, name, {type, phrase = null, path = null, born}) {
    assert(this.unlocked, 'The wallet is locked.');

    name = name ? name.trim() : this.nextName();
    assert(NAME.test(name),
      'A name is 1 to 32 letters, digits, spaces, or _ . -');
    assert(!this.state.keys.some(k => k.name === name),
      `A key is already named ${name}.`);

    const address = ring.getAddress().toString(this.network);
    assert(!this.state.keys.some(k => k.address === address),
      'That key is already in the wallet.');

    assert(born == null || (born >>> 0) === born, 'Bad birth height.');

    this.state.keys.push({
      name,
      type,
      wif: ring.toSecret(this.network),
      phrase,
      path,
      address,
      born
    });

    if (!this.state.active)
      this.state.active = name;

    await this.save();

    return {name, address};
  }

  async use(name) {
    assert(this.unlocked, 'The wallet is locked.');
    assert(this.state.keys.some(k => k.name === name), `No key named ${name}.`);
    this.state.active = name;
    await this.save();
  }

  /**
   * A key's secrets, to back them up: only with the password again.
   * @returns {Promise} {wif, phrase, path}
   */

  async reveal(name, password) {
    const stored = JSON.parse(this.storage.getItem(this.name));
    const {state} = await openVault(stored, password);
    const key = state.keys.find(k => k.name === name);
    assert(key, `No key named ${name}.`);
    return {wif: key.wif, phrase: key.phrase, path: key.path};
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
