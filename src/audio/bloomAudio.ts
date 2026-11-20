// Gentle generative Web Audio piano/celesta arpeggio inspired by the video's ambient soundtrack.
// Zero external audio dependencies; initializes safely upon user interaction.

const CHORD_PROGRESSION: number[][] = [
  // DbMaj9: Db4, F4, Ab4, C5, Eb5
  [277.18, 349.23, 415.3, 523.25, 622.25],
  // Bbm9: Bb3, F4, Ab4, Db5, C5
  [233.08, 349.23, 415.3, 554.37, 523.25],
  // GbMaj7: Gb3, Bb3, Db4, F4, Ab4
  [185.0, 233.08, 277.18, 349.23, 415.3],
  // Ab6/9: Ab3, Eb4, F4, C5, Eb5
  [207.65, 311.13, 349.23, 523.25, 622.25],
];

export class BloomAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private delayNode: DelayNode | null = null;
  private timerId: number | null = null;
  private step = 0;
  private isRunning = false;

  private ensureContext() {
    if (this.ctx) return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 0.0001;

    // Warm tape-like stereo echo for dreamy piano sustain
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.36;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.34;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1850;

    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    filter.connect(master);

    master.connect(ctx.destination);

    this.ctx = ctx;
    this.masterGain = master;
    this.delayNode = delay;
  }

  private playNote(freq: number, velocity = 0.22, duration = 2.6) {
    if (!this.ctx || !this.masterGain || !this.delayNode) return;
    const now = this.ctx.currentTime;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const noteGain = this.ctx.createGain();
    const toneFilter = this.ctx.createBiquadFilter();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);

    // Subtle upper harmonic for celesta/felt-piano warmth
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.16;

    toneFilter.type = 'lowpass';
    toneFilter.frequency.setValueAtTime(2400, now);
    toneFilter.frequency.exponentialRampToValueAtTime(620, now + duration);

    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.linearRampToValueAtTime(velocity, now + 0.024);
    noteGain.gain.exponentialRampToValueAtTime(velocity * 0.38, now + 0.45);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc1.connect(toneFilter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(toneFilter);
    toneFilter.connect(noteGain);

    noteGain.connect(this.masterGain);
    noteGain.connect(this.delayNode);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.05);
    osc2.stop(now + duration + 0.05);
  }

  public start() {
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(0.32, now, 0.25);

    if (this.isRunning) return;
    this.isRunning = true;

    const tick = () => {
      if (!this.isRunning) return;
      const chordIdx = Math.floor(this.step / 8) % CHORD_PROGRESSION.length;
      const chord = CHORD_PROGRESSION[chordIdx];
      const pattern = [0, 1, 2, 3, 4, 3, 2, 1];
      const noteIdx = pattern[this.step % pattern.length];
      const freq = chord[noteIdx];

      // Bass root accent at start of each bar
      if (this.step % 8 === 0) {
        this.playNote(chord[0] * 0.5, 0.16, 3.6);
      }
      this.playNote(freq, 0.18, 2.3);
      this.step++;
    };

    tick();
    this.timerId = window.setInterval(tick, 410);
  }

  public resetPhrase() {
    this.step = 0;
  }

  public stop() {
    this.isRunning = false;
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(0.0001, now, 0.15);
    }
  }

  public dispose() {
    this.stop();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
