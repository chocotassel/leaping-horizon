import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertAuthoringScore(level, score) {
  if (score?.kind !== 'authoring-score' || score?.schemaVersion !== '2.0.0') {
    throw new Error('只能批量采用 Authoring Score v2 的建议。');
  }
  if (!nonEmptyString(level?.id) || score.levelId !== level.id) {
    throw new Error('Authoring Score 与当前关卡不匹配。');
  }
  if (!nonEmptyString(score.audioFingerprint) || !nonEmptyString(score.evidenceFingerprint)) {
    throw new Error('Authoring Score 缺少音频或证据指纹。');
  }
  if (!Array.isArray(score.regions) || !Array.isArray(score.suggestions)) {
    throw new Error('Authoring Score 缺少 Regions 或建议。');
  }
}

function orderedRegions(regions) {
  const seen = new Set();
  return [...regions].sort((left, right) => (
    Number(left?.startSeconds) - Number(right?.startSeconds)
      || Number(left?.endSeconds) - Number(right?.endSeconds)
      || String(left?.id).localeCompare(String(right?.id))
  )).map((region) => {
    if (!nonEmptyString(region?.id) || seen.has(region.id)) {
      throw new Error('Authoring Score 包含无效或重复的 Region。');
    }
    seen.add(region.id);
    return region;
  });
}

function recipeFromSuggestion(region, suggestion) {
  const preset = suggestion?.preset;
  if (!preset || (preset.mode !== 'play' && preset.mode !== 'rest')) {
    throw new Error(`Region ${region.id} 没有可采用的建议。`);
  }
  return {
    id: `recipe:${region.id}`,
    regionId: region.id,
    ...clone(preset),
  };
}

/**
 * Materialize every evidence-backed Authoring Score suggestion into a v3 edits file.
 * Manual row/color work is deliberately preserved and remains the last override layer.
 */
export function adoptAuthoringSuggestions(level, score, oldEdits = {}) {
  assertAuthoringScore(level, score);
  if (oldEdits?.levelId != null && oldEdits.levelId !== level.id) {
    throw new Error('现有编辑内容属于另一首歌。');
  }

  const suggestions = new Map();
  for (const suggestion of score.suggestions) {
    if (!nonEmptyString(suggestion?.regionId) || suggestions.has(suggestion.regionId)) {
      throw new Error('Authoring Score 包含无效或重复的 Region 建议。');
    }
    suggestions.set(suggestion.regionId, suggestion);
  }

  const arrangements = orderedRegions(score.regions).map((region) => {
    const suggestion = suggestions.get(region.id);
    if (!suggestion) throw new Error(`Region ${region.id} 缺少建议，已停止批量采用。`);
    return recipeFromSuggestion(region, suggestion);
  });

  return {
    version: 3,
    levelId: level.id,
    baseFingerprint: score.audioFingerprint,
    evidenceFingerprint: score.evidenceFingerprint,
    arrangements,
    rowOverrides: clone(Array.isArray(oldEdits?.rowOverrides) ? oldEdits.rowOverrides : []),
    colorRanges: clone(Array.isArray(oldEdits?.colorRanges) ? oldEdits.colorRanges : []),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main(argv) {
  const [levelPath, scorePath, oldEditsPath, outputPath] = argv;
  if (!levelPath || !scorePath || !oldEditsPath || !outputPath) {
    throw new Error('用法：node scripts/adopt-authoring-suggestions.mjs <level.json> <authoring.json> <old-edits.json> <output-edits.json>');
  }
  const adopted = adoptAuthoringSuggestions(
    await readJson(levelPath),
    await readJson(scorePath),
    await readJson(oldEditsPath),
  );
  await writeFile(outputPath, `${JSON.stringify(adopted, null, 2)}\n`, 'utf8');
  process.stdout.write(`已采用 ${adopted.arrangements.length} 个 Region 建议：${outputPath}\n`);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
