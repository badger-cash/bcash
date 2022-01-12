/*!
 * slp.js - simple ledger protocol script for bcash
 * Copyright (c) 2021, Vin Armani (MIT License).
 * https://github.com/badger-cash/bcash
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const {U64} = require('n64');
const consensus = require('../protocol/consensus');
const Script = require('./script');
const ScriptNum = require('./scriptnum');

/**
 * SLP Coin Record
 */

 const SLP_TYPES = {
  GENESIS: 0x00,
  MINT: 0x01,
  SEND: 0x02,
  BATON: 0x03
}

class SlpCoinRecord {
  /**
   * Create a record of SLP data for a given coin.
   * @param {Buffer?} hash the output hash of the coin
   * @param {Number?} vout the output index of the coin
   * @param {Buffer?} tokenId 32 byte txid
   * @param {Buffer?} tokenIndex 4 byte unsigned integer (index of tx hash in db)
   * @param {Buffer} value big endian value of token base units
   * @param {String} type GENESIS | MINT | SEND | BATON
   * @constructor
   */

  constructor(options = {}) {
    this.hash = options.hash;
    this.vout = options.vout;
    this.tokenId = options.tokenId;
    this.tokenIndex = options.tokenIndex;
    this.value = options.value;
    this.type = options.type;
    
  }

  /**
   * Get the value as 64 bit big-endian buffer
   * @private
   * @returns {Buffer}
   */
  getValueUInt64BE() {
    assert(this.value.length <= 8, 'value buffer must be 8 bytes or less');
    const padding = Buffer.alloc(8 - this.value.length);
    return Buffer.concat([padding, this.value]);
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromDbData(data) {
    const br = bio.read(data);

    this.tokenIndex = br.readBytes(4);
    const valueBytes = br.readVarBytes();
    const padding = Buffer.alloc(8 - valueBytes.length);
    this.value = Buffer.concat([padding, valueBytes]);
    this.type = Object.keys(SLP_TYPES)[br.readU8()];

    assert(Object.keys(SLP_TYPES).includes(this.type));

    return this;
  }

  /**
   * Instantiate SLP record from serialized data.
   * @param {Buffer} data
   * @returns {SlpCoinRecord}
   */

  static fromDbData(data) {
    return new this().fromDbData(data);
  }

  /**
   * Serialize the SLP record.
   * @returns {Buffer}
   */

  toDbData() {
    assert(this.tokenIndex, 'Missing tokenIndex');
    assert(this.tokenIndex.length == 4, 'tokenId must be a sha256 hash');
    // assert(this.value, 'Missing token amount (in base units)')
    assert(this.value.byteLength, 'Token amount must be a buffer')
    assert(Object.keys(SLP_TYPES).includes(this.type), 'Type must be GENESIS | MINT | SEND | BATON');
    // Remove padding (minimal)
    for (let i = 0; i < this.value.length; i++) {
      if (this.value[i] != 0) {
        this.value = this.value.slice(i)
        break;
      }
    }
    const bw = bio.write();

    bw.writeBytes(this.tokenIndex);
    bw.writeVarBytes(this.value);
    bw.writeU8(SLP_TYPES[this.type]);

    return bw.render();
  }

  /**
   * Convert object to JSON.
   * @returns {Object}
   */

  getJSON() {
    assert(this.tokenId, 'tokenId must be defined');

    const json = {
      hash: this.hash ? Buffer.from(this.hash).reverse().toString('hex') : undefined,
      vout: this.vout,
      tokenId: this.tokenId.toString('hex'),
      value: U64.fromBE(this.value).toString(10),
      type: this.type

    }
    return json;
  }

  /**
   * Convert from JSON to Object.
   * @param {Object} json
   * @returns {SlpCoinRecord}
   */

   fromJSON(json) {

    this.hash = Buffer.from(json.hash, 'hex').reverse();
    this.vout = json.vout;
    this.tokenId = Buffer.from(json.tokenId, 'hex');
    this.value = U64.fromString(json.value).toBE(Buffer);
    this.type = json.type;

    return this
  }

  /**
   * Convert from JSON to Object.
   * @param {Object} json
   * @returns {TokenRecord}
   */

   static fromJSON(json) {
    return new this().fromJSON(json);
  }
}

/**
 * Token Record
 */

