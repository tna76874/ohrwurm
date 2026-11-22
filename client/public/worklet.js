// AudioWorklet: Resampling auf 16 kHz und energiebasierte Sprachsegmentierung.
// Audio bleibt im Speicher dieses Geräts und wird nach der Transkription verworfen.

const TARGET = 16000;
const FRAME = 480; // 30 ms bei 16 kHz
const PRE_ROLL = 10; // 300 ms Vorlauf
const START_FRAMES = 3; // 90 ms Sprache startet ein Segment
const END_FRAMES = 27; // ~800 ms Stille beendet ein Segment
const MAX_SAMPLES = TARGET * 25; // Segmente höchstens 25 s
const MIN_SAMPLES = TARGET * 0.4;

class OhrwurmVad extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET;
    this.acc = 0;
    this.accN = 0;
    this.phase = 0;
    this.frame = new Float32Array(FRAME);
    this.fi = 0;
    this.noise = 0.003;
    this.inSpeech = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.pre = [];
    this.seg = [];
    this.segLen = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.levelTick = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') this.endSegment(false);
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Mittelwert-Dezimierung: einfacher Tiefpass gegen Aliasing.
      this.acc += ch[i];
      this.accN++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.frame[this.fi++] = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (this.fi === FRAME) {
          this.fi = 0;
          this.handleFrame(new Float32Array(this.frame));
        }
      }
    }
    return true;
  }

  handleFrame(f) {
    let sq = 0;
    for (let i = 0; i < f.length; i++) sq += f[i] * f[i];
    const rms = Math.sqrt(sq / f.length);
    const threshold = Math.max(this.noise * 3, 0.008);
    const speech = rms > threshold;

    if (!this.inSpeech && !speech) {
      this.noise = Math.max(0.0005, this.noise * 0.95 + rms * 0.05);
    }

    if (!this.inSpeech) {
      this.pre.push(f);
      if (this.pre.length > PRE_ROLL) this.pre.shift();
      this.speechFrames = speech ? this.speechFrames + 1 : 0;
      if (this.speechFrames >= START_FRAMES) {
        this.inSpeech = true;
        this.seg = this.pre;
        this.segLen = this.pre.length * FRAME;
        this.pre = [];
        this.silenceFrames = 0;
        this.rmsSum = 0;
        this.rmsN = 0;
      }
    } else {
      this.seg.push(f);
      this.segLen += FRAME;
      if (speech) {
        this.silenceFrames = 0;
        this.rmsSum += rms;
        this.rmsN++;
      } else {
        this.silenceFrames++;
      }
      if (this.silenceFrames >= END_FRAMES) this.endSegment(false);
      else if (this.segLen >= MAX_SAMPLES) this.endSegment(true);
    }

    if (++this.levelTick >= 5) {
      this.levelTick = 0;
      this.port.postMessage({ type: 'level', rms, speech: this.inSpeech });
    }
  }

  endSegment(continueSpeech) {
    if (!this.inSpeech) return;
    if (this.segLen >= MIN_SAMPLES && this.rmsN > 0) {
      const out = new Float32Array(this.segLen);
      let o = 0;
      for (const f of this.seg) {
        out.set(f, o);
        o += f.length;
      }
      this.port.postMessage({ type: 'segment', samples: out, rms: this.rmsSum / this.rmsN }, [out.buffer]);
    }
    this.seg = [];
    this.segLen = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.inSpeech = continueSpeech;
  }
}

registerProcessor('ohrwurm-vad', OhrwurmVad);
