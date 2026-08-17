import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function base64AssetPlugin(): Plugin {
  const prefix = '\0base64:';
  return {
    name: 'base64-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      const queryIndex = source.indexOf('?');
      if (queryIndex < 0 || !new URLSearchParams(source.slice(queryIndex + 1)).has('base64')) return null;
      const file = source.slice(0, queryIndex);
      if (isAbsolute(file)) return `${prefix}${file}`;
      if (!importer) return null;
      return `${prefix}${resolve(dirname(importer), file)}`;
    },
    async load(id) {
      if (!id.startsWith(prefix)) return null;
      return `export default ${JSON.stringify((await readFile(id.slice(prefix.length))).toString('base64'))}`;
    },
  };
}

export function runtimeLevelPlugin(): Plugin {
  return {
    name: 'runtime-levels',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/src\/songs\/[^/]+\/level\.json$/.test(id.split('?')[0])) return null;
      const level = JSON.parse(code) as {
        generation: { algorithm: unknown; noteCount: unknown };
        events: Array<{
          timeSeconds: unknown;
          obstacles: unknown;
          kind: unknown;
          downbeatCue?: unknown;
          barIndex?: unknown;
        }>;
        [key: string]: unknown;
      };
      return JSON.stringify({
        ...level,
        generation: {
          algorithm: level.generation.algorithm,
          noteCount: level.generation.noteCount,
        },
        events: level.events.map((event) => ({
          timeSeconds: event.timeSeconds,
          obstacles: event.obstacles,
          kind: event.kind,
          ...(event.downbeatCue === true ? { downbeatCue: true, barIndex: event.barIndex } : {}),
        })),
      });
    },
  };
}
