/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * Obolensky, the May 15, 2026 upgrade. Bitcoin ABC records it only as an
 * activation checkpoint: it changed no consensus rules. Here it activates
 * at ABC's checkpoint block on each network and leaves the script flags
 * exactly as they were.
 */

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const Block = require('../lib/primitives/block');
const Network = require('../lib/protocol/network');
const common = require('../lib/blockchain/common');

// Real headers: the twelve before activation, then the activation block.
const windows = {
  main: {
    start: 949188,
    headers: [
      ['000000000000000066e75d33cfaf3fbed734cf07dd471c1ec28a7394a84fc093',
       '0000e020b1a72430e35c4399a354ace7fad3bbaaea699f19ea76e33e0000000000000' +
         '0003182d60f3bfd79046ea749803f2f6663fc83b45d62e52a59a1529dc98ec25e8f' +
         '42e5066a699b00193dd122fb'],
      ['00000000000000000153685e8d03458e1785d694e18e4168186b6b768b98ed9b',
       '00a0072093c04fa894738ac21e1c47dd07cf34d7be3fafcf335de7660000000000000' +
         '000d02c68eaf490b291dbd87666dc78948ce5f40e2f8b56eec745fd6ede813b40f2' +
         '07eb066a399b001934e865ed'],
      ['00000000000000005361b0567432413387a7510ef01bd279677ea98da3c7b75d',
       '00a002209bed988b766b6b1868418ee194d685178e45038d5e6853010000000000000' +
         '000072fe3c3dc0cb02e49bcbd87a558f598dc9a681071109cbc6e5b6c138d43e4b7' +
         'ad00076ac59b0019159c149b'],
      ['0000000000000000085a21aeab03c0f8740d38611874a38da59fee67b4a3e560',
       '0040842e5db7c7a38da97e6779d21bf00e51a7873341327456b061530000000000000' +
         '0004685bba24924340c194d1f18725aa14845a510af251a665984c4594bea429f6b' +
         'eb03076ae69e0019dbe8317e'],
      ['0000000000000000337b9cd2d99496555df10b5c3704b3bcb8938a3fabdd659d',
       '00000a2060e5a3b467ee9fa58da3741861380d74f8c003abae215a080000000000000' +
         '00089b80241c0ec46e23072a069e1be4714cc5227b0b22ec1dcded4861a67364190' +
         'a804076a0b9f001910fefe75'],
      ['0000000000000000291c0e354d06e412ff8611c8c5456c4fc1f5db96d3210cc8',
       '00407f2e9d65ddab3f8a93b8bcb304375c0bf15d559694d9d29c7b330000000000000' +
         '000bacd350308de72422a497c2bc0dd541ba98c4cbd32c7498d6d5881d0a291a197' +
         '4a09076ac89e0019f8006c20'],
      ['00000000000000009b38e85b40df6fd93f4323d37c77ae1eef8dc96651e7ddb3',
       '00402f27c80c21d396dbf5c14f6c45c5c81186ff12e4064d350e1c290000000000000' +
         '000e844c49784d783d209675a666ac2feb02a6d29dc109f4775ae022eda7e3ae460' +
         'c70a076a279f00194d06270c'],
      ['00000000000000005b3ff797b8309d285baadbfb5e12e696c521d5ca0ae379aa',
       '00004020b3dde75166c98def1eae777cd323433fd96fdf405be8389b0000000000000' +
         '0009c8482aeed42fe68026b5b59b262fadbe6f839b194db7d70aa088c2a1150bd65' +
         '060c076a039f001901045cb9'],
      ['00000000000000004c2b5040e802ca4c6f9be185379a1f73f74494fa06d2b28d',
       '00000120aa79e30acad521c596e6125efbdbaa5b289d30b897f73f5b0000000000000' +
         '000524c434c0c1af27d66211133611312f8515d8fdceb33f6e15ee4e3915bf2244e' +
         '2c0d076ad69e00193d9cbe0b'],
      ['00000000000000006fe433c9344bdf28aca4f76aed126da9c06fae58200b5923',
       '00e0ff378db2d206fa9444f7731f9a3785e19b6f4cca02e840502b4c0000000000000' +
         '000679232089efaa5906df77cbed389d3e8aa7399eee5812720d43f650bae1c2136' +
         'a90f076aa49e00195f7dbc74'],
      ['000000000000000030714dbbed22aff212fab61fb184ee7ec3f75aeeef7c22c2',
       '00e0042023590b2058ae6fc0a96d12ed6af7a4ac28df4b34c933e46f0000000000000' +
         '0006a36414a9155ec2ed8c22422f952adf5c3d0a97c827a7aacc2ea9297cab208c0' +
         '7d12076aaa9e0019e9222f31'],
      ['00000000000000006304376a4c256b4a9b844ad6b7cfa8c3033d1bc3c5b67734',
       '0000cc29c2227cefee5af7c37eee84b11fb6fa12f2af22edbb4d71300000000000000' +
         '000829cae4c6bc3da5e14639a2f8da72ac1fb59d7c8f429d552a809b38d778a9a55' +
         '3017076abe9e0019b478f9d9'],
      ['000000000000000098694560815190dba8bbe2f06c08a7c23837df3c4886cba2',
       '00e0e5273477b6c5c31b3d03c3a8cfb7d64a849b4a6b254c6a3704630000000000000' +
         '0004e0cb069a8711e4d680ac7c2afbc4ab58d27c9514bc497452d9cee9fe2bfa022' +
         'ee1a076a219f0019486e7c73']
    ]
  },
  testnet: {
    start: 1713781,
    headers: [
      ['00000000000304c02765680703a3679dac0c1617194b8eda62bd6a85e68a4306',
       '00000020464d288b7bee30bc63d63f6978a485442c6f6c1509207f1c0380c90200000' +
         '0000aedf063ddb8ffe2196b9d2353120aea4451809da5b405d232c07045886700da' +
         '94fc066a5802171bb54ec628'],
      ['00000000000dc646fe61c26c10f2413e311170c3d90fc494e03c23c0f4206a57',
       '0000002006438ae6856abd62da8e4b1917160cac9d67a30307686527c004030000000' +
         '000f3e7a884fd0273376b40ad130d2f25c9333206f56690dd35479ff7014dd8c9f8' +
         'f2fd066a29fd161b42b88d98'],
      ['000000000003028f42505cb12f00b0eb430c660ccd6bd89e5314628c18122247',
       '00000020576a20f4c0233ce094c40fd9c37011313e41f2106cc261fe46c60d0000000' +
         '0006c80a8c4da0f0087806db829c1303a58395bf1cbdbb494d7d6c15c62db63be74' +
         '2002076a39f7161b024ea2c6'],
      ['0000000000081416e85056cb8838e3827ea05d053a910860619cc73586739d42',
       '00000020472212188c6214539ed86bcd0c660c43ebb0002fb15c50428f02030000000' +
         '000566b0847ebaeb6e822cf43b16ad55ac8403e78447687d5f231e0dcfd3db8b0b9' +
         '7b05076a5802171b089dc5dc'],
      ['000000000014a12962fb3fe94b6a3fbce4cd6eb1643844803013655ac96d3a43',
       '00000020429d738635c79c616008913a055da07e82e33888cb5650e81614080000000' +
         '0008c6543805af585da1a131149a9d3291e6106d83240246a25125db9f276a5f7f1' +
         'd508076a7808171b15d743b2'],
      ['00000000000b74a57356abf9602d89ef9123ef0d42378266a4ce864201a9435e',
       '00000020433a6dc95a65133080443864b16ecde4bc3f6a4be93ffb6229a1140000000' +
         '00062a048a76c4f94cf17c4e3f5302ecc63fc3518d4a6a2e5886d553125e3ca51ce' +
         'f309076a880e171bd0326c93'],
      ['0000000000133fc0ecae37c8abab7886711ed356a5b410f61f55f686ab826b99',
       '000000205e43a9014286cea4668237420def2391ef892d60f9ab5673a5740b0000000' +
         '000e26ae8ccd0c927964a80fef5fa7c7951a0305d88c1df2a045d9059f3a09237b4' +
         'd50c076a1807171b883874e0'],
      ['00000000000c5138a53d780c78a3c8e45d256844b57ac7cb020d91037b0d2450',
       '00000020996b82ab86f6551ff610b4a556d31e718678ababc837aeecc03f130000000' +
         '0005f3f335210c3923dbdf89062b7c84721df91809c21cdd741596cbbff748040df' +
         'e40e076a680a171b9d3b0806'],
      ['000000000bb085b0a3e6e89a5a6ed0bac2167fe5f3b1d98050b0b311600b1a02',
       '0000002050240d7b03910d02cbc77ab54468255de4c8a3780c783da538510c0000000' +
         '0001ab9bea433cca817ba5d3d927e919ae604597bdd0a698553fedbbee8e2f523bd' +
         'ab13076affff001d10be4064'],
      ['0000000001a77ca4e753cc48f5740a1efdac28b1b2b8653a4190d338d51ca505',
       '00000020021a0b6011b3b05080d9b1f3e57f16c2bad06e5a9ae8e6a3b085b00b00000' +
         '000e89dba45004e92731f7c1fbed74752f02c3c46a6dc71909eb48fd03d1cba6bfb' +
         '6d18076affff001d3f1d3f0f'],
      ['000000000010eea72d5ed9d1d6b1acb87aa3e37710a1af17d3ba42044031da5d',
       '0000002005a51cd538d390413a65b8b2b128acfd1e0a74f548cc53e7a47ca70100000' +
         '000644a2a9fb15d7732d70d23f53c6e20110d3f731c550a534685dacb00a5aec684' +
         '031a076a2826171b130d4c2d'],
      ['000000000000d5295623112516ab40d168952699b04c014135e393f750c3ebd1',
       '000000205dda31400442bad317afa11077e3a37ab8acb1d6d1d95e2da7ee100000000' +
         '0007098e32c4a69ad4223a8197b501e6b7f9acb79dac1da783cc84e423c4f41ba3e' +
         'e51a076a7821171b2e81a820'],
      ['000000000008b5b5579ca088a51dd7ed18923e15023f7a296bb248d0eda80f84',
       '00000020d1ebc350f793e33541014cb099269568d140ab162511235629d5000000000' +
         '0006b7fe1c45edc5cdd537b6d82544140d743b545a74f0e21fc6d118d2c49cbaa55' +
         'a81b076a9818171b81f5121d']
    ]
  }
};

