import { describe, expect, it } from "vitest";
import { LengthPrefixedFrameParser } from "./frame-protocol.js";

function encodeFrame(payload: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

describe("native frame parser", () => {
  it("reassembles a frame split across chunks", () => {
    const parser = new LengthPrefixedFrameParser();
    const encoded = encodeFrame(Buffer.from("jpeg-data"));
    expect(parser.push(encoded.subarray(0, 6))).toEqual([]);
    expect(parser.push(encoded.subarray(6)).map(String)).toEqual(["jpeg-data"]);
  });

  it("extracts multiple frames from one chunk", () => {
    const parser = new LengthPrefixedFrameParser();
    const frames = parser.push(Buffer.concat([
      encodeFrame(Buffer.from("one")),
      encodeFrame(Buffer.from("two")),
    ]));
    expect(frames.map(String)).toEqual(["one", "two"]);
  });

  it("rejects an oversized frame", () => {
    const parser = new LengthPrefixedFrameParser(8);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9);
    expect(() => parser.push(header)).toThrow(/Invalid native frame length/);
  });
});

