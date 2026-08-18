import { readFile, writeFile } from 'node:fs/promises';
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
        rhythmPoints: Array<{ timeSeconds: unknown }>;
        events: Array<{
          timeSeconds: unknown;
          obstacles: unknown;
          kind: unknown;
        }>;
        [key: string]: unknown;
      };
      const editor = new URLSearchParams(id.split('?')[1] ?? '').has('editor');
      const runtimeLevel = {
        ...level,
        generation: {
          algorithm: level.generation.algorithm,
          noteCount: level.generation.noteCount,
        },
        rhythmPoints: editor
          ? level.rhythmPoints
          : level.rhythmPoints.map((point) => ({ timeSeconds: point.timeSeconds })),
        events: level.events.map((event) => ({
          timeSeconds: event.timeSeconds,
          obstacles: event.obstacles,
          kind: event.kind,
        })),
      };
      return editor
        ? `export default ${JSON.stringify(runtimeLevel)};`
        : JSON.stringify(runtimeLevel);
    },
  };
}

export function levelEditorPlugin(): Plugin {
  return {
    name: 'level-editor-save',
    configureServer(server) {
      server.middlewares.use('/__level-editor/save', async (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += String(chunk);
            if (body.length > 1_000_000) throw new Error('编辑数据过大。');
          }
          const edits = JSON.parse(body) as {
            version?: unknown;
            levelId?: unknown;
            rowOverrides?: unknown;
            colorRanges?: unknown;
          };
          if (
            edits.version !== 1
            || typeof edits.levelId !== 'string'
            || !/^[a-z0-9-]+-flow$/.test(edits.levelId)
            || !Array.isArray(edits.rowOverrides)
            || !Array.isArray(edits.colorRanges)
          ) throw new Error('编辑数据格式无效。');

          const songId = edits.levelId.replace(/-flow$/, '');
          const songDirectory = resolve(import.meta.dirname, 'src', 'songs', songId);
          const level = JSON.parse(await readFile(resolve(songDirectory, 'level.json'), 'utf8'));
          if (level.id !== edits.levelId) throw new Error('关卡 ID 与目录不匹配。');
          await writeFile(
            resolve(songDirectory, 'edits.json'),
            `${JSON.stringify(edits, null, 2)}\n`,
          );
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ ok: true }));
        } catch (error) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
}
