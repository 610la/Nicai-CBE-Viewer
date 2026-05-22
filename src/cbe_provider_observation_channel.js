function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function compactSite(site) {
  return String(site || "").replace(/^0x0*/i, "0x").toUpperCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validateProvider35C4Observation(row) {
  const problems = [];
  if (row.capturePointId !== "provider35c4-label-ref-compare-1") problems.push("wrong-capture-point");
  if (compactSite(row.site) !== compactSite("0x0001233C")) problems.push("wrong-site");
  if (row.serviceGlobal !== "0x35C4") problems.push("wrong-service");
  if (row.method !== "+0x50") problems.push("wrong-method");
  if (row.dispatchShape !== "label-ref-compare") problems.push("wrong-shape");
  if (!row.label) problems.push("missing-label");
  if (!row.providerRefId) problems.push("missing-providerRefId");
  if (!Number.isFinite(Number(row.returnValue))) problems.push("missing-returnValue");
  return problems;
}

function annotateProvider35C4Observation(row) {
  const problems = validateProvider35C4Observation(row);
  const returnValue = numberOrNull(row.returnValue);
  return {
    ...row,
    returnValue,
    validForAdapter: problems.length === 0,
    validForFeed: problems.length === 0 && returnValue === 0,
    nonMatchObservation: problems.length === 0 && returnValue !== 0,
    problems,
  };
}

function createProvider35C4ObservationPayload(observations, options = {}) {
  return {
    schema: "nicai.cbe.provider35c4Return0Observations.v1",
    generatedAt: options.generatedAt || new Date().toISOString(),
    authority: options.authority || "non-authoritative-js-provider-observation-channel",
    notes: options.notes || [
      "This file is emitted by the JS provider observation channel, not by native provider instrumentation.",
      "It is adapter-compatible evidence and must not replace provider35c4_return0_observations.json.",
      "Only real provider rows with returnValue === 0 can feed resolver matches.",
    ],
    observations,
  };
}

class Provider35C4ObservationChannel {
  constructor(options = {}) {
    this.authority = options.authority || "non-authoritative-js-provider-observation-channel";
    this.events = [];
    this.subscribers = [];
  }

  subscribe(fn) {
    if (typeof fn !== "function") throw new Error("Provider35C4ObservationChannel.subscribe expected a function");
    this.subscribers.push(fn);
    return () => {
      const index = this.subscribers.indexOf(fn);
      if (index >= 0) this.subscribers.splice(index, 1);
    };
  }

  record(row, options = {}) {
    const label = row.label || row.callerLabel || row.normalizedLabel || "";
    const event = {
      observationSeq: this.events.length + 1,
      recorderSurface: options.surface || row.recorderSurface || "",
      capturePointId: row.capturePointId || "provider35c4-label-ref-compare-1",
      site: row.site || "0x0001233C",
      serviceGlobal: row.serviceGlobal || "0x35C4",
      namespaceId: row.namespaceId || "provider:0x35C4:+0x64/+0x50",
      method: row.method || "+0x50",
      dispatchShape: row.dispatchShape || "label-ref-compare",
      script: row.script || row.resource || "",
      resource: row.resource || row.script || "",
      policy: row.policy || "",
      context: row.context || "",
      label,
      callerLabel: row.callerLabel || label,
      normalizedLabel: normalizeLabel(row.normalizedLabel || label),
      providerRefId: row.providerRefId || "",
      returnValue: numberOrNull(row.returnValue),
      source: row.source || options.source || "",
      sourceSeq: row.sourceSeq,
      opSeq: row.opSeq,
      role: row.role || "",
      refKnown: Boolean(row.refKnown),
      refProducerSeq: row.refProducerSeq,
      compareStatus: row.compareStatus || "",
      start: row.start || "",
      modeKey: row.modeKey || "",
      laneIndex: row.laneIndex,
      entryIndex: row.entryIndex,
      entryOffset: row.entryOffset || "",
      field04: row.field04,
      field08: row.field08,
      field0C: row.field0C,
      refRaw: row.refRaw || "",
      refMode: row.refMode || "",
    };
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  sink(surface, options = {}) {
    return (row) => this.record(row, {
      surface,
      source: options.source || `${surface}-runtime-sink`,
    });
  }

  annotatedEvents() {
    return this.events.map((event) => annotateProvider35C4Observation(event));
  }

  eventsBySurface(surface, { annotated = false } = {}) {
    const rows = annotated ? this.annotatedEvents() : this.events;
    return rows.filter((row) => row.recorderSurface === surface);
  }

  invalidRows() {
    return this.annotatedEvents().filter((row) => row.problems.length > 0);
  }

  feedRows() {
    return this.annotatedEvents().filter((row) => row.validForFeed);
  }

  nonMatchRows() {
    return this.annotatedEvents().filter((row) => row.nonMatchObservation);
  }

  counts() {
    const annotated = this.annotatedEvents();
    const invalid = annotated.filter((row) => row.problems.length > 0);
    const feed = annotated.filter((row) => row.validForFeed);
    const nonMatch = annotated.filter((row) => row.nonMatchObservation);
    return {
      totalObservationCount: annotated.length,
      adapterCompatibleObservationCount: annotated.length - invalid.length,
      invalidObservationCount: invalid.length,
      return0ObservationCount: feed.length,
      nonMatchObservationCount: nonMatch.length,
      observedFeedRowCount: feed.length,
    };
  }

  toCapturePayload(options = {}) {
    return createProvider35C4ObservationPayload(this.annotatedEvents(), {
      authority: options.authority || this.authority,
      generatedAt: options.generatedAt,
      notes: options.notes,
    });
  }
}

module.exports = {
  Provider35C4ObservationChannel,
  annotateProvider35C4Observation,
  compactSite,
  createProvider35C4ObservationPayload,
  normalizeLabel,
  validateProvider35C4Observation,
};
