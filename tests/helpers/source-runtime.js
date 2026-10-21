const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual production functions with browser/VS Code boundaries
// supplied by the test. Do not duplicate the implementation in tests.
function sourceRuntime(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions = new Map(ast.statements
    .filter(node => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
    .map(node => [node.name?.text, node.getText(ast)]));
  const selected = names.map(name => {
    if (!functions.has(name)) throw new Error(`Missing production function: ${name}`);
    return functions.get(name);
  }).join('\n');
  const js = ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({
    console, performance, setTimeout, clearTimeout, AbortController,
    ArrayBuffer, DataView, Float32Array, Uint8Array, TextDecoder, TextEncoder,
    ...globals,
  });
  vm.runInContext(js, context, { filename: file });
  vm.runInContext(`Object.assign(this, { ${names.join(', ')} });`, context);
  return context;
}

module.exports = { sourceRuntime };
