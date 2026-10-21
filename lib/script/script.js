/*!
 * script.js - script interpreter for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const bio = require('bufio');
const ripemd160 = require('bcrypto/lib/ripemd160');
const sha1 = require('bcrypto/lib/sha1');
const sha256 = require('bcrypto/lib/sha256');
const hash160 = require('bcrypto/lib/hash160');
const hash256 = require('bcrypto/lib/hash256');
const secp256k1 = require('bcrypto/lib/secp256k1');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const Opcode = require('./opcode');
const Stack = require('./stack');
const ScriptError = require('./scripterror');
const ScriptNum = require('./scriptnum');
const common = require('./common');
const Address = require('../primitives/address');
const Metrics = require('./metrics');
const opcodes = common.opcodes;
const scriptTypes = common.types;
const countBits = common.countBits;
const {encoding} = bio;


/*
 * Constants
 */

const EMPTY_BUFFER = Buffer.alloc(0);
const metrics = new Metrics();

/**
 * Script
 * Represents a input or output script.
 * @alias module:script.Script
 * @property {Array} code - Parsed script code.
 * @property {Buffer?} raw - Serialized script.
 * @property {Number} length - Number of parsed opcodes.
 */

class Script {
  /**
   * Create a script.
   * @constructor
   * @param {Buffer|Array|Object} code
   */

  constructor(options) {
    this.raw = EMPTY_BUFFER;
    this.code = [];

    if (options)
      this.fromOptions(options);
  }

  /**
   * Get length.
   * @returns {Number}
   */

  get length() {
    return this.code.length;
  }

  /**
   * Set length.
   * @param {Number} value
   */

  set length(value) {
    this.code.length = value;
  }

  /**
   * Inject properties from options object.
   * @private
   * @param {Object} options
   */

  fromOptions(options) {
    assert(options, 'Script data is required.');

    if (Buffer.isBuffer(options))
      return this.fromRaw(options);

    if (Array.isArray(options))
      return this.fromArray(options);

    if (options.raw) {
      if (!options.code)
        return this.fromRaw(options.raw);
      assert(Buffer.isBuffer(options.raw), 'Raw must be a Buffer.');
      this.raw = options.raw;
    }

    if (options.code) {
      if (!options.raw)
        return this.fromArray(options.code);
      assert(Array.isArray(options.code), 'Code must be an array.');
      this.code = options.code;
    }

    return this;
  }

  /**
   * Insantiate script from options object.
   * @param {Object} options
   * @returns {Script}
   */

  static fromOptions(options) {
    return new this().fromOptions(options);
  }

  /**
   * Instantiate a value-only iterator.
   * @returns {ScriptIterator}
   */

  values() {
    return this.code.values();
  }

  /**
   * Instantiate a key and value iterator.
   * @returns {ScriptIterator}
   */

  entries() {
    return this.code.entries();
  }

  /**
   * Instantiate a value-only iterator.
   * @returns {ScriptIterator}
   */

  [Symbol.iterator]() {
    return this.code[Symbol.iterator]();
  }

  /**
   * Convert the script to an array of
   * Buffers (pushdatas) and Numbers
   * (opcodes).
   * @returns {Array}
   */

  toArray() {
    return this.code.slice();
  }

  /**
   * Inject properties from an array of
   * of buffers and numbers.
   * @private
   * @param {Array} code
   * @returns {Script}
   */

  fromArray(code) {
    assert(Array.isArray(code));

    this.clear();

    for (const op of code)
      this.push(op);

    return this.compile();
  }

  /**
   * Instantiate script from an array
   * of buffers and numbers.
   * @param {Array} code
   * @returns {Script}
   */

  static fromArray(code) {
    return new this().fromArray(code);
  }

  /**
   * Convert script to stack items.
   * @returns {Buffer[]}
   */

  toItems() {
    const items = [];

    for (const op of this.code) {
      const data = op.toPush();

      if (!data)
        throw new Error('Non-push opcode in script.');

      items.push(data);
    }

    return items;
  }

  /**
   * Inject data from stack items.
   * @private
   * @param {Buffer[]} items
   * @returns {Script}
   */

  fromItems(items) {
    assert(Array.isArray(items));

    this.clear();

    for (const item of items)
      this.pushData(item);

    return this.compile();
  }

  /**
   * Instantiate script from stack items.
   * @param {Buffer[]} items
   * @returns {Script}
   */

  static fromItems(items) {
    return new this().fromItems(items);
  }

  /**
   * Convert script to stack.
   * @returns {Stack}
   */

  toStack() {
    return new Stack(this.toItems());
  }

  /**
   * Inject data from stack.
   * @private
   * @param {Stack} stack
   * @returns {Script}
   */

  fromStack(stack) {
    return this.fromItems(stack.items);
  }

  /**
   * Instantiate script from stack.
   * @param {Stack} stack
   * @returns {Script}
   */

  static fromStack(stack) {
    return new this().fromStack(stack);
  }

  /**
   * Clone the script.
   * @returns {Script} Cloned script.
   */

  clone() {
    return new this.constructor().inject(this);
  }

  /**
   * Inject properties from script.
   * Used for cloning.
   * @private
   * @param {Script} script
   * @returns {Script}
   */

  inject(script) {
    this.raw = script.raw;
    this.code = script.code.slice();
    return this;
  }

  /**
   * Test equality against script.
   * @param {Script} script
   * @returns {Boolean}
   */

  equals(script) {
    assert(Script.isScript(script));
    return this.raw.equals(script.raw);
  }

  /**
   * Compare against another script.
   * @param {Script} script
   * @returns {Number}
   */

  compare(script) {
    assert(Script.isScript(script));
    return this.raw.compare(script.raw);
  }

  /**
   * Clear the script.
   * @returns {Script}
   */

  clear() {
    this.raw = EMPTY_BUFFER;
    this.code.length = 0;
    return this;
  }

  /**
   * Inspect the script.
   * @returns {String} Human-readable script code.
   */

  inspect() {
    return `<Script: ${this.toString()}>`;
  }

  /**
   * Convert the script to a bitcoind test string.
   * @returns {String} Human-readable script code.
   */

  toString() {
    const out = [];

    for (const op of this.code)
      out.push(op.toFormat());

    return out.join(' ');
  }

  /**
   * Format the script as bitcoind asm.
   * @param {Boolean?} decode - Attempt to decode hash types.
   * @returns {String} Human-readable script.
   */

  toASM(decode) {
    if (this.isNulldata())
      decode = false;

    const out = [];

    for (const op of this.code)
      out.push(op.toASM(decode));

    return out.join(' ');
  }

  /**
   * Re-encode the script internally. Useful if you
   * changed something manually in the `code` array.
   * @returns {Script}
   */

  compile() {
    if (this.code.length === 0)
      return this.clear();

    let size = 0;

    for (const op of this.code)
      size += op.getSize();

    const bw = bio.write(size);

    for (const op of this.code)
      op.toWriter(bw);

    this.raw = bw.render();

    return this;
  }

  /**
   * Write the script to a buffer writer.
   * @param {BufferWriter} bw
   */

  toWriter(bw) {
    bw.writeVarBytes(this.raw);
    return bw;
  }

  /**
   * Encode the script to a Buffer. See {@link Script#encode}.
   * @param {String} enc - Encoding, either `'hex'` or `null`.
   * @returns {Buffer|String} Serialized script.
   */

  toRaw() {
    return this.raw;
  }

  /**
   * Convert script to a hex string.
   * @returns {String}
   */

  toJSON() {
    return this.toRaw().toString('hex');
  }

  /**
   * Inject properties from json object.
   * @private
   * @param {String} json
   */

  fromJSON(json) {
    assert(typeof json === 'string', 'Code must be a string.');
    return this.fromRaw(Buffer.from(json, 'hex'));
  }

  /**
   * Instantiate script from a hex string.
   * @params {String} json
   * @returns {Script}
   */

  static fromJSON(json) {
    return new this().fromJSON(json);
  }

  /**
   * Get the script's "subscript" starting at a separator.
   * @param {Number} index - The last separator to sign/verify beyond.
   * @returns {Script} Subscript.
   */

  getSubscript(index) {
    if (index === 0)
      return this.clone();

    const script = new Script();

    for (let i = index; i < this.code.length; i++) {
      const op = this.code[i];

      if (op.value === -1)
        break;

      script.code.push(op);
    }

    return script.compile();
  }

  /**
   * Get the script's "subscript" starting at a separator.
   * Remove all OP_CODESEPARATORs if present. This bizarre
   * behavior is necessary for signing and verification when
   * code separators are present.
   * @returns {Script} Subscript.
   */

