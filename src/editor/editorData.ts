import { emptyLevelEdits, parseLevelEdits, type LevelEdits } from '../levelEdits';
import type { Level } from '../types';
import {
  normalizeAuthoringScoreForEditor,
  type AuthoringScore,
} from './arrangementDraft';

const levelModules = import.meta.glob<{ default: Level }>('../songs/*/level.json', {
  eager: true,
  query: '?editor',
});
const editModules = import.meta.glob<{ default: unknown }>('../songs/*/edits.json', { eager: true });
const authoringModules = import.meta.glob<{ default: unknown }>('../songs/*/authoring.json', {
  eager: true,
});
const audioModules = import.meta.glob<string>('../songs/*/audio.mp3', {
  eager: true,
  import: 'default',
  query: '?url',
});
const ORDER = ['rearview-halo-flow', 'slice-at-two-flow', 'story-reactions-flow', 'hands-on-deck-flow'];
const editsByLevelId = new Map<string, LevelEdits>();
const authoringByLevelId = new Map<string, AuthoringScore>();

export const EDITOR_LEVELS = Object.entries(levelModules).map(([path, module]) => {
  const audioUrl = audioModules[path.replace(/level\.json$/, 'audio.mp3')];
  if (!audioUrl) throw new Error(`Missing editor audio for ${path}.`);
  const level = { ...module.default, song: { ...module.default.song, audioUrl } };
  const editValue = editModules[path.replace(/level\.json$/, 'edits.json')]?.default;
  const authoringValue = authoringModules[path.replace(/level\.json$/, 'authoring.json')]?.default;
  if (!authoringValue) {
    throw new Error(`Missing or mismatched Authoring Score for ${path}.`);
  }
  const authoring = normalizeAuthoringScoreForEditor(authoringValue);
  if (authoring.levelId !== level.id) throw new Error(`Mismatched Authoring Score for ${path}.`);
  editsByLevelId.set(level.id, parseLevelEdits(editValue, level));
  authoringByLevelId.set(level.id, authoring);
  return level;
}).sort((left, right) => (
  ORDER.indexOf(left.id) - ORDER.indexOf(right.id) || left.id.localeCompare(right.id)
));

export function getEditorLevel(levelId: string | null | undefined): Level {
  return EDITOR_LEVELS.find((level) => level.id === levelId) ?? EDITOR_LEVELS[0];
}

export function getEditorLevelEdits(levelId: string): LevelEdits {
  return editsByLevelId.get(levelId) ?? emptyLevelEdits(levelId);
}

export function getEditorAuthoringScore(levelId: string): AuthoringScore {
  const score = authoringByLevelId.get(levelId);
  if (!score) throw new Error(`Missing Authoring Score for ${levelId}.`);
  return score;
}
