const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
let runtime;
function productionRuntime() {
  return runtime ||= (async () => {
    const root = path.join(__dirname, '../..');
    const built = await esbuild.build({
      stdin: { contents: `
        export * from './src/io/gzipScan';
        export * from './src/io/gzipUnpack';
        export * from './src/io/gzipIndex';
        export * from './src/io/compression';
        export * from './src/nifti/headerParser';
        export * from './src/nifti/sliceExtractor';
        export * from './src/LocalFileProxy';
        export * from './webview/sliceFrame';
        export { makeSliceCacheKey } from './webview/SliceCacheDB';
        export { testConfig } from 'vscode';
      `, loader: 'ts', resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', write: false,
      plugins: [{ name: 'vscode-test-boundary', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
          export const env = { remoteName: 'ssh-remote' };
          export const testConfig = {};
          export const workspace = { getConfiguration: () => ({ get: (key, fallback) => testConfig[key] ?? fallback }) };
        ` }));
      } }],
    });
    const file = path.join(root, 'dist/p0-runtime.cjs'), mod = new Module(file, module);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(built.outputFiles[0].text, file);
    return mod.exports;
  })();
}
module.exports = { productionRuntime };
