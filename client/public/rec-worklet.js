// AudioWorklet fürs Einmessen: nimmt ungefiltert und lückenlos auf, ab einem
// vorgegebenen Frame der AudioContext-Zeitleiste. Der Ton bleibt auf dem Gerät.
class OhrwurmRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.from = -1;
    this.to = -1;
    this.buf = new Float32Array(8192);
    this.bufFrame = -1;
    this.n = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'window') {
        this.from = d.from;
        this.to = d.to;
      }
    };
  }

  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.port.postMessage({ type: 'chunk', frame: this.bufFrame, samples: out }, [out.buffer]);
    }
    this.n = 0;
    this.bufFrame = -1;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const start = currentFrame;
    if (!ch || this.from < 0) return true;
    for (let i = 0; i < ch.length; i++) {
      const f = start + i;
      if (f < this.from || f >= this.to) continue;
      if (this.bufFrame < 0) this.bufFrame = f;
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) this.flush();
    }
    if (start + ch.length >= this.to) {
      this.flush();
      this.port.postMessage({ type: 'done' });
      this.from = -1;
    }
    return true;
  }
}

registerProcessor('ohrwurm-rec', OhrwurmRec);
