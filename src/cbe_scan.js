const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "cbe file");
const files = process.argv.slice(2);
const targets = files.length ? files : ["众神之战.CBE", "AppStore.CBE"];

const signatures = {
  GIF87a: Buffer.from("GIF87a", "ascii"),
  GIF89a: Buffer.from("GIF89a", "ascii"),
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPG: Buffer.from([0xff, 0xd8, 0xff]),
  MThd: Buffer.from("MThd", "ascii"),
  PKZIP: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ZLIB_78_01: Buffer.from([0x78, 0x01]),
  ZLIB_78_5E: Buffer.from([0x78, 0x5e]),
  ZLIB_78_9C: Buffer.from([0x78, 0x9c]),
  ZLIB_78_DA: Buffer.from([0x78, 0xda]),
  BMP: Buffer.from("BM", "ascii"),
  RIFF: Buffer.from("RIFF", "ascii"),
};

function hex(n) {
  return "0x" + n.toString(16).toUpperCase();
}

function u32be(buf, off) {
  return buf.readUInt32BE(off);
}

function u32le(buf, off) {
  return buf.readUInt32LE(off);
}

function allPositions(buf, sig, limit = 40) {
  const out = [];
  let idx = 0;
  while ((idx = buf.indexOf(sig, idx)) !== -1) {
    out.push(idx);
    idx += 1;
    if (out.length >= limit) break;
  }
  return out;
}

function asciiStrings(buf, min = 5, limit = 250) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i += 1) {
    const c = i < buf.length ? buf[i] : 0;
    const ok = c >= 0x20 && c <= 0x7e;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= min) out.push({ off: start, text: buf.slice(start, i).toString("ascii") });
      start = -1;
      if (out.length >= limit) break;
    }
  }
  return out;
}

for (const name of targets) {
  const file = path.isAbsolute(name) ? name : path.join(root, name);
  const buf = fs.readFileSync(file);
  console.log(`\n== ${path.basename(file)} size=${buf.length} ${hex(buf.length)} ==`);
  console.log("header u32be:");
  for (let off = 0; off < 0xa0; off += 4) {
    const val = u32be(buf, off);
    if (val !== 0xfefefefe) console.log(`  ${hex(off).padStart(6)}: be=${hex(val).padStart(10)} le=${hex(u32le(buf, off)).padStart(10)}`);
  }
  console.log("signatures:");
  for (const [sigName, sig] of Object.entries(signatures)) {
    const positions = allPositions(buf, sig);
    if (positions.length) console.log(`  ${sigName}: ${positions.map(hex).join(", ")}`);
  }
  console.log("ascii strings:");
  for (const s of asciiStrings(buf)) {
    console.log(`  ${hex(s.off)} ${s.text}`);
  }
}
