// Convert a simple CSV (word,pos,cn[,freq]) into dictionary.json entries.
// Usage: node tools/import_csv.js raw.csv data/dictionary.json
const fs = require("fs");
const path = require("path");

function parseLine(line) {
  // naive CSV split by comma; adjust if your data has quoted commas
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 3) return null;
  const [word, pos, cn, freq] = parts;
  if (!/^[a-zA-Z]+$/.test(word)) return null;
  return {
    word,
    pos: pos || "",
    cn: cn || "",
    freq: freq ? Number(freq) || 0 : 0,
  };
}

function main() {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.log("Usage: node tools/import_csv.js <input.csv> <output.json>");
    process.exit(1);
  }

  const raw = fs.readFileSync(input, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const item = parseLine(line);
    if (item) items.push(item);
  }

  fs.writeFileSync(output, JSON.stringify(items, null, 2), "utf8");
  console.log(`Converted ${items.length} entries to ${output}`);
}

main();
