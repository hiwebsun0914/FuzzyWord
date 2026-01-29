// Merge data/1.json and data/2.json into data/dictionary.json
// Usage: node tools/merge_json_dicts.js
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const INPUTS = [path.join(DATA_DIR, "1.json"), path.join(DATA_DIR, "2.json")];
const OUTPUT = path.join(DATA_DIR, "dictionary.json");

function readJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

function mergeEntries(lists) {
  const merged = new Map();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || !item.word) continue;
      const word = String(item.word).trim();
      if (!word) continue;
      const key = word.toLowerCase();

      if (!merged.has(key)) {
        merged.set(key, {
          word,
          translations: [],
          phrases: [],
          _tSet: new Set(),
          _pSet: new Set(),
        });
      }
      const target = merged.get(key);
      target.word = word; // keep last seen casing

      if (Array.isArray(item.translations)) {
        for (const t of item.translations) {
          if (!t || !t.translation) continue;
          const translation = String(t.translation).trim();
          if (!translation) continue;
          const type = t.type ? String(t.type).trim() : "";
          const sig = `${type}||${translation}`;
          if (target._tSet.has(sig)) continue;
          target._tSet.add(sig);
          target.translations.push({ translation, type });
        }
      }

      if (Array.isArray(item.phrases)) {
        for (const p of item.phrases) {
          if (!p || !p.phrase || !p.translation) continue;
          const phrase = String(p.phrase).trim();
          const translation = String(p.translation).trim();
          if (!phrase || !translation) continue;
          const sig = `${phrase}||${translation}`;
          if (target._pSet.has(sig)) continue;
          target._pSet.add(sig);
          target.phrases.push({ phrase, translation });
        }
      }
    }
  }

  // convert to final dictionary shape
  const dict = Array.from(merged.values()).map((entry) => {
    const sortedTranslations = entry.translations.sort((a, b) =>
      a.translation.localeCompare(b.translation)
    );
    const posSet = new Set(
      sortedTranslations
        .map((t) => t.type)
        .filter(Boolean)
        .map((t) => t.replace(/\s+/g, ""))
    );
    const pos = Array.from(posSet).join("/") || "";
    const cn = sortedTranslations.map((t) => t.translation).join("; ");
    return {
      word: entry.word,
      pos,
      cn,
      freq: 0,
    };
  });

  dict.sort((a, b) => a.word.localeCompare(b.word));
  return dict;
}

function mergeJsonDicts(inputFiles = INPUTS) {
  const lists = inputFiles.map(readJson);
  const dict = mergeEntries(lists);
  return {
    dict,
    counts: {
      inputLengths: lists.map((l) => (Array.isArray(l) ? l.length : 0)),
      unique: dict.length,
    },
  };
}

function writeMergedDictionary({ inputFiles = INPUTS, outputFile = OUTPUT } = {}) {
  const { dict, counts } = mergeJsonDicts(inputFiles);
  fs.writeFileSync(outputFile, JSON.stringify(dict, null, 2), "utf8");
  return { dict, counts, outputFile };
}

function main() {
  const { counts, outputFile } = writeMergedDictionary();
  console.log(
    `Merged ${counts.inputLengths.join(" + ")} entries -> ${counts.unique} unique words`
  );
  console.log(`Written to ${outputFile}`);
}

if (require.main === module) {
  main();
}

module.exports = { mergeJsonDicts, writeMergedDictionary };
