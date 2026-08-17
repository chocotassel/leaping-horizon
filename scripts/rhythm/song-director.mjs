export const DIRECTOR_ALGORITHM = 'music-evidence-song-director-v1';

const ANCHOR_MERGE_SECONDS = 0.055;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function sourceKind(sourceId) {
  if (sourceId === 'beat-this') return 'beat';
  if (sourceId === 'librosa-onset') return 'onset';
  if (sourceId === 'basic-pitch') return 'melody';
  return 'detector';
}

function candidatePriority(candidate) {
  if (candidate.kind === 'section-boundary') return 7;
  if (candidate.isDownbeat) return 6;
  if (candidate.kind === 'beat') return 5;
  if (candidate.kind === 'onset') return 4;
  if (candidate.kind === 'bar-boundary') return 3;
  if (candidate.kind === 'phrase-boundary') return 2;
  return 1;
}

function pushBoundaryCandidates(target, items, scope, kind) {
  const sorted = Array.isArray(items)
    ? [...items].sort((left, right) => (
      finite(left?.startSeconds) - finite(right?.startSeconds)
      || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
    ))
    : [];
  for (const [index, item] of sorted.entries()) {
    const itemId = String(item?.id ?? `${scope}-${index + 1}`);
    const measuredStart = finite(item?.startSeconds);
    const measuredEnd = finite(item?.endSeconds);
    if (Number.isFinite(measuredStart) && Number.isFinite(measuredEnd) && measuredEnd <= measuredStart) continue;
    for (const edge of ['start', 'end']) {
      const timeSeconds = finite(item?.[`${edge}Seconds`]);
      if (!Number.isFinite(timeSeconds)) continue;
      const boundarySupport = clamp(finite(item?.boundarySupport, kind === 'section-boundary' ? 0.5 : 0.35));
      target.push({
        evidenceId: `${scope}:${itemId}:${edge}`,
        timeSeconds,
        confidence: boundarySupport,
        kind,
        sourceId: scope,
        isDownbeat: false,
      });
    }
  }
}

function measuredCandidates(analysis) {
  const candidates = [];
  const eventSources = Array.isArray(analysis?.eventSources)
    ? [...analysis.eventSources].sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
    : [];
  for (const [sourceIndex, source] of eventSources.entries()) {
    const sourceId = String(source?.id ?? `source-${sourceIndex + 1}`);
    const events = Array.isArray(source?.events)
      ? [...source.events].sort((left, right) => (
        finite(left?.timeSeconds) - finite(right?.timeSeconds)
        || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
      ))
      : [];
    for (const [eventIndex, event] of events.entries()) {
      const timeSeconds = finite(event?.timeSeconds);
      if (!Number.isFinite(timeSeconds)) continue;
      candidates.push({
        evidenceId: `event:${sourceId}:${String(event?.id ?? eventIndex + 1)}`,
        timeSeconds,
        confidence: clamp(finite(event?.confidence, 0.65)),
        kind: sourceKind(sourceId),
        sourceId,
        isDownbeat: event?.isDownbeat === true,
      });
    }
  }

  const structure = analysis?.musicalStructure ?? {};
  const structuralBeats = Array.isArray(structure.beats) ? structure.beats : [];
  for (const [index, beat] of structuralBeats.entries()) {
    const timeSeconds = finite(beat?.timeSeconds);
    if (!Number.isFinite(timeSeconds)) continue;
    candidates.push({
      evidenceId: `structure:beat:${String(beat?.index ?? index)}`,
      timeSeconds,
      confidence: beat?.isDownbeat === true ? 1 : 0.72,
      kind: 'beat',
      sourceId: 'musical-structure',
      isDownbeat: beat?.isDownbeat === true,
    });
  }
  const structuralDownbeats = Array.isArray(structure.downbeats) ? structure.downbeats : [];
  for (const [index, downbeat] of structuralDownbeats.entries()) {
    const timeSeconds = finite(downbeat?.timeSeconds);
    if (!Number.isFinite(timeSeconds)) continue;
    candidates.push({
      evidenceId: `structure:downbeat:${String(downbeat?.index ?? index)}`,
      timeSeconds,
      confidence: 1,
      kind: 'beat',
      sourceId: 'musical-structure',
      isDownbeat: true,
    });
  }
  const bars = Array.isArray(structure.bars) ? structure.bars : [];
  for (const [index, bar] of bars.entries()) {
    const timeSeconds = finite(bar?.downbeatTimeSeconds ?? bar?.startSeconds);
    if (!Number.isFinite(timeSeconds)) continue;
    candidates.push({
      evidenceId: `structure:bar:${String(bar?.id ?? bar?.index ?? index)}`,
      timeSeconds,
      confidence: 0.9,
      kind: 'bar-boundary',
      sourceId: 'musical-structure',
      isDownbeat: true,
    });
  }
  pushBoundaryCandidates(candidates, structure.sections, 'section', 'section-boundary');
  pushBoundaryCandidates(candidates, structure.phrases, 'phrase', 'phrase-boundary');
  pushBoundaryCandidates(candidates, structure.overlappingPhrases, 'overlap-phrase', 'phrase-boundary');
  return candidates.sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || candidatePriority(right) - candidatePriority(left)
    || left.evidenceId.localeCompare(right.evidenceId)
  ));
}

