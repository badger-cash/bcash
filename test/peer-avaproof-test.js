/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

/*
 * A getdata waits for its answer, and a peer that gives none is dropped
 * as stalling. For an avalanche proof the answer is an avaproof, which
 * had not counted, so nodes asked for their proofs were dropped.
 */

const assert = require('bsert');
const random = require('bcrypto/lib/random');
const Peer = require('../lib/net/peer');
const packets = require('../lib/net/packets');
const InvItem = require('../lib/primitives/invitem');

const AVA_PROOF = 0x1f000001;

function outbound() {
  const peer = Peer.fromOptions({network: 'regtest', hasNonce: () => false});
  peer.outbound = true;
  peer.write = () => {};
  peer.handshake = true;
  return peer;
}

describe('Peer avaproof response', function() {
  it('should count an avaproof as the answer to a getdata', () => {
    const peer = outbound();
    const item = new InvItem(AVA_PROOF, random.randomBytes(32));

    peer.addTimeout(new packets.GetDataPacket([item]));
    assert(peer.responseMap.has(packets.types.DATA));

    peer.fulfill(new packets.UnknownPacket('avaproof', Buffer.alloc(1)));
    assert(!peer.responseMap.has(packets.types.DATA));
  });

  it('should not count other unknown packets', () => {
    const peer = outbound();
    const item = new InvItem(AVA_PROOF, random.randomBytes(32));

    peer.addTimeout(new packets.GetDataPacket([item]));
    peer.fulfill(new packets.UnknownPacket('avahello', Buffer.alloc(1)));
    assert(peer.responseMap.has(packets.types.DATA));
  });
});
