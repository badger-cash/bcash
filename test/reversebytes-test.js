/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * OP_REVERSEBYTES must behave as if stack items were values, as they are in
 * Bitcoin ABC (std::vector<valtype>). Here items are Buffers shared by
 * reference: OP_DUP, OP_OVER, OP_PICK, OP_TUCK and the alt stack all push the
 * same Buffer, and pushdata pushes the Script's own opcode buffer. Reversing
 * in place therefore reversed every alias at once, so DUP REVERSEBYTES EQUAL
 * passed for any input and a Script executed twice reversed itself back.
 * These tests pin the by-value semantics.
 */

const assert = require('bsert');
const {randomBytes} = require('crypto');
const Script = require('../lib/script/script');
const Stack = require('../lib/script/stack');
const Opcode = require('../lib/script/opcode');
const TX = require('../lib/primitives/tx');
const consensus = require('../lib/protocol/consensus');

const {flags} = Script;

const FLAG_SETS = [
  ['VERIFY_NONE', flags.VERIFY_NONE],
  ['STANDARD_VERIFY_FLAGS', flags.STANDARD_VERIFY_FLAGS],
  ['MANDATORY_VERIFY_FLAGS', flags.MANDATORY_VERIFY_FLAGS],
  ['VERIFY_REVERSEBYTES', flags.VERIFY_REVERSEBYTES]
];

for (const name of Object.keys(flags)) {
  if (/^VERIFY_/.test(name) && !FLAG_SETS.some(([n]) => n === name))
    FLAG_SETS.push([name, flags[name]]);
}

// Byte string where byte i is i % 256, as in ABC's op_reversebytes_iota.
function iota(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++)
    buf[i] = i & 0xff;
  return buf;
}

function reversed(buf) {
  return Buffer.from(buf).reverse();
}

function palindrome(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++)
    buf[i] = Math.min(i, size - 1 - i) & 0xff;
  return buf;
}

// Build a script from data pushes (Buffers) and opcode names (strings).
function script(...items) {
  const code = items.map((item) => {
    if (Buffer.isBuffer(item))
      return Opcode.fromData(item);
    if (typeof item === 'number')
      return Opcode.fromInt(item);
    return Opcode.fromSymbol(item);
  });
  return new Script(code);
}

function run(s, flag = flags.VERIFY_NONE, stack = new Stack()) {
  s.execute(stack, flag);
  return stack;
}

function expectError(s, code, flag = flags.VERIFY_NONE) {
  let err = null;
  try {
    run(s, flag);
  } catch (e) {
    err = e;
  }
  assert(err, `expected ${code}`);
  assert.strictEqual(err.code, code);
}

