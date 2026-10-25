/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An anchored chain cannot open without its anchor's headers, and a page
 * may have one host, whose first session can drop as it opens: the pool
 * asks again, a few rounds, a moment apart, before giving up.
 */

const assert = require('bsert');
const Pool = require('../lib/net/pool');

function pool(rounds) {
  const p = Object.create(Pool.prototype);
  p.logger = {info() {}};
  p.calls = 0;
  p.fetchAnchorRound = async () => {
    p.calls += 1;
    const next = rounds.shift();
    if (next instanceof Error)
      throw next;
    return next;
  };
  return p;
}

describe('Pool anchor retry', function() {
  this.timeout(10000);

  it('should ask again when a round fails', async () => {
    const p = pool([new Error('Peer was destroyed.'), ['headers']]);
    assert.deepStrictEqual(await p.fetchAnchor({}), ['headers']);
    assert.strictEqual(p.calls, 2);
  });

  it('should give up after its rounds', async () => {
    const p = pool([new Error('a'), new Error('b'), new Error('c'),
      ['never']]);
    await assert.rejects(p.fetchAnchor({}), /c/);
    assert.strictEqual(p.calls, 3);
  });
});
