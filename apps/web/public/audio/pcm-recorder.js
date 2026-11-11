// AudioWorklet: forwards raw mono Float32 frames to the main thread while recording.
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorder);