  removeSeparators() {
    let found = false;

    // Optimizing for the common case:
    // Check for any separators first.
    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.value === opcodes.OP_CODESEPARATOR) {
        found = true;
        break;
      }
    }

    if (!found)
      return this;

    // Uncommon case: someone actually
    // has a code separator. Go through
    // and remove them all.
    const script = new Script();

    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.value !== opcodes.OP_CODESEPARATOR)
        script.code.push(op);
    }

    return script.compile();
  }

  /**
   * Get the value of the checkBits while calculated as little endian.
   * @param {Buffer} abkam - Stack depth of the dummy element.
   * @param {Number?} nKeysCount - Stack depth of the top pubkeys.
   * @returns {Number}
   */

  bitcalculator(abkam, nKeysCount) {
    let checkBits = 0;

    const bitfield_size = ((nKeysCount + 7) / 8);

    for (let i = 0; i < bitfield_size; i++) {
      checkBits |= abkam[i] << (8 * i);
    }

    return checkBits;
  }

  /**
   * Execute and interpret the script.
   * @param {Stack} stack - Script execution stack.
   * @param {Number?} flags - Script standard flags.
   * @param {TX?} tx - Transaction being verified.
   * @param {Number?} index - Index of input being verified.
   * @param {Amount?} value - Previous output value.
   * @param {Number?} sigchecks
   * @throws {ScriptError} Will be thrown on VERIFY failures.
   */

  execute(stack, flags, tx, index, value, sigchecks) {
    if (flags == null)
      flags = Script.flags.STANDARD_VERIFY_FLAGS;

    if (this.getSize() > consensus.MAX_SCRIPT_SIZE)
      throw new ScriptError('SCRIPT_SIZE');

    const state = [];
    const alt = [];

    let lastSep = 0;
    let opCount = 0;
    let negate = 0;
    let nSigsRemaining = 0;
    let nKeysRemaining = 0;
    let checkBits;
    let minimal = false;
    let intBytes = 4;

    if (flags & Script.flags.VERIFY_MINIMALDATA)
      minimal = true;

    if (flags & Script.flags.VERIFY_63BITINT)
      intBytes = 8;

    for (let ip = 0; ip < this.code.length; ip++) {
      const op = this.code[ip];

      if (op.value === -1)
        throw new ScriptError('BAD_OPCODE', op, ip);

      if (op.data && op.data.length > consensus.MAX_SCRIPT_PUSH)
        throw new ScriptError('PUSH_SIZE', op, ip);

      if (op.value > opcodes.OP_16 && ++opCount > consensus.MAX_SCRIPT_OPS)
        throw new ScriptError('OP_COUNT', op, ip);

      if (op.isDisabled(flags))
        throw new ScriptError('DISABLED_OPCODE', op, ip);

      if (negate && !op.isBranch()) {
        if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
          throw new ScriptError('STACK_SIZE', op, ip);
        continue;
      }

      if (op.data && 0 <= op.value <= opcodes.OP_PUSHDATA4) {
        if (minimal && !op.isMinimal())
          throw new ScriptError('MINIMALDATA', op, ip);

        stack.push(op.data);

        if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
          throw new ScriptError('STACK_SIZE', op, ip);

        continue;
      }

      switch (op.value) {
        case opcodes.OP_0: {
          stack.pushInt(0);
          break;
        }
        case opcodes.OP_1NEGATE: {
          stack.pushInt(-1);
          break;
        }
        case opcodes.OP_1:
        case opcodes.OP_2:
        case opcodes.OP_3:
        case opcodes.OP_4:
        case opcodes.OP_5:
        case opcodes.OP_6:
        case opcodes.OP_7:
        case opcodes.OP_8:
        case opcodes.OP_9:
        case opcodes.OP_10:
        case opcodes.OP_11:
        case opcodes.OP_12:
        case opcodes.OP_13:
        case opcodes.OP_14:
        case opcodes.OP_15:
        case opcodes.OP_16: {
          stack.pushInt(op.value - 0x50);
          break;
        }
        case opcodes.OP_NOP: {
          break;
        }
        case opcodes.OP_CHECKLOCKTIMEVERIFY: {
          // OP_CHECKLOCKTIMEVERIFY = OP_NOP2
          if (!(flags & Script.flags.VERIFY_CHECKLOCKTIMEVERIFY)) {
            if (flags & Script.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
              throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
            break;
          }

          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getNum(-1, minimal, 5);

          if (num.isNeg())
            throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

          const locktime = num.toDouble();

          if (!tx.verifyLocktime(index, locktime))
            throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

          break;
        }
        case opcodes.OP_CHECKSEQUENCEVERIFY: {
          // OP_CHECKSEQUENCEVERIFY = OP_NOP3
          if (!(flags & Script.flags.VERIFY_CHECKSEQUENCEVERIFY)) {
            if (flags & Script.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
              throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
            break;
          }

          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getNum(-1, minimal, 5);

          if (num.isNeg())
            throw new ScriptError('NEGATIVE_LOCKTIME', op, ip);

          const locktime = num.toDouble();

          if (!tx.verifySequence(index, locktime))
            throw new ScriptError('UNSATISFIED_LOCKTIME', op, ip);

          break;
        }
        case opcodes.OP_NOP1:
        case opcodes.OP_NOP4:
        case opcodes.OP_NOP5:
        case opcodes.OP_NOP6:
        case opcodes.OP_NOP7:
        case opcodes.OP_NOP8:
        case opcodes.OP_NOP9:
        case opcodes.OP_NOP10: {
          if (flags & Script.flags.VERIFY_DISCOURAGE_UPGRADABLE_NOPS)
            throw new ScriptError('DISCOURAGE_UPGRADABLE_NOPS', op, ip);
          break;
        }
        case opcodes.OP_IF:
        case opcodes.OP_NOTIF: {
          let val = false;

          if (!negate) {
            if (stack.length < 1)
              throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

            if (flags & Script.flags.VERIFY_MINIMALIF) {
              const item = stack.get(-1);

              if (item.length > 1)
                throw new ScriptError('MINIMALIF');

              if (item.length === 1 && item[0] !== 1)
                throw new ScriptError('MINIMALIF');
            }

            val = stack.getBool(-1);

            if (op.value === opcodes.OP_NOTIF)
              val = !val;

            stack.pop();
          }

          state.push(val);

          if (!val)
            negate += 1;

          break;
        }
        case opcodes.OP_ELSE: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          state[state.length - 1] = !state[state.length - 1];

          if (!state[state.length - 1])
            negate += 1;
          else
            negate -= 1;

          break;
        }
        case opcodes.OP_ENDIF: {
          if (state.length === 0)
            throw new ScriptError('UNBALANCED_CONDITIONAL', op, ip);

          if (!state.pop())
            negate -= 1;

          break;
        }
        case opcodes.OP_VERIFY: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          if (!stack.getBool(-1))
            throw new ScriptError('VERIFY', op, ip);

          stack.pop();

          break;
        }
        case opcodes.OP_RETURN: {
          throw new ScriptError('OP_RETURN', op, ip);
        }
        case opcodes.OP_TOALTSTACK: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          alt.push(stack.pop());
          break;
        }
        case opcodes.OP_FROMALTSTACK: {
          if (alt.length === 0)
            throw new ScriptError('INVALID_ALTSTACK_OPERATION', op, ip);

          stack.push(alt.pop());
          break;
        }
        case opcodes.OP_2DROP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pop();
          stack.pop();
          break;
        }
        case opcodes.OP_2DUP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);

          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_3DUP: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-3);
          const v2 = stack.get(-2);
          const v3 = stack.get(-1);

          stack.push(v1);
          stack.push(v2);
          stack.push(v3);
          break;
        }
        case opcodes.OP_2OVER: {
          if (stack.length < 4)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-4);
          const v2 = stack.get(-3);

          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_2ROT: {
          if (stack.length < 6)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-6);
          const v2 = stack.get(-5);

          stack.erase(-6, -4);
          stack.push(v1);
          stack.push(v2);
          break;
        }
        case opcodes.OP_2SWAP: {
          if (stack.length < 4)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-4, -2);
          stack.swap(-3, -1);
          break;
        }
        case opcodes.OP_IFDUP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          if (stack.getBool(-1)) {
            const val = stack.get(-1);
            stack.push(val);
          }

          break;
        }
        case opcodes.OP_DEPTH: {
          stack.pushInt(stack.length);
          break;
        }
        case opcodes.OP_DROP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pop();
          break;
        }
        case opcodes.OP_DUP: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(stack.get(-1));
          break;
        }
        case opcodes.OP_NIP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.remove(-2);
          break;
        }
        case opcodes.OP_OVER: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(stack.get(-2));
          break;
        }
        case opcodes.OP_PICK:
        case opcodes.OP_ROLL: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const num = stack.getInt(-1, minimal, intBytes);
          stack.pop();

          if (num < 0 || num >= stack.length)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const val = stack.get(-num - 1);

          if (op.value === opcodes.OP_ROLL)
            stack.remove(-num - 1);

          stack.push(val);
          break;
        }
        case opcodes.OP_ROT: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-3, -2);
          stack.swap(-2, -1);
          break;
        }
        case opcodes.OP_SWAP: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.swap(-2, -1);
          break;
        }
        case opcodes.OP_TUCK: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.insert(-2, stack.get(-1));
          break;
        }
        case opcodes.OP_SIZE: {
          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pushInt(stack.get(-1).length);
          break;
        }
        case opcodes.OP_EQUAL:
        case opcodes.OP_EQUALVERIFY: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);

          const res = v1.equals(v2);

          stack.pop();
          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_EQUALVERIFY) {
            if (!res)
              throw new ScriptError('EQUALVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_1ADD:
        case opcodes.OP_1SUB:
        case opcodes.OP_NEGATE:
        case opcodes.OP_ABS:
        case opcodes.OP_NOT:
        case opcodes.OP_0NOTEQUAL: {
          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let num = stack.getNum(-1, minimal, intBytes);
          let cmp;

          switch (op.value) {
            case opcodes.OP_1ADD:
              num.iaddn(1);
              break;
            case opcodes.OP_1SUB:
              num.isubn(1);
              break;
            case opcodes.OP_NEGATE:
              num.ineg();
              break;
            case opcodes.OP_ABS:
              num.iabs();
              break;
            case opcodes.OP_NOT:
              cmp = num.isZero();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_0NOTEQUAL:
              cmp = !num.isZero();
              num = ScriptNum.fromBool(cmp);
              break;
            default:
              assert(false, 'Fatal script error.');
              break;
          }

          stack.pop();
          stack.pushNum(num);

          break;
        }
        case opcodes.OP_ADD:
        case opcodes.OP_SUB:
        case opcodes.OP_DIV:
        case opcodes.OP_MOD:
        case opcodes.OP_BOOLAND:
        case opcodes.OP_BOOLOR:
        case opcodes.OP_NUMEQUAL:
        case opcodes.OP_NUMEQUALVERIFY:
        case opcodes.OP_NUMNOTEQUAL:
        case opcodes.OP_LESSTHAN:
        case opcodes.OP_GREATERTHAN:
        case opcodes.OP_LESSTHANOREQUAL:
        case opcodes.OP_GREATERTHANOREQUAL:
        case opcodes.OP_MIN:
        case opcodes.OP_MAX: {
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const n1 = stack.getNum(-2, minimal, intBytes);
          const n2 = stack.getNum(-1, minimal, intBytes);
          let num, cmp;

          switch (op.value) {
            case opcodes.OP_ADD:
              num = n1.iadd(n2);
              break;
            case opcodes.OP_SUB:
              num = n1.isub(n2);
              break;
            case opcodes.OP_DIV:
              if (n2.isZero())
                throw new ScriptError('DIV_BY_ZERO', op, ip);
              num = n1.div(n2);
              break;
            case opcodes.OP_MOD:
              if (n2.isZero())
                throw new ScriptError('MOD_BY_ZERO', op, ip);
              num = n1.mod(n2);
              break;
            case opcodes.OP_BOOLAND:
              cmp = n1.toBool() && n2.toBool();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_BOOLOR:
              cmp = n1.toBool() || n2.toBool();
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMEQUAL:
              cmp = n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMEQUALVERIFY:
              cmp = n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_NUMNOTEQUAL:
              cmp = !n1.eq(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_LESSTHAN:
              cmp = n1.lt(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_GREATERTHAN:
              cmp = n1.gt(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_LESSTHANOREQUAL:
              cmp = n1.lte(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_GREATERTHANOREQUAL:
              cmp = n1.gte(n2);
              num = ScriptNum.fromBool(cmp);
              break;
            case opcodes.OP_MIN:
              num = ScriptNum.min(n1, n2);
              break;
            case opcodes.OP_MAX:
              num = ScriptNum.max(n1, n2);
              break;
            default:
              assert(false, 'Fatal script error.');
              break;
          }

          stack.pop();
          stack.pop();
          stack.pushNum(num);

          if (op.value === opcodes.OP_NUMEQUALVERIFY) {
            if (!stack.getBool(-1))
              throw new ScriptError('NUMEQUALVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_WITHIN: {
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const n1 = stack.getNum(-3, minimal, intBytes);
          const n2 = stack.getNum(-2, minimal, intBytes);
          const n3 = stack.getNum(-1, minimal, intBytes);

          const val = n2.lte(n1) && n1.lt(n3);

          stack.pop();
          stack.pop();
          stack.pop();

          stack.pushBool(val);
          break;
        }
        case opcodes.OP_RIPEMD160: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(ripemd160.digest(stack.pop()));
          break;
        }
        case opcodes.OP_SHA1: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(sha1.digest(stack.pop()));
          break;
        }
        case opcodes.OP_SHA256: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(sha256.digest(stack.pop()));
          break;
        }
        case opcodes.OP_HASH160: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(hash160.digest(stack.pop()));
          break;
        }
        case opcodes.OP_HASH256: {
          if (stack.length === 0)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.push(hash256.digest(stack.pop()));
          break;
        }
        case opcodes.OP_CODESEPARATOR: {
          lastSep = ip + 1;
          break;
        }
        case opcodes.OP_CHECKSIG:
        case opcodes.OP_CHECKSIGVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const sig = stack.get(-2);
          const key = stack.get(-1);

          const subscript = this.getSubscript(lastSep);

          if (!(flags & Script.flags.VERIFY_SIGHASH_FORKID)
            || !(sig[sig.length - 1] & Script.hashType.SIGHASH_FORKID))
            subscript.findAndDelete(sig);

          checkTransactionSignature(sig, flags);
          validateKey(key, flags);

          let res = false;

          if (sig.length > 0) {
            const type = sig[sig.length - 1];
            const hash = tx.signatureHash(
              index,
              subscript,
              value,
              type,
              flags
            );
            res = verifySignature(hash, sig.slice(0, -1), key, flags);
            metrics.sigchecks += 1;
            sigchecks = metrics.sigchecks;
          }

          if (!res && (flags & Script.flags.VERIFY_NULLFAIL)) {
            if (sig.length !== 0)
              throw new ScriptError('NULLFAIL', op, ip);
          }

          stack.pop();
          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_CHECKSIGVERIFY) {
            if (!res)
              throw new ScriptError('CHECKSIGVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_CHECKDATASIG:
        case opcodes.OP_CHECKDATASIGVERIFY: {
          // (sig message pubkey -- bool)
          if (stack.length < 3)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const sig = stack.get(-3);
          const msg = stack.get(-2);
          const key = stack.get(-1);

          validateDataSignature(sig, flags);
          validateKey(key, flags);

          let res = false;

          if (sig.length > 0) {
            const hash = sha256.digest(msg);
            res = verifySignature(hash, sig, key, flags);
            metrics.sigchecks += 1;
	    sigchecks = metrics.sigchecks;
          }

          if (!res && (flags & Script.flags.VERIFY_NULLFAIL)) {
            if (sig.length !== 0)
              throw new ScriptError('NULLFAIL', op, ip);
          }

          stack.pop();
          stack.pop();
          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_CHECKDATASIGVERIFY) {
            if (!res)
              throw new ScriptError('CHECKDATASIGVERIFY', op, ip);
            stack.pop();
          }

          break;
        }
        case opcodes.OP_CHECKMULTISIG:
        case opcodes.OP_CHECKMULTISIGVERIFY: {
          if (!tx)
            throw new ScriptError('UNKNOWN_ERROR', 'No TX passed in.');

          let keyCount = 1;
          let sigCount = 0;
          let keyTop, sigTop;

          if (stack.length < keyCount)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let nKeysCount = stack.getInt(-keyCount, minimal, intBytes);
          let okey = nKeysCount + 2;
          let ikey, isig;

          if (nKeysCount < 0 || nKeysCount > consensus.MAX_MULTISIG_PUBKEYS)
            throw new ScriptError('PUBKEY_COUNT', op, ip);

          opCount += nKeysCount;

          if (opCount > consensus.MAX_SCRIPT_OPS)
            throw new ScriptError('OP_COUNT', op, ip);

          keyCount += 1;
          keyTop = keyCount;

          // stack depth of nSigsCount
          sigCount = keyTop + nKeysCount;

          ikey = keyCount;
          keyCount += nKeysCount;

          if (stack.length < sigCount)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          let nSigsCount = stack.getInt(-sigCount, minimal, intBytes);

          if (nSigsCount < 0 || nSigsCount > nKeysCount)
            throw new ScriptError('SIG_COUNT', op, ip);

          // stack depth of the top signature
          sigTop = sigCount + 1;

          // stack depth of the dummy element
          const dummy = sigTop + nSigsCount;

          if (stack.length < dummy)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          keyCount += 1;
          isig = keyCount;
          keyCount += nSigsCount;

          const subscript = this.getSubscript(lastSep);
          let res = true;

          if ((flags & Script.flags.VERIFY_SCHNORR_MULTISIG)
             && stack.get(-dummy).length !== 0) {
              assert(consensus.MAX_MULTISIG_PUBKEYS < 32)

            if (nKeysCount > 32)
              throw new ScriptError('INVALID_BITFIELD_SIZE', op, ip);

            const bitfield_size = Math.floor((nKeysCount + 7) / 8);
            const abkam = stack.get(-dummy);

            if (abkam.length !== bitfield_size)
              throw new ScriptError('BITFIELD_SIZE', op, ip);

            checkBits = this.bitcalculator(abkam, nKeysCount);

            const mask = (1 << nKeysCount) - 1;
            const numBits = countBits(checkBits);

            if ((checkBits & mask) !== checkBits)
              throw new ScriptError('BIT_RANGE', op, ip);

            if (numBits !== nSigsCount)
              throw new ScriptError('INVALID_BIT_COUNT', op, ip);

            const bKey = keyTop + nKeysCount - 1;
            const bSig = sigTop + nSigsCount - 1;

            // Every signature the bitfield names must be valid: the
            // Schnorr path can only succeed, and a signature that fails,
            // empty or not, is a NULLFAIL error, as the bitfield should not
            // have named its key (Bitcoin ABC's interpreter).
            let ik3y = 0;

            for (let is1g = 0; is1g < nSigsCount; is1g++, ik3y++) {
              if ((checkBits >> ik3y) === 0)
                throw new ScriptError('INVALID_BIT_RANGE', op, ip);

              // Find the next key the bitfield names.
              while (((checkBits >> ik3y) & 0x01) === 0)
                ik3y++;

              if (ik3y >= nKeysCount)
                throw new ScriptError('PUBKEY_COUNT', op, ip);

              const sig = stack.get(-bSig + is1g);
              const key = stack.get(-bKey + ik3y);

              // Only keys paired with a signature are checked for validity.
              checkTransactionSchnorrSig(sig, flags);
              validateKey(key, flags);

              if (sig.length === 0)
                throw new ScriptError('NULLFAIL', op, ip);

              const type = sig[sig.length - 1];
              const hash = tx.signatureHash(
                index,
                subscript,
                value,
                type,
                flags
              );

              if (!verifySignature(hash, sig.slice(0, -1), key, flags))
                throw new ScriptError('NULLFAIL', op, ip);

              metrics.sigchecks += 1;
            }

            if ((checkBits >> ik3y) !== 0)
              throw new ScriptError('INVALID_BIT_COUNT', op, ip);

            // The arguments, down to and including the dummy.
            for (let i = 0; i < dummy; i++)
              stack.pop();

            stack.pushBool(true);

            if (op.value === opcodes.OP_CHECKMULTISIGVERIFY)
              stack.pop();
          } else {
            // Legacy Multisig (ECDSA / NULL)
            // A bug causes CHECKMULTISIG to consume one extra
            // argument whose contents were not checked in any way.

          for (let j = 0; j < nSigsCount; j++) {
            const sig = stack.get(-sigTop - j);
            if (!(flags & Script.flags.VERIFY_SIGHASH_FORKID)
              || !(sig[sig.length - 1] & Script.hashType.SIGHASH_FORKID))
              subscript.findAndDelete(sig, flags);
          }

          // SigChecks: every key, unless all the signatures are null. An
          // upper bound on the verifications, known without doing them
          // (Bitcoin ABC's interpreter).
          let allNull = true;
          for (let j = 0; j < nSigsCount; j++) {
            if (stack.get(-sigTop - j).length !== 0) {
              allNull = false;
              break;
            }
          }
          if (!allNull)
            metrics.sigchecks += nKeysCount;

          nSigsRemaining = nSigsCount;
          nKeysRemaining = nKeysCount;

          while (res && nSigsCount > 0) {
            const sig = stack.get(-isig);
            const key = stack.get(-ikey);

            checkTransactionECDSASignature(sig, flags);
            validateKey(key, flags);

            if (sig.length > 0) {
              const type = sig[sig.length - 1];
              const hash = tx.signatureHash(
                index,
                subscript,
                value,
                type,
                flags
              );

              if (checksig(hash, sig, key)) {
                isig += 1;
                nSigsCount -= 1;
              }
            }

            ikey += 1;
            nKeysCount -= 1;

            if (nSigsCount > nKeysCount)
              res = false;
          }

          while (keyCount > 1) {
            if (!res && (flags & Script.flags.VERIFY_NULLFAIL)) {
              if (okey === 0 && stack.get(-1).length !== 0)
                throw new ScriptError('NULLFAIL', op, ip);
            }

            if (okey > 0)
              okey -= 1;

            stack.pop();

            keyCount -= 1;
          }

          if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          stack.pop();

          stack.pushBool(res);

          if (op.value === opcodes.OP_CHECKMULTISIGVERIFY) {
            if (!res)
              throw new ScriptError('CHECKMULTISIGVERIFY', op, ip);
            stack.pop();
           }
          }

          break;
        }

        //
        // Byte string operations
        //
        case opcodes.OP_CAT: {
          // (x1 x2 -- out)
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);
          if (v1.length + v2.length > consensus.MAX_SCRIPT_PUSH) {
            throw new ScriptError('PUSH_SIZE', op, ip);
          }
          stack.pop();
          stack.pop();

          stack.push(Buffer.concat([v1, v2]));

          break;
        }

        case opcodes.OP_SPLIT: {
          // (in position -- x1 x2)
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const data = stack.get(-2);

          // Make sure the split point is appropriate.
          const pos = stack.getInt(-1, minimal, intBytes);
          if (pos < 0 || pos > data.length)
            throw new ScriptError('INVALID_SPLIT_RANGE', op, ip);

          // Prepare the results in their own buffer as `data`
          // will be invalidated.
          const n1 = data.slice(0, pos);
          const n2 = data.slice(pos);

          // Replace existing stack values by the new values.
          stack.set(-2, n1);
          stack.set(-1, n2);
          break;
        }
        case opcodes.OP_REVERSEBYTES: {
         if (stack.length < 1)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          // Stack items are shared by reference (OP_DUP, OP_PICK, pushdata
          // from the script itself), so reverse a copy rather than in place.
          const data = stack.get(-1);

          stack.set(-1, Buffer.from(data).reverse());

          break;
        }

        //
        // Bitwise logic
        //
        case opcodes.OP_AND:
        case opcodes.OP_OR:
        case opcodes.OP_XOR: {
          // (x1 x2 - out)
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const v1 = stack.get(-2);
          const v2 = stack.get(-1);

          // Inputs must be the same size
          if (v1.length !== v2.length)
            throw new ScriptError('INVALID_OPERAND_SIZE', op, ip);

          const raw = Buffer.alloc(v1.length);

          switch (op.value) {
            case opcodes.OP_AND:
              for (let i = 0; i < v1.length; i++) {
                raw[i] = v1[i] & v2[i];
              }
              break;
            case opcodes.OP_OR:
              for (let i = 0; i < v1.length; i++) {
                raw[i] = v1[i] | v2[i];
              }
              break;
            case opcodes.OP_XOR:
              for (let i = 0; i < v1.length; i++) {
                raw[i] = v1[i] ^ v2[i];
              }
              break;
            default:
              break;
          }

          // And pop v1 and v2.
          stack.pop();
          stack.pop();

          stack.push(raw);

          break;
        }

        //
        // Conversion operations
        //
        case opcodes.OP_NUM2BIN: {
          // (in size -- out)
          if (stack.length < 2)
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);

          const size = stack.getInt(-1, minimal, intBytes);
          if (size < 0 || size > consensus.MAX_SCRIPT_PUSH)
            throw new ScriptError('PUSH_SIZE', op, ip);

          stack.pop();

          const n = stack.get(-1);
          const v = ScriptNum.toMinimal(Buffer.from(n));

          // Try to see if we can fit that number in the number of
          // byte requested.
          if (v.length > size)
            // We definitively cannot.
            throw new ScriptError('IMPOSSIBLE_ENCODING', op, ip);

          // We already have an element of the right size, we don't need to do
          // anything.
          if (v.length === size) {
            stack.pop();
            stack.push(v);
            break;
          }

          const raw = Buffer.alloc(size);
          v.copy(raw);

          let signbit = 0x00;
          if (v.length > 0) {
            signbit = v[v.length - 1] & 0x80;
            raw[v.length - 1] &= 0x7f;
          }

          raw[size-1] = signbit;

          stack.pop();
          stack.push(raw);

          break;
        }

        case opcodes.OP_BIN2NUM: {
          // (in -- out)
          if (stack.length < 1) {
            throw new ScriptError('INVALID_STACK_OPERATION', op, ip);
          }

          const n = stack.get(-1);
          const v = ScriptNum.toMinimal(Buffer.from(n));

          stack.pop();
          stack.push(v);

          // The resulting number must be a valid number.
          if (!ScriptNum.isMinimal(v) || v.length > intBytes)
            throw new ScriptError('INVALID_NUMBER_RANGE', op, ip);

          break;
        }

        default: {
          throw new ScriptError('BAD_OPCODE', op, ip);
        }
      }
    }

    if (stack.length + alt.length > consensus.MAX_SCRIPT_STACK)
      throw new ScriptError('STACK_SIZE');

    if (state.length !== 0)
      throw new ScriptError('UNBALANCED_CONDITIONAL');
  }

  /**
   * Remove all matched data elements from
   * a script's code (used to remove signatures
   * before verification). Note that this
   * compares and removes data on the _byte level_.
   * It also reserializes the data to a single
   * script with minimaldata encoding beforehand.
   * A signature will _not_ be removed if it is
   * not minimaldata.
   * @see https://lists.linuxfoundation.org/pipermail/bitcoin-dev/2014-November/006878.html
   * @see https://test.webbtc.com/tx/19aa42fee0fa57c45d3b16488198b27caaacc4ff5794510d0c17f173f05587ff
   * @param {Buffer} data - Data element to match against.
   * @returns {Number} Total.
   */

  findAndDelete(data) {
    const target = Opcode.fromPush(data);

    if (this.raw.length < target.getSize())
      return 0;

    let found = false;

    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.equals(target)) {
        found = true;
        break;
      }
    }

    if (!found)
      return 0;

    const code = [];

    let total = 0;

    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (op.equals(target)) {
        total += 1;
        continue;
      }

      code.push(op);
    }

    this.code = code;
    this.compile();

    return total;
  }

  /**
   * Find a data element in a script.
   * @param {Buffer} data - Data element to match against.
   * @returns {Number} Index (`-1` if not present).
   */

  indexOf(data) {
    for (let i = 0; i < this.code.length; i++) {
      const op = this.code[i];

      if (op.value === -1)
        break;

      if (!op.data)
        continue;

      if (op.data.equals(data))
        return i;
    }

    return -1;
  }

  /**
   * Test a script to see if it is likely
   * to be script code (no weird opcodes).
   * @param {Number?} flags - Script standard flags.
   * @returns {Boolean}
   */

  isCode(flags) {
    if (flags == null)
      flags = Script.flags.STANDARD_VERIFY_FLAGS;

    for (const op of this.code) {
      if (op.value === -1)
        return false;

      if (op.isDisabled(flags))
        return false;

      switch (op.value) {
        case opcodes.OP_RESERVED:
        case opcodes.OP_NOP:
        case opcodes.OP_VER:
        case opcodes.OP_VERIF:
        case opcodes.OP_VERNOTIF:
        case opcodes.OP_RESERVED1:
        case opcodes.OP_RESERVED2:
        case opcodes.OP_NOP1:
          return false;
      }

      if (op.value > opcodes.OP_CHECKSEQUENCEVERIFY)
        return false;
    }

    return true;
  }

  /**
   * Inject properties from a pay-to-pubkey script.
   * @private
   * @param {Buffer} key
   */

  fromPubkey(key) {
    assert(Buffer.isBuffer(key) && (key.length === 33 || key.length === 65));

    this.raw = Buffer.allocUnsafe(1 + key.length + 1);
    this.raw[0] = key.length;
    key.copy(this.raw, 1);
    this.raw[1 + key.length] = opcodes.OP_CHECKSIG;

    key = this.raw.slice(1, 1 + key.length);

    this.code.length = 0;
    this.code.push(Opcode.fromPush(key));
    this.code.push(Opcode.fromOp(opcodes.OP_CHECKSIG));

    return this;
  }

  /**
   * Create a pay-to-pubkey script.
   * @param {Buffer} key
   * @returns {Script}
   */

  static fromPubkey(key) {
    return new this().fromPubkey(key);
  }

  /**
   * Inject properties from a pay-to-pubkeyhash script.
   * @private
   * @param {Buffer} hash
   */

  fromPubkeyhash(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 20);

    this.raw = Buffer.allocUnsafe(25);
    this.raw[0] = opcodes.OP_DUP;
    this.raw[1] = opcodes.OP_HASH160;
    this.raw[2] = 0x14;
    hash.copy(this.raw, 3);
    this.raw[23] = opcodes.OP_EQUALVERIFY;
    this.raw[24] = opcodes.OP_CHECKSIG;

    hash = this.raw.slice(3, 23);

    this.code.length = 0;
    this.code.push(Opcode.fromOp(opcodes.OP_DUP));
    this.code.push(Opcode.fromOp(opcodes.OP_HASH160));
    this.code.push(Opcode.fromPush(hash));
    this.code.push(Opcode.fromOp(opcodes.OP_EQUALVERIFY));
    this.code.push(Opcode.fromOp(opcodes.OP_CHECKSIG));

    return this;
  }

  /**
   * Create a pay-to-pubkeyhash script.
   * @param {Buffer} hash
   * @returns {Script}
   */

  static fromPubkeyhash(hash) {
    return new this().fromPubkeyhash(hash);
  }

  /**
   * Inject properties from pay-to-multisig script.
   * @private
   * @param {Number} m
   * @param {Number} n
   * @param {Buffer[]} keys
   */

  fromMultisig(m, n, keys) {
    assert((m & 0xff) === m && (n & 0xff) === n);
    assert(Array.isArray(keys));
    assert(keys.length === n, '`n` keys are required for multisig.');
    assert(m >= 1 && m <= n);
    assert(n >= 1 && n <= 15);

    this.clear();

    this.pushSmall(m);

    for (const key of sortKeys(keys))
      this.pushData(key);

    this.pushSmall(n);
    this.pushOp(opcodes.OP_CHECKMULTISIG);

    return this.compile();
  }

  /**
   * Create a pay-to-multisig script.
   * @param {Number} m
   * @param {Number} n
   * @param {Buffer[]} keys
   * @returns {Script}
   */

  static fromMultisig(m, n, keys) {
    return new this().fromMultisig(m, n, keys);
  }

  /**
   * Inject properties from a pay-to-scripthash script.
   * @private
   * @param {Buffer} hash
   */

  fromScripthash(hash) {
    assert(Buffer.isBuffer(hash) && hash.length === 20);

    this.raw = Buffer.allocUnsafe(23);
    this.raw[0] = opcodes.OP_HASH160;
    this.raw[1] = 0x14;
    hash.copy(this.raw, 2);
    this.raw[22] = opcodes.OP_EQUAL;

    hash = this.raw.slice(2, 22);

    this.code.length = 0;
    this.code.push(Opcode.fromOp(opcodes.OP_HASH160));
    this.code.push(Opcode.fromPush(hash));
    this.code.push(Opcode.fromOp(opcodes.OP_EQUAL));

    return this;
  }

  /**
   * Create a pay-to-scripthash script.
   * @param {Buffer} hash
   * @returns {Script}
   */

  static fromScripthash(hash) {
    return new this().fromScripthash(hash);
  }

  /**
   * Inject properties from a nulldata/opreturn script.
   * @private
   * @param {Buffer} flags
   */

  fromNulldata(flags) {
    assert(Buffer.isBuffer(flags));
    assert(flags.length <= policy.MAX_OP_RETURN, 'Nulldata too large.');

    this.clear();
    this.pushOp(opcodes.OP_RETURN);
    this.pushData(flags);

    return this.compile();
  }

  /**
   * Create a nulldata/opreturn script.
   * @param {Buffer} flags
   * @returns {Script}
   */

  static fromNulldata(flags) {
    return new this().fromNulldata(flags);
  }

  /**
   * Inject properties from an address.
   * @private
   * @param {Address|AddressString} address
   */

  fromAddress(address) {
    if (typeof address === 'string')
      address = Address.fromString(address);

    assert(address instanceof Address, 'Not an address.');

    if (address.isPubkeyhash())
      return this.fromPubkeyhash(address.hash);

    if (address.isScripthash())
      return this.fromScripthash(address.hash);

    throw new Error('Unknown address type.');
  }

  /**
   * Create an output script from an address.
   * @param {Address|AddressString} address
   * @returns {Script}
   */

  static fromAddress(address) {
    return new this().fromAddress(address);
  }

  /**
   * Grab and deserialize the redeem script.
   * @returns {Script|null} Redeem script.
   */

  getRedeem() {
    let data = null;

    for (const op of this.code) {
      if (op.value === -1)
        return null;

      if (op.value > opcodes.OP_16)
        return null;

      data = op.data;
    }

    if (!data)
      return null;

    return Script.fromRaw(data);
  }

  /**
   * Get the standard script type.
   * @returns {ScriptType}
   */

  getType() {
    if (this.isPubkey())
      return scriptTypes.PUBKEY;

    if (this.isPubkeyhash())
      return scriptTypes.PUBKEYHASH;

    if (this.isScripthash())
      return scriptTypes.SCRIPTHASH;

    if (this.isMultisig())
      return scriptTypes.MULTISIG;

    if (this.isNulldata())
      return scriptTypes.NULLDATA;

    return scriptTypes.NONSTANDARD;
  }

  /**
   * Test whether a script is of an unknown/non-standard type.
   * @returns {Boolean}
   */

  isUnknown() {
    return this.getType() === scriptTypes.NONSTANDARD;
  }

  /**
   * Test whether the script is standard by policy standards.
   * @returns {Boolean}
   */

  isStandard() {
    const [m, n] = this.getMultisig();

    if (m !== -1) {
      if (n < 1 || n > 3)
        return false;

      if (m < 1 || m > n)
        return false;

      return true;
    }

    if (this.isNulldata())
      return this.raw.length <= policy.MAX_OP_RETURN_BYTES;

    return this.getType() !== scriptTypes.NONSTANDARD;
  }

  /**
   * Calculate the size of the script
   * excluding the varint size bytes.
   * @returns {Number}
   */

  getSize() {
    return this.raw.length;
  }

  /**
   * Calculate the size of the script
   * including the varint size bytes.
   * @returns {Number}
   */

  getVarSize() {
    return encoding.sizeVarBytes(this.raw);
  }

  /**
   * "Guess" the address of the input script.
   * This method is not 100% reliable.
   * @returns {Address|null}
   */

  getInputAddress() {
    return Address.fromInputScript(this);
  }

  /**
   * Get the address of the script if present. Note that
   * pubkey and multisig scripts will be treated as though
   * they are pubkeyhash and scripthashes respectively.
   * @returns {Address|null}
   */

  getAddress() {
    return Address.fromScript(this);
  }

  /**
   * Get the hash160 of the raw script.
   * @param {String?} enc
   * @returns {Hash}
   */

  hash160(enc) {
    let hash = hash160.digest(this.toRaw());
    if (enc === 'hex')
      hash = hash.toString('hex');
    return hash;
  }

  /**
   * Get the sha256 of the raw script.
   * @param {String?} enc
   * @returns {Hash}
   */

  sha256(enc) {
    let hash = sha256.digest(this.toRaw());
    if (enc === 'hex')
      hash = hash.toString('hex');
    return hash;
  }

  /**
   * Test whether the output script is pay-to-pubkey.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isPubkey(minimal) {
    if (minimal) {
      return this.raw.length >= 35
        && (this.raw[0] === 33 || this.raw[0] === 65)
        && this.raw[0] + 2 === this.raw.length
        && this.raw[this.raw.length - 1] === opcodes.OP_CHECKSIG;
    }

    if (this.code.length !== 2)
      return false;

    const size = this.getLength(0);

    return (size === 33 || size === 65)
      && this.getOp(1) === opcodes.OP_CHECKSIG;
  }

  /**
   * Get P2PK key if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Buffer|null}
   */

  getPubkey(minimal) {
    if (!this.isPubkey(minimal))
      return null;

    if (minimal)
      return this.raw.slice(1, 1 + this.raw[0]);

    return this.getData(0);
  }

  /**
   * Test whether the output script is pay-to-pubkeyhash.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isPubkeyhash(minimal) {
    if (minimal || this.raw.length === 25) {
      return this.raw.length === 25
        && this.raw[0] === opcodes.OP_DUP
        && this.raw[1] === opcodes.OP_HASH160
        && this.raw[2] === 0x14
        && this.raw[23] === opcodes.OP_EQUALVERIFY
        && this.raw[24] === opcodes.OP_CHECKSIG;
    }

    if (this.code.length !== 5)
      return false;

    return this.getOp(0) === opcodes.OP_DUP
      && this.getOp(1) === opcodes.OP_HASH160
      && this.getLength(2) === 20
      && this.getOp(3) === opcodes.OP_EQUALVERIFY
      && this.getOp(4) === opcodes.OP_CHECKSIG;
  }

  /**
   * Get P2PKH hash if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Buffer|null}
   */

  getPubkeyhash(minimal) {
    if (!this.isPubkeyhash(minimal))
      return null;

    if (minimal)
      return this.raw.slice(3, 23);

    return this.getData(2);
  }

