import type { SceneColorSchemeId } from './game/colorSchemes';

export const LANE_CENTERS = [-2, -1, 0, 1, 2] as const;
export type LaneIndex = 0 | 1 | 2 | 3 | 4;

export enum ObstacleType {
  Empty = 0,
  Breakable = 1,
  Spike = 2,
}

export type ObstacleRow = [
  ObstacleType,
  ObstacleType,
  ObstacleType,
  ObstacleType,
  ObstacleType,
];

export interface Song {
  title: string;
  artist: string;
  audioUrl: string;
  /** BPM is retained for background visuals only. It never determines event time. */
  bpm: number;
  durationSeconds: number;
}

export interface LevelEvent {
  timeSeconds: number;
  /** A row can expose several Target Cells; any one satisfies the Choice Row. */
  obstacles: ObstacleRow;
  /** Choice Rows score a hit; Gate Rows score a dodge. */
  kind: 'target' | 'dodge';
}

export interface LevelGeneration {
  algorithm: string;
  /** Number of Choice Rows, not the number of individual Target Cells. */
  noteCount: number;
  difficulty?: 'flow';
  confidence?: number;
  colorSchemeEventCount?: number;
  [key: string]: unknown;
}

export interface ColorSchemeEvent {
  timeSeconds: number;
  colorSchemeId: SceneColorSchemeId;
  kind: 'section' | 'accent';
  source: string;
  strength: number;
}

export interface RhythmPoint {
  id: string;
  timeSeconds: number;
  suggestedLane: LaneIndex;
  kind: 'attack' | 'beat' | 'downbeat' | 'pitch';
  strength: number;
  pitchMidi?: number;
  sourceRole: string;
  hasBaseRow: boolean;
}

/** Legacy v2 mapping, retained only for deterministic edit migration. */
export type RegionMapping = 'pulse' | 'alternating' | 'pitch-contour' | 'rest';

export type RegionFeel = 'steady' | 'natural' | 'showcase';
export type TimingLayerRole = 'target' | 'accent';

export interface RegionTimingLayer {
  sourceId: string;
  role: TimingLayerRole;
  /** Relative contribution inside this Region, normalized by the compiler. */
  weight: number;
  /** Persisted provenance for lossless v2 single-source migration. */
  compatibility?: 'legacy-single-source-v2';
}

export type RegionLaneDriver =
  | {
      kind: 'source';
      sourceId: string;
      motion: number;
    }
  | {
      kind: 'gesture';
      pattern: 'pulse' | 'alternating';
      motion: number;
    };

interface RegionRecipeIdentity {
  id: string;
  regionId: string;
  repeatSetId?: string;
  occurrenceIds?: string[];
}

export interface PlayRegionRecipe extends RegionRecipeIdentity {
  mode: 'play';
  timingLayers: RegionTimingLayer[];
  laneDriver: RegionLaneDriver;
  density: number;
  challenge: number;
  feel: RegionFeel;
  /** Optional safety target. It filters anchors but never creates or moves one. */
  maxGapBeats?: number;
}

export interface RestRegionRecipe extends RegionRecipeIdentity {
  mode: 'rest';
}

export type RegionRecipe = PlayRegionRecipe | RestRegionRecipe;

export type AuthoringSourceAvailability = 'measured' | 'estimated' | 'unavailable';

export interface AuthoringSourceCapabilities {
  onsets: boolean;
  pitch: boolean;
  continuousPitch: boolean;
}

export interface AuthoringEvent {
  id: string;
  timeSeconds: number;
  strength: number;
  pitchMidi?: number;
  durationSeconds?: number;
  traceId?: string;
  isDownbeat?: boolean;
}

export interface AuthoringSource {
  id: string;
  label: string;
  availability: AuthoringSourceAvailability;
  capabilities: AuthoringSourceCapabilities;
  events: AuthoringEvent[];
}

export type AuthoringEvidenceKind = 'timing' | 'lane' | 'accent' | 'metric';

export interface AuthoringEvidenceStream extends AuthoringSource {
  kind: AuthoringEvidenceKind;
  stemRole: string;
  /** Stem identities are model estimates; mix and metric identities are direct. */
  identity: 'direct' | 'model-estimated';
}

export interface AuthoringEvidenceStreams {
  timing: AuthoringEvidenceStream[];
  lane: AuthoringEvidenceStream[];
  accent: AuthoringEvidenceStream[];
  metric: AuthoringEvidenceStream[];
}

export interface AuthoringRegion {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  sourceSectionId?: string;
  sourcePhraseId?: string;
}

export interface AuthoringRepeatOccurrence {
  id: string;
  regionId?: string;
  startSeconds: number;
  endSeconds: number;
}

export interface AuthoringRepeatSet {
  id: string;
  confidence: number;
  occurrences: AuthoringRepeatOccurrence[];
}

export interface AuthoringSuggestion {
  regionId: string;
  preset: Omit<PlayRegionRecipe, 'id' | 'regionId'> | { mode: 'rest' };
  reasonCodes: string[];
}

export interface AuthoringRegionStreamSummary {
  streamId: string;
  kind: AuthoringEvidenceKind;
  eventCount: number;
  /** Fraction of equal-duration Region cells containing at least one event. */
  activeCoverageRatio: number;
  maximumGapSeconds: number;
  pitchSpan?: number;
}

export interface AuthoringRegionEvidence {
  regionId: string;
  streams: AuthoringRegionStreamSummary[];
}

export interface AuthoringScore {
  kind: 'authoring-score';
  schemaVersion: '2.0.0';
  algorithm: string;
  levelId: string;
  audioFingerprint: string;
  evidenceFingerprint: string;
  /** Legacy catalog retained during v2-to-v3 rollout. */
  sources: AuthoringSource[];
  evidenceStreams: AuthoringEvidenceStreams;
  regions: AuthoringRegion[];
  regionEvidence: AuthoringRegionEvidence[];
  repeatSets: AuthoringRepeatSet[];
  suggestions: AuthoringSuggestion[];
}

/**
 * Level v3 stores every row at its measured audio time. There is deliberately
 * no ticksPerBeat or beatOffset: gameplay events cannot be snapped to a grid.
 */
export interface Level {
  id: string;
  version: 3;
  song: Song;
  generation: LevelGeneration;
  rhythmPoints: RhythmPoint[];
  colorSchemeEvents: ColorSchemeEvent[];
  events: LevelEvent[];
}

export type ObstacleState = 'pending' | 'hit' | 'miss';
export type ObstacleStateRow = [
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
];

export interface GameResult {
  score: number;
  maxCombo: number;
  /** Number of satisfied Choice Rows; multi-target rows count once. */
  hits: number;
  /** Number of Choice Rows in the level; this is the accuracy denominator. */
  total: number;
  /** Multi-target Choice Rows where at least two Target Cells were collected. */
  doubleHitRows: number;
  totalMultiTargetRows: number;
  dodges: number;
  totalDodges: number;
}
