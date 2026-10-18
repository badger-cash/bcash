/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * SLP requires every field after OP_RETURN to be a data push; an empty
 * field is OP_PUSHDATA1 0x00. bcash gives OP_0 and OP_1..OP_16 null data,
 * and SLP#verifySlp read .length from fields without checking, so an
 * OP_RETURN with OP_0 in a quantity threw instead of being "not SLP".
 * eCash testnet tx 12ddc5a3..7198 (block 1345104) ends a SEND with OP_0,
 * which stopped the SLP indexer of every node that reached it.
 */

const assert = require('bsert');
const Script = require('../lib/script/script');
const SLP = require('../lib/script/slp');

const fromHex = hex => Script.fromRaw(Buffer.from(hex, 'hex'));
const isValid = hex => SLP.fromScript(fromHex(hex)).isValidSlp();

// OP_RETURN, LOKAD id, version 1.
const HEAD = '6a04534c5000' + '0101';
const TOKEN = '20' + '7ac7f4bb50b019fe0f5c81e3fc13fc07'
  + '20e130282ea460768cafb49785eb2796';
const QTY = '080000000000000064';
const EMPTY = '4c00';

// GENESIS: ticker, name, uri, hash, decimals, baton, quantity.
const genesis = (baton, qty) => HEAD + '0747454e45534953'
  + EMPTY + EMPTY + EMPTY + EMPTY + '0100' + baton + qty;

describe('SLP verify', function() {
  it('treats the testnet SEND ending in OP_0 as not SLP', () => {
    // Output 0 of testnet tx 12ddc5a386e20a567d059533ee4cc26f
    // 28ff8d8b90f0218f4ab86dc825a27198, byte for byte.
    const script = HEAD + '0453454e44' + TOKEN + '0800000000790d7c46' + '00';
    assert.strictEqual(isValid(script), false);
  });

  it('still accepts spec-encoded empty fields', () => {
    assert.strictEqual(isValid(genesis(EMPTY, QTY)), true);
  });

  it('treats OP_0 in any checked field as not SLP', () => {
    const cases = {
      'GENESIS quantity': genesis(EMPTY, '00'),
      'GENESIS baton': genesis('00', QTY),
      'MINT baton': HEAD + '044d494e54' + TOKEN + '00' + QTY,
      'MINT quantity': HEAD + '044d494e54' + TOKEN + EMPTY + '00',
      'SEND token id': HEAD + '0453454e44' + '00' + QTY,
      'BURN quantity': HEAD + '044255524e' + TOKEN + '00'
    };

    for (const [name, hex] of Object.entries(cases))
      assert.strictEqual(isValid(hex), false, name);
  });

  it('treats OP_1..OP_16 in a field as not SLP', () => {
    assert.strictEqual(isValid(genesis(EMPTY, '51')), false);
  });
});
