/**
 * sim.js — стенд для проверки алгоритма без контроллера.
 *
 * Эмулирует:
 *   - рантайм wb-rules (dev, defineVirtualDevice, defineRule, таймеры,
 *     PersistentStorage, log, require из /etc/wb-rules-modules);
 *   - гидравлику смесительного узла: смешение, тепловую инерцию
 *     смесителя, транспортное запаздывание до датчика, инерцию контура;
 *   - фазный привод: реле -> реальное перемещение штока.
 *
 * Запуск: node test/sim.js
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MOD_DIR = path.join(__dirname, '..', 'etc', 'wb-rules-modules');

/* =================================================================== */
/*  Виртуальное время и планировщик                                     */
/* =================================================================== */

let vnow = 0; // мс
let seq = 0;
const timers = new Map();

function addTimer(cb, ms, repeat) {
  const id = ++seq;
  timers.set(id, { cb, at: vnow + ms, period: repeat ? ms : 0 });
  return id;
}
function delTimer(id) {
  timers.delete(id);
}
function runDue() {
  let guard = 0;
  for (;;) {
    let best = null;
    for (const [id, t] of timers) {
      if (t.at <= vnow && (best === null || t.at < timers.get(best).at)) best = id;
    }
    if (best === null) break;
    const t = timers.get(best);
    if (t.period > 0) t.at = vnow + t.period;
    else timers.delete(best);
    t.cb();
    if (++guard > 10000) throw new Error('timer storm');
  }
}

/* =================================================================== */
/*  Модель объекта                                                      */
/* =================================================================== */

const P = {
  travel: 120, // с, полный ход привода
  tauMix: 25, // с, инерция смесителя
  deadTime: 12, // с, транспорт до датчика подачи
  tauLoop: 320, // с, инерция контура (стяжка/петли)
  loopDrop: 7, // К, теплосъём контура
  noise: 0.04 // К, шум датчика
};

const plant = {
  pos: 0, // реальное положение штока, %
  relOpen: false,
  relClose: false,
  tIn: 60, // от котла
  tMixInternal: 20, // температура в смесителе
  tRet: 20, // обратка контура
  buf: [], // линия задержки до датчика
  tSensor: 20
};

function plantStep(dt) {
  // 1. Привод
  let v = 0;
  if (plant.relOpen && !plant.relClose) v = 100 / P.travel;
  if (plant.relClose && !plant.relOpen) v = -100 / P.travel;
  plant.pos = Math.max(0, Math.min(100, plant.pos + v * dt));

  // 2. Мгновенное смешение
  const k = plant.pos / 100;
  const tTarget = k * plant.tIn + (1 - k) * plant.tRet;

  // 3. Инерция смесителя
  plant.tMixInternal += ((tTarget - plant.tMixInternal) * dt) / P.tauMix;

  // 4. Транспортное запаздывание до датчика
  const steps = Math.round(P.deadTime / dt);
  plant.buf.push(plant.tMixInternal);
  while (plant.buf.length > steps) plant.buf.shift();
  plant.tSensor = plant.buf[0];

  // 5. Контур: обратка гонится за подачей минус теплосъём
  plant.tRet += ((plant.tSensor - P.loopDrop - plant.tRet) * dt) / P.tauLoop;
}

/* =================================================================== */
/*  Эмуляция wb-rules                                                   */
/* =================================================================== */

const store = {}; // MQTT-хранилище значений
const meta = {};
const vdevs = {};
const rules = [];