/**
   * Test whether the output script is pay-to-multisig.
   * @param {Boolean} [minimal=true] - Minimaldata only.
   * @returns {Boolean}
   */

  isMultisig(minimal) {
    if (this.code.length < 4 || this.code.length > 19)
      return false;

    if (this.getOp(-1) !== opcodes.OP_CHECKMULTISIG)
      return false;

    const m = this.getSmall(0);

    if (m < 1)
      return false;

    const n = this.getSmall(-2);


    if (n < 1 || m > n)
      return false;

    if (this.code.length !== n + 3)
      return false;

    for (let i = 1; i < n + 1; i++) {
      const op = this.code[i];
      const size = op.toLength();

      if (size !== 33 && size !== 65)
        return false;

      if (minimal && !op.isMinimal())
        return false;
    }

    return true;
  }

  /**
   * Get multisig m and n values if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Array} [m, n]
   */

  getMultisig(minimal) {
    if (!this.isMultisig(minimal))
      return [-1, -1];

    return [this.getSmall(0), this.getSmall(-2)];
  }

  /**
   * Test whether the output script is pay-to-scripthash. Note that
   * bitcoin itself requires scripthashes to be in strict minimaldata
   * encoding. Using `OP_HASH160 OP_PUSHDATA1 [hash] OP_EQUAL` will
   * _not_ be recognized as a scripthash.
   * @returns {Boolean}
   */

  isScripthash() {
    return this.raw.length === 23
      && this.raw[0] === opcodes.OP_HASH160
      && this.raw[1] === 0x14
      && this.raw[22] === opcodes.OP_EQUAL;
  }

  /**
   * Get P2SH hash if present.
   * @returns {Buffer|null}
   */

  getScripthash() {
    if (!this.isScripthash())
      return null;

    return this.getData(1);
  }

  /**
   * Test whether the output script is nulldata/opreturn.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Boolean}
   */

  isNulldata(minimal) {
    if (this.code.length === 0)
      return false;

    if (this.getOp(0) !== opcodes.OP_RETURN)
      return false;

    if (this.code.length === 1)
      return true;

    if (minimal) {
      if (this.raw.length > policy.MAX_OP_RETURN_BYTES)
        return false;
    }

    for (let i = 1; i < this.code.length; i++) {
      const op = this.code[i];

      if (op.value === -1)
        return false;

      if (op.value > opcodes.OP_16)
        return false;

      if (minimal && !op.isMinimal())
        return false;
    }

    return true;
  }

  /**
   * Get OP_RETURN data if present.
   * @param {Boolean} [minimal=false] - Minimaldata only.
   * @returns {Buffer|null}
   */

  getNulldata(minimal) {
    if (!this.isNulldata(minimal))
      return null;

    for (let i = 1; i < this.code.length; i++) {
      const op = this.code[i];
      const data = op.toPush();
      if (data)
        return data;
    }

    return EMPTY_BUFFER;
  }

  /**
   * Test whether the output script is a witness program.
   * Note that this will return true even for malformed
   * witness v0 programs.
   * @returns {Boolean}
   */

  isProgram() {
    if (this.raw.length < 4 || this.raw.length > 42)
      return false;

    if (this.raw[0] !== opcodes.OP_0
      && (this.raw[0] < opcodes.OP_1 || this.raw[0] > opcodes.OP_16)) {
      return false;
    }

    if (this.raw[1] + 2 !== this.raw.length)
      return false;

    return true;
  }

  /**
   * Test whether the output script is unspendable.
   * @returns {Boolean}
   */

  isUnspendable() {
    if (this.raw.length > consensus.MAX_SCRIPT_SIZE)
      return true;

    return this.raw.length > 0 && this.raw[0] === opcodes.OP_RETURN;
  }

  /**
   * "Guess" the type of the input script.
   * This method is not 100% reliable.
   * @returns {ScriptType}
   */

  getInputType() {
    if (this.isPubkeyInput())
      return scriptTypes.PUBKEY;

    if (this.isPubkeyhashInput())
      return scriptTypes.PUBKEYHASH;

    if (this.isScripthashInput())
      return scriptTypes.SCRIPTHASH;

    if (this.isMultisigInput())
      return scriptTypes.MULTISIG;

    return scriptTypes.NONSTANDARD;
  }

  /**
   * "Guess" whether the input script is an unknown/non-standard type.
   * This method is not 100% reliable.
   * @returns {Boolean}
   */

  isUnknownInput() {
    return this.getInputType() === scriptTypes.NONSTANDARD;
  }

  /**
   * "Guess" whether the input script is pay-to-pubkey.
   * This method is not 100% reliable.
   * @returns {Boolean}
   */

  isPubkeyInput() {
    if (this.code.length !== 1)
      return false;

    const size = this.getLength(0);

    return size >= 9 && size <= 73;
  }

  /**
   * Get P2PK signature if present.
   * @returns {Buffer|null}
   */

  getPubkeyInput() {
    if (!this.isPubkeyInput())
      return null;

    return this.getData(0);
  }

  /**
   * "Guess" whether the input script is pay-to-pubkeyhash.
   * This method is not 100% reliable.
   * @returns {Boolean}
   */

  isPubkeyhashInput() {
    if (this.code.length !== 2)
      return false;

    const sig = this.getLength(0);
    const key = this.getLength(1);

    return sig >= 9 && sig <= 73
      && (key === 33 || key === 65);
  }

  /**
   * Get P2PKH signature and key if present.
   * @returns {Array} [sig, key]
   */

  getPubkeyhashInput() {
    if (!this.isPubkeyhashInput())
      return [null, null];

    return [this.getData(0), this.getData(1)];
  }

  /**
   * "Guess" whether the input script is pay-to-multisig.
   * This method is not 100% reliable.
   * @returns {Boolean}
   */

  isMultisigInput() {
    if (this.code.length < 2)
      return false;

    if (this.getOp(0) !== opcodes.OP_0)
      return false;

    if (this.getOp(1) > opcodes.OP_PUSHDATA4)
      return false;

    // We need to rule out scripthash
    // because it may look like multisig.
    if (this.isScripthashInput())
      return false;

    for (let i = 1; i < this.code.length; i++) {
      const size = this.getLength(i);
      if (size < 9 || size > 73)
        return false;
    }

    return true;
  }

  /**
   * Get multisig signatures if present.
   * @returns {Buffer[]|null}
   */

  getMultisigInput() {
    if (!this.isMultisigInput())
      return null;

    const sigs = [];

    for (let i = 1; i < this.code.length; i++)
      sigs.push(this.getData(i));

    return sigs;
  }

  /**
   * "Guess" whether the input script is pay-to-scripthash.
   * This method is not 100% reliable.
   * @returns {Boolean}
   */

  isScripthashInput() {
    if (this.code.length < 1)
      return false;

    // Grab the raw redeem script.
    const raw = this.getData(-1);

    // Last data element should be an array
    // for the redeem script.
    if (!raw)
      return false;

    // Testing for scripthash inputs requires
    // some evil magic to work. We do it by
    // ruling things _out_. This test will not
    // be correct 100% of the time. We rule
    // out that the last data element is: a
    // null dummy, a valid signature, a valid
    // key, and we ensure that it is at least
    // a script that does not use undefined
    // opcodes.
    if (raw.length === 0)
      return false;

    if (common.isDERSignatureEncoding(raw.slice(0, -1)))
      return false;

    if (common.isKeyEncoding(raw))
      return false;

    const redeem = Script.fromRaw(raw);

    if (!redeem.isCode())
      return false;

    if (redeem.isUnspendable())
      return false;

    if (!this.isPushOnly())
      return false;

    return true;
  }

  /**
   * Get P2SH redeem script if present.
   * @returns {Buffer|null}
   */

  getScripthashInput() {
    if (!this.isScripthashInput())
      return null;

    return this.getData(-1);
  }

  /**
   * Get coinbase height.
   * @returns {Number} `-1` if not present.
   */

  getCoinbaseHeight() {
    return Script.getCoinbaseHeight(this.raw);
  }

  /**
   * Get coinbase height.
   * @param {Buffer} raw - Raw script.
   * @returns {Number} `-1` if not present.
   */

  static getCoinbaseHeight(raw) {
    if (raw.length === 0)
      return -1;

    if (raw[0] >= opcodes.OP_1 && raw[0] <= opcodes.OP_16)
      return raw[0] - 0x50;

    if (raw[0] > 0x06)
      return -1;

    const op = Opcode.fromRaw(raw);
    const num = op.toNum();

    if (!num)
      return 1;

    if (num.isNeg())
      return -1;

    if (!op.equals(Opcode.fromNum(num)))
      return -1;

    return num.toDouble();
  }

  /**
   * Test the script against a bloom filter.
   * @param {Bloom} filter
   * @returns {Boolean}
   */

  test(filter) {
    for (const op of this.code) {
      if (op.value === -1)
        break;

      if (!op.data || op.data.length === 0)
        continue;

      if (filter.test(op.data))
        return true;
    }

    return false;
  }

  /**
   * Test the script to see if it contains only push ops.
   * Push ops are: OP_1NEGATE, OP_0-OP_16 and all PUSHDATAs.
   * @returns {Boolean}
   */

  isPushOnly() {
    for (const op of this.code) {
      if (op.value === -1)
        return false;

      if (op.value > opcodes.OP_16)
        return false;
    }

    return true;
  }

  /**
   * Count the sigops in the script.
   * @param {Boolean} accurate - Whether to enable accurate counting. This will
   * take into account the `n` value for OP_CHECKMULTISIG(VERIFY).
   * @returns {Number} sigop count
   */

  getSigops(accurate, flags) {
    if (flags & Script.flags.VERIFY_ZERO_SIGOPS)
      return 0;

    let total = 0;
    let lastOp = -1;

    for (const op of this.code) {
      if (op.value === -1)
        break;

      switch (op.value) {
        case opcodes.OP_CHECKSIG:
        case opcodes.OP_CHECKSIGVERIFY:
          total += 1;
          break;
        case opcodes.OP_CHECKSDATAIG:
        case opcodes.OP_CHECKDATASIGVERIFY:
          if (flags & Script.flags.VERIFY_CHECKDATASIG) {
            total += 1;
          }
          break;
        case opcodes.OP_CHECKMULTISIG:
        case opcodes.OP_CHECKMULTISIGVERIFY:
          if (accurate && lastOp >= opcodes.OP_1 && lastOp <= opcodes.OP_16)
            total += lastOp - 0x50;
          else
            total += consensus.MAX_MULTISIG_PUBKEYS;
          break;
      }

      lastOp = op.value;
    }

    return total;
  }

  /**
   * Count the sigops in the script, taking into account redeem scripts.
   * @param {Script} input - Input script, needed for access to redeem script.
   * @param {VerifyFlags} flags
   * @returns {Number} sigop count
   */

  getScripthashSigops(input, flags) {
    if (!this.isScripthash())
      return this.getSigops(true, flags);

    const redeem = input.getRedeem();

    if (!redeem)
      return 0;

    return redeem.getSigops(true, flags);
  }

  /*
   * Mutation
   */

  get(index) {
    if (index < 0)
      index += this.code.length;

    if (index < 0 || index >= this.code.length)
      return null;

    return this.code[index];
  }

  pop() {
    const op = this.code.pop();
    return op || null;
  }

  shift() {
    const op = this.code.shift();
    return op || null;
  }

  remove(index) {
    if (index < 0)
      index += this.code.length;

    if (index < 0 || index >= this.code.length)
      return null;

    const items = this.code.splice(index, 1);

    if (items.length === 0)
      return null;

    return items[0];
  }

  set(index, op) {
    if (index < 0)
      index += this.code.length;

    assert(Opcode.isOpcode(op));
    assert(index >= 0 && index <= this.code.length);

    this.code[index] = op;

    return this;
  }

  push(op) {
    assert(Opcode.isOpcode(op));
    this.code.push(op);
    return this;
  }

  unshift(op) {
    assert(Opcode.isOpcode(op));
    this.code.unshift(op);
    return this;
  }

  insert(index, op) {
    if (index < 0)
      index += this.code.length;

    assert(Opcode.isOpcode(op));
    assert(index >= 0 && index <= this.code.length);

    this.code.splice(index, 0, op);

    return this;
  }

  /*
   * Op
   */

  getOp(index) {
    const op = this.get(index);
    return op ? op.value : -1;
  }

  popOp() {
    const op = this.pop();
    return op ? op.value : -1;
  }

  shiftOp() {
    const op = this.shift();
    return op ? op.value : -1;
  }

  removeOp(index) {
    const op = this.remove(index);
    return op ? op.value : -1;
  }

  setOp(index, value) {
    return this.set(index, Opcode.fromOp(value));
  }

  pushOp(value) {
    return this.push(Opcode.fromOp(value));
  }

  unshiftOp(value) {
    return this.unshift(Opcode.fromOp(value));
  }

  insertOp(index, value) {
    return this.insert(index, Opcode.fromOp(value));
  }

  /*
   * Data
   */

  getData(index) {
    const op = this.get(index);
    return op ? op.data : null;
  }

  popData() {
    const op = this.pop();
    return op ? op.data : null;
  }

  shiftData() {
    const op = this.shift();
    return op ? op.data : null;
  }

  removeData(index) {
    const op = this.remove(index);
    return op ? op.data : null;
  }

  setData(index, data) {
    return this.set(index, Opcode.fromData(data));
  }

  pushData(data) {
    return this.push(Opcode.fromData(data));
  }

  unshiftData(data) {
    return this.unshift(Opcode.fromData(data));
  }

  insertData(index, data) {
    return this.insert(index, Opcode.fromData(data));
  }

  /*
   * Length
   */

  getLength(index) {
    const op = this.get(index);
    return op ? op.toLength() : -1;
  }

  /*
   * Push
   */

  getPush(index) {
    const op = this.get(index);
    return op ? op.toPush() : null;
  }

  popPush() {
    const op = this.pop();
    return op ? op.toPush() : null;
  }

  shiftPush() {
    const op = this.shift();
    return op ? op.toPush() : null;
  }

  removePush(index) {
    const op = this.remove(index);
    return op ? op.toPush() : null;
  }

  setPush(index, data) {
    return this.set(index, Opcode.fromPush(data));
  }

  pushPush(data) {
    return this.push(Opcode.fromPush(data));
  }

  unshiftPush(data) {
    return this.unshift(Opcode.fromPush(data));
  }

  insertPush(index, data) {
    return this.insert(index, Opcode.fromPush(data));
  }

  /*
   * String
   */

  getString(index, enc) {
    const op = this.get(index);
    return op ? op.toString(enc) : null;
  }

  popString(enc) {
    const op = this.pop();
    return op ? op.toString(enc) : null;
  }

  shiftString(enc) {
    const op = this.shift();
    return op ? op.toString(enc) : null;
  }

  removeString(index, enc) {
    const op = this.remove(index);
    return op ? op.toString(enc) : null;
  }

  setString(index, str, enc) {
    return this.set(index, Opcode.fromString(str, enc));
  }

  pushString(str, enc) {
    return this.push(Opcode.fromString(str, enc));
  }

  unshiftString(str, enc) {
    return this.unshift(Opcode.fromString(str, enc));
  }

  insertString(index, str, enc) {
    return this.insert(index, Opcode.fromString(str, enc));
  }

  /*
   * Small
   */

  getSmall(index) {
    const op = this.get(index);
    return op ? op.toSmall() : -1;
  }

  popSmall() {
    const op = this.pop();
    return op ? op.toSmall() : -1;
  }

  shiftSmall() {
    const op = this.shift();
    return op ? op.toSmall() : -1;
  }

  removeSmall(index) {
    const op = this.remove(index);
    return op ? op.toSmall() : -1;
  }

  setSmall(index, num) {
    return this.set(index, Opcode.fromSmall(num));
  }

  pushSmall(num) {
    return this.push(Opcode.fromSmall(num));
  }

  unshiftSmall(num) {
    return this.unshift(Opcode.fromSmall(num));
  }

  insertSmall(index, num) {
    return this.insert(index, Opcode.fromSmall(num));
  }

  /*
   * Num
   */

  getNum(index, minimal, limit) {
    const op = this.get(index);
    return op ? op.toNum(minimal, limit) : null;
  }

  popNum(minimal, limit) {
    const op = this.pop();
    return op ? op.toNum(minimal, limit) : null;
  }

  shiftNum(minimal, limit) {
    const op = this.shift();
    return op ? op.toNum(minimal, limit) : null;
  }

  removeNum(index, minimal, limit) {
    const op = this.remove(index);
    return op ? op.toNum(minimal, limit) : null;
  }

  setNum(index, num) {
    return this.set(index, Opcode.fromNum(num));
  }

  pushNum(num) {
    return this.push(Opcode.fromNum(num));
  }

  unshiftNum(num) {
    return this.unshift(Opcode.fromNum(num));
  }

  insertNum(index, num) {
    return this.insert(index, Opcode.fromNum(num));
  }

  /*
   * Int
   */

  getInt(index, minimal, limit) {
    const op = this.get(index);
    return op ? op.toInt(minimal, limit) : -1;
  }

  popInt(minimal, limit) {
    const op = this.pop();
    return op ? op.toInt(minimal, limit) : -1;
  }

  shiftInt(minimal, limit) {
    const op = this.shift();
    return op ? op.toInt(minimal, limit) : -1;
  }

  removeInt(index, minimal, limit) {
    const op = this.remove(index);
    return op ? op.toInt(minimal, limit) : -1;
  }

  setInt(index, num) {
    return this.set(index, Opcode.fromInt(num));
  }

  pushInt(num) {
    return this.push(Opcode.fromInt(num));
  }

  unshiftInt(num) {
    return this.unshift(Opcode.fromInt(num));
  }

  insertInt(index, num) {
    return this.insert(index, Opcode.fromInt(num));
  }

  /*
   * Bool
   */

  getBool(index) {
    const op = this.get(index);
    return op ? op.toBool() : false;
  }

  popBool() {
    const op = this.pop();
    return op ? op.toBool() : false;
  }

  shiftBool() {
    const op = this.shift();
    return op ? op.toBool() : false;
  }

  removeBool(index) {
    const op = this.remove(index);
    return op ? op.toBool() : false;
  }

  setBool(index, value) {
    return this.set(index, Opcode.fromBool(value));
  }

  pushBool(value) {
    return this.push(Opcode.fromBool(value));
  }

  unshiftBool(value) {
    return this.unshift(Opcode.fromBool(value));
  }

  insertBool(index, value) {
    return this.insert(index, Opcode.fromBool(value));
  }

  /*
   * Symbol
   */

  getSym(index) {
    const op = this.get(index);
    return op ? op.toSymbol() : null;
  }

  popSym() {
    const op = this.pop();
    return op ? op.toSymbol() : null;
  }

  shiftSym() {
    const op = this.shift();
    return op ? op.toSymbol() : null;
  }

  removeSym(index) {
    const op = this.remove(index);
    return op ? op.toSymbol() : null;
  }

  setSym(index, symbol) {
    return this.set(index, Opcode.fromSymbol(symbol));
  }

  pushSym(symbol) {
    return this.push(Opcode.fromSymbol(symbol));
  }

  unshiftSym(symbol) {
    return this.unshift(Opcode.fromSymbol(symbol));
  }

  insertSym(index, symbol) {
    return this.insert(index, Opcode.fromSymbol(symbol));
  }

  /**
   * Inject properties from bitcoind test string.
   * @private
   * @param {String} items - Script string.
   * @throws Parse error.
   */

  fromString(code) {
    assert(typeof code === 'string');

    code = code.trim();

    if (code.length === 0)
      return this;

    const items = code.split(/\s+/);
    const bw = bio.write();

    for (const item of items) {
      let symbol = item;

      if (symbol.charCodeAt(0) & 32)
        symbol = symbol.toUpperCase();

      if (!/^OP_/.test(symbol))
        symbol = `OP_${symbol}`;

      const value = opcodes[symbol];

      if (value == null) {
        if (item[0] === '\'') {
          assert(item[item.length - 1] === '\'', 'Invalid string.');
          const str = item.slice(1, -1);
          const op = Opcode.fromString(str);
          bw.writeBytes(op.toRaw());
          continue;
        }

        if (/^-?\d+$/.test(item)) {
          const num = ScriptNum.fromString(item, 10);
          const op = Opcode.fromNum(num);
          bw.writeBytes(op.toRaw());
          continue;
        }

        assert(item.indexOf('0x') === 0, 'Unknown opcode.');

        const hex = item.substring(2);
        const data = Buffer.from(hex, 'hex');

        assert(data.length === hex.length / 2, 'Invalid hex string.');

        bw.writeBytes(data);

        continue;
      }

      bw.writeU8(value);
    }

    return this.fromRaw(bw.render());
  }

  /**
   * Parse a bitcoind test script
   * string into a script object.
   * @param {String} items - Script string.
   * @returns {Script}
   * @throws Parse error.
   */

  static fromString(code) {
    return new this().fromString(code);
  }

  /**
   * Verify an input and output script, and a witness if present.
   * @param {Script} input
   * @param {Null} witness
   * @param {Script} output
   * @param {TX} tx
   * @param {Number} index
   * @param {Amount} value
   * @param {VerifyFlags} flags
   * @param {Number?} sigchecks
   * @throws {ScriptError}
   */

  static verify(input, witness, output, tx, index, value, flags, sigchecks) {
    if (flags == null)
      flags = Script.flags.STANDARD_VERIFY_FLAGS;

    if (flags & Script.flags.VERIFY_SIGPUSHONLY) {
      if (!input.isPushOnly())
        throw new ScriptError('SIG_PUSHONLY');
    }

    if (flags & Script.flags.VERIFY_SIGHASH_FORKID)
      flags |= Script.flags.VERIFY_STRICTENC;

    // SigChecks are counted per input: the density rule below compares this
    // input's count with its own size.
    metrics.sigchecks = 0;

    // Setup a stack.
    let stack = new Stack();

    // Execute the input script
    input.execute(stack, flags, tx, index, value, metrics.sigchecks);

    // Copy the stack for P2SH
    let copy;
    if (flags & Script.flags.VERIFY_P2SH)
      copy = stack.clone();

    // Execute the previous output script.
    output.execute(stack, flags, tx, index, value, metrics.sigchecks);

    // Verify the stack values.
    if (stack.length === 0 || !stack.getBool(-1))
      throw new ScriptError('EVAL_FALSE');

    // If the script is P2SH, execute the real output script
    if ((flags & Script.flags.VERIFY_P2SH) && output.isScripthash()) {
      // P2SH can only have push ops in the scriptSig
      if (!input.isPushOnly())
        throw new ScriptError('SIG_PUSHONLY');

      // Reset the stack
      stack = copy;

      // Stack should not be empty at this point
      if (stack.length === 0)
        throw new ScriptError('EVAL_FALSE');

      // Grab the real redeem script
      const raw = stack.pop();
      const redeem = Script.fromRaw(raw);

      if ((flags & Script.flags.VERIFY_DISALLOW_SEGWIT_RECOVERY) === 0
         && stack.length === 0 && redeem.isProgram()) {

        // Before activation all transaction count a value of 0
        if (!(flags & Script.flags.REPORT_SIGCHECKS)) {
          metrics.sigchecks = 0;
        }
        return;
      }

        // Execute the redeem script.
      redeem.execute(stack, flags, tx, index, value, 0, metrics.sigchecks);

      // Verify the the stack values.
      if (stack.length === 0 || !stack.getBool(-1))
        throw new ScriptError('EVAL_FALSE');
    }

    // Ensure there is nothing left on the stack.
    if (flags & Script.flags.VERIFY_CLEANSTACK) {
      assert((flags & Script.flags.VERIFY_P2SH) !== 0);
      if (stack.length !== 1)
        throw new ScriptError('CLEANSTACK');
    }

    if (flags & Script.flags.VERIFY_INPUT_SIGCHECKS) {
      if (input.getSize() < metrics.sigchecks * 43 - 60)
        throw new ScriptError('INPUT_SIGCHECKS');
    }

    if (!(flags & Script.flags.REPORT_SIGCHECKS)) {
      metrics.sigchecks = 0;
    }
  }

  /**
   * Inject properties from buffer reader.
   * @private
   * @param {BufferReader} br
   */

  fromReader(br) {
    return this.fromRaw(br.readVarBytes());
  }

  /**
   * Inject properties from serialized data.
   * @private
   * @param {Buffer}
   */

  fromRaw(data) {
    const br = bio.read(data);

    this.raw = data;

    while (br.left())
      this.code.push(Opcode.fromReader(br));

    return this;
  }

  /**
   * Create a script from buffer reader.
   * @param {BufferReader} br
   * @param {String?} enc - Either `"hex"` or `null`.
   * @returns {Script}
   */

  static fromReader(br) {
    return new this().fromReader(br);
  }

  /**
   * Create a script from a serialized buffer.
   * @param {Buffer|String} data - Serialized script.
   * @param {String?} enc - Either `"hex"` or `null`.
   * @returns {Script}
   */

  static fromRaw(data, enc) {
    if (typeof data === 'string')
      data = Buffer.from(data, enc);
    return new this().fromRaw(data);
  }

  /**
   * Test whether an object a Script.
   * @param {Object} obj
   * @returns {Boolean}
   */

  static isScript(obj) {
    return obj instanceof Script;
  }
}

