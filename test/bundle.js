/**
 * bundle.js — проверка ОДНОФАЙЛОВОЙ сборки dist/wb-mixing-groups.js.
 *
 * Грузит собранный файл ровно так, как это делает wb-rules: единый
 * скрипт в своём контексте, никаких внешних модулей. Проверяет, что
 * создаются оба виртуальных устройства, что контур выходит на уставку
 * и что повторная загрузка файла (автоперезагрузка при сохранении
 * в веб-интерфейсе) не плодит дублирующие тактовые циклы.
 *
 * Запуск: node test/bundle.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.join(__dirname, '..', 'dist', 'wb-mixing-groups.js');

let vnow = 0,
  seq = 0;
const timers = new Map();
function runDue() {
  for (;;) {
    let best = null;
    for (const [id, t] of timers)
      if (t.at <= vnow && (best === null || t.at < timers.get(best).at)) best = id;
    if (best === null) break;
    const t = timers.get(best);
    if (t.period > 0) t.at = vnow + t.period;
    else timers.delete(best);
    t.cb();
  }
}

const store = {},
  meta = {},
  rules = [],
  devices = {};
function setDev(topic, v) {
  const old = store[topic];
  store[topic] = v;
  if (old !== v) for (const r of rules) if (r.topics.indexOf(topic) >= 0) r.then(v);
}
const devProxy = new Proxy(
  {},
  {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (k.indexOf('#') >= 0) {
        const [t, m] = k.split('#');
        if (!(t in store)) return null;
        return meta[k] !== undefined ? meta[k] : m === 'error' ? '' : undefined;
      }
      return store[k];
    },
    set(_, k, v) {
      if (k.indexOf('#') >= 0) meta[k] = v;
      else setDev(k, v);
      return true;
    }
  }
);
function defineVirtualDevice(id, spec) {
  devices[id] = spec;
  for (const n of Object.keys(spec.cells)) {
    const c = spec.cells[n];
    store[id + '/' + n] = c.value !== undefined ? c.value : false;
    meta[id + '/' + n + '#error'] = '';
  }
  return { getControl: () => ({ setUnits() {}, setOrder() {}, setTitle() {} }) };
}
const defineRule = (n, c) =>
  rules.push({ topics: Array.isArray(c.whenChanged) ? c.whenChanged : [c.whenChanged], then: c.then });
const logs = [];
const fmt = (f, ...a) => {
  let i = 0;
  return String(f).replace(/\{\}/g, () => (i < a.length ? String(a[i++]) : '{}'));
};
const logFn = (...a) => logs.push(fmt(...a));
logFn.debug = () => {};
logFn.info = (...a) => logs.push('I ' + fmt(...a));
logFn.warning = (...a) => logs.push('W ' + fmt(...a));
logFn.error = (...a) => logs.push('E ' + fmt(...a));

/* wb-rules: у всех сценариев общий прототип глобального объекта */
const sharedProto = {};
const globalObj = Object.create(sharedProto);

const ctx = vm.createContext({
  global: globalObj,
  dev: devProxy,
  log: logFn,
  defineVirtualDevice,
  defineRule,
  PersistentStorage: function () {
    return {};
  },
  setTimeout: (cb, ms) => (timers.set(++seq, { cb, at: vnow + ms, period: 0 }), seq),
  setInterval: (cb, ms) => (timers.set(++seq, { cb, at: vnow + ms, period: ms }), seq),
  clearTimeout: (id) => timers.delete(id),
  clearInterval: (id) => timers.delete(id),
  Date: { now: () => vnow },
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  isFinite,
  parseFloat,
  Error,
  console
});