function buildAnchors(analysis) {
  const groups = [];
  for (const candidate of measuredCandidates(analysis)) {
    const previous = groups.at(-1);
    if (previous && candidate.timeSeconds - previous.at(-1).timeSeconds <= ANCHOR_MERGE_SECONDS) {
      previous.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }

  return groups.map((group, index) => {
    const canonical = [...group].sort((left, right) => (
      candidatePriority(right) - candidatePriority(left)
      || right.confidence - left.confidence
      || left.timeSeconds - right.timeSeconds
      || left.evidenceId.localeCompare(right.evidenceId)
    ))[0];
    const kinds = [...new Set(group.map((candidate) => candidate.kind))].sort();
    const sourceIds = [...new Set(group.map((candidate) => candidate.sourceId))].sort();
    const confidence = Math.max(...group.map((candidate) => candidate.confidence));
    const convergence = Math.min(0.28, (kinds.length - 1) * 0.09 + (sourceIds.length - 1) * 0.035);
    const structuralBonus = group.some((candidate) => candidate.kind === 'section-boundary') ? 0.18 : 0;
    const downbeatBonus = group.some((candidate) => candidate.isDownbeat) ? 0.12 : 0;
    return {
      id: `anchor-${String(index + 1).padStart(4, '0')}`,
      timeSeconds: canonical.timeSeconds,
      salience: round(clamp(confidence * 0.62 + convergence + structuralBonus + downbeatBonus)),
      confidence: round(confidence),
      evidenceIds: group.map((candidate) => candidate.evidenceId).sort(),
      evidenceKinds: kinds,
      sourceIds,
      isDownbeat: group.some((candidate) => candidate.isDownbeat),
      structuralBoundary: group.some((candidate) => candidate.kind === 'section-boundary'),
      phraseBoundary: group.some((candidate) => candidate.kind === 'phrase-boundary'),
    };
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function intervalCoverage(intervals, durationSeconds) {
  if (!(durationSeconds > 0) || !intervals.length) return 0;
  const ordered = intervals
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  if (!ordered.length) return 0;
  let covered = 0;
  let start = ordered[0].startSeconds;
  let end = ordered[0].endSeconds;
  for (const interval of ordered.slice(1)) {
    if (interval.startSeconds <= end) {
      end = Math.max(end, interval.endSeconds);
    } else {
      covered += end - start;
      start = interval.startSeconds;
      end = interval.endSeconds;
    }
  }
  covered += end - start;
  return round(clamp(covered / durationSeconds));
}

function phraseNodes(structure) {
  const collections = [
    { scope: 'primary', phrases: structure?.phrases },
    { scope: 'overlapping', phrases: structure?.overlappingPhrases },
  ];
  const nodes = [];
  for (const { scope, phrases } of collections) {
    const sorted = Array.isArray(phrases)
      ? [...phrases].sort((left, right) => (
        finite(left?.startSeconds) - finite(right?.startSeconds)
        || finite(left?.endSeconds) - finite(right?.endSeconds)
        || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
      ))
      : [];
    for (const [index, phrase] of sorted.entries()) {
      const startSeconds = finite(phrase?.startSeconds);
      const endSeconds = finite(phrase?.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) continue;
      const rawId = String(phrase?.id ?? `${scope}-phrase-${index + 1}`);
      nodes.push({
        key: `${scope}:${rawId}`,
        rawId,
        scope,
        startSeconds,
        endSeconds,
        intensity: clamp(finite(phrase?.intensity, 0.5)),
        familyId: phrase?.familyId == null ? null : String(phrase.familyId),
        familyKind: phrase?.familyKind == null ? null : String(phrase.familyKind),
        familyConfidence: Number.isFinite(Number(phrase?.familyConfidence))
          ? clamp(Number(phrase.familyConfidence))
          : null,
      });
    }
  }
  return nodes;
}

function makeDisjointSet(keys) {
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    const current = parent.get(key);
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot.localeCompare(rightRoot) <= 0) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };
  return { find, union };
}

function meanOccurrenceDuration(identity) {
  return mean(identity.occurrences.map((occurrence) => occurrence.endSeconds - occurrence.startSeconds));
}

function sharesOverlappingRecurrence(left, right) {
  const tolerance = Math.max(
    0.08,
    Math.min(meanOccurrenceDuration(left), meanOccurrenceDuration(right)) * 0.04,
  );
  const matches = [];
  let lastRightIndex = -1;
  for (const [leftIndex, occurrence] of left.occurrences.entries()) {
    const candidates = right.occurrences
      .map((other, rightIndex) => {
        const intersection = Math.max(
          0,
          Math.min(occurrence.endSeconds, other.endSeconds)
          - Math.max(occurrence.startSeconds, other.startSeconds),
        );
        const smallerDuration = Math.min(
          occurrence.endSeconds - occurrence.startSeconds,
          other.endSeconds - other.startSeconds,
        );
        return {
          leftIndex,
          rightIndex,
          overlap: smallerDuration > 0 ? intersection / smallerDuration : 0,
        };
      })
      .filter((candidate) => candidate.rightIndex > lastRightIndex && candidate.overlap >= 0.5)
      .sort((a, b) => b.overlap - a.overlap || a.rightIndex - b.rightIndex);
    if (!candidates.length) continue;
    matches.push(candidates[0]);
    lastRightIndex = candidates[0].rightIndex;
  }
  if (matches.length < 2) return false;
  const origin = matches[0];
  return matches.slice(1).every((match) => Math.abs(
    (
      left.occurrences[match.leftIndex].startSeconds
      - left.occurrences[origin.leftIndex].startSeconds
    )
    - (
      right.occurrences[match.rightIndex].startSeconds
      - right.occurrences[origin.rightIndex].startSeconds
    )
  ) <= tolerance);
}

function convergeOverlappingExactContracts(identities) {
  const isOverlapExact = (identity) => (
    identity.relation === 'exact'
    && identity.componentKeys.size > 0
    && [...identity.componentKeys].every((key) => key.startsWith('overlapping:'))
  );
  const candidates = identities.filter(isOverlapExact).sort((left, right) => (
    meanOccurrenceDuration(right) * (0.75 + right.confidence * 0.25)
    - meanOccurrenceDuration(left) * (0.75 + left.confidence * 0.25)
    || right.confidence - left.confidence
    || left.occurrences[0].startSeconds - right.occurrences[0].startSeconds
    || left.evidenceIds.join('|').localeCompare(right.evidenceIds.join('|'))
  ));
  const retained = [];
  const supportingEvidenceByIdentity = new Map();
  const suppressed = new Set();
  for (const candidate of candidates) {
    const dominant = retained.find((existing) => (
      sharesOverlappingRecurrence(existing, candidate)
    ));
    if (!dominant) {
      retained.push(candidate);
      supportingEvidenceByIdentity.set(candidate, []);
      continue;
    }
    suppressed.add(candidate);
    supportingEvidenceByIdentity.get(dominant).push(...candidate.evidenceIds);
  }
  const retainedSet = new Set(retained);
  return {
    identities: identities
      .filter((identity) => !isOverlapExact(identity) || retainedSet.has(identity))
      .map((identity) => ({
        ...identity,
        supportingExactEvidenceIds: [...new Set(supportingEvidenceByIdentity.get(identity) ?? [])].sort(),
      }))
      .sort((left, right) => (
        left.occurrences[0].startSeconds - right.occurrences[0].startSeconds
        || left.occurrences[0].endSeconds - right.occurrences[0].endSeconds
        || left.occurrences[0].sourcePhraseIds.join('|').localeCompare(right.occurrences[0].sourcePhraseIds.join('|'))
      )),
    suppressedCount: suppressed.size,
  };
}

function buildPhraseIdentities(analysis) {
  const structure = analysis?.musicalStructure ?? {};
  const nodes = phraseNodes(structure);
  if (!nodes.length) {
    return {
      identities: [],
      phraseCoverage: 0,
      repetitionCoverage: 0,
      repetitionAgreement: null,
      suppressedExactContractCount: 0,
    };
  }

  const nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  const keysByRawId = new Map();
  for (const node of nodes) {
    if (!keysByRawId.has(node.rawId)) keysByRawId.set(node.rawId, []);
    keysByRawId.get(node.rawId).push(node.key);
  }
  const sets = makeDisjointSet(nodes.map((node) => node.key));
  const relations = [];
  const connect = (leftKey, rightKey, relation, similarity, evidenceId) => {
    if (!nodesByKey.has(leftKey) || !nodesByKey.has(rightKey) || leftKey === rightKey) return;
    sets.union(leftKey, rightKey);
    relations.push({
      leftKey,
      rightKey,
      relation,
      similarity: similarity != null && Number.isFinite(Number(similarity))
        ? clamp(Number(similarity))
        : null,
      evidenceId,
    });
  };

  const implicitFamilies = new Map();
  for (const node of nodes) {
    if (!node.familyId) continue;
    const familyKey = `${node.scope}:${node.familyId}`;
    if (!implicitFamilies.has(familyKey)) implicitFamilies.set(familyKey, []);
    implicitFamilies.get(familyKey).push(node.key);
  }
  for (const [familyKey, memberKeys] of [...implicitFamilies.entries()].sort()) {
    const ordered = [...memberKeys].sort();
    for (const memberKey of ordered.slice(1)) {
      const confidences = [nodesByKey.get(ordered[0])?.familyConfidence, nodesByKey.get(memberKey)?.familyConfidence]
        .filter(Number.isFinite);
      connect(ordered[0], memberKey, 'exact', confidences.length ? mean(confidences) : null, `implicit-family:${familyKey}`);
    }
  }

  const declaredFamilyCollections = [
    { scope: 'primary', families: structure?.families },
    { scope: 'overlapping', families: structure?.overlappingPhraseFamilies },
  ];
  const declaredMembers = new Map();
  const familyRecords = [];
  for (const { scope, families } of declaredFamilyCollections) {
    const orderedFamilies = Array.isArray(families)
      ? [...families].sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
      : [];
    for (const family of orderedFamilies) {
      const familyId = String(family?.id ?? '');
      if (!familyId) continue;
      const familyKey = `${scope}:${familyId}`;
      const listedIds = Array.isArray(family?.phraseIds) ? family.phraseIds.map(String) : [];
      const memberKeys = [...new Set([
        ...listedIds.flatMap((rawId) => (keysByRawId.get(rawId) ?? []).filter((key) => key.startsWith(`${scope}:`))),
        ...(implicitFamilies.get(familyKey) ?? []),
      ])].sort();
      declaredMembers.set(familyKey, memberKeys);
      familyRecords.push({ family, familyId, familyKey, memberKeys, scope });
      for (const memberKey of memberKeys.slice(1)) {
        connect(memberKeys[0], memberKey, 'exact', family?.confidence, `family:${familyKey}`);
      }
    }
  }
  for (const record of familyRecords) {
    const relatedIds = Array.isArray(record.family?.relatedFamilyIds)
      ? [...record.family.relatedFamilyIds].map(String).sort()
      : [];
    for (const relatedId of relatedIds) {
      const relatedKeys = declaredMembers.get(`${record.scope}:${relatedId}`)
        ?? implicitFamilies.get(`${record.scope}:${relatedId}`)
        ?? [];
      if (record.memberKeys[0] && relatedKeys[0]) {
        connect(
          record.memberKeys[0],
          relatedKeys[0],
          'developed',
          Math.min(clamp(finite(record.family?.confidence, 0.5)), 0.89),
          `related-family:${record.familyKey}:${relatedId}`,
        );
      }
    }
  }

  const links = Array.isArray(structure?.phraseLinks)
    ? [...structure.phraseLinks].sort((left, right) => (
      String(left?.sourcePhraseId ?? '').localeCompare(String(right?.sourcePhraseId ?? ''))
      || String(left?.targetPhraseId ?? '').localeCompare(String(right?.targetPhraseId ?? ''))
      || String(left?.relationship ?? '').localeCompare(String(right?.relationship ?? ''))
    ))
    : [];
  for (const link of links) {
    const sourceKeys = keysByRawId.get(String(link?.sourcePhraseId ?? '')) ?? [];
    const targetKeys = keysByRawId.get(String(link?.targetPhraseId ?? '')) ?? [];
    const relationship = link?.relationship === 'related-variant' ? 'developed' : 'exact';
    for (const leftKey of sourceKeys) {
      for (const rightKey of targetKeys) {
        connect(
          leftKey,
          rightKey,
          relationship,
          link?.similarity,
          `phrase-link:${String(link?.sourcePhraseId)}:${String(link?.targetPhraseId)}:${String(link?.relationship ?? 'same-family')}`,
        );
      }
    }
  }

  const equivalentWindows = new Map();
  for (const node of nodes) {
    const intervalKey = `${round(node.startSeconds, 3)}:${round(node.endSeconds, 3)}`;
    if (!equivalentWindows.has(intervalKey)) equivalentWindows.set(intervalKey, []);
    equivalentWindows.get(intervalKey).push(node.key);
  }
  for (const [intervalKey, memberKeys] of [...equivalentWindows.entries()].sort()) {
    const ordered = [...memberKeys].sort();
    for (const memberKey of ordered.slice(1)) {
      connect(ordered[0], memberKey, 'equivalent-window', null, `equivalent-window:${intervalKey}`);
    }
  }

  const components = new Map();
  for (const node of nodes) {
    const root = sets.find(node.key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(node);
  }
  const preliminaryDrafts = [...components.values()].map((componentNodes) => {
    const componentKeys = new Set(componentNodes.map((node) => node.key));
    const componentRelations = relations.filter((relation) => (
      componentKeys.has(relation.leftKey) && componentKeys.has(relation.rightKey)
    ));
    const occurrencesByInterval = new Map();
    for (const node of componentNodes) {
      const intervalKey = `${round(node.startSeconds, 3)}:${round(node.endSeconds, 3)}`;
      if (!occurrencesByInterval.has(intervalKey)) occurrencesByInterval.set(intervalKey, []);
      occurrencesByInterval.get(intervalKey).push(node);
    }
    const occurrences = [...occurrencesByInterval.values()].map((occurrenceNodes) => ({
      startSeconds: Math.min(...occurrenceNodes.map((node) => node.startSeconds)),
      endSeconds: Math.max(...occurrenceNodes.map((node) => node.endSeconds)),
      sourcePhraseIds: [...new Set(occurrenceNodes.map((node) => node.rawId))].sort(),
      sourceFamilyIds: [...new Set(occurrenceNodes.map((node) => node.familyId).filter(Boolean))].sort(),
      intensity: round(mean(occurrenceNodes.map((node) => node.intensity))),
    })).sort((left, right) => (
      left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds
      || left.sourcePhraseIds.join('|').localeCompare(right.sourcePhraseIds.join('|'))
    ));
    const hasDevelopedEvidence = componentRelations.some((relation) => relation.relation === 'developed');
    const relation = hasDevelopedEvidence
      ? 'developed'
      : occurrences.length > 1
        ? 'exact'
        : 'unique';
    const confidenceEvidence = [
      ...componentNodes.map((node) => node.familyConfidence),
      ...componentRelations.map((edge) => edge.similarity),
    ].filter(Number.isFinite);
    return {
      relation,
      developmentPolicy: relation === 'exact'
        ? 'preserve-canonical-kinetic-form'
        : relation === 'developed'
          ? 'preserve-form-with-directed-development'
          : 'independent-form',
      sourceFamilyIds: [...new Set(componentNodes.map((node) => node.familyId).filter(Boolean))].sort(),
      occurrences,
      confidence: round(confidenceEvidence.length ? mean(confidenceEvidence) : 0.5),
      evidenceIds: [...new Set([
        ...componentNodes.map((node) => `phrase:${node.scope}:${node.rawId}`),
        ...componentRelations.map((relationEdge) => relationEdge.evidenceId),
      ])].sort(),
      componentKeys,
      componentRelations,
    };
  }).sort((left, right) => (
    left.occurrences[0].startSeconds - right.occurrences[0].startSeconds
    || left.occurrences[0].endSeconds - right.occurrences[0].endSeconds
    || left.occurrences[0].sourcePhraseIds.join('|').localeCompare(right.occurrences[0].sourcePhraseIds.join('|'))
  ));

  const convergence = convergeOverlappingExactContracts(preliminaryDrafts);
  const preliminary = convergence.identities;
  const durationSeconds = Math.max(
    finite(analysis?.song?.durationSeconds, 0),
    ...nodes.map((node) => node.endSeconds),
  );
  const identities = preliminary.map((identity, index) => ({
    id: `phrase-identity-${String(index + 1).padStart(3, '0')}`,
    relation: identity.relation,
    developmentPolicy: identity.developmentPolicy,
    sourceFamilyIds: identity.sourceFamilyIds,
    occurrences: identity.occurrences.map((occurrence, occurrenceIndex) => ({
      id: `phrase-identity-${String(index + 1).padStart(3, '0')}-occurrence-${String(occurrenceIndex + 1).padStart(2, '0')}`,
      ...occurrence,
    })),
    coverage: intervalCoverage(identity.occurrences, durationSeconds),
    confidence: identity.confidence,
    evidenceIds: identity.evidenceIds,
    supportingExactEvidenceIds: identity.supportingExactEvidenceIds,
    kineticForm: deriveKineticForm(analysis, identity),
  }));
  const repeatedKeys = new Set(preliminary
    .filter((identity) => identity.relation !== 'unique')
    .flatMap((identity) => [...identity.componentKeys]));
  const agreementValues = preliminary
    .filter((identity) => identity.occurrences.length > 1)
    .flatMap((identity) => identity.componentRelations)
    .filter((relation) => relation.relation === 'exact' && Number.isFinite(relation.similarity))
    .map((relation) => relation.similarity);

  return {
    identities,
    phraseCoverage: intervalCoverage(nodes, durationSeconds),
    repetitionCoverage: round(repeatedKeys.size / nodes.length),
    repetitionAgreement: agreementValues.length ? round(mean(agreementValues)) : null,
    suppressedExactContractCount: convergence.suppressedCount,
  };
}

function pitchOf(event) {
  const candidates = [event?.midiPitch, event?.pitchMidi, event?.pitch, event?.pitchMean];
  for (const candidate of candidates) {
    if (Number.isFinite(Number(candidate))) return Number(candidate);
  }
  return Number.NaN;
}

function pitchStatsForOccurrence(analysis, occurrence) {
  const duration = occurrence.endSeconds - occurrence.startSeconds;
  if (!(duration > 0)) return null;
  const points = eventsInRange(
    analysis,
    'basic-pitch',
    occurrence.startSeconds,
    occurrence.endSeconds,
  ).map((event) => ({
    x: (finite(event?.timeSeconds) - occurrence.startSeconds) / duration,
    y: pitchOf(event),
    confidence: clamp(finite(event?.confidence, 0.65)),
    polyphony: Math.max(1, finite(event?.polyphony, 1)),
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 2) return null;
  const weights = points.map((point) => point.confidence);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const xMean = points.reduce((sum, point) => sum + point.x * point.confidence, 0) / totalWeight;
  const yMean = points.reduce((sum, point) => sum + point.y * point.confidence, 0) / totalWeight;
  const numerator = points.reduce(
    (sum, point) => sum + point.confidence * (point.x - xMean) * (point.y - yMean),
    0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + point.confidence * (point.x - xMean) ** 2,
    0,
  );
  const directions = [];
  for (let index = 1; index < points.length; index += 1) {
    const difference = points[index].y - points[index - 1].y;
    if (Math.abs(difference) >= 0.5) directions.push(Math.sign(difference));
  }
  let directionChanges = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] !== directions[index - 1]) directionChanges += 1;
  }
  return {
    slope: denominator > 1e-9 ? numerator / denominator : 0,
    range: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
    turnRatio: directions.length > 1 ? directionChanges / (directions.length - 1) : 0,
    confidence: clamp(totalWeight / Math.max(3, points.length)),
    polyphony: mean(points.map((point) => point.polyphony)),
    eventCount: points.length,
  };
}

function pressureContourForOccurrence(analysis, occurrence, binCount = 5) {
  const duration = occurrence.endSeconds - occurrence.startSeconds;
  if (!(duration > 0)) return Array.from({ length: binCount }, () => 0);
  const expectedBeatRate = Math.max(0.5, finite(analysis?.song?.bpm, 120) / 60);
  return Array.from({ length: binCount }, (_, index) => {
    const startSeconds = occurrence.startSeconds + duration * index / binCount;
    const endSeconds = occurrence.startSeconds + duration * (index + 1) / binCount;
    const binDuration = Math.max(1e-6, endSeconds - startSeconds);
    const onsetRate = eventsInRange(analysis, 'librosa-onset', startSeconds, endSeconds).length / binDuration;
    const melodyRate = eventsInRange(analysis, 'basic-pitch', startSeconds, endSeconds).length / binDuration;
    return clamp(
      waveformEnergy(analysis, startSeconds, endSeconds) * 0.55
      + clamp(onsetRate / expectedBeatRate) * 0.3
      + clamp(melodyRate / expectedBeatRate) * 0.15,
    );
  });
}

function songPolyphonyContext(analysis) {
  const source = Array.isArray(analysis?.eventSources)
    ? analysis.eventSources.find((candidate) => candidate?.id === 'basic-pitch')
    : null;
  const values = Array.isArray(source?.events)
    ? source.events
      .filter((event) => (
        Number.isFinite(Number(event?.timeSeconds))
        && Number.isFinite(pitchOf(event))
      ))
      .map((event) => Math.max(1, finite(event?.polyphony, 1)))
    : [];
  const baseline = values.length ? mean(values) : 1;
  const variance = values.length
    ? mean(values.map((value) => (value - baseline) ** 2))
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const upperQuartile = values.length ? percentile(values, 0.75) : 1;
  return {
    eventCount: values.length,
    baseline,
    upperQuartile,
    salienceThreshold: Math.max(
      baseline + Math.max(0.35, standardDeviation * 0.5),
      upperQuartile - 0.25,
    ),
  };
}

function deriveKineticForm(analysis, identity) {
  const pitchStats = identity.occurrences
    .map((occurrence) => pitchStatsForOccurrence(analysis, occurrence))
    .filter(Boolean);
  const slope = pitchStats.length ? mean(pitchStats.map((stats) => stats.slope)) : 0;
  const pitchRange = pitchStats.length ? mean(pitchStats.map((stats) => stats.range)) : 0;
  const turnRatio = pitchStats.length ? mean(pitchStats.map((stats) => stats.turnRatio)) : 0;
  const trendThreshold = Math.max(1.5, pitchRange * 0.25);
  const motionKind = !pitchStats.length
    ? 'unknown'
    : pitchRange >= 3 && turnRatio >= 0.34 && Math.abs(slope) < Math.max(3, pitchRange * 0.8)
      ? 'oscillating'
      : slope >= trendThreshold
        ? 'rising'
        : slope <= -trendThreshold
          ? 'falling'
          : turnRatio >= 0.28 && pitchRange >= 2
            ? 'oscillating'
            : 'steady';
  const occurrenceContours = identity.occurrences.map((occurrence) => (
    pressureContourForOccurrence(analysis, occurrence)
  ));
  const pressureContour = Array.from({ length: 5 }, (_, index) => round(mean(
    occurrenceContours.map((contour) => contour[index]),
  )));
  const pressureMean = mean(pressureContour);
  const pressureMinimum = Math.min(...pressureContour);
  const pressureMaximum = Math.max(...pressureContour);
  const polyphonyContext = songPolyphonyContext(analysis);
  const identityPitchEventCount = pitchStats.reduce((sum, stats) => sum + stats.eventCount, 0);
  const averagePolyphony = identityPitchEventCount > 0
    ? pitchStats.reduce((sum, stats) => sum + stats.polyphony * stats.eventCount, 0)
      / identityPitchEventCount
    : 1;
  const minimumIdentityEvents = Math.max(6, identity.occurrences.length * 3);
  const sufficientPolyphonyEvidence = (
    polyphonyContext.eventCount >= 12
    && pitchStats.length === identity.occurrences.length
    && pitchStats.every((stats) => stats.eventCount >= 3)
    && identityPitchEventCount >= minimumIdentityEvents
  );
  const salientPolyphony = (
    sufficientPolyphonyEvidence
    && averagePolyphony >= polyphonyContext.salienceThreshold
  );
  const branchMode = salientPolyphony ? 'fork-converge' : 'single-route';
  const attack = pressureContour[0] >= pressureMean + 0.12
    || pressureContour[0] - pressureContour[1] >= 0.14
    ? 'strike'
    : pressureContour[0] <= pressureMean - 0.18
      ? 'rest'
      : 'flow';
  const verbs = [];
  if (attack === 'strike') verbs.push('strike');
  else if (attack === 'rest') verbs.push('rest');
  if (motionKind === 'rising' || motionKind === 'falling') verbs.push('drift');
  else if (motionKind === 'oscillating') verbs.push('reverse');
  else verbs.push('hold');
  if (pitchRange >= 5 || pressureMaximum - pressureMinimum >= 0.22) verbs.push('bend');
  const pressureDelta = pressureContour.at(-1) - pressureContour[0];
  if (pressureDelta >= 0.12) verbs.push('open');
  else if (pressureDelta <= -0.12) verbs.push('close');
  if (branchMode === 'fork-converge') verbs.push('fork', 'converge');
  if (pressureContour.at(-1) <= pressureMaximum - 0.18) verbs.push('release');

  return {
    version: 'continuous-kinetic-form-v1',
    verbs: [...new Set(verbs)],
    motion: {
      kind: motionKind,
      slope: round(slope, 3),
      pitchRange: round(pitchRange, 3),
      turnRatio: round(turnRatio),
      confidence: round(pitchStats.length
        ? mean(pitchStats.map((stats) => stats.confidence))
        : 0),
    },
    pressureContour,
    branchMode,
    branchEvidence: {
      algorithm: 'relative-polyphony-salience-v1',
      identityEventCount: identityPitchEventCount,
      minimumIdentityEvents,
      songEventCount: polyphonyContext.eventCount,
      averagePolyphony: round(averagePolyphony, 3),
      songBaseline: round(polyphonyContext.baseline, 3),
      songUpperQuartile: round(polyphonyContext.upperQuartile, 3),
      salienceThreshold: round(polyphonyContext.salienceThreshold, 3),
      sufficient: sufficientPolyphonyEvidence,
      salient: salientPolyphony,
    },
    attack,
    development: identity.relation === 'exact'
      ? 'locked'
      : identity.relation === 'developed'
        ? 'directed'
        : 'free',
  };
}

function normalizeSeries(values) {
  if (!values.length) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (maximum - minimum <= 1e-9) {
    return values.map((value) => (Math.abs(value) <= 1e-9 ? 0 : 0.5));
  }
  return values.map((value) => clamp((value - minimum) / (maximum - minimum)));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(ratio) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

function eventsInRange(analysis, sourceId, startSeconds, endSeconds) {
  const source = Array.isArray(analysis?.eventSources)
    ? analysis.eventSources.find((candidate) => candidate?.id === sourceId)
    : null;
  if (!Array.isArray(source?.events)) return [];
  return source.events.filter((event) => {
    const timeSeconds = finite(event?.timeSeconds);
    return Number.isFinite(timeSeconds) && timeSeconds >= startSeconds && timeSeconds < endSeconds;
  });
}

function waveformEnergy(analysis, startSeconds, endSeconds) {
  const peaks = Array.isArray(analysis?.waveform?.peaks) ? analysis.waveform.peaks : [];
  const durationSeconds = finite(analysis?.song?.durationSeconds, 0);
  if (!peaks.length || durationSeconds <= 0 || endSeconds <= startSeconds) return 0;
  const startIndex = Math.max(0, Math.floor(startSeconds / durationSeconds * peaks.length));
  const endIndex = Math.min(peaks.length, Math.max(startIndex + 1, Math.ceil(endSeconds / durationSeconds * peaks.length)));
  return clamp(mean(peaks.slice(startIndex, endIndex).map((value) => finite(value, 0))));
}

function measuredSectionEnergy(analysis, section) {
  if (Number.isFinite(Number(section?.intensity))) return clamp(Number(section.intensity));
  if (Number.isFinite(Number(section?.energy))) return clamp(Number(section.energy));
  const bars = Array.isArray(analysis?.musicalStructure?.bars) ? analysis.musicalStructure.bars : [];
  const startSeconds = finite(section?.startSeconds, 0);
  const endSeconds = finite(section?.endSeconds, startSeconds);
  const barIntensities = bars
    .filter((bar) => {
      const timeSeconds = finite(bar?.startSeconds ?? bar?.downbeatTimeSeconds);
      return Number.isFinite(timeSeconds) && timeSeconds >= startSeconds && timeSeconds < endSeconds;
    })
    .map((bar) => Number(bar?.intensity))
    .filter(Number.isFinite);
  return barIntensities.length
    ? clamp(mean(barIntensities))
    : waveformEnergy(analysis, startSeconds, endSeconds);
}

function harmonicNovelty(section) {
  const candidates = [
    section?.harmonicNovelty,
    section?.harmonyNovelty,
    section?.boundaryNovelty,
    section?.harmonicChange,
    section?.chordChange,
  ];
  for (const candidate of candidates) {
    if (Number.isFinite(Number(candidate))) return clamp(Number(candidate));
  }
  return 0;
}

function entryAnchorFor(section, anchors) {
  const sectionId = String(section?.id ?? '');
  const evidenceId = `section:${sectionId}:start`;
  return anchors.find((anchor) => anchor.evidenceIds.includes(evidenceId))
    ?? anchors.find((anchor) => anchor.timeSeconds === finite(section?.startSeconds))
    ?? null;
}

function buildScenes(analysis, anchors) {
  const sections = Array.isArray(analysis?.musicalStructure?.sections)
    ? [...analysis.musicalStructure.sections].sort((left, right) => (
      finite(left?.startSeconds) - finite(right?.startSeconds)
      || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
    ))
    : [];
  const measured = sections.map((section, index) => {
    const startSeconds = finite(section?.startSeconds);
    const endSeconds = finite(section?.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return null;
    const durationSeconds = endSeconds - startSeconds;
    return {
      source: section,
      sourceSectionId: String(section?.id ?? `S${String(index + 1).padStart(2, '0')}`),
      startSeconds,
      endSeconds,
      energy: measuredSectionEnergy(analysis, section),
      onsetRate: eventsInRange(analysis, 'librosa-onset', startSeconds, endSeconds).length / durationSeconds,
      melodyRate: eventsInRange(analysis, 'basic-pitch', startSeconds, endSeconds).length / durationSeconds,
      beatRate: eventsInRange(analysis, 'beat-this', startSeconds, endSeconds).length / durationSeconds,
      structuralSupport: clamp(finite(section?.boundarySupport, index === 0 ? 1 : 0.5)),
      harmonicNovelty: harmonicNovelty(section),
    };
  }).filter(Boolean);
  const normalizedOnset = normalizeSeries(measured.map((section) => section.onsetRate));
  const normalizedMelody = normalizeSeries(measured.map((section) => section.melodyRate));
  const normalizedBeat = normalizeSeries(measured.map((section) => section.beatRate));

  const scenes = measured.map((section, index) => {
    const activity = normalizedOnset[index] * 0.45
      + normalizedMelody[index] * 0.35
      + normalizedBeat[index] * 0.2;
    const pressure = section.energy * 0.6 + activity * 0.4;
    const previousMeasured = measured[index - 1];
    const previousActivity = index > 0
      ? normalizedOnset[index - 1] * 0.45 + normalizedMelody[index - 1] * 0.35 + normalizedBeat[index - 1] * 0.2
      : activity;
    const previousPressure = previousMeasured
      ? previousMeasured.energy * 0.6 + previousActivity * 0.4
      : pressure;
    const energyDelta = previousMeasured ? section.energy - previousMeasured.energy : 0;
    const activityDelta = previousMeasured ? activity - previousActivity : 0;
    const pressureDelta = previousMeasured ? pressure - previousPressure : 0;
    const changeSalience = previousMeasured ? clamp(
      Math.abs(pressureDelta) * 0.5
      + Math.abs(energyDelta) * 0.2
      + Math.abs(activityDelta) * 0.15
      + section.harmonicNovelty * 0.1
      + section.structuralSupport * 0.1,
    ) : 0;
    const entryAnchor = entryAnchorFor(section.source, anchors);
    const id = `scene-${String(index + 1).padStart(2, '0')}`;
    return {
      id,
      sourceSectionId: section.sourceSectionId,
      startSeconds: section.startSeconds,
      endSeconds: section.endSeconds,
      entryAnchorId: entryAnchor?.id ?? null,
      energy: round(section.energy),
      activity: round(activity),
      pressure: round(pressure),
      eventRatesPerSecond: {
        onset: round(section.onsetRate, 3),
        melody: round(section.melodyRate, 3),
        beat: round(section.beatRate, 3),
      },
      state: index === 0
        ? 'opening'
        : index === measured.length - 1
          ? 'closing'
          : pressureDelta > 0.12
            ? 'lift'
            : pressureDelta < -0.12
              ? 'release'
              : 'continuation',
      changeFromPrevious: {
        energyDelta: round(energyDelta),
        activityDelta: round(activityDelta),
        pressureDelta: round(pressureDelta),
        harmonicNovelty: round(section.harmonicNovelty),
        structuralSupport: round(section.structuralSupport),
        salience: round(changeSalience),
      },
      narrativeTurn: false,
      turnCommitment: 'none',
      evidenceIds: [...new Set([
        `section:${section.sourceSectionId}`,
        ...(entryAnchor?.evidenceIds ?? []),
      ])].sort(),
    };
  });
  const credibleTurns = scenes.slice(1).filter((scene) => {
    const change = scene.changeFromPrevious;
    return change.structuralSupport >= 0.45 && (
      Math.abs(change.pressureDelta) >= 0.11
      || Math.abs(change.energyDelta) >= 0.16
      || Math.abs(change.activityDelta) >= 0.18
      || change.harmonicNovelty >= 0.3
    );
  });
  const credibleSaliences = credibleTurns.map((scene) => scene.changeFromPrevious.salience);
  const narrativeThreshold = Math.max(0.2, percentile(credibleSaliences, 0.55));
  const mustThreshold = Math.max(0.3, percentile(credibleSaliences, 0.82));
  const credibleIds = new Set(credibleTurns.map((scene) => scene.id));
  return scenes.map((scene, index) => {
    if (index === 0 || !credibleIds.has(scene.id)) return scene;
    const narrativeTurn = scene.changeFromPrevious.salience >= narrativeThreshold;
    const must = narrativeTurn && scene.changeFromPrevious.salience >= mustThreshold;
    return {
      ...scene,
      narrativeTurn,
      turnCommitment: must ? 'must' : narrativeTurn ? 'should' : 'may',
    };
  });
}

function sceneAt(scenes, timeSeconds) {
  return scenes.find((scene, index) => (
    timeSeconds >= scene.startSeconds
    && (timeSeconds < scene.endSeconds || (index === scenes.length - 1 && timeSeconds <= scene.endSeconds))
  )) ?? null;
}

function buildDirectionEvents(analysis, anchors, scenes) {
  const momentDrafts = [];
  for (const scene of scenes.slice(1)) {
    const anchor = anchors.find((candidate) => candidate.id === scene.entryAnchorId);
    if (!anchor || (!scene.narrativeTurn && scene.changeFromPrevious.salience < 0.28)) continue;
    const { pressureDelta, energyDelta, activityDelta, harmonicNovelty, structuralSupport, salience } = scene.changeFromPrevious;
    const abruptContrast = Math.abs(pressureDelta) >= 0.5
      && (harmonicNovelty >= 0.45 || structuralSupport >= 0.85);
    const type = pressureDelta <= -0.12
      ? 'release'
      : abruptContrast
        ? 'rupture'
        : pressureDelta >= 0.12
        ? 'arrival'
          : Math.abs(activityDelta) > Math.abs(energyDelta)
            ? 'impact'
            : 'breath';
    const commitment = scene.turnCommitment === 'must'
      ? 'must'
      : scene.narrativeTurn
        ? 'should'
        : 'may';
    const requiredChannels = new Set(
      ['release', 'breath'].includes(type) ? ['density'] : ['movement'],
    );
    if (salience >= 0.42) requiredChannels.add('density');
    if (type === 'rupture' || type === 'arrival') requiredChannels.add('threat');
    if (scene.narrativeTurn) requiredChannels.add('color');
    momentDrafts.push({
      type,
      anchorId: anchor.id,
      timeSeconds: anchor.timeSeconds,
      strength: salience,
      commitment,
      requiredChannels: [...requiredChannels].sort(),
      evidenceIds: [...new Set([...scene.evidenceIds, ...anchor.evidenceIds])].sort(),
      sceneId: scene.id,
      narrativeTurn: scene.narrativeTurn,
    });
  }

  const narrativeAnchorIds = new Set(momentDrafts.map((moment) => moment.anchorId));
  const visualAccentCandidates = anchors
    .filter((anchor) => (
      !narrativeAnchorIds.has(anchor.id)
      && !anchor.structuralBoundary
      && anchor.salience >= 0.88
      && (anchor.isDownbeat || anchor.evidenceKinds.includes('onset'))
    ))
    .map((anchor) => {
      const scene = sceneAt(scenes, anchor.timeSeconds);
      return {
        anchorId: anchor.id,
        sceneId: scene?.id ?? null,
        timeSeconds: anchor.timeSeconds,
        strength: anchor.salience,
        kind: 'pulse',
        evidenceIds: [...anchor.evidenceIds],
      };
    });
  const minimumVisualAccentSpacing = Math.max(
    1.5,
    60 / Math.max(1, finite(analysis?.song?.bpm, 120)) * 2.5,
  );
  const visualAccentDrafts = [];
  for (const candidate of visualAccentCandidates) {
    const previous = visualAccentDrafts.at(-1);
    if (!previous || candidate.timeSeconds - previous.timeSeconds >= minimumVisualAccentSpacing) {
      visualAccentDrafts.push(candidate);
    } else if (candidate.strength > previous.strength) {
      visualAccentDrafts[visualAccentDrafts.length - 1] = candidate;
    }
  }
  for (const accent of visualAccentDrafts) {
    momentDrafts.push({
      type: 'impact',
      anchorId: accent.anchorId,
      timeSeconds: accent.timeSeconds,
      strength: accent.strength,
      commitment: 'may',
      requiredChannels: ['visual-accent'],
      evidenceIds: [...accent.evidenceIds],
      sceneId: accent.sceneId,
      narrativeTurn: false,
    });
  }

  const moments = momentDrafts
    .sort((left, right) => (
      left.timeSeconds - right.timeSeconds
      || (left.narrativeTurn === right.narrativeTurn ? 0 : left.narrativeTurn ? -1 : 1)
      || left.type.localeCompare(right.type)
    ))
    .map((moment, index) => ({
      id: `directed-moment-${String(index + 1).padStart(3, '0')}`,
      type: moment.type,
      anchorId: moment.anchorId,
      timeSeconds: moment.timeSeconds,
      strength: round(moment.strength),
      commitment: moment.commitment,
      requiredChannels: moment.requiredChannels,
      evidenceIds: moment.evidenceIds,
      sceneId: moment.sceneId,
      narrativeTurn: moment.narrativeTurn,
    }));
  const colorMomentDrafts = moments.filter((moment) => (
    moment.narrativeTurn
    && moment.requiredChannels.includes('color')
  ));
  const durationSeconds = Math.max(0, finite(analysis?.song?.durationSeconds, scenes.at(-1)?.endSeconds ?? 0));
  const colorScenes = colorMomentDrafts.map((moment, index) => ({
    id: `color-scene-${String(index + 1).padStart(2, '0')}`,
    sceneId: moment.sceneId,
    anchorId: moment.anchorId,
    sourceMomentId: moment.id,
    timeSeconds: moment.timeSeconds,
    startSeconds: moment.timeSeconds,
    endSeconds: colorMomentDrafts[index + 1]?.timeSeconds ?? durationSeconds,
    strength: moment.strength,
    evidenceIds: [...moment.evidenceIds],
  }));
  const visualAccents = visualAccentDrafts.map((accent, index) => ({
    id: `visual-accent-${String(index + 1).padStart(3, '0')}`,
    ...accent,
    strength: round(accent.strength),
  }));
  return { moments, colorScenes, visualAccents };
}

/**
 * Convert measured musical analysis into a stable, evidence-grounded Director Score.
 * The function is intentionally pure so an offline build can cache and review its output.
 */
export function directSong(analysis) {
  const source = analysis && typeof analysis === 'object' ? analysis : null;
  const audioFingerprint = typeof source?.song?.audioFingerprint === 'string'
    && source.song.audioFingerprint.length > 0
    ? source.song.audioFingerprint
    : 'missing-audio-fingerprint';

  const anchors = source ? buildAnchors(source) : [];
  const phraseResult = source ? buildPhraseIdentities(source) : {
    identities: [],
    phraseCoverage: 0,
    repetitionCoverage: 0,
    repetitionAgreement: null,
    suppressedExactContractCount: 0,
  };
  const scenes = source ? buildScenes(source, anchors) : [];
  const directionEvents = source ? buildDirectionEvents(source, anchors, scenes) : {
    moments: [],
    colorScenes: [],
    visualAccents: [],
  };
  const anchorIds = new Set(anchors.map((anchor) => anchor.id));
  const anchorReferences = [
    ...scenes.map((scene) => scene.entryAnchorId),
    ...directionEvents.moments.map((moment) => moment.anchorId),
    ...directionEvents.colorScenes.map((scene) => scene.anchorId),
    ...directionEvents.visualAccents.map((accent) => accent.anchorId),
  ].filter((anchorId) => anchorId != null);
  const unresolvedAnchorReferenceCount = anchorReferences
    .filter((anchorId) => !anchorIds.has(anchorId)).length;
  const warnings = [];
  if (!source) warnings.push('missing-measured-analysis');
  else {
    if (audioFingerprint === 'missing-audio-fingerprint') warnings.push('missing-audio-fingerprint');
    if (!anchors.length) warnings.push('missing-musical-anchors');
    if (!scenes.length) warnings.push('missing-musical-scenes');
    if (!phraseResult.identities.length) warnings.push('missing-phrase-evidence');
  }

  return {
    algorithm: DIRECTOR_ALGORITHM,
    audioFingerprint,
    anchors,
    scenes,
    phraseIdentities: phraseResult.identities,
    moments: directionEvents.moments,
    colorScenes: directionEvents.colorScenes,
    visualAccents: directionEvents.visualAccents,
    diagnostics: {
      phraseCoverage: phraseResult.phraseCoverage,
      repetitionCoverage: phraseResult.repetitionCoverage,
      repetitionAgreement: phraseResult.repetitionAgreement,
      suppressedExactContractCount: phraseResult.suppressedExactContractCount,
      anchorCount: anchors.length,
      sceneCount: scenes.length,
      narrativeTurnCount: directionEvents.moments.filter((moment) => moment.narrativeTurn).length,
      mustMomentCount: directionEvents.moments.filter((moment) => moment.commitment === 'must').length,
      colorSceneCount: directionEvents.colorScenes.length,
      visualAccentCount: directionEvents.visualAccents.length,
      unresolvedAnchorReferenceCount,
      warnings,
    },
  };
}
