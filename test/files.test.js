// Catches "works on my machine, crashes on the device": every relative require() in the app must
// point at a file that actually exists. If a file is missed when uploading a release to GitHub,
// this fails in CI instead of stopping a room screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const codeDirs = ['.', 'lib', 'routes', 'scripts'];

function jsFiles() {
  return codeDirs.flatMap(d => {
    const dir = path.join(root, d);
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
  });
}

function resolves(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  return [base, base + '.js', base + '.json', path.join(base, 'index.js')].some(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

test('every relative require() points at a file that exists', () => {
  const missing = [];
  for (const file of jsFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      if (!resolves(file, m[1])) missing.push(path.relative(root, file) + ' -> ' + m[1]);
    }
  }
  assert.deepEqual(missing, [], 'missing files: ' + missing.join(', '));
});

test('the Dockerfile copies every folder the app needs', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  for (const dir of ['lib', 'routes', 'public']) assert.match(docker, new RegExp('COPY ' + dir + ' '), dir + '/ is not copied into the image');
});
