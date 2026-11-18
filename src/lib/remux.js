// MPEG-TS -> fragmented MP4 without re-encoding. `Transmuxer` is mux.js's constructor
// (globalThis.muxjs.Transmuxer in the offscreen page, require("mux.js").mp4.Transmuxer in Node).
export function createTsRemuxer(Transmuxer) {
  const transmuxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let init = null;
  let ready = [];
  transmuxer.on("data", (segment) => {
    if (!init && segment.initSegment?.length) init = new Uint8Array(segment.initSegment);
    if (segment.data?.length) ready.push(new Uint8Array(segment.data));
  });
  return {
    push(bytes) {
      transmuxer.push(bytes);
      transmuxer.flush();
      const out = ready;
      ready = [];
      return out;
    },
    get init() {
      return init;
    },
  };
}
