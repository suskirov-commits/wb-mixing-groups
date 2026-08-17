/**
 * faults.js — проверка защит: обрыв датчика, перегрев, потеря тепла
 * на входе, ручной режим, авария внешнего термостата.
 *
 * Запуск: node test/faults.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MOD_DIR = path.join(__dirname, '..', 'etc', 'wb-rules-modules');

let vnow = 0,
  seq = 0;
const timers = new Map();
const addTimer = (cb, ms, rep) => (timers.set(++seq, { cb, at: vnow + ms, period: rep ? ms : 0 }), seq);
const delTimer = (id) => timers.delete(id);
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
  rules = [];
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
const defineVirtualDevice = (id, spec) => {
  for (const n of Object.keys(spec.cells)) {
    const c = spec.cells[n];
    store[id + '/' + n] = c.value !== undefined ? c.value : false;
    meta[id + '/' + n + '#error'] = '';
  }
  return { getControl: () => ({ setUnits() {}, setOrder() {}, setTitle() {} }) };
};
const defineRule = (n, c) => {
  rules.push({ topics: Array.isArray(c.whenChanged) ? c.whenChanged : [c.whenChanged], then: c.then });
};
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

const modCache = {};
const ctx = vm.createContext({
  dev: devProxy,
  log: logFn,
  defineVirtualDevice,
  defineRule,
  PersistentStorage: function () {
    return {};
  },
  setTimeout: (cb, ms) => addTimer(cb, ms, false),
  setInterval: (cb, ms) => addTimer(cb, ms, true),
  clearTimeout: delTimer,
  clearInterval: delTimer,
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
    filename: name + '.js'
  })(m.exports, m, wbrequire);
  return m.exports;
}

/* ---------------- сцена ---------------- */
const T_IN = 's/in',
  T_MIX = 's/mix',
  OPEN = 's/open',
  CLOSE = 's/close',
  PUMP = 's/pump',
  EMG = 's/emg';
for (const t of [T_IN, T_MIX, OPEN, CLOSE, PUMP, EMG]) meta[t + '#error'] = '';
store[T_IN] = 60;
store[T_MIX] = 35;
store[OPEN] = false;
store[CLOSE] = false;
store[PUMP] = false;
store[EMG] = false;

const GROUP = wbrequire('wbmix-group');
GROUP.create({
  id: 'mg',
  title: 'test',
  defaultEnabled: true,
  defaultMode: 1,
  defaultSetpoint: 35,
  sensors: { supplyIn: T_IN, supplyOut: T_MIX, tau: 0 },
  actuator: {
    type: 'tristate',
    open: OPEN,
    close: CLOSE,
    travelTime: 60,
    minPulse: 400,
    deadband: 1.5,
    interlock: 0
  },
  pump: { topic: PUMP, postRun: 30 },
  control: { period: 10, kp: 3, ki: 0.01, setpointMin: 20, setpointMax: 45, loopDeltaT: 7 },
  safety: {
    maxSupply: 45,
    maxSupplyHyst: 4,
    failSafePosition: 0,
    frostProtect: true,
    frostTemp: 6,
    emergencyInput: EMG
  }
});

// «Проматываем» время; клапан считаем стоящим (проверяем только логику защит)
function advance(sec) {
  for (let i = 0; i < sec; i++) {
    vnow += 1000;
    runDue();
  }
}

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (detail ? '  -> ' + detail : ''));
  }
}

const st = () => store['mg/state'];
const alarm = () => store['mg/alarm'];
const alarmText = () => store['mg/alarm_text'];

console.log('\n=== ПРОВЕРКА ЗАЩИТ ===\n');
advance(200); // дать пройти стартовой калибровке

console.log('1. Нормальная работа');
setDev(T_MIX, 35);
advance(30);
check('состояние «уставка держится»', st() === 'Уставка держится', st());
check('насос включён', store[PUMP] === true);
check('аварий нет', alarm() === false, alarmText());

console.log('\n2. Перегрев подачи (45 °C, предел 45)');
setDev(T_MIX, 47);
advance(30);
check('состояние «ограничение по перегреву»', st() === 'Ограничение по перегреву', st());
check('поднята авария', alarm() === true);
check('идёт закрытие клапана', store[CLOSE] === true || store['mg/position'] < 1);

console.log('\n3. Снятие перегрева (гистерезис 4 К)');
setDev(T_MIX, 42);
advance(30);
check('при 42 °C ограничение ещё держится', st() === 'Ограничение по перегреву', st());
setDev(T_MIX, 40);
advance(30);
check('при 40 °C ограничение снято', st() !== 'Ограничение по перегреву', st());

