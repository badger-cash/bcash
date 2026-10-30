'use strict';

/*
 * An in-memory stand-in for the browser's RTCPeerConnection: two in one
 * process connect once each has the other's description and one of its
 * ICE candidates, as signaling carries them; then their data channels
 * pass messages. Enough to test what is built on WebRTC, not WebRTC.
 */

const connections = new Map();
let lastId = 0;

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.other = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onbufferedamountlow = null;
  }

  open() {
    this.readyState = 'open';
    if (this.onopen)
      this.onopen({});
  }

  send(data) {
    if (this.readyState !== 'open')
      throw new Error('Data channel is not open.');

    const copy = Uint8Array.from(data).buffer;
    const other = this.other;

    setImmediate(() => {
      if (other.readyState === 'open' && other.onmessage)
        other.onmessage({data: copy});
    });
  }

  close() {
    if (this.readyState === 'closed')
      return;

    this.readyState = 'closed';

    if (this.onclose)
      this.onclose({});

    if (this.other)
      this.other.close();
  }
}

class FakeRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.id = ++lastId;
    this.localDescription = null;
    this.remoteDescription = null;
    this.remote = null;
    this.gotCandidate = false;
    this.channels = [];
    this.linked = false;
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
    FakeRTCPeerConnection.created.push(this);
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return {type: 'offer', sdp: `fake ${this.id}`};
  }

  async createAnswer() {
    return {type: 'answer', sdp: `fake ${this.id}`};
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    connections.set(this.id, this);

    // One candidate, then the end of them, as ICE gathers.
    setImmediate(() => {
      if (!this.onicecandidate || this.connectionState === 'closed')
        return;
      const candidate = {
        candidate: `candidate:1 1 udp 1 127.0.0.1 ${this.id} typ host`,
        sdpMid: '0',
        sdpMLineIndex: 0
      };
      this.onicecandidate({candidate});
      this.onicecandidate({candidate: null});
    });

    this.maybeLink();
  }

  async setRemoteDescription(desc) {
    const id = Number(String(desc.sdp).split(' ')[1]);
    const remote = connections.get(id);

    if (!remote)
      throw new Error('Unknown remote description.');

    this.remoteDescription = desc;
    this.remote = remote;
    this.maybeLink();
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription)
      throw new Error('No remote description.');
    if (candidate && candidate.candidate)
      this.gotCandidate = true;
    this.maybeLink();
  }

  ready() {
    return this.localDescription && this.remoteDescription
      && this.gotCandidate && this.connectionState !== 'closed';
  }

  maybeLink() {
    const remote = this.remote;

    if (this.linked || !remote || !this.ready() || !remote.ready())
      return;

    if (remote.remote !== this)
      return;

    this.linked = true;
    remote.linked = true;

    // The offerer made the channels; the answerer is given them.
    const offerer = this.localDescription.type === 'offer' ? this : remote;
    const answerer = offerer === this ? remote : this;

    setImmediate(() => {
      for (const ours of offerer.channels) {
        const theirs = new FakeDataChannel(ours.label);
        ours.other = theirs;
        theirs.other = ours;
        answerer.channels.push(theirs);

        theirs.readyState = 'open';
        if (answerer.ondatachannel)
          answerer.ondatachannel({channel: theirs});
        ours.open();
        if (theirs.onopen)
          theirs.onopen({});
      }

      for (const pc of [offerer, answerer]) {
        pc.connectionState = 'connected';
        if (pc.onconnectionstatechange)
          pc.onconnectionstatechange();
      }
    });
  }

  close() {
    if (this.connectionState === 'closed')
      return;

    this.connectionState = 'closed';
    connections.delete(this.id);

    for (const channel of this.channels)
      channel.close();

    if (this.onconnectionstatechange)
      this.onconnectionstatechange();
  }
}

FakeRTCPeerConnection.created = [];

module.exports = FakeRTCPeerConnection;