/**
 * Script opcodes.
 * @enum {Number}
 * @default
 */

Script.opcodes = common.opcodes;

/**
 * Opcodes by value.
 * @const {RevMap}
 */

Script.opcodesByVal = common.opcodesByVal;

/**
 * Script and locktime flags. See {@link VerifyFlags}.
 * @enum {Number}
 */

Script.flags = common.flags;

/**
 * Sighash Types.
 * @enum {SighashType}
 * @default
 */

Script.hashType = common.hashType;

/**
 * Sighash types by value.
 * @const {RevMap}
 */

Script.hashTypeByVal = common.hashTypeByVal;

/**
 * Output script types.
 * @enum {Number}
 */

Script.types = common.types;

/**
 * Output script types by value.
 * @const {RevMap}
 */

Script.typesByVal = common.typesByVal;

/*
 * Helpers
 */

function sortKeys(keys) {
  return keys.slice().sort((a, b) => {
    return a.compare(b);
  });
}

/**
 * Test whether the data element is a valid key if VERIFY_STRICTENC is enabled.
 * @param {Buffer} key
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function validateKey(key, flags) {
  assert(Buffer.isBuffer(key));
  assert(typeof flags === 'number');

  if (flags & Script.flags.VERIFY_STRICTENC) {
    if (!common.isKeyEncoding(key))
      throw new ScriptError('PUBKEYTYPE');
  }

  if ((flags & Script.flags.VERIFY_COMPRESSED_PUBKEYTYPE)
    && !common.isCompressedEncoding(key)) {
    throw new ScriptError('NONCOMPRESSED_PUBKEY');
  };

  return true;
}

/**
 * Test whether the raw element is a valid signature based
 * on the encoding, S value, and sighash type.
 * In an ECDSA-only context, 64-byte signatures are bannned
 * when Schnorr Flag is set.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function validateECDSASignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  if (common.isSchnorr(sig))
    throw new ScriptError('SIG_BADLENGTH');

  if ((flags & Script.flags.VERIFY_DERSIG)
      || (flags & Script.flags.VERIFY_LOW_S)
      || (flags & Script.flags.VERIFY_STRICTENC)) {
    if (!common.isDERSignatureEncoding(sig))
      throw new ScriptError('SIG_DER');
  }

  if (flags & Script.flags.VERIFY_LOW_S) {
    if (!common.isLowDER(sig))
      throw new ScriptError('SIG_HIGH_S');
  }

  return true;
}

/**
 * Test whether the tx element is a valid signature based
 * on the encoding, S value, and sighash type. Requires
 * VERIFY_STRICTENC, VERIFY_SIGHASH_FORKID to be enabled respectively.
 * Note that this will allow zero-length signatures.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function checkSighashEncoding(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  if (flags & Script.flags.VERIFY_STRICTENC) {
    if (!common.isHashType(sig))
      throw new ScriptError('SIG_HASHTYPE');

    const usesFork = sig[sig.length - 1] & Script.hashType.SIGHASH_FORKID;
    const forkEnabled = flags & Script.flags.VERIFY_SIGHASH_FORKID;

    if (!forkEnabled && usesFork)
      throw new ScriptError('ILLEGAL_FORKID');

    if (forkEnabled && !usesFork)
      throw new ScriptError('MUST_USE_FORKID');
  }

  return true;
}

/**
 * Test whether the transaction tested against
 * the Sighash Encoding is a valid Schnorr Signature.
 * Requires Sighash
 * @param {Buffer} sig
 * @param {VeirfyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function checkTransactionSignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  // allow empty sigs
  if (sig.length === 0)
    return true;

  validateSchnorrSignature(sig.slice(0, -1), flags);

  return checkSighashEncoding(sig, flags);
}

/**
 * Test whether the transaction is tested
 * against the sighash encoding w schnorr / ecdsa
 * for multisig opcodes.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 */

