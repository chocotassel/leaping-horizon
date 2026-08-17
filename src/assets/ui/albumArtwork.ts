import type { CSSProperties } from 'react';
const coverModules = import.meta.glob<string>('../../songs/*/cover.jpeg', {
  eager: true,
  import: 'default',
  query: '?url',
});
const artworkByLevelId: Record<string, string> = {};
Object.entries(coverModules).forEach(([path, artwork]) => {
  const songId = path.match(/\/songs\/([^/]+)\/cover\.jpeg$/)?.[1];
  if (!songId) throw new Error(`Invalid song cover path: ${path}`);
  artworkByLevelId[`${songId}-flow`] = artwork;
});

export function albumArtworkStyle(levelId: string): CSSProperties | undefined {
  const artwork = artworkByLevelId[levelId];
  return artwork ? ({ '--album-art': `url("${artwork}")` } as CSSProperties) : undefined;
}
