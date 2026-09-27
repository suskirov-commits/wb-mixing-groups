/**
 * faults.js — проверка защит: обрыв датчика, перегрев, потеря тепла
 * на входе, ручной режим, авария внешнего термостата; проверка
 * конфигурации при старте (пустые топики, одно реле в двух узлах),
 * такт по типу привода, характеристика крана.
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
  rules = [],
  writes = []; // [топик, значение] — всё, что записал код узлов
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
      else {
        writes.push([k, v]);
        setDev(k, v);
      }
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

console.log('\n12. Перегрев прерывает прогон на открытие');
// Плановая рекалибровка к верхнему упору и антизалипание гонят клапан
// на полное открытие с перебегом 20 %. Раньше apply() в это время
// отвечал 'calibrate' и команду закрыть не принимал — защита была слепа.
advance(30);
g.act.calibrate(1, null);
check('идёт прогон на открытие', store[OPEN] === true);
setDev(T_MIX, 47);
advance(10);
check('перегрев снял команду «открыть»', store[OPEN] === false);
check('клапан пошёл на закрытие', store[CLOSE] === true, 'close=' + store[CLOSE]);
check('состояние «ограничение по перегреву»', st() === 'Ограничение по перегреву', st());
setDev(T_MIX, 35);
advance(200);

console.log('\n13. Аварийный термостат прерывает прогон на открытие');
g.act.calibrate(1, null);
check('идёт прогон на открытие', store[OPEN] === true);
setDev(EMG, true);
advance(10);
check('термостат снял команду «открыть»', store[OPEN] === false);
check('клапан пошёл на закрытие', store[CLOSE] === true, 'close=' + store[CLOSE]);
setDev(EMG, false);
advance(200);

console.log('\n14. Ход на закрытие защита не прерывает');
g.act.calibrate(-1, null);
setDev(T_MIX, 47);
advance(10);
check('прогон на закрытие продолжается', g.act.calibrating === true && store[CLOSE] === true);
setDev(T_MIX, 35);
advance(200);

console.log('\n15. Летнее отключение');
// Тёплый пол на грунте работает круглый год. Раньше отключить лето
// было нельзя: U.def() превращал summerCutoff: null в 16.
const T_OUT = 's/out';
meta[T_OUT + '#error'] = '';
store[T_OUT] = 25;
function summerGroup(id, curve) {
  const out = 'ao/' + id;
  meta[out + '#error'] = '';
  store[out] = 0;
  GROUP.create({
    id,
    title: id,
    defaultEnabled: true,
    defaultMode: 1,
    defaultSetpoint: 35,
    sensors: { supplyIn: T_IN, supplyOut: T_MIX, outdoor: T_OUT, tau: 0 },
    actuator: { type: 'analog', out },
    control: { period: 10 },
    curve
  });
}
summerGroup('sm_def', {});
summerGroup('sm_off', { summerShutdown: false });
summerGroup('sm_null', { summerCutoff: null });
advance(30);
check('по умолчанию при +25 °C на улице — «лето»', store['sm_def/state'] === 'Лето (отключен)', store['sm_def/state']);
setDev('sm_def/mode', 0);
setDev('sm_def/position_cmd', 50);
advance(20);
check('в «лете» не работает и ручной режим', store['ao/sm_def'] === 0, String(store['ao/sm_def']));
const offState = store['sm_off/state'];
check('с summerShutdown: false контур работает', offState !== 'Лето (отключен)' && offState !== 'Выключен', offState);
check('summerCutoff: null тоже выключает лето', store['sm_null/state'] !== 'Лето (отключен)', store['sm_null/state']);
setDev('sm_off/mode', 0);
setDev('sm_off/position_cmd', 50);
advance(20);
check('без летнего отключения работает и ручной режим', store['ao/sm_off'] === 5000, String(store['ao/sm_off']));

console.log('\n16. Эталонный конфиг: узлы не запускаются и ничего не переключают');
// Адреса модулей на каждом объекте свои. Правдоподобные адреса в эталоне
// (wb-mr6c_45/K1 и т. п.) сразу после установки переключили бы чужое
// оборудование, если такой модуль на объекте есть.
const stock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'etc', 'wb-mixing-groups.conf'), 'utf8'));
const checkGroups = GROUP.checkGroups || (() => ({}));
const stockProblems = checkGroups(stock.groups);
writes.length = 0;
for (const sg of stock.groups) GROUP.create(sg, stockProblems[sg.id]);
advance(300);
const OWN = /^(mg|sm_def|sm_off|sm_null|mix_floor|mix_rad|s|ao)\//;
const foreign = [...new Set(writes.filter(([t]) => !OWN.test(t)).map(([t]) => t))];
check('в чужие топики ничего не записано', foreign.length === 0, foreign.join(', '));
for (const id of ['mix_floor', 'mix_rad']) {
  check(id + ': состояние «ошибка настройки»', store[id + '/state'] === 'Ошибка настройки', store[id + '/state']);
  check(id + ': авария поднята', store[id + '/alarm'] === true);
  check(id + ': в тексте — что не задано', /датчик выхода/.test(store[id + '/alarm_text']), store[id + '/alarm_text']);
}

console.log('\n17. Одно реле в двух узлах, «открыть» = «закрыть»');
// Пауза на реверс защищает только внутри одного узла. Реле, которым
// командуют два узла, или привод, у которого «открыть» и «закрыть» —
// один выход, узел запускать нельзя: реле будут включаться вразнобой.
for (const t of ['c/r1', 'c/r2', 'c/r3', 'c/r4', 'c/r6', 'c/r7', 'c/ao']) {
  store[t] = t === 'c/ao' ? 0 : false;
  meta[t + '#error'] = '';
}
const tri = (open, close) => ({ type: 'tristate', open, close, travelTime: 60, interlock: 0 });
const node = (id, actuator, pump) => ({
  id,
  title: 'Узел ' + id,
  defaultSetpoint: 35,
  sensors: { supplyIn: T_IN, supplyOut: T_MIX, tau: 0 },
  actuator,
  pump: pump ? { topic: pump } : undefined,
  control: { period: 10 }
});
const set17 = [
  node('cA', tri('c/r1', 'c/r2')),
  node('cB', tri('c/r2', 'c/r3')), // c/r2 — «закрыть» узла cA
  node('cC', tri('c/r4', 'c/r4')),
  node('cD', { type: 'analog', out: 'c/ao' }, 'c/r1'), // насос на «открыть» узла cA
  node('cE', tri('c/r6', 'c/r7'))
];
const p17 = checkGroups(set17);
writes.length = 0;
for (const n of set17) GROUP.create(n, p17[n.id]);
advance(120);
for (const id of ['cA', 'cB', 'cC', 'cD']) {
  check(
    id + ': узел не запущен, авария',
    store[id + '/state'] === 'Ошибка настройки' && store[id + '/alarm'] === true,
    store[id + '/state'] + ' / ' + store[id + '/alarm_text']
  );
}
check('cB: в тексте — с каким узлом конфликт', /Узел cA/.test(store['cB/alarm_text']), store['cB/alarm_text']);
check('cC: в тексте — «открыть» и «закрыть» совпадают', /открыть.*закрыть/.test(store['cC/alarm_text']), store['cC/alarm_text']);
check('cD: в тексте — реле насоса', /насос/.test(store['cD/alarm_text']), store['cD/alarm_text']);
const touched = writes.filter(([t]) => /^c\/(r[1-4]|ao)$/.test(t)).map(([t, v]) => t + '=' + v);
check('реле и выходы узлов с конфликтом не тронуты', touched.length === 0, touched.join(', '));
check(
  'узел без конфликтов работает',
  store['cE/state'] !== 'Ошибка настройки' && store['cE/alarm'] === false,
  store['cE/state'] + ' / ' + store['cE/alarm_text']
);

console.log('\n18. Такт по типу привода');
// Эталонный такт радиаторов был 5 с — под 0-10 В. На объекте тип привода
// переключили в форме на фазный, а явный такт так и остался 5 с.
// Такт 0 = «по типу привода»: фазному 20 с, аналоговому 5 с.
const stockRad = () => {
  const g = JSON.parse(JSON.stringify(stock.groups.find((x) => x.id === 'mix_rad')));
  g.sensors.supplyIn = T_IN;
  g.sensors.supplyOut = T_MIX;
  g.pump = {};
  return g;
};
store['c/r8'] = store['c/r9'] = false;
store['c/ao2'] = 0;
for (const t of ['c/r8', 'c/r9', 'c/ao2']) meta[t + '#error'] = '';
const radTri = stockRad();
radTri.id = 'pr_tri';
radTri.actuator = { type: 'tristate', open: 'c/r8', close: 'c/r9', travelTime: 120 };
GROUP.create(radTri);
const radAna = stockRad();
radAna.id = 'pr_ana';
radAna.actuator.out = 'c/ao2';
GROUP.create(radAna);
check('эталонный узел, переключённый на фазный привод: такт 20 с', GROUP.get('pr_tri').periodMs === 20000, GROUP.get('pr_tri').periodMs + ' мс');
check('он же с приводом 0-10 В: такт 5 с', GROUP.get('pr_ana').periodMs === 5000, GROUP.get('pr_ana').periodMs + ' мс');

console.log('\n19. Характеристика крана в упреждении');
// Без датчика обратки: T_обр = 35 − 7 = 28 °C, доля горячего потока
// (35 − 28) / (55 − 28) = 0,259. Линейный кран — 25,9 %; равнопроцентный
// с R = 50 — ln(1 + 0,259 · 49) / ln 50 = 66,9 %. На объекте при
// упреждении 25 % кран реально стоял на 67 %.
const R_IN = 'r/in',
  R_MIX = 'r/mix';
for (const t of [R_IN, R_MIX]) meta[t + '#error'] = '';
store[R_IN] = 55;
store[R_MIX] = 35;
const valveGroup = (id, valveCurve) => {
  meta['v/' + id + '#error'] = '';
  store['v/' + id] = 0;
  GROUP.create({
    id,
    title: id,
    defaultSetpoint: 35,
    sensors: { supplyIn: R_IN, supplyOut: R_MIX, tau: 0 },
    actuator: { type: 'analog', out: 'v/' + id },
    control: { period: 10, loopDeltaT: 7, valveCurve }
  });
};
valveGroup('vl');
valveGroup('ve', 50);
advance(20);
check('линейный кран: упреждение 25,9 %', Math.abs(store['vl/ff'] - 25.9) < 0.2, String(store['vl/ff']));
check('равнопроцентный, R = 50: упреждение 66,9 %', Math.abs(store['ve/ff'] - 66.9) < 0.3, String(store['ve/ff']));
const posBefore = store['vl/position'];
setDev('vl/valve_curve', 50);
advance(10);
check('R меняется на лету со страницы устройства', Math.abs(store['vl/ff'] - 66.9) < 0.3, String(store['vl/ff']));
check('смена R не дёргает кран', Math.abs(store['vl/position'] - posBefore) < 1, posBefore + ' -> ' + store['vl/position']);
check(
  'разницу принял интегратор',
  Math.abs(store['vl/pid_i'] - (posBefore - 66.9)) < 1,
  String(store['vl/pid_i'])
);

console.log('\n--- ИТОГО: ' + pass + ' пройдено, ' + fail + ' провалено ---\n');
if (fail) {
  console.log('Лог:');
  for (const l of logs.slice(-20)) console.log('  ' + l);
}
process.exit(fail ? 1 : 0);
