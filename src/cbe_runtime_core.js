const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive, sanitizeName } = require("./cbe_unpack");
const { buildResourceProfile, classifyResource, cleanName, extOf } = require("./cbe_profile");
const { Provider35C4ServiceObject } = require("./cbe_provider35c4_service_object_probe");
const { ParsedProvider35C4StreamExecutor } = require("./cbe_provider35c4_stream_executor_probe");
const { Provider35C4ObservationChannel } = require("./cbe_provider_observation_channel");

function relForEntry(entry) {
  return [
    `section_${entry.section}_${entry.sectionOffset.toString(16).toUpperCase()}`,
    `${String(entry.index).padStart(4, "0")}_${sanitizeName(entry.name)}`,
  ].join("/");
}

function normalizeName(name) {
  return cleanName(name).toLowerCase();
}

function publicEntry(entry) {
  return {
    section: entry.section,
    index: entry.index,
    name: entry.name,
    cleanName: cleanName(entry.name),
    rel: relForEntry(entry),
    ext: extOf(entry.name),
    kind: classifyResource(entry.name),
    offset: entry.offsetHex,
    end: entry.endHex,
    rawSize: entry.size,
  };
}

class CbeRuntimeCore {
  constructor(options = {}) {
    this.input = path.resolve(options.input || DEFAULT_INPUT);
    this.archive = loadCbeArchive(this.input);
    this.profile = buildResourceProfile(this.archive.entries);
    this.catalog = this.archive.entries.map(publicEntry);
    this.catalogByRel = new Map(this.catalog.map((entry) => [entry.rel, entry]));
    this.catalogByName = new Map();
    for (const entry of this.catalog) {
      const key = normalizeName(entry.name);
      if (!this.catalogByName.has(key)) this.catalogByName.set(key, []);
      this.catalogByName.get(key).push(entry);
    }
    this.provider35c4Channel = new Provider35C4ObservationChannel({
      authority: options.providerAuthority || "non-authoritative-cbe-runtime-core",
    });
  }

  sourceSummary() {
    return {
      input: this.archive.input,
      size: this.archive.size,
      sectionCount: this.archive.sections.length,
      resourceCount: this.archive.entries.length,
      profile: this.profile,
      providerChannelEventCount: this.provider35c4Channel.events.length,
    };
  }

  listResources(options = {}) {
    const extFilter = options.ext ? String(options.ext).toLowerCase() : "";
    const kindFilter = options.kind ? String(options.kind).toLowerCase() : "";
    const query = options.search ? String(options.search).toLowerCase() : "";
    let rows = this.catalog;
    if (extFilter) rows = rows.filter((entry) => entry.ext === extFilter);
    if (kindFilter) rows = rows.filter((entry) => entry.kind === kindFilter);
    if (query) rows = rows.filter((entry) => `${entry.name} ${entry.rel}`.toLowerCase().includes(query));
    return rows.slice(0, options.limit || rows.length);
  }

  findResource(nameOrRel) {
    const text = String(nameOrRel || "");
    if (this.catalogByRel.has(text)) return this.catalogByRel.get(text);
    const rows = this.catalogByName.get(normalizeName(text)) || [];
    return rows[0] || null;
  }

  readResource(entryOrName, options = {}) {
    const publicRow = typeof entryOrName === "string" ? this.findResource(entryOrName) : entryOrName;
    if (!publicRow) throw new Error(`CBE resource not found: ${entryOrName}`);
    const archiveEntry = this.archive.entries.find((entry) => (
      entry.section === publicRow.section && entry.index === publicRow.index && entry.name === publicRow.name
    ));
    if (!archiveEntry) throw new Error(`CBE archive entry not found: ${publicRow.name}`);
    const raw = this.archive.rawPayload(archiveEntry);
    const fixed = options.raw ? { payload: raw, note: "" } : fixupPayload(archiveEntry.name, raw);
    return {
      ...publicRow,
      raw,
      fixed: fixed.payload,
      fixupNote: fixed.note || "",
    };
  }

  createProvider35C4Service(options = {}) {
    return new Provider35C4ServiceObject({
      observedMatches: options.observedMatches || [],
      observationSink: options.observationSink || this.provider35c4Channel.sink(options.surface || "runtime-core"),
    });
  }

  createProvider35C4StreamExecutor(options = {}) {
    return new ParsedProvider35C4StreamExecutor({
      observedMatches: options.observedMatches || [],
      observationSink: options.observationSink || this.provider35c4Channel.sink(options.surface || "parsed-stream"),
    });
  }

  providerObservationSummary() {
    return {
      ...this.provider35c4Channel.counts(),
      surfaces: this.provider35c4Channel.events.reduce((acc, row) => {
        const key = row.recorderSurface || "(none)";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

module.exports = {
  CbeRuntimeCore,
  relForEntry,
  normalizeName,
  publicEntry,
};
