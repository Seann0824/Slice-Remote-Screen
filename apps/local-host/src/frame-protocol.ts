export class LengthPrefixedFrameParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = 16 * 1024 * 1024) {}

  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Buffer[] = [];

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32BE(0);
      if (frameLength === 0 || frameLength > this.maxFrameBytes) {
        throw new Error(`Invalid native frame length: ${frameLength}`);
      }
      if (this.buffer.length < frameLength + 4) break;
      frames.push(this.buffer.subarray(4, frameLength + 4));
      this.buffer = this.buffer.subarray(frameLength + 4);
    }

    return frames;
  }
}
