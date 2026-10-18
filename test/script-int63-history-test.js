/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Bitcoin ABC activated 63+sign-bit script integers with Shibusawa, then
 * made them unconditional (D18955, "32-bit integers? I never knew you"):
 * it validates every height with them. eCash testnet block 1684438, three
 * weeks before Shibusawa, spends an Agora offer that decodes an 8-byte
 * number with OP_BIN2NUM. ABC accepts it; bcash, which still gated the
 * flag on Shibusawa, rejected it (INVALID_NUMBER_RANGE) and stopped there.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Block = require('../lib/primitives/block');
const TX = require('../lib/primitives/tx');
const Coin = require('../lib/primitives/coin');
const Script = require('../lib/script/script');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');
const {twentyMinute: window} = require('./data/testnet-asert-headers');

const network = Network.get('testnet');

// Transaction 734f246e..ae85 from testnet block 1684438.
const AGORA_TX = [
  '0200000002baf398f751afd1508fe5760cab98d4d3fe799e786634560aa9ff4b',
  'ff4653c8c301000000fd490321023c72addb4fdf09af94f0c94d7fe92a386a7e',
  '70cf8a1d85916386bb2535c7b1b14098719aa17efe900dfbaa5d97656b1a9cef',
  '2dd4857a39c74872648b38d6e2d44547cbe0d5ebd2a213c03cef12feb47eef98',
  'd936409143f096763106640373016f4422020000000000001976a9147401c8d6',
  '56b5ea97c203606e57ebe2f58ca631c788ac87290e00000000001976a9147401',
  'c8d656b5ea97c203606e57ebe2f58ca631c788ac4d3401baf398f751afd1508f',
  'e5760cab98d4d3fe799e786634560aa9ff4bff4653c8c301000000db7b63817b',
  '6ea26976065c5ad07b6308a26976052fe28e79159700887d945279012a7f7578',
  '92635357807e78052fe28e7915965667525768807e5279052fe28e7915965680',
  '7e827c7e5379012a7f777c7e825980bc7c7e007e7b041889da0793041989da07',
  '9658807e041976a914707501577f77a97e0288ac7e7e6b7d02220258800317a9',
  '147e024c7872587d807e7e7e01ab7e537901257f7702db007f5c7f7701207f54',
  '7f7504479a0438886b7ea97e01877e7c92647500687b8292697e6c6c7b7eaa88',
  '520144807c7ea86f7bbb7501c17e7c677501577f7768ac2202000000000000ff',
  'ffffffed69fda160a010bebfbfa49ca84f02825d3af7fce12bb9449208bb3869',
  '70ddcf479a0438c1000000065c5ad07b6308514d5f014c78534c503200045345',
  '4e44e786e0cd831a86111f1905680a6c09e75829fd81a58d68038c83653d1c41',
  '00d06a504b41475230075041525449414c00002fe28e79150000001989da0700',
  '0000005c5ad07b63080000479a0438023a0170f1ceeb24036842367de8f4a283',
  '9440127369895d342ba6018127bbe0b608004fc6f6ffffff7fab7b63817b6ea2',
  '6976065c5ad07b6308a26976052fe28e79159700887d945279012a7f75789263',
  '5357807e78052fe28e7915965667525768807e5279052fe28e79159656807e82',
  '7c7e5379012a7f777c7e825980bc7c7e007e7b041889da0793041989da079658',
  '807e041976a914707501577f77a97e0288ac7e7e6b7d02220258800317a9147e',
  '024c7872587d807e7e7e01ab7e537901257f7702db007f5c7f7701207f547f75',
  '04479a0438886b7ea97e01877e7c92647500687b8292697e6c6c7b7eaa885201',
  '44807c7ea86f7bbb7501c17e7c677501577f7768acffffffffaffd2a97d5b754',
  '78f874853d8c848cb7201c900b8b9abd14deb3955695bb697b0000000064419e',
  '4dc7fb27d59d897f914efd7d444175e95174160749f09c69a49f370661530488',
  'e211e9821190f32d6f0fde65a5471c73f37c65eb3fe0b36034bd0bc9afb99541',
  '210332b2a8403b0cf64f90572704046a8b049ae400671125e77d98a5a6a6e3c3',
  '2921ffffffff0500000000000000008c6a504b41475230075041525449414c00',
  '002fe28e79150000001989da07000000005c5ad07b63080000479a0438023a01',
  '70f1ceeb24036842367de8f4a2839440127369895d342ba6018127bbe0b63d53',
  '4c5032000453454e44e786e0cd831a86111f1905680a6c09e75829fd81a58d68',
  '038c83653d1c4100d0030000000000009ce0f505000064000000000071110100',
  '000000001976a914215edfff4aec2a3b85e57d2358332428da5438eb88ac2202',
  '00000000000017a914b9deb8abf104ce4dcdc181f049ae9295cbc9cbcf872202',
  '0000000000001976a9147401c8d656b5ea97c203606e57ebe2f58ca631c788ac',
  '87290e00000000001976a9147401c8d656b5ea97c203606e57ebe2f58ca631c7',
  '88ac479a0438'
].join('');

// The two outputs it spends, both created earlier in the same block.
const COINS = [
  {value: 546,
   script: 'a914cc7f6e77bb9590b5c8211674409ceaf3905809da87'},
  {value: 1000000,
   script: '76a9147401c8d656b5ea97c203606e57ebe2f58ca631c788ac'}
];

const toBlock = hex => Block.fromRaw(
  Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from([0])]));

describe('Script integers at every height', function() {
  this.timeout(30000);

  const headers = window.headers.map(([, h]) => h);
  const chain = new Chain({
    network, memory: true, spv: true,
    anchor: {
      height: window.start,
      headers: headers.slice(0, 12).map(h => Buffer.from(h, 'hex'))
    }
  });
  let state;

  before(async () => {
    await chain.open();
    for (const header of headers.slice(12))
      assert(await chain.add(toBlock(header), common.flags.VERIFY_POW));
    const tip = chain.tip;
    state = await chain.getDeployments(tip.time + 600, tip);
  });

  after(async () => {
    await chain.close();
  });

  it('are 63+sign-bit before Shibusawa, as in Bitcoin ABC', () => {
    assert(!state.hasShibusawa());
    assert(state.flags & Script.flags.VERIFY_63BITINT);
  });

  it('accept the pre-Shibusawa Agora spend from testnet', () => {
    const tx = TX.fromRaw(Buffer.from(AGORA_TX, 'hex'));
    assert.strictEqual(tx.txid(),
      '734f246e674f09e2facb6f7c0d8bfc7ebd34a66d6ce2ba5a95a8b67d5670ae85');

    for (let i = 0; i < tx.inputs.length; i++) {
      const coin = new Coin({
        value: COINS[i].value,
        script: Script.fromRaw(Buffer.from(COINS[i].script, 'hex'))
      });
      tx.checkInput(i, coin, state.flags);
    }
  });
});
