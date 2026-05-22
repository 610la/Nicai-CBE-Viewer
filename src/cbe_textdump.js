const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_text");
const TARGET_EXTS = new Set([".xse"]);
const decoder = new TextDecoder("gb18030");

function usage() {
  console.log(`Usage:
  node src/cbe_textdump.js [unpacked_dir_or_file] [output_dir]

Examples:
  node src/cbe_textdump.js .\\out_godwar .\\out_godwar_text
  node src/cbe_textdump.js .\\out_batch\\众神之战 .\\out_godwar_text`);
}

function isAsciiText(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
}

function isGbkTextPair(lead, trail) {
  const commonHan = lead >= 0xb0 && lead <= 0xf7 && trail >= 0xa1 && trail <= 0xfe;
  const commonPunctuation = (lead === 0xa1 || lead === 0xa3) && trail >= 0xa1 && trail <= 0xfe;
  return commonHan || commonPunctuation;
}

function isAllowedChar(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff，。！？、：；（）【】《》“”‘’·—￥％]/u.test(ch) ||
    /[A-Za-z0-9_ .,:;!?()[\]<>+\-*/\\'"#@$%&=\r\n]/.test(ch);
}

function scoreText(text) {
  const chinese = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  const ascii = (text.match(/[A-Za-z0-9_./\\]/g) || []).length;
  const punctuation = (text.match(/[，。！？、：；（）【】《》“”\[\]]/gu) || []).length;
  return { chinese, ascii, punctuation, score: text.length + chinese * 2 + punctuation };
}

function cleanText(text) {
  return text
    .replace(/[\r\n\t]+/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .replace(/^[A-Za-z0-9#@$%&*?=.+\- ]{1,5}(?=\[)/, "")
    .replace(/([。！？）])\s*[A-Za-z0-9#@$%&*?=.+\-]$/, "$1")
    .trim();
}

function scanTextRuns(buf, minChars = 4) {
  const runs = [];
  let pos = 0;

  while (pos < buf.length) {
    let i = pos;
    let text = "";

    while (i < buf.length) {
      const byte = buf[i];
      if (isAsciiText(byte)) {
        const ch = String.fromCharCode(byte);
        if (!isAllowedChar(ch)) break;
        text += ch;
        i += 1;
        continue;
      }

      const next = buf[i + 1];
      if (isGbkTextPair(byte, next)) {
        const ch = decoder.decode(buf.subarray(i, i + 2));
        if (ch.length !== 1 || !isAllowedChar(ch)) break;
        text += ch;
        i += 2;
        continue;
      }

      break;
    }

    const cleaned = cleanText(text);
    const stats = scoreText(cleaned);
    if (
      cleaned.length >= minChars &&
      stats.score >= 9 &&
      (stats.chinese >= 2 || stats.ascii >= 4)
    ) {
      runs.push({
        offset: pos,
        length: i - pos,
        text: cleaned,
        chinese: stats.chinese,
        ascii: stats.ascii,
      });
    }

    pos = i > pos ? i : pos + 1;
  }

  return runs;
}

function walk(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];

  const out = [];
  for (const name of fs.readdirSync(input)) {
    const file = path.join(input, name);
    const childStat = fs.statSync(file);
    if (childStat.isDirectory()) {
      out.push(...walk(file));
    } else {
      out.push(file);
    }
  }
  return out;
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function dump(input, outDir) {
  const rootStat = fs.statSync(input);
  const root = rootStat.isDirectory() ? input : path.dirname(input);
  const files = walk(input)
    .filter((file) => TARGET_EXTS.has(path.extname(file).toLowerCase()))
    .sort((a, b) => relFrom(root, a).localeCompare(relFrom(root, b), "zh-Hans-CN"));

  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    input,
    generatedAt: new Date().toISOString(),
    encoding: "gb18030",
    files: [],
  };

  const textParts = [];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const strings = scanTextRuns(buf);
    const rel = relFrom(root, file);
    report.files.push({
      file,
      rel,
      size: buf.length,
      strings,
    });

    textParts.push(`## ${rel}`);
    textParts.push(`size=${buf.length} strings=${strings.length}`);
    for (const item of strings) {
      textParts.push(`0x${item.offset.toString(16).toUpperCase().padStart(4, "0")}  ${item.text}`);
    }
    textParts.push("");
  }

  fs.writeFileSync(path.join(outDir, "xse_text.json"), JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "xse_text.txt"), textParts.join("\n"), "utf8");
  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`XSE files: ${files.length}`);
  console.log(`Strings: ${report.files.reduce((sum, file) => sum + file.strings.length, 0)}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  dump(input, outDir);
}

main();
