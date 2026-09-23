export type LevelListener = (level: number) => void;

export class PushToTalk {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private captureNode: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rawChunks: Float32Array[] = [];
  private raf = 0;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private startedAt = 0;
  private peak = 0;

  onLevel: LevelListener | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    // Live PCM capture for streaming transcription snapshots
    this.rawChunks = [];
    this.captureNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.captureNode.onaudioprocess = (e) => {
      this.rawChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.mute = this.audioCtx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.captureNode);
    this.captureNode.connect(this.mute);
    this.mute.connect(this.audioCtx.destination);

    this.levelData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.startedAt = performance.now();
    this.peak = 0;
    const tick = () => {
      if (!this.analyser || !this.levelData) return;
      this.analyser.getByteTimeDomainData(this.levelData);
      let sum = 0;
      for (let i = 0; i < this.levelData.length; i++) {
        const dev = this.levelData[i] - 128;
        sum += dev * dev;
      }
      const level = Math.min(1, Math.sqrt(sum / this.levelData.length) / 40);
      if (level > this.peak) this.peak = level;
      this.onLevel?.(level);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);

    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : undefined;
    this.recorder = mime
      ? new MediaRecorder(this.stream, { mimeType: mime })
      : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  stop(): Promise<{ blob: Blob; durationMs: number; peak: number }> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec) {
        this.cleanup();
        reject(new Error("Not recording"));
        return;
      }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, {
          type: rec.mimeType || "audio/webm",
        });
        const durationMs = performance.now() - this.startedAt;
        const peak = this.peak;
        this.cleanup();
        resolve({ blob, durationMs, peak });
      };
      rec.stop();
    });
  }

  /** Live PCM snapshot (mono 16 kHz) without stopping the recording —
   * powers incremental transcription while the user is still speaking. */
  snapshotPcm(): { pcm: Float32Array; durationMs: number; peak: number } {
    const total = this.rawChunks.reduce((n, c) => n + c.length, 0);
    const native = new Float32Array(total);
    let off = 0;
    for (const c of this.rawChunks) {
      native.set(c, off);
      off += c.length;
    }
    const inRate = this.audioCtx?.sampleRate ?? 48000;
    const ratio = inRate / 16000;
    const outLen = Math.max(1, Math.floor(native.length / ratio));
    const pcm = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) pcm[i] = native[Math.floor(i * ratio)];
    return { pcm, durationMs: performance.now() - this.startedAt, peak: this.peak };
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.captureNode = null;
    this.mute = null;
    this.source = null;
    this.rawChunks = [];
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this.levelData = null;
    this.onLevel?.(0);
  }
}