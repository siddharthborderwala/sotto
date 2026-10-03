// Runs on the audio thread. Turns mic audio at the device rate into 16 kHz mono float32,
// posted in 50 ms blocks (the engine's live block size) with each block's RMS for the meter.
//
// Resampling: a windowed-sinc low-pass at 7 kHz (below the 8 kHz Nyquist of the target rate,
// so consonants don't alias into hiss), then linear interpolation at the fractional step.
// Cheap enough to run per sample: 63 taps at 48 kHz is ~3 M multiply-adds a second.

const TARGET_RATE = 16000
const BLOCK = 800 // 50 ms at 16 kHz
const TAPS = 63
const CUTOFF_HZ = 7000

function lowpass(rate) {
  const fc = CUTOFF_HZ / rate
  const mid = (TAPS - 1) / 2
  const h = new Float32Array(TAPS)
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const n = i - mid
    const sinc =
      n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n)
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1))
    h[i] = sinc * blackman
    sum += h[i]
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum // unity gain at DC
  return h
}

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / TARGET_RATE
    this.filter = this.step > 1 ? lowpass(sampleRate) : null
    this.ring = new Float32Array(TAPS)
    this.ringAt = 0
    this.prev = 0
    this.t = 0 // position of the next output sample between prev (0) and current (1)
    this.out = new Float32Array(BLOCK)
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data === "flush" && this.n) this.emit()
    }
  }

  filtered(x) {
    if (!this.filter) return x
    this.ring[this.ringAt] = x
    this.ringAt = (this.ringAt + 1) % TAPS
    let acc = 0
    for (let i = 0, j = this.ringAt; i < TAPS; i++, j = (j + 1) % TAPS)
      acc += this.filter[i] * this.ring[j]
    return acc
  }

  emit() {
    const block = this.out.slice(0, this.n)
    let sq = 0
    for (let i = 0; i < block.length; i++) sq += block[i] * block[i]
    this.port.postMessage({ pcm: block, rms: Math.sqrt(sq / block.length) }, [
      block.buffer,
    ])
    this.n = 0
  }

  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const x = this.filtered(ch[i])
        while (this.t <= 1) {
          this.out[this.n++] = this.prev + (x - this.prev) * this.t
          if (this.n === BLOCK) this.emit()
          this.t += this.step
        }
        this.t -= 1
        this.prev = x
      }
    }
    // Silent output keeps the node pulled by the graph in every browser.
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0)
    return true
  }
}

registerProcessor("pcm-tap", PcmTap)
