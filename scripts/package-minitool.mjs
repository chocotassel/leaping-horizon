import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outputDir = join(root, 'artifacts/leaping-horizon-minitool');
const zipPath = join(root, 'artifacts/leaping-horizon-minitool.zip');
const reportPath = join(root, 'artifacts/leaping-horizon-minitool-validation.json');
const allowedExtensions = new Set([
  '.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.json',
]);

const createIndexHtml = (appPath) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>飞跃地平线</title>
    <link rel="stylesheet" href="./assets/style.css">
  </head>
  <body>
    <div id="root"></div>
    <script src="./${appPath}"></script>
  </body>
</html>
`;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const builtFiles = await listFiles(outputDir);
const appFiles = builtFiles.filter((file) => extname(file) === '.js');
assert(appFiles.length === 1, `Expected one app script, found ${appFiles.length}`);
const appPath = relative(outputDir, appFiles[0]);
assert(/^assets\/app-[A-Za-z0-9_-]+\.js$/.test(appPath), 'App script must use a content-hashed filename');
await writeFile(join(outputDir, 'index.html'), createIndexHtml(appPath));

const files = await listFiles(outputDir);
const paths = files.map((file) => relative(outputDir, file));
assert(paths.includes('index.html'), 'index.html must be at ZIP root');
assert(paths.filter((path) => path.endsWith('.html')).length === 1, 'ZIP must contain exactly one HTML file');
assert(paths.every((path) => allowedExtensions.has(extname(path).toLowerCase())), 'ZIP contains an unsupported file type');
assert(paths.every((path) => !path.split('/').some((part) => part.startsWith('.'))), 'ZIP contains a hidden file');

const sourceFiles = files.filter((file) => ['.html', '.css', '.js', '.json', '.svg'].includes(extname(file)));
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')))).join('\n');
const html = await readFile(join(outputDir, 'index.html'), 'utf8');
const css = await readFile(join(outputDir, 'assets/style.css'), 'utf8');
const js = await readFile(join(outputDir, appPath), 'utf8');

const forbidden = [
  ['network request', /\b(?:fetch|XMLHttpRequest)\b/],
  ['realtime or worker API', /\b(?:WebSocket|EventSource|RTCPeerConnection|SharedWorker|Worker)\b/],
  ['dynamic execution', /\beval\s*\(|\bnew\s+Function\s*\(|\bWebAssembly\b/],
  ['blocked browser API', /navigator\.(?:geolocation|clipboard|bluetooth|usb|hid|serial|getBattery|connection|credentials|locks)|navigator\.(?:storage\.persist|serviceWorker\.register)|requestFullscreen|window\.(?:open|prompt)\s*\(|location\.(?:href\s*=(?!=)|assign\s*\()/],
  ['media data URL', /data:(?:audio|video)\//],
];
for (const [name, pattern] of forbidden) assert(!pattern.test(source), `Forbidden ${name} found`);
assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'Inline script found');
assert(!/\btype=["']module["']/i.test(html), 'Module script found');
assert(!/\b(?:src|href)=["'](?:\/|https?:|data:|blob:)/i.test(html), 'Non-relative HTML resource found');
assert(!/url\(\s*["']?https?:/i.test(css), 'External CSS resource found');
assert(!/\b(?:import\s*(?:\(|\{|\*)|export\s+(?:default|const|let|var|function|class|\{|\*))/m.test(js), 'ES module syntax found');
assert(!/(^|[;{])\s*inset\s*:/m.test(css), 'Unsupported CSS inset declaration found');
assert(css.includes('border-radius:1.8vw') && css.includes('1.8cqw'), 'Android 8 CSS fallback declarations are missing');

const threePackage = JSON.parse(await readFile(join(root, 'node_modules/three/package.json'), 'utf8'));
const rendererSource = await readFile(join(root, 'node_modules/three/src/renderers/WebGLRenderer.js'), 'utf8');
const gameSceneSource = await readFile(join(root, 'src/game/GameScene.ts'), 'utf8');
assert(threePackage.version === '0.162.0', `Three.js must be 0.162.0, got ${threePackage.version}`);
assert(rendererSource.includes("[ 'webgl2', 'webgl', 'experimental-webgl' ]"), 'Pinned Three.js renderer lacks a WebGL1 context path');
assert(gameSceneSource.includes('new THREE.WebGLRenderer('), 'Game scene must prefer WebGL2 with WebGL1 fallback');
assert(!gameSceneSource.includes('new THREE.WebGL1Renderer('), 'Game scene must not force WebGL1 on capable devices');

const syntax = spawnSync(process.execPath, ['--check', join(outputDir, appPath)], { encoding: 'utf8' });
assert(syntax.status === 0, syntax.stderr || 'Classic bundle syntax check failed');

await rm(zipPath, { force: true });
const zipped = spawnSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: outputDir, encoding: 'utf8' });
assert(zipped.status === 0, zipped.stderr || 'zip failed');

const fileStats = await Promise.all(files.map(async (file) => ({
  path: relative(outputDir, file),
  bytes: (await stat(file)).size,
})));
const zipBytes = (await stat(zipPath)).size;
assert(zipBytes <= 10 * 1024 * 1024, `ZIP exceeds 10 MiB: ${zipBytes} bytes`);

const zipEntries = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
assert(zipEntries.status === 0, zipEntries.stderr || 'Unable to inspect ZIP');
assert(zipEntries.stdout.split('\n').includes('index.html'), 'Packaged ZIP root does not contain index.html');

const report = {
  status: 'PASS',
  createdAt: new Date().toISOString(),
  artifactDirectory: outputDir,
  zipPath,
  zipBytes,
  uncompressedBytes: fileStats.reduce((sum, file) => sum + file.bytes, 0),
  files: fileStats,
  checks: {
    rootIndex: true,
    allowedFileTypesOnly: true,
    localRelativeResources: true,
    classicExternalScript: true,
    forbiddenCapabilitiesAbsent: true,
    android8CssFallbacks: true,
    cssInsetAbsent: true,
    babelTarget: 'Chrome 61 / Android 8 WebView baseline',
    threeVersion: threePackage.version,
    webgl1ContextPath: true,
    webgl2Preferred: true,
    contentHashedScript: appPath,
    sizeLimitBytes: 10 * 1024 * 1024,
  },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ zipPath, reportPath, zipBytes, files: fileStats.length }));