function setDev(topic, value) {
  const old = store[topic];
  store[topic] = value;
  if (old !== value) {
    for (const r of rules) if (r.topics.indexOf(topic) >= 0) r.then(value, ...topic.split('/'));
  }
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

function makeControl(devId, name) {
  return {
    setUnits() {},
    setOrder() {},
    setTitle() {},
    getValue: () => store[devId + '/' + name]
  };
}

function defineVirtualDevice(id, spec) {
  vdevs[id] = spec;
  for (const name of Object.keys(spec.cells)) {
    const c = spec.cells[name];
    if (c.value !== undefined) store[id + '/' + name] = c.value;
    else if (c.type === 'pushbutton') store[id + '/' + name] = false;
    meta[id + '/' + name + '#error'] = '';
  }
  return {
    getControl: (n) => {
      if (!(n in spec.cells)) throw new Error('no control ' + n);
      return makeControl(id, n);
    }
  };
}

function defineRule(name, cfg) {
  const t = cfg.whenChanged;
  rules.push({ name, topics: Array.isArray(t) ? t : [t], then: cfg.then });
  return rules.length;
}

const logCalls = [];
function fmt(f, ...a) {
  let i = 0;
  return String(f).replace(/\{\}/g, () => (i < a.length ? String(a[i++]) : '{}'));
}
const logFn = (...a) => logCalls.push(fmt(...a));
logFn.debug = () => {};
logFn.info = (...a) => logCalls.push('I ' + fmt(...a));
logFn.warning = (...a) => logCalls.push('W ' + fmt(...a));
logFn.error = (...a) => logCalls.push('E ' + fmt(...a));

function PersistentStorage() {
  return {};
}

const FakeDate = { now: () => vnow };

/* --- загрузчик модулей --- */
const modCache = {};
const ctx = vm.createContext({
  dev: devProxy,
  log: logFn,
  defineVirtualDevice,
  defineRule,
  PersistentStorage,
  setTimeout: (cb, ms) => addTimer(cb, ms, false),
  setInterval: (cb, ms) => addTimer(cb, ms, true),
  clearTimeout: delTimer,
  clearInterval: delTimer,
  Date: FakeDate,
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
  const wrapper = vm.runInContext(
    '(function(exports, module, require){' + code + '\n})',
    ctx,
    { filename: name + '.js' }
  );
  wrapper(m.exports, m, wbrequire);
  return m.exports;
}

/* =================================================================== */
/*  Сборка сценария                                                     */
/* =================================================================== */

const T_IN = 'sim/t_in';
const T_MIX = 'sim/t_mix';
const T_RET = 'sim/t_ret';
const R_OPEN = 'sim/open';
const R_CLOSE = 'sim/close';
const PUMP = 'sim/pump';

store[T_IN] = 60;
store[T_MIX] = 20;
store[T_RET] = 20;
store[R_OPEN] = false;
store[R_CLOSE] = false;
store[PUMP] = false;
for (const t of [T_IN, T_MIX, T_RET, R_OPEN, R_CLOSE, PUMP]) meta[t + '#error'] = '';

const CFG = {
  id: 'mix_floor',
  title: 'ТП',
  defaultEnabled: true,
  defaultMode: 1,
  defaultSetpoint: 35,
  sensors: { supplyIn: T_IN, supplyOut: T_MIX, returnLine: T_RET, tau: 5 },
  actuator: {
    type: 'tristate',
    open: R_OPEN,
    close: R_CLOSE,
    travelTime: P.travel,
    minPulse: 500,
    deadband: 1.5,
    interlock: 300,
    recalibrateAfter: 500
  },
  pump: { topic: PUMP, postRun: 60, antiStickDays: 7 },
  control: {
    period: 20,
    kp: 3.0,
    ki: 0.012,
    kd: 0,
    deadband: 0.3,
    setpointMin: 20,
    setpointMax: 45,
    setpointRamp: 2,
    loopDeltaT: 7,
    feedForward: true
  },
  safety: { maxSupply: 45, maxSupplyHyst: 4, failSafePosition: 0, frostProtect: false }
};

const GROUP = wbrequire('wbmix-group');

/* =================================================================== */
/*  Прогон                                                              */
/* =================================================================== */

const args = process.argv.slice(2);
const NO_FF = args.indexOf('--no-ff') >= 0;
if (NO_FF) CFG.control.feedForward = false;

GROUP.create(CFG);

const DT = 0.2; // с, шаг модели
const HOURS = 2.5;
const rows = [];

let peak = 0;
let settleTime = null;
const events = [];

for (let t = 0; t < HOURS * 3600; t += DT) {
  // --- возмущения ---
  if (Math.abs(t - 3600) < DT / 2) {
    plant.tIn = 75; // котёл резко поднял температуру
    events.push([t, 'вход 60 -> 75 °C']);
  }
  if (Math.abs(t - 5400) < DT / 2) {
    plant.tIn = 42; // котёл просел
    events.push([t, 'вход 75 -> 42 °C']);
  }
  if (Math.abs(t - 7200) < DT / 2) {
    setDev('mix_floor/setpoint', 30);
    events.push([t, 'уставка 35 -> 30 °C']);
  }

  plantStep(DT);

  // публикуем показания датчиков с шумом
  setDev(T_IN, +(plant.tIn + (Math.random() - 0.5) * P.noise).toFixed(3));
  setDev(T_MIX, +(plant.tSensor + (Math.random() - 0.5) * P.noise).toFixed(3));
  setDev(T_RET, +(plant.tRet + (Math.random() - 0.5) * P.noise).toFixed(3));

  vnow += DT * 1000;
  runDue();

  // реле -> модель
  plant.relOpen = store[R_OPEN] === true;
  plant.relClose = store[R_CLOSE] === true;

  const target = store['mix_floor/target'];
  if (t > 60 && plant.tSensor > peak) peak = plant.tSensor;
  if (settleTime === null && t > 60 && Math.abs(plant.tSensor - 35) < 0.5) settleTime = t;

  if (Math.round(t / DT) % Math.round(30 / DT) === 0) {
    rows.push({
      t,
      tIn: plant.tIn,
      sp: target,
      tMix: plant.tSensor,
      posReal: plant.pos,
      posModel: store['mix_floor/position'],
      ff: store['mix_floor/ff'],
      state: store['mix_floor/state']
    });
  }
}

/* =================================================================== */
/*  Отчёт                                                               */
/* =================================================================== */

function bar(v, max, w) {
  const n = Math.round((Math.max(0, Math.min(max, v)) / max) * w);
  return '#'.repeat(n).padEnd(w, '.');
}

console.log('\n=== ПРОГОН: ' + (NO_FF ? 'ТОЛЬКО ПИ (без упреждения)' : 'FF + ПИ') + ' ===\n');
console.log(
  'время   Твх    уст    Твых   поз(факт) поз(модель) FF     состояние'
);
for (const r of rows) {
  if (Math.round(r.t) % 300 !== 0) continue;
  const mm = String(Math.floor(r.t / 60)).padStart(4);
  console.log(
    `${mm}м  ${r.tIn.toFixed(1).padStart(5)}  ${String(r.sp).padStart(5)}  ` +
      `${r.tMix.toFixed(2).padStart(6)}  ${r.posReal.toFixed(1).padStart(6)}    ` +
      `${String(r.posModel).padStart(6)}   ${String(r.ff).padStart(5)}  ${r.state}`
  );
}

console.log('\nСобытия:');
for (const [t, e] of events) console.log('  ' + Math.round(t / 60) + ' мин: ' + e);

/* --- метрики качества по участкам --- */
function seg(from, to) {
  const s = rows.filter((r) => r.t >= from && r.t <= to);
  const errs = s.map((r) => Math.abs(r.tMix - (r.sp || 35)));
  const max = Math.max(...errs);
  const avg = errs.reduce((a, b) => a + b, 0) / errs.length;
  return { max, avg };
}

console.log('\nКачество поддержания (|Твых − уставка|):');
const s1 = seg(1200, 3600);
const s2 = seg(3660, 5400);
const s3 = seg(5460, 7200);
const s4 = seg(7260, 9000);
console.log(`  установившийся режим:      макс ${s1.max.toFixed(2)} К, средн ${s1.avg.toFixed(2)} К`);
console.log(`  после скачка входа +15 К:  макс ${s2.max.toFixed(2)} К, средн ${s2.avg.toFixed(2)} К`);
console.log(`  после провала входа −33 К: макс ${s3.max.toFixed(2)} К, средн ${s3.avg.toFixed(2)} К`);
console.log(`  после смены уставки −5 К:  макс ${s4.max.toFixed(2)} К, средн ${s4.avg.toFixed(2)} К`);
console.log(`  перерегулирование при пуске: ${(peak - 35).toFixed(2)} К`);
console.log(`  выход в зону ±0.5 К:         ${settleTime ? Math.round(settleTime / 60) + ' мин' : 'не достигнут'}`);

/* --- износ привода --- */
const g = GROUP.get('mix_floor');
const st = g.act.stats();
console.log('\nПривод:');
console.log(`  включений реле: ${st.moves}, суммарное время хода: ${st.onMinutes} мин`);
console.log(`  накопленный ход с калибровки: ${st.travelAcc} %`);
console.log(`  зона нечувствительности: ${st.deadband} %`);
console.log(`  ошибка модели положения: ${(st.pos - plant.pos).toFixed(2)} % (модель ${st.pos}, факт ${plant.pos.toFixed(1)})`);

console.log('\nЛог:');
for (const l of logCalls.slice(0, 25)) console.log('  ' + l);
console.log('');
