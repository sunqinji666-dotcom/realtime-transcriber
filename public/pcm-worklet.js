class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000;
    this.sourceSampleRate = sampleRate;
    this.ratio = this.sourceSampleRate / this.targetSampleRate;
    this.pending = [];
    this.pendingLength = 0;
    this.flushSize = Math.floor(this.targetSampleRate * 0.1);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    const outputLength = Math.floor(input.length / this.ratio);
    const pcm = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = Math.floor(i * this.ratio);
      const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    this.pending.push(pcm);
    this.pendingLength += pcm.length;

    if (this.pendingLength >= this.flushSize) {
      const merged = new Int16Array(this.pendingLength);
      let offset = 0;
      for (const chunk of this.pending) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.pending = [];
      this.pendingLength = 0;
      this.port.postMessage(merged.buffer, [merged.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