 class TokenRecord {
  /**
   * Create a token record.
   * @constructor
   * @param {Buffer?} tokenId
   * @param {Buffer?} tokenIndex
   * @param {String?} ticker
   * @param {String?} name
   * @param {String?} uri
   * @param {String?} hash
   * @param {Number} decimals
   */

  constructor(options = {}) {
    this.tokenId = options.tokenId;
    this.tokenIndex = options.tokenIndex;
    this.ticker = options.ticker || '';
    this.name = options.name || '';
    this.uri = options.uri || '';
    this.hash = options.hash || '';
    this.decimals = options.decimals;

  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer} data
   */

  fromDbData(data) {
    const br = bio.read(data);

    this.tokenId = br.readHash();
    this.ticker = br.readVarString('utf8');
    // assert(this.ticker.length > 0);

    this.name = br.readVarString('utf8');
    // assert(this.name.length > 0);

    this.uri = br.readVarString('utf8');
    this.hash = br.readVarString('hex');
    this.decimals = br.readU8();

    // assert(this.decimals >= 0 && this.decimals < 9);

    return this;
  }

  /**
   * Instantiate token record from serialized data.
   * @param {Buffer} data
   * @returns {TokenRecord}
   */

  static fromDbData(data) {
    return new this().fromDbData(data);
  }

  /**
   * Serialize the token record.
   * @returns {Buffer}
   */

  toDbData() {
    const bw = bio.write();
    const encoding = bio.encoding;

    bw.writeHash(this.tokenId);
    bw.writeVarString(this.ticker, 'utf8');
    if (this.ticker.length === 0)
      bw.offset += encoding.sizeVarint(0);
    bw.writeVarString(this.name, 'utf8');
    if (this.name.length === 0)
      bw.offset += encoding.sizeVarint(0);
    bw.writeVarString(this.uri, 'utf8');
    if (this.uri.length === 0)
      bw.offset += encoding.sizeVarint(0);
    bw.writeVarString(this.hash, 'hex');
    if (this.hash.length === 0)
      bw.offset += encoding.sizeVarint(0);
    bw.writeU8(this.decimals);

    return bw.render();
  }

  /**
   * Convert object to JSON.
   * @returns {Object}
   */

  getJSON() {
    assert(this.tokenId, 'tokenId must be defined');

    const json = {
      tokenId: this.tokenId.toString('hex'),
      ticker: this.ticker,
      name: this.name,
      uri: this.uri,
      hash: this.hash,
      decimals: this.decimals
    }
    return json;
  }

  /**
   * Convert from JSON to Object.
   * @param {Object} json
   * @returns {SlpCoinRecord}
   */

   fromJSON(json) {

    this.tokenId = Buffer.from(json.tokenId, 'hex');
    this.ticker = json.ticker;
    this.name = json.name;
    this.uri = json.uri;
    this.hash = json.hash
    this.decimals = json.decimals;

    return this
  }

  /**
   * Convert from JSON to Object.
   * @param {Object} json
   * @returns {TokenRecord}
   */

   static fromJSON(json) {
    return new this().fromJSON(json);
  }

}


/**
 * SLP
 * @alias module:script.SLP
 * @extends Script
 */

class SLP extends Script {
  /**
   * Create an SLP script.
   * @constructor
   * @param {Buffer|Array|Object} code
   */

  constructor(options) {
    super(options);

    this.valid = null;
  }

  /**
   * Is SLP script is of valid construction?
   * Use this as opposed to calling property this.isValid
   * @private
   * @returns {Boolean}
   */
  isValidSlp() {
    if (this.valid === null) {
      this.valid = this.verifySlp();
    }
    return this.valid;
  }

  /**
   * Test whether SLP script is of valid construction
   * (Does not test if transaction is valid SLP transaction)
   * @private
   * @param {Script?} script
   * @returns {Boolean}
   */

