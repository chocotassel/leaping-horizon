import { resolve } from 'node:path';
import babel from '@rollup/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { base64AssetPlugin, runtimeLevelPlugin } from './vite.base64-plugin.ts';

function android8CssPlugin(): Plugin {
  const legacyValue = (value: string): string => {
    let result = value;
    for (;;) {
      const match = /\b(clamp|min|max)\(/.exec(result);
      if (!match) break;
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      for (; end < result.length && depth; end += 1) {
        if (result[end] === '(') depth += 1;
        if (result[end] === ')') depth -= 1;
      }
      if (depth) break;
      const args: string[] = [];
      let argumentStart = start;
      let argumentDepth = 0;
      for (let index = start; index < end - 1; index += 1) {
        if (result[index] === '(') argumentDepth += 1;
        if (result[index] === ')') argumentDepth -= 1;
        if (result[index] === ',' && argumentDepth === 0) {
          args.push(result.slice(argumentStart, index));
          argumentStart = index + 1;
        }
      }
      args.push(result.slice(argumentStart, end - 1));
      const replacement = match[1] === 'clamp' ? args[1] : args[0];
      if (!replacement) break;
      result = result.slice(0, match.index) + replacement.trim() + result.slice(end);
    }
    return result
      .replace(/(-?\d*\.?\d+)cqw\b/g, '$1vw')
      .replace(/(-?\d*\.?\d+)cqh\b/g, '$1vh')
      .replace(/(-?\d*\.?\d+)dvw\b/g, '$1vw')
      .replace(/(-?\d*\.?\d+)dvh\b/g, '$1vh');
  };

  return {
    name: 'android-8-css-fallbacks',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].endsWith('.css')) return null;
      return code.replace(/(^|[;{])(\s*)([-\w]+)\s*:\s*([^;{}]+);/gm, (declaration, prefix, spacing, property, value) => {
        const fallback = legacyValue(value);
        return fallback === value
          ? declaration
          : `${prefix}${spacing}${property}: ${fallback};\n${spacing}${property}: ${value};`;
      });
    },
  };
}

function offlineRuntimePlugin(): Plugin {
  return {
    name: 'offline-runtime',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/three/examples/jsm/loaders/SVGLoader.js')) {
        const offlineCode = code.replace(
          /\n\tload\( url, onLoad, onProgress, onError \) \{[\s\S]*?\n\tparse\( text \) \{/,
          '\n\tparse( text ) {',
        );
        if (offlineCode === code) throw new Error('Unable to remove SVGLoader network method');
        return offlineCode;
      }
      if (id.includes('/react-dom/') && code.includes('navigator.connection')) {
        return code.replace(
          /return navigator\.connection &&\s*\(\(count = navigator\.connection\.downlink\), "number" === typeof count\)\s*\? count\s*: 5;/,
          'return 5;',
        );
      }
      return null;
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    base64AssetPlugin(),
    runtimeLevelPlugin(),
    offlineRuntimePlugin(),
    android8CssPlugin(),
    react(),
    babel({
      babelHelpers: 'bundled',
      babelrc: false,
      configFile: false,
      exclude: 'node_modules/**',
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      presets: [['@babel/preset-env', { bugfixes: true, modules: false, targets: { chrome: '61' } }]],
    }),
  ],
  build: {
    outDir: 'artifacts/leaping-horizon-minitool',
    emptyOutDir: true,
    target: 'chrome61',
    cssTarget: 'chrome61',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/main.tsx'),
      output: {
        format: 'iife',
        name: 'LeapingHorizon',
        entryFileNames: 'assets/app-[hash].js',
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.css'))
          ? 'assets/style.css'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
