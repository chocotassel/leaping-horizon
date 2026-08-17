import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SONGS_DIRECTORY = resolve(ROOT, 'src/songs');
const SOURCE_LABEL = 'src/songs/*/level.json';
const REPORTED_MOTIFS = ['m', 'wave', 'sweep', 'contour'];

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numericRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [key, finiteNumber(count)])
      .filter(([, count]) => count !== null)
      .sort(([left], [right]) => stableCompare(left, right)),
  );
}

function histogram(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => stableCompare(left, right)));
}

function transitionHistogram(values) {
  return histogram(values.slice(1).map((value, index) => `${values[index]}>${value}`));
}

function cosine(left, right) {
  const dimensions = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(stableCompare);
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (const dimension of dimensions) {
    const leftValue = finiteNumber(left[dimension], 0);
    const rightValue = finiteNumber(right[dimension], 0);
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  if (leftSquared === 0 && rightSquared === 0) return 1;
  if (leftSquared === 0 || rightSquared === 0) return 0;
  return dot / Math.sqrt(leftSquared * rightSquared);
}

function rowSignature(event) {
  const kind = typeof event?.kind === 'string' ? event.kind : 'unknown';
  const cells = Array.isArray(event?.obstacles) && event.obstacles.length
    ? event.obstacles.map((cell) => finiteNumber(cell, '?')).join('')
    : 'unknown';
  return `${kind}:${cells}`;
}

function reportFor(level, directoryName) {
  const generation = level?.generation ?? {};
  const director = generation.directorScore ?? {};
  const diagnostics = director.diagnostics ?? {};
  const receipt = generation.realizationReceipt ?? {};
  const events = asArray(level?.events);
  const motifDistribution = numericRecord(generation.motifCounts);
  const motifSequence = asArray(generation.flowSections).map((section) => section?.motif ?? 'unknown');
  const rowSequence = events.map(rowSignature);
  const mustCount = finiteNumber(
    receipt.mustCueCount,
    asArray(receipt.cues).filter((cue) => cue?.commitment === 'must').length,
  );
  const realizedMustCount = finiteNumber(
    receipt.realizedMustCueCount,
    asArray(receipt.cues).filter((cue) => cue?.commitment === 'must' && cue?.status === 'realized').length,
  );
  const mustCoverage = finiteNumber(
    receipt.mustCueCoverage,
    mustCount > 0 ? realizedMustCount / mustCount : null,
  );
  const identityCount = finiteNumber(
    receipt.phraseIdentityCount,
    asArray(director.phraseIdentities).length,
  );
  const realizedIdentityCount = finiteNumber(
    receipt.realizedPhraseIdentityCount,
    asArray(receipt.phraseIdentities).filter((identity) => identity?.status === 'realized').length,
  );
  const exactIdentityCount = finiteNumber(
    receipt.exactPhraseIdentityCount,
    asArray(director.phraseIdentities).filter((identity) => identity?.relation === 'exact').length,
  );
  const realizedExactIdentityCount = finiteNumber(
    receipt.realizedExactPhraseIdentityCount,
    asArray(receipt.phraseIdentities).filter((identity) => (
      identity?.relation === 'exact' && identity?.status === 'realized'
    )).length,
  );
  const guideCount = events.filter((event) => event?.kind === 'guide' || event?.densityFill === true).length;

  return {
    key: directoryName,
    title: level?.song?.title ?? level?.id ?? directoryName,
    momentCount: asArray(director.moments).length,
    mustCount,
    realizedMustCount,
    mustCoverage,
    identityCount,
    realizedIdentityCount,
    exactIdentityCount,
    realizedExactIdentityCount,
    suppressedExactContractCount: finiteNumber(diagnostics.suppressedExactContractCount, 0),
    colorSceneCount: asArray(director.colorScenes).length,
    visualAccentCount: asArray(director.visualAccents).length,
    guideCount,
    eventCount: events.length,
    guideShare: events.length ? guideCount / events.length : null,
    repetitionCoverage: finiteNumber(diagnostics.repetitionCoverage),
    repetitionAgreement: finiteNumber(diagnostics.repetitionAgreement),
    motifDistribution,
    motifCounts: Object.fromEntries(REPORTED_MOTIFS.map((motif) => [
      motif,
      finiteNumber(motifDistribution[motif], 0),
    ])),
    motifTransitionDistribution: transitionHistogram(motifSequence),
    rowSignatureDistribution: histogram(rowSequence),
    rowTransitionDistribution: transitionHistogram(rowSequence),
  };
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function similarity(value) {
  return value.toFixed(4);
}

async function readReports() {
  const directories = (await readdir(SONGS_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(stableCompare);

  const reports = await Promise.all(directories.map(async (directoryName) => {
    const levelPath = resolve(SONGS_DIRECTORY, directoryName, 'level.json');
    let source;
    try {
      source = await readFile(levelPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return reportFor(JSON.parse(source), directoryName);
    } catch (error) {
      throw new Error(`Could not parse src/songs/${directoryName}/level.json: ${error.message}`, {
        cause: error,
      });
    }
  }));

  return reports.filter(Boolean).sort((left, right) => stableCompare(left.key, right.key));
}

function render(reports) {
  const lines = [
    '# Song Direction Report',
    '',
    `Source: \`${SOURCE_LABEL}\``,
    '',
    'Guide share is Guide Rows divided by all emitted event rows. Row signatures use `kind:five-lane-cells`.',
    '',
    '## Per-song direction and vocabulary',
    '',
    '| Song | Moments | Must realized | Must coverage | Kinetic contracts | Exact contracts | Suppressed aliases | Color Scenes | Visual Accents | Guides / rows | Guide share | Repeat coverage | Repeat agreement | M | Wave | Sweep | Contour |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const report of reports) {
    lines.push([
      markdownCell(report.title),
      report.momentCount,
      `${report.realizedMustCount}/${report.mustCount}`,
      percent(report.mustCoverage),
      `${report.realizedIdentityCount}/${report.identityCount}`,
      `${report.realizedExactIdentityCount}/${report.exactIdentityCount}`,
      report.suppressedExactContractCount,
      report.colorSceneCount,
      report.visualAccentCount,
      `${report.guideCount}/${report.eventCount}`,
      percent(report.guideShare),
      percent(report.repetitionCoverage),
      percent(report.repetitionAgreement),
      report.motifCounts.m,
      report.motifCounts.wave,
      report.motifCounts.sweep,
      report.motifCounts.contour,
    ].map(markdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    '## Pairwise distribution cosine',
    '',
    '| Song A | Song B | Motif cosine | Motif-transition cosine | Row-signature cosine | Row-transition cosine |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );

  for (let leftIndex = 0; leftIndex < reports.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < reports.length; rightIndex += 1) {
      const left = reports[leftIndex];
      const right = reports[rightIndex];
      lines.push([
        markdownCell(left.title),
        markdownCell(right.title),
        similarity(cosine(left.motifDistribution, right.motifDistribution)),
        similarity(cosine(left.motifTransitionDistribution, right.motifTransitionDistribution)),
        similarity(cosine(left.rowSignatureDistribution, right.rowSignatureDistribution)),
        similarity(cosine(left.rowTransitionDistribution, right.rowTransitionDistribution)),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
  }

  if (!reports.length) lines.push('| n/a | n/a | n/a | n/a | n/a | n/a |');
  return `${lines.join('\n')}\n`;
}

const reports = await readReports();
process.stdout.write(render(reports));