function checkTransactionSchnorrSig(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  // Allow empty sigs.
  if (sig.length === 0)
    return true;

  if (!isSchnorrEncoded(sig.slice(0, -1), flags))
    return validateECDSASignature(sig.slice(0, -1), flags);

  return checkSighashEncoding(sig, flags);
}

/**
 * Test whether the transaction tested against
 * the Sighash Encoding is a valid ECDSA Signature.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function checkTransactionECDSASignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  // Allow empty sigs
  if (sig.length === 0)
    return true;

  validateECDSASignature(sig.slice(0, -1), flags);

  return checkSighashEncoding(sig, flags);
}

/**
 * Test whether the data element is a valid signature based
 * on the encoding, S value, and sighash type. Requires
 * VERIFY_DERSIG|VERIFY_LOW_S|VERIFY_STRICTENC, and VERIFY_LOW_S
 * to be enabled respectively. Note that this will allow zero-length
 * signatures.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function validateDataSignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  // Allow empty sigs
  if (sig.length === 0)
    return true;

  return validateSchnorrSignature(sig.slice(0, sig.length), flags);
}

/**
 * Test whether the Signature is valid in context
 * 64-byte signatures are interpreted as schnorr signatures.
 * Always correctly encoded when Verify_SCHNORR flag is set.
 * @param {Buffer} sig
 * @param {Buffer} msg - Signature hash.
 * @param {VerifyFlags?} flags
 * @returns {Promise}
 * @throws {ScriptError}
 */