/* --- подменяем топики из примера конфига на стендовые --- */
let src = fs.readFileSync(BUNDLE, 'utf8');
const MAP = {
  'wb-w1/28-00000a1b2c3d': 'x/in',
  'wb-w1/28-00000a1b2c4e': 'x/mix_f',
  'wb-w1/28-00000a1b2c5f': 'x/ret_f',
  'wb-w1/28-00000a1b2c60': 'x/out',
  'wb-w1/28-00000a1b2c71': 'x/mix_r',
  'wb-w1/28-00000a1b2c82': 'x/ret_r',
  'wb-mr6c_45/K1': 'x/open_f',
  'wb-mr6c_45/K2': 'x/close_f',
  'wb-mr6c_45/K3': 'x/pump_f',
  'wb-mr6c_45/K4': 'x/pump_r',
  'wb-mao4_21/Channel 1': 'x/ao_r'
};
for (const [k, v] of Object.entries(MAP)) src = src.split(k).join(v);

for (const t of Object.values(MAP)) {
  store[t] = t.indexOf('open') >= 0 || t.indexOf('close') >= 0 || t.indexOf('pump') >= 0 ? false : 20;
  meta[t + '#error'] = '';
}
store['x/in'] = 60;
store['x/out'] = -5;
store['x/ao_r'] = 0;

let pass = 0,
  fail = 0;
const check = (n, c, d) =>
  c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (d ? ' -> ' + d : '')));

console.log('\n=== ОДНОФАЙЛОВАЯ СБОРКА ===\n');

console.log('1. Загрузка файла');
let loadErr = null;
try {
  vm.runInContext(src, ctx, { filename: 'wb-mixing-groups.js' });
} catch (e) {
  loadErr = e;
}
check('файл выполнился без ошибок', loadErr === null, loadErr && loadErr.message);
check('создано устройство mix_floor', !!devices['mix_floor']);
check('создано устройство mix_rad', !!devices['mix_rad']);
check('нет ошибок в логе', !logs.some((l) => l[0] === 'E'), logs.filter((l) => l[0] === 'E')[0]);
check('оба узла инициализированы', logs.some((l) => /инициализировано узлов: 2/.test(l)));

console.log('\n2. Контур с фазным приводом выходит на уставку');
// простая модель: подача идёт за смесью, обратка за подачей
let posF = 0,
  tMixF = 20,
  tRetF = 20;
const timersAtStart = timers.size;
for (let s = 0; s < 3600; s++) {
  vnow += 1000;
  runDue();
  if (store['x/open_f']) posF = Math.min(100, posF + 100 / 120);
  if (store['x/close_f']) posF = Math.max(0, posF - 100 / 120);
  const k = posF / 100;
  const tgt = k * 60 + (1 - k) * tRetF;
  tMixF += (tgt - tMixF) / 25;
  tRetF += (tMixF - 7 - tRetF) / 320;
  setDev('x/mix_f', +tMixF.toFixed(2));
  setDev('x/ret_f', +tRetF.toFixed(2));
}
check(
  'температура после узла вышла на 35 °C',
  Math.abs(tMixF - 35) < 1,
  tMixF.toFixed(2) + ' °C, позиция ' + posF.toFixed(1) + ' %'
);
check('состояние «уставка держится»', store['mix_floor/state'] === 'Уставка держится', store['mix_floor/state']);
check('аварий нет', store['mix_floor/alarm'] === false, store['mix_floor/alarm_text']);

console.log('\n3. Контур 0-10 В: аналоговый выход пишется');
check('на канал выдано напряжение', store['x/ao_r'] > 0, store['x/ao_r'] + ' мВ');
check(
  'режим кривой посчитал уставку при −5 °C на улице',
  store['mix_rad/target'] > 30 && store['mix_rad/target'] < 55,
  store['mix_rad/target']
);

console.log('\n4. Повторная загрузка (автоперезагрузка скрипта)');
const before = timers.size;
try {
  vm.runInContext(src, ctx, { filename: 'wb-mixing-groups.js' });
} catch (e) {
  loadErr = e;
}
check('повторная загрузка без ошибок', loadErr === null, loadErr && loadErr.message);
check(
  'дублирующих тактовых циклов не появилось',
  timers.size <= before,
  'было ' + before + ', стало ' + timers.size
);

console.log('\n--- ИТОГО: ' + pass + ' пройдено, ' + fail + ' провалено ---\n');
if (fail) for (const l of logs.slice(-15)) console.log('  ' + l);
process.exit(fail ? 1 : 0);