  verifySlp(script) {
    if (script == undefined)
      script = this;

    if (script.getSym(0) != 'OP_RETURN')
      return false;

    // LOKAD_ID
    if (script.getString(1, 'hex') != '534c5000')
      return false;

    // Check version
    if (script.getString(2, 'hex') != '01')
      return false;

    // Type
    const type = script.getType();

    switch (type) {
      case 'GENESIS': {
        if (script.code.length != 11)
          return false;
        // Hash
        if (script.getData(7) && script.getData(7).length != 32)
          return false;
        // Decimals
        if (!script.getData(8))
          return false;
        if (script.getData(8).length != 1 || script.getInt(8) > 9)
          return false;
        // Mint Baton
        if (!script.getData(9))
          return false;
        if (script.getData(9).length > 1)
          return false;
        if (script.getData(9).length == 1 && script.getInt(9) < 2)
          return false;
        // Minted Tokens
        if (script.getData(10).length != 8)
          return false
        break;
      }
      case 'MINT': {
        if (script.code.length != 7)
          return false;
        // Token ID
        if (script.getData(4).length != 32)
          return false;
        // Mint Baton
        if (!script.getData(5))
          return false;
        if (script.getData(5).length > 1)
          return false;
        if (script.getData(5).length == 1 && script.getInt(5) < 2)
          return false;
        // Minted Tokens
        if (script.getData(6).length != 8)
          return false
        break;
      }
      case 'SEND': {
        if (script.code.length < 6)
          return false;
        // Token ID
        if (script.getData(4).length != 32)
          return false;
        const outputs = script.code.slice(5);
        for (let i = 0; i < outputs.length; i++) {
          const op = outputs[i];
          // Sent Tokens
          if (op.data.length != 8)
            return false
        }
        break;
      }
      default: {
        return false;
      }
    }

    return true;
  }

  /**
   * Test whether script is of valid construction
   * (Does not test if transaction is valid SLP transaction)
   * @param {Script?} script
   * @returns {Boolean}
   */

  static verifySlp(script) {
    return new this().verifySlp(script);
  }

  /**
   * Inject properties from a script
   * @private
   * @param {Script} code
   * @returns {SLP}
   */

  fromScript(script) {
    this.inject(script);
    return this;
  }

  /**
   * Inject properties from a script
   * @param {Script} code
   * @returns {SLP}
   */

   static fromScript(script) {
    return new this().fromScript(script);
  }

  /**
   * Get token ID for this script
   * @private
   * @returns {Hash}
   */

    getTokenId() {
      assert(this.verifySlp(), 'This is not a valid SLP script')
    
      // Type
      const type = this.getType();
      assert(type != 'GENESIS', 'Cannot derive the tokenID from GENESIS script')
      
      // Return tokenId as buffer
      return this.getData(4);
    }

  /**
   * Get records for a this script
   * @private
   * @param {Buffer?} txId The txid of the transaction containing this script
   * @returns {(SlpCoinRecord | TokenRecord)[]}
   */

  getRecords(txId) {
    assert(this.isValidSlp(), 'Must be a valid SLP Script' )

    const type = this.getType();
    assert(Object.keys(SLP_TYPES).includes(type) && type != 'BATON', 'Type must be GENESIS | MINT | SEND');
    assert(txId.byteLength, 'tokenId must be a buffer');
    assert(txId.length == 32, 'tokenId must be a sha256 hash');

    switch (type) {
      case 'GENESIS': {
        return this.getGenesisRecords(txId);
        break;
      }
      case 'MINT': {
        return this.getMintRecords(txId);
        break;
      }
      case 'SEND': {
        return this.getSendRecords(txId);
        break;
      }
      default: {
        return null;
      }
    }
  }

  /**
   * Get records for a GENESIS script
   * @private
   * @param {Buffer} tokenId The tokenId of the transaction containing this script
   * @returns {(SlpCoinRecord | TokenRecord)[]}
   */

   getGenesisRecords(tokenId) {
    assert(tokenId.byteLength, 'tokenId must be a buffer');
    assert(tokenId.byteLength == 32, 'tokenId must be a sha256 hash');
    const type = this.getType();
    assert(type == 'GENESIS', 'This is not a GENESIS transaction')

    const records = [];
    // Create TokenRecord
    records.push(this.constructor.TokenRecord({
      tokenId,
      ticker: this.getString(4, 'utf-8'),
      name: this.getString(5, 'utf-8'),
      uri: this.getString(6, 'utf-8'),
      hash: this.getString(7, 'hex'),
      decimals: this.getInt(8)
    }));
    // Create Minted Tokens SLPCoinRecord
    records.push(this.constructor.SlpCoinRecord({
      hash: Buffer.from(tokenId).reverse(),
      vout: 1,
      tokenId,
      value: this.getData(10),
      type
    }));
    // Create Mint Baton SLPCoinRecord
    if (this.getInt(9) >= 2) {
      const valBuf = Buffer.alloc(1);
      valBuf.writeInt8(1);
      records.push(this.constructor.SlpCoinRecord({
        hash: Buffer.from(tokenId).reverse(),
        vout: this.getInt(9),
        tokenId,
        value: valBuf,
        type: 'BATON'
      }));
    }
    return records;
  }

