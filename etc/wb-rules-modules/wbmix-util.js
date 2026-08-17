/**
 * @file wbmix-util.js
 * @description Утилиты для модуля управления смесительными узлами:
 *              валидация чисел, фильтрация показаний датчиков,
 *              отбраковка выбросов, контроль связи по meta/error.
 *
 * Целевой рантайм: wb-rules 2.x (duktape, ECMAScript 5).
 * Никаких let/const/=>/шаблонных строк.
 */

/* ------------------------------------------------------------------ */
/*  Базовые хелперы                                                    */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/** Мягкое приведение значения из MQTT к числу. */
function toNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  var n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

/** Округление до N знаков (для публикации в MQTT). */
function round(v, digits) {
  if (!isNum(v)) return v;
  var k = Math.pow(10, digits === undefined ? 2 : digits);
  return Math.round(v * k) / k;
}

/** Поверхностное слияние объектов (замена Object.assign из ES6). */
function extend(dst, src) {
  if (!src) return dst;
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
  }
  return dst;
}

/** Значение по умолчанию, если поле не задано. */
function def(v, d) {
  return v === undefined || v === null ? d : v;
}

/* ------------------------------------------------------------------ */
/*  Экспоненциальный фильтр первого порядка                            */
/* ------------------------------------------------------------------ */

/**
 * @param {number} tau постоянная времени фильтра, с (0 = фильтр выключен)
 */
function Ema(tau) {
  this.tau = tau || 0;
  this.value = null;
}

Ema.prototype.push = function (x, dt) {
  if (!isNum(x)) return this.value;
  if (this.value === null || this.tau <= 0 || !isNum(dt) || dt <= 0) {
    this.value = x;
    return this.value;
  }
  var a = dt / (this.tau + dt);
  this.value = this.value + a * (x - this.value);
  return this.value;
};

Ema.prototype.reset = function () {
  this.value = null;
};

/* ------------------------------------------------------------------ */
/*  Датчик температуры                                                 */
/* ------------------------------------------------------------------ */

/**
 * Обёртка над MQTT-топиком датчика температуры.
 *
 * Делает всё, что нужно для промышленной эксплуатации:
 *   - проверяет наличие контрола и meta/error (обрыв 1-Wire, потеря Modbus);
 *   - отбраковывает значения вне физического диапазона;
 *   - отбраковывает выбросы (скачок быстрее maxRate градусов в секунду);
 *   - сглаживает показания фильтром первого порядка;
 *   - поднимает признак fault только после N подряд плохих чтений,
 *     чтобы одиночный сбой опроса не ронял контур в аварию.
 *
 * @param {string} topic  "device/control", например "wb-w1/28-0000073d8f4c"
 * @param {Object} opts   { tau, min, max, maxRate, faultAfter, required }
 */
function Sensor(topic, opts) {
  opts = opts || {};
  this.topic = topic || null;
  this.required = def(opts.required, true);
  this.min = def(opts.min, -60);
  this.max = def(opts.max, 150);
  // Предельная физически осмысленная скорость изменения температуры
  // теплоносителя на датчике. 2 К/с = 120 К/мин — заведомо выше любого
  // реального переходного процесса в смесительном узле, но отсекает
  // «мусор» с шины (обрыв 1-Wire отдаёт 85 или 127, сбой Modbus —
  // случайное слово). Одиночный выброс критичен: по нему сработала бы
  // защита от перегрева и закрыла исправный контур.
  this.maxRate = def(opts.maxRate, 2); // К/с
  this.faultAfter = def(opts.faultAfter, 3);
  this.ema = new Ema(def(opts.tau, 5));

  this.value = null; // отфильтрованное
  this.raw = null; // последнее принятое сырое
  this.badCount = 0;
  this.fault = false;
  this.reason = this.topic ? 'init' : 'not configured';
  this.configured = !!this.topic;
}

/**
 * Прочитать датчик.
 * @param {number} dt интервал с прошлого чтения, с
 * @returns {boolean} true, если значение валидно
 */
Sensor.prototype.poll = function (dt) {
  if (!this.configured) {
    this.fault = this.required;
    return false;
  }

  var bad = null;
  var v = NaN;

  // 1. Существование контрола и признак ошибки шины
  var errMeta = dev[this.topic + '#error'];
  if (errMeta === null) {
    bad = 'no control';
  } else if (errMeta !== undefined && errMeta !== '' && errMeta !== false) {
    bad = 'bus error: ' + errMeta;
  } else {
    // 2. Значение и физический диапазон
    v = toNum(dev[this.topic]);
    if (!isNum(v)) bad = 'no value';
    else if (v < this.min || v > this.max) bad = 'out of range: ' + v;
    // 3. Отбраковка выбросов
    else if (
      this.raw !== null &&
      isNum(dt) &&
      dt > 0 &&
      Math.abs(v - this.raw) > this.maxRate * dt + 1
    ) {
      bad = 'spike: ' + this.raw + ' -> ' + v;
    }
  }

  if (bad !== null) {
    this.badCount++;
    this.reason = bad;
    if (this.badCount >= this.faultAfter) {
      this.fault = true;
      // после устойчивой аварии сбрасываем историю, чтобы после
      // восстановления датчик не считался «выбросом»
      this.raw = null;
      this.ema.reset();
      this.value = null;
    }
    return false;
  }

  this.badCount = 0;
  this.fault = false;
  this.reason = 'ok';
  this.raw = v;
  this.value = this.ema.push(v, dt);
  return true;
};

/** Значение или fallback, если датчик неисправен/не настроен. */
Sensor.prototype.get = function (fallback) {
  return this.fault || this.value === null ? fallback : this.value;
};

Sensor.prototype.ok = function () {
  return !this.fault && this.value !== null;
};

/* ------------------------------------------------------------------ */

exports.clamp = clamp;
exports.isNum = isNum;
exports.toNum = toNum;
exports.round = round;
exports.extend = extend;
exports.def = def;
exports.Ema = Ema;
exports.Sensor = Sensor;
