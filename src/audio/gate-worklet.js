/* ============================================================================
   Noise gate AudioWorklet processor (preview-only DSP).

   Web Audio has no native gate or expander node, so the live-preview gate is
   hand-written here as an envelope-follower gate. It mirrors the ffmpeg `agate`
   in server/render.mjs at the same chain position (after highpass, before the
   compressor); a close match to the export, not bit-exact parity, is the goal.

   This file is plain JS on purpose: it is shipped to the AudioWorkletGlobalScope
   verbatim via ctx.audioWorklet.addModule(new URL('./gate-worklet.js',
   import.meta.url)). Vite copies it as a static asset and serves it unchanged,
   so it must already be valid JS (no TypeScript syntax to transpile) and must
   NOT import anything from the main bundle: that scope has no DOM and no module
   graph. It uses only the worklet globals (registerProcessor,
   AudioWorkletProcessor, sampleRate).

   Parameters arrive as k-rate AudioParams (set through parameterData on the
   node and editable later via node.parameters):
     threshold  linear amplitude (0..1); envelope below this closes the gate
     range      linear floor gain applied when closed (0..1); 1 = no attenuation
     attack     seconds to open (ramp floor -> 1) once the signal rises
     release    seconds to close (ramp 1 -> floor) once the signal falls
   The envelope follows the rectified input with a short time constant; the
   applied gain ramps toward its target (1 when open, range when closed) with
   the attack/release time constants so the gate does not click or chatter. */

class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /* smoothed signal envelope (rectified, one-pole) */
    this.env = 0;
    /* current applied gain, ramped toward the open/closed target */
    this.gain = 1;
    /* one-pole coefficient for the envelope follower (~5 ms) */
    this.envCoef = Math.exp(-1 / (0.005 * sampleRate));
  }

  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0.01, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 0.001, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.15, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    /* no input connected this block: keep the processor alive, emit silence */
    if (!input || input.length === 0) return true;

    const threshold = params.threshold[0];
    const floor = params.range[0];
    /* per-sample ramp coefficients from the attack/release time constants;
       a zero time means snap (coefficient 0 -> reach target in one sample) */
    const atkCoef = params.attack[0] > 0 ? Math.exp(-1 / (params.attack[0] * sampleRate)) : 0;
    const relCoef = params.release[0] > 0 ? Math.exp(-1 / (params.release[0] * sampleRate)) : 0;

    const frames = input[0].length;
    const channels = output.length;

    for (let i = 0; i < frames; i++) {
      /* envelope follows the loudest channel so a quiet channel does not gate
         speech that is present on another */
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const s = Math.abs(input[c][i]);
        if (s > peak) peak = s;
      }
      this.env = peak + this.envCoef * (this.env - peak);

      /* target gain: open (1) above threshold, attenuated (floor) below it */
      const target = this.env >= threshold ? 1 : floor;
      /* ramp toward the target; opening uses attack, closing uses release */
      const coef = target > this.gain ? atkCoef : relCoef;
      this.gain = target + coef * (this.gain - target);

      for (let c = 0; c < channels; c++) {
        const inCh = input[c] || input[input.length - 1];
        output[c][i] = inCh[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
