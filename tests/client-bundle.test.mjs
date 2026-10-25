// Guards the client bundle's module-loader contract.
//
// dsh-client-modules calls `factory(require)` with no `module`/`exports` in
// scope and uses the returned object as the plugin's exports. A bundle that
// assigns to an undeclared `exports` throws "exports is not defined", which
// fails the whole Web boot — not just this plugin. Run: node tests/client-bundle.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let registration;
vm.runInNewContext(
  source,
  {
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value;
        },
      },
    },
    console,
  },
  { filename: 'lib/client.js' },
);

assert.ok(registration, 'the bundle must register through window.__ModuleLoader__.load');
assert.equal(registration.id, 'dsh-vision-click');
assert.equal(typeof registration.factory, 'function');

const exportsObject = registration.factory((specifier) => {
  if (specifier === 'react') return {};
  if (specifier === 'react/jsx-runtime') return { jsx() {}, jsxs() {} };
  throw new Error(`unexpected require(${specifier})`);
});

assert.equal(typeof exportsObject.apply, 'function', 'the factory must return the exports object with apply');
assert.deepEqual(Array.from(exportsObject.inject), ['slots', 'sessions']);

console.log('client bundle contract ok: apply + inject exported');