const toBlock = hex => Block.fromRaw(Buffer.concat([Buffer.from(hex, 'hex'),
  Buffer.from([0])]));

describe('Obolensky', function() {
  this.timeout(20000);

  for (const [name, expectHeight] of [['main', 949200], ['testnet', 1713793]]) {
    describe(name, function() {
      const network = Network.get(name);
      const window = windows[name];
      let chain;

      before(async () => {
        chain = new Chain({
          network, memory: true, spv: true,
          anchor: {
            height: window.start,
            headers: window.headers.slice(0, 12).map(([, h]) => Buffer.from(h,
              'hex'))
          }
        });
        await chain.open();
      });

      after(async () => {
        await chain.close();
      });

      it('activates at Bitcoin ABC\'s activation checkpoint', () => {
        assert.strictEqual(network.block.obolenskyHeight, expectHeight);
        assert.strictEqual(network.block.obolenskyActivationTime, 1778846400);
        assert.bufferEqual(network.checkpointMap[expectHeight],
          network.block.obolenskyHash);
      });

      it('is inactive for the block before and active for the activation bloc' +
        'k', async () => {
        const before = await chain.getEntryByHeight(expectHeight - 2);
        const last = chain.tip;
        assert.strictEqual(last.height, expectHeight - 1);

        const prior = await chain.getDeployments(last.time, before);
        const activation = toBlock(window.headers[12][1]);
        const state = await chain.getDeployments(activation.time, last);

        assert.strictEqual(prior.hasObolensky(), false);
        assert.strictEqual(state.hasObolensky(), true);
        // No consensus change: identical script flags either side.
        assert.strictEqual(state.flags, prior.flags);
        assert.strictEqual(state.hasShibusawa(), true);
      });

      it('accepts the real activation block, matching its checkpoint',
        async () => {
        let hit = null;
        chain.once('checkpoint', (hash, height) => {
 hit = height;
});
        const entry = await chain.add(toBlock(window.headers[12][1]),
          common.flags.VERIFY_POW);
        assert(entry);
        assert.strictEqual(entry.height, expectHeight);
        assert.strictEqual(entry.rhash(), window.headers[12][0]);
        assert.strictEqual(hit, expectHeight);
      });
    });
  }
});