  /**
   * Get records for a MINT script
   * @private
   * @param {Buffer} txId The txHash of the transaction containing this script
   * @returns {SlpCoinRecord[]}
   */

   getMintRecords(txId) {
    assert(txId.byteLength, 'txId must be a buffer');
    assert(txId.byteLength == 32, 'txId must be a sha256 hash');
    const type = this.getType();
    assert(type == 'MINT', 'This is not a MINT transaction')

    const records = [];
    // Create Minted Tokens SLPCoinRecord
    records.push(this.constructor.SlpCoinRecord({
      hash: Buffer.from(txId).reverse(),
      vout: 1,
      tokenId: this.getData(4),
      value: this.getData(6),
      type
    }));
    // Create Mint Baton SLPCoinRecord
    if (this.getInt(5) >= 2) {
      const valBuf = U64.fromInt(1).toBE(Buffer);
      records.push(this.constructor.SlpCoinRecord({
        hash: Buffer.from(txId).reverse(),
        vout: this.getInt(5),
        tokenId: this.getData(4),
        value: valBuf,
        type: 'BATON'
      }));
    }
    return records;
  }

  /**
   * Get records for a SEND script
   * @private
   * @param {Buffer} txId The txHash of the transaction containing this script
   * @param {Boolean} nonStandardOuts OP_RETURN is located at an index other than 0
   * @returns {SlpCoinRecord[]}
   */

   getSendRecords(txId, nonStandardOuts = false) {
    assert(txId.byteLength, 'txId must be a buffer');
    assert(txId.byteLength == 32, 'txId must be a sha256 hash');
    const type = this.getType();
    assert(type == 'SEND', 'This is not a SEND transaction')

    const records = [];
    const outputs = this.code.slice(5);
    for (let i = 0; i < outputs.length; i++) {
      const valueBuf = outputs[i].toData();
      const vout = nonStandardOuts ? i : i + 1;
    
      // Create Send Tokens SLPCoinRecord
      records.push(this.constructor.SlpCoinRecord({
        hash: Buffer.from(txId).reverse(),
        vout,
        tokenId: this.getData(4),
        value: valueBuf,
        type
      }));
    }
    return records;
  }
  
  /**
   * Re-encode the script internally. Useful if you
   * changed something manually in the `code` array.
   * @returns {Script}
   */

  compile() {
    super.compile();

    this.valid = null;
    this.isValidSlp();
  }

  /**
   * Inspect the script.
   * @returns {String} Human-readable script code.
   */

  inspect() {
    return `<SLP: ${this.toString()}>`;
  }

  getType() {
    return this.getString(3);
  }

  /**
   * Create a new TokenRecord
   * @param {Buffer?} tokenId
   * @param {Buffer?} tokenIndex
   * @param {String?} ticker
   * @param {String?} name
   * @param {String?} uri
   * @param {String?} hash
   * @param {Number} decimals
   * @returns {TokenRecord}
   */

  static TokenRecord(options = {}) {
    return new TokenRecord(options);
  }

  /**
   * Create a new SlpCoinRecord
   * @param {Buffer?} hash the output hash of the coin
   * @param {Number?} vout the output index of the coin
   * @param {Buffer?} tokenId 32 byte txid
   * @param {Buffer?} tokenIndex 4 byte unsigned integer (index of tx hash in db)
   * @param {Number} value
   * @param {String} type GENESIS | MINT | SEND | BATON
   * @returns {SlpCoinRecord}
   */

  static SlpCoinRecord(options = {}) {
    return new SlpCoinRecord(options);
  }

}

module.exports = SLP;