function assertStack(stack, expected) {
  assert.strictEqual(stack.length, expected.length,
    `stack depth ${stack.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++)
    assert.bufferEqual(stack.get(i), expected[i], null, `stack item ${i}`);
}

describe('OP_REVERSEBYTES', function() {
  describe('reversal', function() {
    const pairs = [
      [Buffer.alloc(0), Buffer.alloc(0)],
      [Buffer.from([0x99]), Buffer.from([0x99])],
      [Buffer.from([0xde, 0xad]), Buffer.from([0xad, 0xde])],
      [Buffer.from([0xde, 0xad, 0xa1]), Buffer.from([0xa1, 0xad, 0xde])],
      [Buffer.from([0xde, 0xad, 0xbe, 0xef]),
       Buffer.from([0xef, 0xbe, 0xad, 0xde])],
      [Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0x56, 0x34, 0x12])]
    ];

    for (const [item, rev] of pairs) {
      const hex = item.toString('hex') || '(empty)';

      it(`reverses ${hex} and back under every flag set`, () => {
        for (const [, flag] of FLAG_SETS) {
          assertStack(run(script(item, 'reversebytes'), flag), [rev]);
          assertStack(run(script(rev, 'reversebytes'), flag), [item]);
          assertStack(run(script(item, 'reversebytes', 'reversebytes'), flag),
            [item]);
          assertStack(run(script(rev, 'reversebytes', 'reversebytes'), flag),
            [rev]);
        }
      });
    }

    const sizes = [0, 1, 2, 10, 16, 32, 50, 128, 300, 400, 512, 519, 520];

    for (const size of sizes) {
      it(`reverses a ${size}-byte iota string and its reverse`, () => {
        const item = iota(size);
        const rev = reversed(item);
        for (const [, flag] of FLAG_SETS) {
          assertStack(run(script(item, 'reversebytes'), flag), [rev]);
          assertStack(run(script(rev, 'reversebytes'), flag), [item]);
          assertStack(run(script(item, 'reversebytes', 'reversebytes'), flag),
            [item]);
        }
      });
    }

    it('is an involution on random data of every size up to the limit', () => {
      for (let size = 0; size < consensus.MAX_SCRIPT_PUSH; size += 7) {
        const item = randomBytes(size);
        const rev = reversed(item);
        assertStack(run(script(item, 'reversebytes')), [rev]);
        assertStack(run(script(item, 'reversebytes', 'reversebytes')), [item]);
      }
    });

    it('leaves palindromes unchanged', () => {
      for (let size = 0; size < consensus.MAX_SCRIPT_PUSH; size += 13) {
        const item = palindrome(size);
        for (const [, flag] of FLAG_SETS)
          assertStack(run(script(item, 'reversebytes'), flag), [item]);
      }
    });

    it('fails with INVALID_STACK_OPERATION on an empty stack', () => {
      for (const [, flag] of FLAG_SETS)
        expectError(script('reversebytes'), 'INVALID_STACK_OPERATION', flag);
    });

    it('fails the palindrome idiom on a non-palindrome (ABC vector)', () => {
      const item = Buffer.from([0x01, 0x02, 0x03, 0x02, 0x02]);
      for (const [, flag] of FLAG_SETS) {
        expectError(script(item, 'dup', 'reversebytes', 'equalverify'),
          'EQUALVERIFY', flag);
      }
    });
  });

  describe('aliased stack items', function() {
    const x = Buffer.from('0102030405', 'hex');
    const rx = reversed(x);
    const y = Buffer.from('aabb', 'hex');

    it('OP_DUP: reversing the copy leaves the original', () => {
      assertStack(run(script(x, 'dup', 'reversebytes')), [x, rx]);
      assertStack(run(script(x, 'dup', 'reversebytes', 'cat')),
        [Buffer.concat([x, rx])]);
    });

    it('OP_DUP REVERSEBYTES EQUAL is false for a non-palindrome', () => {
      const stack = run(script(x, 'dup', 'reversebytes', 'equal'));
      assert.strictEqual(stack.getBool(-1), false);
    });

    it('OP_DUP REVERSEBYTES EQUAL is true for a palindrome', () => {
      const p = Buffer.from('madam', 'ascii');
      const stack = run(script(p, 'dup', 'reversebytes', 'equal'));
      assert.strictEqual(stack.getBool(-1), true);
    });

    it('OP_2DUP and OP_3DUP', () => {
      assertStack(run(script(x, y, '2dup', 'reversebytes')),
        [x, y, x, reversed(y)]);
      assertStack(run(script(x, y, '2dup', 'swap', 'reversebytes')),
        [x, y, y, rx]);
      assertStack(run(script(x, y, x, '3dup', 'reversebytes')),
        [x, y, x, x, y, rx]);
    });

    it('OP_OVER', () => {
      assertStack(run(script(x, y, 'over', 'reversebytes')), [x, y, rx]);
    });

    it('OP_TUCK', () => {
      // x y -> y x y ; reverse the top y only
      assertStack(run(script(x, y, 'tuck', 'reversebytes')),
        [y, x, reversed(y)]);
    });

    it('OP_PICK', () => {
      assertStack(run(script(x, y, 1, 'pick', 'reversebytes')), [x, y, rx]);
      assertStack(run(script(x, y, 0, 'pick', 'reversebytes')),
        [x, y, reversed(y)]);
    });

    it('OP_ROLL moves rather than copies, so nothing else can change', () => {
      assertStack(run(script(x, y, 1, 'roll', 'reversebytes')), [y, rx]);
    });

    it('the alt stack', () => {
      assertStack(run(script(x, 'dup', 'toaltstack', 'reversebytes',
        'fromaltstack')), [rx, x]);
      assertStack(run(script(x, 'dup', 'toaltstack', 'reversebytes',
        'fromaltstack', 'equal')), [Buffer.alloc(0)]);
    });

    it('reversing an item twice through two aliases restores both', () => {
      assertStack(run(script(x, 'dup', 'reversebytes', 'swap', 'reversebytes')),
        [rx, rx]);
    });

    it('OP_SPLIT halves are independent of the reversed source', () => {
      // x2 = x split at 2 -> x[0..2) x[2..); reverse the tail
      const stack = run(script(x, 'dup', 2, 'split', 'reversebytes'));
      assertStack(stack, [x, x.slice(0, 2), reversed(x.slice(2))]);
    });

    it('OP_CAT of a reversed alias keeps the original intact', () => {
      assertStack(run(script(x, 'dup', 'reversebytes', 'over', 'cat')),
        [x, Buffer.concat([rx, x])]);
    });

    it('OP_AND, OP_OR and OP_XOR do not mutate their operands either', () => {
      const a = Buffer.from('f0f0', 'hex');
      const b = Buffer.from('3c3c', 'hex');
      assertStack(run(script(a, 'dup', b, 'and')),
        [a, Buffer.from('3030', 'hex')]);
      assertStack(run(script(a, 'dup', b, 'or')),
        [a, Buffer.from('fcfc', 'hex')]);
      assertStack(run(script(a, 'dup', b, 'xor')),
        [a, Buffer.from('cccc', 'hex')]);
    });
  });

  describe('operands handed in by the caller', function() {
    it('does not modify a Buffer placed on the stack by the caller', () => {
      const original = Buffer.from('deadbeef', 'hex');
      const stack = new Stack([original]);
      script('reversebytes').execute(stack, flags.VERIFY_NONE);

      assert.bufferEqual(original, Buffer.from('deadbeef', 'hex'));
      assertStack(stack, [Buffer.from('efbeadde', 'hex')]);
    });

    it('does not modify the Script whose pushdata it reversed', () => {
      const s = script(Buffer.from('beef', 'hex'), 'reversebytes');
      const raw = s.toRaw().toString('hex');

      run(s);

      assert.bufferEqual(s.code[0].data, Buffer.from('beef', 'hex'));
      assert.strictEqual(s.toRaw().toString('hex'), raw);
    });

    it('gives the same result when the same Script object runs again', () => {
      const s = script(Buffer.from('beef', 'hex'), 'reversebytes',
        Buffer.from('efbe', 'hex'), 'equal');

      for (let i = 0; i < 5; i++)
        assert.strictEqual(run(s).getBool(-1), true, `run ${i + 1}`);
    });

    it('a sliced operand does not reach back into the buffer it came from',
      () => {
      // The covenant pattern: a large element is split and one piece reversed.
      const blob = Buffer.concat([
        Buffer.from('0000000000000000', 'hex'),
        Buffer.from('00000000000003e8', 'hex'),
        Buffer.from('ffff', 'hex')
      ]);
      const before = Buffer.from(blob);
      const stack = new Stack([blob]);

      script(8, 'split', 8, 'split', 'swap', 'reversebytes')
        .execute(stack, flags.VERIFY_NONE);

      assert.bufferEqual(blob, before);
      assertStack(stack, [
        Buffer.from('0000000000000000', 'hex'),
        Buffer.from('ffff', 'hex'),
        Buffer.from('e803000000000000', 'hex')
      ]);
    });
  });

  describe('in a transaction', function() {
    // Funding and spending transactions in the shape script-test.js uses.
    function spend(input, output) {
      const prev = new TX({
        version: 1,
        inputs: [{
          prevout: {hash: consensus.ZERO_HASH, index: 0xffffffff},
          script: [Opcode.fromInt(0), Opcode.fromInt(0)],
          sequence: 0xffffffff
        }],
        outputs: [{script: output, value: 0}],
        locktime: 0
      });

      const tx = new TX({
        version: 1,
        inputs: [{
          prevout: {hash: prev.hash(), index: 0},
          script: input,
          sequence: 0xffffffff
        }],
        outputs: [{script: [], value: 0}],
        locktime: 0
      });

      return {prev, tx};
    }

    it('verifies the same bare script twice, cached and refreshed', () => {
      const input = script(Buffer.from('beef', 'hex'));
      const output = script('reversebytes', Buffer.from('efbe', 'hex'),
        'equal');
      const {prev, tx} = spend(input, output);
      const flag = flags.STANDARD_VERIFY_FLAGS;

      Script.verify(input, null, output, tx, 0, 0, flag);

      prev.refresh();
      tx.refresh();

      Script.verify(input, null, output, tx, 0, 0, flag);
      assert.bufferEqual(input.code[0].data, Buffer.from('beef', 'hex'));
    });

    it('verifies a P2SH redeem twice without altering the input script', () => {
      const redeem = script('reversebytes', Buffer.from('efbe', 'hex'),
        'equal');
      const output = Script.fromScripthash(redeem.hash160());
      const input = script(Buffer.from('beef', 'hex'), redeem.toRaw());
      const {prev, tx} = spend(input, output);
      const before = tx.toRaw().toString('hex');
      const flag = flags.STANDARD_VERIFY_FLAGS;

      for (let i = 0; i < 3; i++) {
        Script.verify(input, null, output, tx, 0, 0, flag);
        assert.strictEqual(tx.toRaw().toString('hex'), before, `run ${i + 1}`);
        assert.bufferEqual(input.code[0].data, Buffer.from('beef', 'hex'));
      }

      prev.refresh();
      tx.refresh();
      Script.verify(input, null, output, tx, 0, 0, flag);
    });

    it('rejects the palindrome idiom on a non-palindrome in a P2SH spend',
      () => {
      const redeem = script('dup', 'reversebytes', 'equal');
      const output = Script.fromScripthash(redeem.hash160());
      const input = script(Buffer.from('beef', 'hex'), redeem.toRaw());
      const {tx} = spend(input, output);

      let err = null;
      try {
        Script.verify(input, null, output, tx, 0, 0,
          flags.STANDARD_VERIFY_FLAGS);
      } catch (e) {
        err = e;
      }

      assert(err, 'expected failure');
      assert.strictEqual(err.code, 'EVAL_FALSE');
    });
  });
});
