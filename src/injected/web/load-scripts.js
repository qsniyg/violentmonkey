import { getUniqId } from '#/common';
import { INJECT_CONTENT } from '#/common/consts';
import { attachFunction } from '../utils';
import {
  filter, map, join, defineProperty, Boolean, Promise, setTimeout, log, noop,
  objectEntries, jsonDump,
} from '../utils/helpers';
import bridge from './bridge';
import store from './store';
import { propertyToString } from './gm-api';
import { deletePropsCache, wrapGM } from './gm-wrapper';

const { concat } = Array.prototype;

bridge.addHandlers({
  LoadScripts(data) {
    if (data.mode !== bridge.mode) return;
    const start = [];
    const idle = [];
    const end = [];
    bridge.version = data.version;
    if ([
      'greasyfork.org',
    ].includes(window.location.host)) {
      exposeVM();
    }
    // reset load and checkLoad
    bridge.load = () => {
      bridge.load = noop;
      run(end);
      setTimeout(runIdle);
    };
    // Firefox doesn't display errors in content scripts https://bugzil.la/1410932
    const isFirefoxContentMode = bridge.isFirefox && bridge.mode === INJECT_CONTENT;
    // Firefox provides ComponentUtils functions in content scripts
    const componentUtils = isFirefoxContentMode ? '' : makeComponentUtilsPolyfill();
    const listMap = {
      'document-start': start,
      'document-idle': idle,
      'document-end': end,
    };
    if (data.items) {
      data.items.forEach((item) => {
        const { script } = item;
        const runAt = script.custom.runAt || script.meta.runAt;
        const list = listMap[runAt] || end;
        list.push(item);
        store.values[script.props.id] = data.values[script.props.id];
      });
      run(start);
    }
    if (!store.state && ['interactive', 'complete'].includes(document.readyState)) {
      store.state = 1;
    }
    if (store.state) bridge.load();

    function buildCode({ script, injectInto }) {
      const pathMap = script.custom.pathMap || {};
      const requireKeys = script.meta.require || [];
      const requires = requireKeys::map(key => data.require[pathMap[key] || key])::filter(Boolean);
      const code = data.code[script.props.id] || '';
      const { wrapper, thisObj, keys } = wrapGM(script, code, data.cache, injectInto);
      const id = getUniqId('VMin');
      const fnId = getUniqId('VMfn');
      const codeSlices = [
        `function(${
          keys::join(',')
        }){${
          isFirefoxContentMode
            ? 'try{'
            : ''
        }${
          keys::map(name => `this["${name}"]=${name};`)::join('')
        }with(this){${componentUtils}((define,module,exports)=>{`,
        // 1. trying to avoid string concatenation of potentially huge code slices
        // 2. adding `;` on a new line in case some required script ends with a line comment
        ...[]::concat(...requires::map(req => [req, '\n;'])),
        '(()=>{',
        code,
        // adding a new line in case the code ends with a line comment
        `\n})()})()}${
          isFirefoxContentMode
            ? '}catch(e){console.error(e)}'
            : ''
        }}`,
      ];
      const name = script.custom.name || script.meta.name || script.props.id;
      const args = keys::map(key => wrapper[key]);
      attachFunction(fnId, () => {
        const func = window[id];
        if (func) runCode(name, func, args, thisObj);
      });
      return [id, codeSlices, fnId, bridge.mode, script.props.id, script.meta.name];
    }

    function run(list) {
      bridge.post('InjectMulti', list::map(buildCode));
      list.length = 0;
    }

    async function runIdle() {
      for (const script of idle) {
        bridge.post('Inject', buildCode(script));
        await new Promise(setTimeout);
      }
      deletePropsCache();
      idle.length = 0;
    }
  },
});

function runCode(name, func, args, thisObj) {
  if (process.env.DEBUG) {
    log('info', [bridge.mode], name);
  }
  func.apply(thisObj, args);
}

// polyfills for Firefox's Components.utils functions exposed to userscripts
// TODO: create it at build-time
function makeComponentUtilsPolyfill() {
  const funcs = objectEntries({
    cloneInto: obj => obj,
    createObjectIn: (targetScope, options) => {
      const obj = {};
      if (options?.defineAs) targetScope[options.defineAs] = obj;
      return obj;
    },
    exportFunction: (func, targetScope, options) => {
      if (options?.defineAs) targetScope[options.defineAs] = func;
      return func;
    },
  });
  return `var ${
    funcs::map(([name, f]) => `${name}=${f}`)::join(',')
  };${
    funcs::map(([name]) => `${name}.toString=`)::join('')
  }()=>${
    jsonDump(propertyToString())
  };`;
}

function exposeVM() {
  const Violentmonkey = {};
  const checking = {};
  let key = 0;
  bridge.addHandlers({
    ScriptChecked({ callback, result }) {
      const cb = checking[callback];
      if (cb) {
        cb(result);
        delete checking[callback];
      }
    },
  });
  defineProperty(Violentmonkey, 'getVersion', {
    value: () => Promise.resolve({
      version: bridge.version,
    }),
  });
  defineProperty(Violentmonkey, 'isInstalled', {
    value: (name, namespace) => new Promise((resolve) => {
      key += 1;
      const callback = key;
      checking[callback] = resolve;
      bridge.post('CheckScript', { name, namespace, callback });
    }),
  });
  defineProperty(window.external, 'Violentmonkey', {
    value: Violentmonkey,
  });
}
