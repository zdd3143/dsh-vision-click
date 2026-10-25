// Behavioural test for the composer consent switch.
//
// DSH 0.2's session.command() settles admission only, so the switch derives its
// state from the durable `command/done` events. This renders the client
// component against a fake session/sessions service and a minimal hook
// runtime, then drives the button. Run: node tests/client-consent.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const ON = '屏幕控制：SCREEN_CONTROL=on（已授权）';
const OFF = '屏幕控制：SCREEN_CONTROL=off（未授权）';

let clock = 1000;

function doneEntry(text) {
  return { event: { type: 'command/done', time: clock++, data: { kind: 'success', text } } };
}

function createSource(history = []) {
  const listeners = new Set();
  let snapshot = { entries: history, hasMore: false, revision: 0, change: { kind: 'replace', entries: history } };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(entry) {
      snapshot = {
        entries: [...snapshot.entries, entry],
        hasMore: false,
        revision: snapshot.revision + 1,
        change: { kind: 'append', entries: [entry] },
      };
      for (const listener of listeners) listener();
    },
  };
}

/** Mount the component over a fake host and return the test controller. */
function mount({ history = [], answer }) {
  const source = createSource(history);
  const calls = [];
  const states = [];
  let pendingEffects = [];
  let index = 0;

  const React = {
    useState(initial) {
      const slot = index++;
      if (!(slot in states)) states[slot] = initial;
      return [
        states[slot],
        (next) => {
          states[slot] = typeof next === 'function' ? next(states[slot]) : next;
        },
      ];
    },
    useEffect(effect) {
      pendingEffects[index++] = effect;
    },
    useCallback(callback) {
      index++;
      return callback;
    },
  };

  const jsx = (type, props) => ({ type, props });

  let registration;
  vm.runInNewContext(
    SOURCE,
    { window: { __ModuleLoader__: { load(value) { registration = value; } } }, console },
    { filename: 'lib/client.js' },
  );
  const exportsObject = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    throw new Error(`unexpected require(${specifier})`);
  });

  const sessions = {
    binding: (sessionId) =>
      sessionId === 's1'
        ? {
            session: {
              async command(line) {
                calls.push(line);
                source.push(doneEntry(answer(line)));
                return { ok: true, value: { matched: true } };
              },
            },
            eventSource: source,
          }
        : undefined,
  };

  let component;
  exportsObject.apply({
    sessions,
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(_definition, registered) {
        component = registered;
        return () => {};
      },
    },
  });
  assert.equal(typeof component, 'function', 'apply must register a component');

  const render = () => {
    index = 0;
    pendingEffects = [];
    return component({ sessionId: 's1', sessions });
  };

  let tree = render();
  for (const effect of pendingEffects) if (typeof effect === 'function') effect();
  tree = render();

  return {
    calls,
    label: () => tree.props.children.props.children[1].props.children,
    click: async () => {
      await tree.props.onClick();
      tree = render();
    },
    push: (entry) => {
      source.push(entry);
      tree = render();
    },
  };
}

// 1. Fresh session: neutral until the first click; the first click arms, the
//    second revokes, and both labels follow the host's own command/done text.
{
  const view = mount({ answer: (line) => (line === '/vision off' ? OFF : ON) });
  assert.equal(view.label(), '屏幕控制');
  await view.click();
  assert.deepEqual(view.calls, ['/vision arm']);
  assert.equal(view.label(), '屏幕控制：开');
  await view.click();
  assert.deepEqual(view.calls, ['/vision arm', '/vision off']);
  assert.equal(view.label(), '屏幕控制：关');
}

// 2. After a host restart the log still says "on" while the host reset to off:
//    the one-shot probe asks the host and the probe's own answer wins.
{
  const view = mount({ history: [doneEntry(ON)], answer: (line) => (line === '/vision status' ? OFF : ON) });
  assert.deepEqual(view.calls, ['/vision status']);
  assert.equal(view.label(), '屏幕控制：关');
}

// 3. A manual /vision command (typed in this session) updates the switch
//    through the event window without sending any extra command.
{
  const view = mount({ history: [doneEntry(OFF)], answer: () => OFF });
  assert.deepEqual(view.calls, ['/vision status']);
  assert.equal(view.label(), '屏幕控制：关');
  view.push(doneEntry(ON));
  assert.equal(view.label(), '屏幕控制：开');
  assert.deepEqual(view.calls, ['/vision status']);
}

console.log('client consent flow ok');
