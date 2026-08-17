/**
 * actuator.js — модульные тесты приводов (0-10 В и фазного).
 * Запуск: node test/actuator.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MOD_DIR = path.join(__dirname, '..', 'etc', 'wb-rules-modules');

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
    timers.delete(best);
    t.cb();
  }
}
const store = {};
const devProxy = new Proxy(
  {},
  {
    get: (_, k) => (typeof k === 'string' && k.indexOf('#') >= 0 ? '' : store[k]),
    set: (_, k, v) => ((store[k] = v), true)
  }
);
const logFn = () => {};
logFn.debug = logFn.info = logFn.warning = logFn.error = () => {};

const modCache = {};
const ctx = vm.createContext({
  dev: devProxy,
  log: logFn,
  setTimeout: (cb, ms) => (timers.set(++seq, { cb, at: vnow + ms }), seq),
  clearTimeout: (id) => timers.delete(id),
  setInterval: () => 0,
  clearInterval: () => {},
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
  require: wbrequire,
  console
});
function wbrequire(name) {
  if (modCache[name]) return modCache[name].exports;
  const m = { exports: {}, static: {}, filename: name };
  modCache[name] = m;
  const code = fs.readFileSync(path.join(MOD_DIR, name + '.js'), 'utf8');
  vm.runInContext('(function(exports,module,require){' + code + '\n})', ctx, {
    filename: name
  })(m.exports, m, wbrequire);
  return m.exports;
}

const ACT = wbrequire('wbmix-actuator');
let pass = 0,
  fail = 0;
const check = (n, c, d) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (d ? ' -> ' + d : ''))));

/* ---------------- аналоговый 0-10 В ---------------- */
console.log('\n=== Аналоговый привод (WB-MAO4, 0-10 В) ===');
const a1 = ACT.create({ type: 'analog', out: 'ao/ch1', outUnits: 'mv', vMin: 0, vMax: 10000 }, {});
a1.apply(0, 5000);
check('0 % -> 0 мВ', store['ao/ch1'] === 0, store['ao/ch1']);
a1.apply(50, 5000);
check('50 % -> 5000 мВ', store['ao/ch1'] === 5000, store['ao/ch1']);
a1.apply(100, 5000);
check('100 % -> 10000 мВ', store['ao/ch1'] === 10000, store['ao/ch1']);
check('положение достоверно', a1.isPositionTrusted() === true);

console.log('\n=== Аналоговый привод 2-10 В ===');
const a2 = ACT.create({ type: 'analog', out: 'ao/ch2', vMin: 2000, vMax: 10000 }, {});
a2.apply(0, 5000);
check('0 % -> 2000 мВ', store['ao/ch2'] === 2000, store['ao/ch2']);
a2.apply(50, 5000);
check('50 % -> 6000 мВ', store['ao/ch2'] === 6000, store['ao/ch2']);

console.log('\n=== Аналоговый привод, инверсия ===');
const a3 = ACT.create({ type: 'analog', out: 'ao/ch3', invert: true }, {});
a3.apply(100, 5000);
check('100 % при инверсии -> 0 мВ', store['ao/ch3'] === 0, store['ao/ch3']);

console.log('\n=== Обратная связь по положению ===');
const a4 = ACT.create({ type: 'analog', out: 'ao/ch4', feedback: 'ai/fb', fbMin: 0, fbMax: 10000 }, {});
store['ai/fb'] = 7500;
check('обратная связь 7500 мВ -> 75 %', Math.abs(a4.getPosition() - 75) < 0.01, a4.getPosition());

/* ---------------- фазный 3-точечный ---------------- */
console.log('\n=== Фазный (3-точечный) привод, ход 100 с ===');
const store2 = {};
const t3 = ACT.create(
  {
    type: 'tristate',
    open: 'r/open',
    close: 'r/close',
    travelTime: 100,
    minPulse: 500,
    deadband: 1.5,
    interlock: 0
  },
  { storage: store2, log: logFn, id: 'v' }
);

function tick(ms) {
  const step = 100;
  for (let i = 0; i < ms / step; i++) {
    vnow += step;
    runDue();
  }
}

// стартовая калибровка
let act = t3.apply(50, 20000);
check('первый такт уходит в калибровку', act === 'calibrate', act);
tick(130000);
check('после калибровки позиция = 0', t3.getPosition() === 0, t3.getPosition());
check('позиция достоверна', t3.isPositionTrusted() === true);
check('оба реле сняты', store['r/open'] === false && store['r/close'] === false);

// шаг на 30 %: импульс намеренно ограничен тактом регулирования
// (20 с такта при 100 с хода = не более 17 % за такт), поэтому
// цель набирается за несколько тактов
t3.apply(30, 20000);
check('идёт открытие', store['r/open'] === true && store['r/close'] === false);
tick(18000);
check('за один такт отработано не более 17 %', t3.getPosition() <= 17.5, t3.getPosition());
check('реле снято до конца такта', store['r/open'] === false);
for (let i = 0; i < 4; i++) {
  t3.apply(30, 20000);
  tick(20000);
}
check('цель 30 % достигнута за несколько тактов', Math.abs(t3.getPosition() - 30) < 1.6, t3.getPosition());

// зона нечувствительности
const before = t3.getPosition();
const r = t3.apply(before + 1, 20000);
check('шаг 1 % внутри зоны нечувствительности игнорируется', r === 'idle', r);
check('позиция не изменилась', t3.getPosition() === before);

// накопление остатка: 4 такта по 1 % дают движение
let moved = false;
for (let i = 0; i < 5; i++) {
  const rr = t3.apply(before + 0.5 + i * 0.5, 20000);
  if (rr === 'open') moved = true;
  tick(5000);
}
check('малые приращения накапливаются и отрабатываются', moved === true);

// импульс не должен вылезать за такт регулирования
t3.apply(90, 20000);
for (let i = 0; i < 20; i++) tick(1000);
check('импульс уложился в такт 20 с', t3.moving === 0, 'moving=' + t3.moving);

// прижим к упору
t3.apply(0, 20000);
check('пошло закрытие на упор', store['r/close'] === true);
tick(125000);
check('позиция прибита к 0 %', t3.getPosition() === 0, t3.getPosition());
check('накопленный ход обнулён', t3.stats().travelAcc === 0, t3.stats().travelAcc);

// реверс без одновременного включения реле
t3.apply(50, 20000);
tick(1000);
check('одновременного включения реле нет', !(store['r/open'] && store['r/close']));

// halt посреди хода
t3.halt();
check('halt снимает оба реле', store['r/open'] === false && store['r/close'] === false);
check('позиция учла частичный ход', t3.getPosition() > 0 && t3.getPosition() < 50, t3.getPosition());

console.log('\n--- ИТОГО: ' + pass + ' пройдено, ' + fail + ' провалено ---\n');
process.exit(fail ? 1 : 0);