function validateSchnorrSignature(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  if (common.isSchnorr(sig))
    return true;

  return validateECDSASignature(sig, flags);
}

/**
 * Test whether the current signature is schnorr encoded.
 * @param {Buffer} sig
 * @param {VerifyFlags?} flags
 * @returns {Boolean}
 * @throws {ScriptError}
 */

function isSchnorrEncoded(sig, flags) {
  assert(Buffer.isBuffer(sig));
  assert(typeof flags === 'number');

  if (common.isSchnorr(sig))
    return true;

  throw new ScriptError('SIG_NONSCHNORR');
}

/**
 * Test whether the signature from the stack
 * is valid in either Schnorr or DER Format.
 * Always encoded correctly when Schnorr flag is set.
 * @param {Buffer} hash
 * @param {Buffer} sig
 * @param {Buffer} key
 * @param {Number} flags
 */

function verifySignature(hash, sig, key, flags) {
  assert(Buffer.isBuffer(hash));
  assert(Buffer.isBuffer(sig));
  assert(Buffer.isBuffer(key));
  assert(typeof flags === 'number');

  let res = false;

  if (sig.length === 64) {
    res = secp256k1.schnorrVerify(hash, sig, key, flags);
  } else {
    res = secp256k1.verifyDER(hash, sig, key, flags);
  }

  return res;
}

/**
 * Verify a signature, taking into account sighash type.
 * @param {Buffer} msg - Signature hash.
 * @param {Buffer} sig
 * @param {Buffer} key
 * @returns {Boolean}
 */

function checksig(msg, sig, key) {
  return secp256k1.verifyDER(msg, sig.slice(0, -1), key);
}

/*
 * Expose
 */

module.exports = Script;
