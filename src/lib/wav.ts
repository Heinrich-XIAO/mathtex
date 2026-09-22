export async function blobToWav(blob: Blob): Promise<ArrayBuffer> {
  const raw = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(raw);
    return encodeWav(audio, 16000);
  } finally {
    void ctx.close();
  }
}

function encodeWav(audio: AudioBuffer, targetRate: number): ArrayBuffer {
  const src = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < d.length; i++) src[i] += d[i] / audio.numberOfChannels;
  }

  const ratio = audio.sampleRate / targetRate;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, targetRate, true);
  v.setUint32(28, targetRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));
  return buf;
}