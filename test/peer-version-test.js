/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * An outbound peer must offer NODE_NETWORK unless the connection was opened
 * with requireNetwork: false, as Avalanche connections are: Bitcoin ABC
 * staking nodes often run without it, and they do not need to serve blocks
 * to take part in Avalanche.
 */

const assert = require('bsert');
const Peer = require('../lib/net/peer');
const NetAddress = require('../lib/net/netaddress');
const packets = require('../lib/net/packets');
const common = require('../lib/net/common');

function version(services) {
  return packets.VersionPacket.fromOptions({
    version: common.PROTOCOL_VERSION,
    services,
    height: 0,
    agent: '/Bitcoin ABC:0.34.2(EB32.0)/',
    remote: new NetAddress(),
    local: new NetAddress(),
    nonce: Buffer.alloc(8, 1)
  });
}

function outbound(options) {
  const peer = Peer.fromOptions({
    network: 'regtest',
    hasNonce: () => false,
    ...options
  });
  peer.outbound = true;
  peer.send = () => {};
  return peer;
}

describe('Peer version', function() {
  it('drops an outbound peer without NODE_NETWORK by default', async () => {
    await assert.rejects(outbound().handleVersion(version(0)),
      /does not support network services/);
  });

  it('keeps it when the connection does not require NODE_NETWORK', async () => {
    const peer = outbound({requireNetwork: false});
    await peer.handleVersion(version(0));
    assert.strictEqual(peer.services, 0);
  });

  it('still accepts an outbound peer with NODE_NETWORK', async () => {
    await outbound().handleVersion(version(common.services.NETWORK));
  });
});