console.log('\n4. Обрыв датчика после узла (meta/error)');
meta[T_MIX + '#error'] = 'r';
advance(60);
check('состояние «авария»', st() === 'Авария', st());
check('в тексте аварии — датчик', /датчик/.test(alarmText()), alarmText());
check('насос оставлен включённым', store[PUMP] === true);
meta[T_MIX + '#error'] = '';
setDev(T_MIX, 35);
advance(60);
check('после восстановления вернулись в работу', st() !== 'Авария', st());

console.log('\n5. Выброс показаний (скачок 35 -> 120 °C)');
setDev(T_MIX, 120);
advance(10);
check('выброс отфильтрован, аварии перегрева нет', st() !== 'Ограничение по перегреву', st());
setDev(T_MIX, 35);
advance(30);

console.log('\n6. Внешний аварийный термостат');
setDev(EMG, true);
advance(20);
check('состояние «авария»', st() === 'Авария', st());
check('в тексте — внешний термостат', /термостат/.test(alarmText()), alarmText());
setDev(EMG, false);
advance(30);
check('после сброса вернулись в работу', st() !== 'Авария', st());

console.log('\n7. Нет тепла на входе (котёл 30 °C при уставке 35)');
setDev(T_IN, 30);
setDev(T_MIX, 29);
advance(400);
check('клапан открыт полностью', store['mg/position'] > 95, String(store['mg/position']));
check('состояние «нет тепла на входе»', st() === 'Нет тепла на входе', st());
const iBefore = store['mg/pid_i'];
advance(600);
check(
  'интегратор не разгоняется (anti-windup)',
  Math.abs(store['mg/pid_i'] - iBefore) < 20,
  iBefore + ' -> ' + store['mg/pid_i']
);
setDev(T_IN, 60);
setDev(T_MIX, 35);
advance(60);
check('после возврата тепла клапан прикрылся', store['mg/position'] < 90, String(store['mg/position']));

console.log('\n8. Защита от замерзания');
// Остываем реалистично: фильтр выбросов не пропустил бы прыжок 35 -> 4 °C
// одним шагом, и это правильное поведение — такой скачок физически
// невозможен и означает неисправность датчика, а не замерзание.
for (let v = 34; v >= 4; v -= 2) {
  setDev(T_MIX, v);
  advance(10);
}
advance(20);
check('состояние «защита от замерзания»', st() === 'Защита от замерзания', st());
check('насос включён', store[PUMP] === true);
setDev(T_MIX, 35);
advance(30);

console.log('\n9. Выключение контура и выбег насоса');
setDev('mg/enabled', false);
advance(10);
check('насос ещё работает (выбег)', store[PUMP] === true);
advance(40);
check('после выбега насос выключен', store[PUMP] === false);
check('состояние «выключен»', st() === 'Выключен', st());

console.log('\n10. Ручной режим');
setDev('mg/enabled', true);
setDev('mg/mode', 0);
setDev('mg/position_cmd', 60);
advance(300);
check('клапан отработал ручную позицию', Math.abs(store['mg/position'] - 60) < 3, String(store['mg/position']));
setDev(T_MIX, 50);
advance(30);
check('предел перегрева работает и в ручном режиме', store['mg/position'] < 60, String(store['mg/position']));

console.log('\n11. Потеря связи с модулем реле привода');
// Кран без возвратной пружины: если модуль реле отвалился, привод замер
// в неизвестном положении и сам никуда не вернётся. Положение обязано
// стать недостоверным, а после восстановления связи нужна калибровка.
setDev('mg/mode', 1);
setDev(T_MIX, 35);
setDev(T_IN, 60);
advance(200);
const g = GROUP.get('mg');
check('до аварии положение достоверно', g.act.isPositionTrusted() === true);

meta[OPEN + '#error'] = 'r';
advance(30);
check('поднята авария по приводу', alarm() === true);
check('в тексте — связь с модулем реле', /модулем реле/.test(alarmText()), alarmText());
check('состояние «авария»', st() === 'Авария', st());
check('положение помечено недостоверным', g.act.isPositionTrusted() === false);
check('оба реле сняты', store[OPEN] === false && store[CLOSE] === false);

const iDuring = store['mg/pid_i'];
advance(600);
check(
  'интегратор не разгоняется, пока приводом не управляем',
  Math.abs(store['mg/pid_i'] - iDuring) < 1,
  iDuring + ' -> ' + store['mg/pid_i']
);

meta[OPEN + '#error'] = '';
advance(20);
check('после восстановления связи авария снята', !/модулем реле/.test(alarmText()), alarmText());
check('запущена калибровка', st() === 'Калибровка привода' || g.act.calibrating === true, st());
advance(200);
check('после калибровки положение снова достоверно', g.act.isPositionTrusted() === true);

console.log('\n--- ИТОГО: ' + pass + ' пройдено, ' + fail + ' провалено ---\n');
if (fail) {
  console.log('Лог:');
  for (const l of logs.slice(-20)) console.log('  ' + l);
}
process.exit(fail ? 1 : 0);
