/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const common = require('../lib/script/common');
const Script = require('../lib/script/script');
const Stack = require('../lib/script/stack');
const ScriptNum = require('../lib/script/scriptnum');

const EMPTY = Buffer.alloc(0);

const flags = [
  common.flags.VERIFY_NONE,
  common.flags.STANDARD_VERIFY_FLAGS,
  common.flags.MANDATORY_VERIFY_FLAGS
];

// STANDARD_VERIFY_FLAGS includes VERIFY_63BITINT since Shibusawa, so a case
// that is not activated must clear it as well as not adding it.
function withActivation(flag, activated) {
  if (activated)
    return flag | common.flags.VERIFY_63BITINT;
  return flag & ~common.flags.VERIFY_63BITINT;
}

function isSuccess(stack, script, expected, activated) {
  for (let flag of flags) {
    const input = stack.clone();
    flag = withActivation(flag, activated);
    script.execute(input, flag);
    assert.bufferEqual(input.items[0], expected);
  }
}

function isError(stack, script, errorMsg, activated) {
  for (let flag of flags) {
    const input = stack.clone();
    let err;
    try {
      flag = withActivation(flag, activated);
      script.execute(input, flag);
    } catch (e) {
      err = e;
    }
    assert(err, 'error');
    assert.strictEqual(err.message, errorMsg);
  }
}

describe('Shibusawa', function() {
  it('should do valid addition if not activated', async () => {
    const stack = new Stack();
    stack.push(Buffer.alloc(4, 1));
    stack.push(Buffer.alloc(4, 1));

    isSuccess(
      stack,
      Script.fromString('OP_ADD'),
      Buffer.from('02020202', 'hex')
    );
  });

  it('should do valid subtraction if not activated', async () => {
    const stack = new Stack();
    stack.push(Buffer.alloc(4, 3));
    stack.push(Buffer.alloc(4, 1));

    isSuccess(
      stack,
      Script.fromString('OP_SUB'),
      Buffer.from('02020202', 'hex')
    );
  });

  it('should fail on 64 bit integers if not activated', async () => {
    const stack = new Stack();
    stack.push(Buffer.alloc(8, 1));
    stack.push(Buffer.alloc(8, 1));

    isError(stack, Script.fromString('OP_ADD'), 'Script number overflow.');
  });

  it('should do addition on 64 bit integers if activated', async () => {
    const stack = new Stack();
    stack.push(Buffer.alloc(8, 2));
    stack.push(Buffer.alloc(8, 1));

    isSuccess(
      stack,
      Script.fromString('OP_ADD'),
      Buffer.from('0303030303030303', 'hex'),
      true
    );
  });

  it('should do subtraction on 64 bit integers if activated', async () => {
    const stack = new Stack();
    stack.push(Buffer.alloc(8, 2));
    stack.push(Buffer.alloc(8, 1));

    isSuccess(
      stack,
      Script.fromString('OP_SUB'),
      Buffer.from('0101010101010101', 'hex'),
      true
    );
  });

  it('should throw error if 64 bit integer addition overflows', async () => {
    const max = ScriptNum.from('9223372036854775807');
    const one = ScriptNum.from('1');
    const stack = new Stack();
    stack.push(max.toRaw());
    stack.push(one.toRaw());

    isError(stack, Script.fromString('OP_ADD'), '64 bit ScriptNumber overflow.', true);
  });

  it('should throw error if 64 bit integer addition overflows with negative number', async () => {
    const min = ScriptNum.from('-9223372036854775807');
    const negOne = ScriptNum.from('-1');
    const stack = new Stack();
    stack.push(min.toRaw());
    stack.push(negOne.toRaw());

    isError(stack, Script.fromString('OP_ADD'), '64 bit ScriptNumber overflow.', true);
  });

  it('should throw error if 64 bit integer subtraction overflows', async () => {
    const min = ScriptNum.from('-9223372036854775807');
    const one = ScriptNum.from('1');
    const stack = new Stack();
    stack.push(min.toRaw());
    stack.push(one.toRaw());

    isError(stack, Script.fromString('OP_SUB'), '64 bit ScriptNumber overflow.', true);
  });

  it('should throw error if 64 bit integer subtraction overflows with negative number', async () => {
    const max = ScriptNum.from('9223372036854775807');
    const negOne = ScriptNum.from('-1');
    const stack = new Stack();
    stack.push(max.toRaw());
    stack.push(negOne.toRaw());

    isError(stack, Script.fromString('OP_SUB'), '64 bit ScriptNumber overflow.', true);
  });

  it('should throw error if 0 + -9223372036854775808', async () => {
    const zero = ScriptNum.from('0');
    const min = ScriptNum.from('-9223372036854775808');

    let err;
    try {
      zero.checkOverflow(min);
    } catch (e) {
      err = e;
    }
    assert(err, 'error');
    assert.strictEqual(err.message, 'Invalid INT64_MIN');

    try {
      min.checkOverflow(zero);
    } catch (e) {
      err = e;
    }
    assert(err, 'error');
    assert.strictEqual(err.message, 'Invalid INT64_MIN');
  });
});
