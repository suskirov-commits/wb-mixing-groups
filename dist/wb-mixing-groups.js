/**
 * wb-mixing-groups.js — ОДНОФАЙЛОВАЯ СБОРКА
 *
 * Управление смесительными узлами (тёплый пол, радиаторы) на Wiren Board.
 * Поддерживаются фазные (3-точечные) приводы и приводы 0-10 В.
 *
 * КУДА ЗАГРУЖАТЬ:
 *   Веб-интерфейс контроллера -> Правила -> Новый скрипт
 *   (файл ляжет в /etc/wb-rules/). Больше ничего копировать не нужно:
 *   модули и конфигурация уже внутри этого файла.
 *
 * ЧТО ПРАВИТЬ:
 *   Секцию CONFIG ниже — топики датчиков, реле, приводов и параметры
 *   контуров. Всё остальное ниже отметки «КОД» трогать не нужно.
 *
 * Для парка объектов лучше ставить пакетом (см. README, способ 1):
 * там есть страница настроек с выбором топиков из выпадающего списка.
 *
 * Сгенерировано автоматически из исходников wbmix. Не редактируйте
 * секцию кода вручную — правьте исходники и выполните make build.
 */

/* ==================================================================== *
 *                          К О Н Ф И Г У Р А Ц И Я                     *
 * ==================================================================== */

var CONFIG = {
  "groups": [

    // =====================================================================
    //  КОНТУР 1. Тёплый пол. Привод фазный (3-точечный), 2 реле.
    // =====================================================================
    {
      "id": "mix_floor",
      "title": "Смесительный узел: тёплый пол",
      "debug": false,

      "defaultEnabled": true,
      "defaultMode": 1,          // 0 ручной, 1 фикс. уставка, 2 кривая
      "defaultSetpoint": 35,

      "sensors": {
        // Обязательные
        "supplyIn":   "wb-w1/28-00000a1b2c3d",   // вход узла, от котла
        "supplyOut":  "wb-w1/28-00000a1b2c4e",   // выход узла, в контур
        // Необязательные, но очень желательные
        "returnLine": "wb-w1/28-00000a1b2c5f",   // обратка контура в узел
        "outdoor":    "wb-w1/28-00000a1b2c60",   // улица (нужен для кривой)
        "room":       null,                       // датчик в помещении
        "tau": 5                                  // постоянная фильтра, с
      },

      "actuator": {
        "type": "tristate",                       // фазный 3-точечный привод
        "open":  "wb-mr6c_45/K1",                 // реле «открыть»
        "close": "wb-mr6c_45/K2",                 // реле «закрыть»
        "travelTime": 120,                        // ПАСПОРТНОЕ время хода, с
        "travelTimeClose": 120,
        "minPulse": 500,                          // мин. импульс, мс
        "deadband": 1.5,                          // зона нечувств., %
        "interlock": 300,                         // пауза на реверс, мс
        "invert": false,
        "recalibrateAfter": 500,                  // % накопл. хода до прогона
        "posMin": 0,
        "posMax": 100
      },

      "pump": {
        "topic": "wb-mr6c_45/K3",
        "postRun": 300,                           // выбег насоса, с
        "antiStickDays": 7
      },

      "demand": {
        // Запрос тепла источнику (реле на клеммы котла / вход OpenTherm-модуля)
        "topic": null,
        "band": 1
      },

      "control": {
        "period": 20,          // такт регулирования, с (для 3-точечного 15..30)
        "kp": 3.0,             // %/К
        "ki": 0.012,           // %/(К·с)
        "kd": 0,
        "deadband": 0.3,       // К
        "setpointMin": 20,
        "setpointMax": 45,
        "setpointRamp": 2,     // К/мин — плавный вывод на уставку
        "loopDeltaT": 7,       // расчётный перепад контура, К (если нет датчика обратки)
        "minAuthority": 3,     // мин. (Tвх − Tобр) для работы модели, К
        "feedForward": true,
        "readyBand": 1.0
      },

      "safety": {
        "maxSupply": 45,             // ЖЁСТКИЙ предел подачи в пол, °C
        "maxSupplyHyst": 4,
        "softLimitBand": 3,          // уставку не пускаем выше maxSupply−3
        "failSafePosition": 0,       // при отказе датчика — закрыть
        "frostProtect": true,
        "frostTemp": 6,
        "frostPosition": 40,
        "deviationAlarm": 8,         // К
        "deviationAlarmDelay": 900,  // с
        "emergencyInput": null,      // топик аварийного термостата (сухой контакт)
        "emergencyInputInvert": false
      },

      "curve": {
        "roomTemp": 20,
        "outdoorDesign": -28,        // расчётная температура вашего региона
        "supplyDesign": 35,          // проектная подача при outdoorDesign
        "returnDesign": 28,          // проектная обратка
        "exponent": 1.1,             // 1.1 — тёплый пол
        "summerCutoff": 16,
        "summerHyst": 2,
        "roomGain": 2
      }
    },

    // =====================================================================
    //  КОНТУР 2. Радиаторы. Привод 0-10 В через WB-MAO4.
    // =====================================================================
    {
      "id": "mix_rad",
      "title": "Смесительный узел: радиаторы",

      "defaultEnabled": true,
      "defaultMode": 2,
      "defaultSetpoint": 50,

      "sensors": {
        "supplyIn":   "wb-w1/28-00000a1b2c3d",   // тот же вход от котла
        "supplyOut":  "wb-w1/28-00000a1b2c71",
        "returnLine": "wb-w1/28-00000a1b2c82",
        "outdoor":    "wb-w1/28-00000a1b2c60",
        "room":       null,
        "tau": 5
      },

      "actuator": {
        "type": "analog",
        "out": "wb-mao4_21/Channel 1",
        "outUnits": "mv",          // WB-MAO4 в режиме 0-10 В: 0..10000 мВ
        "vMin": 0,                 // для привода 2-10 В поставить 2000
        "vMax": 10000,
        "invert": false,
        "feedback": null,          // топик обратной связи по положению, если есть
        "rateLimit": 0,            // %/с, 0 = без ограничения
        "posMin": 0,
        "posMax": 100
      },

      "pump": {
        "topic": "wb-mr6c_45/K4",
        "postRun": 300,
        "antiStickDays": 7
      },

      "control": {
        "period": 5,
        "kp": 2.5,
        "ki": 0.02,
        "kd": 0,
        "deadband": 0.3,
        "setpointMin": 25,
        "setpointMax": 70,
        "setpointRamp": 0,
        "loopDeltaT": 10,
        "minAuthority": 3,
        "feedForward": true,
        "readyBand": 1.0
      },

      "safety": {
        "maxSupply": 70,
        "maxSupplyHyst": 5,
        "softLimitBand": 3,
        "failSafePosition": 0,
        "frostProtect": true,
        "frostTemp": 6,
        "frostPosition": 40,
        "deviationAlarm": 10,
        "deviationAlarmDelay": 1200
      },

      "curve": {
        "roomTemp": 20,
        "outdoorDesign": -28,
        "supplyDesign": 50,
        "returnDesign": 40,
        "exponent": 1.3,           // 1.3 — стальные/алюминиевые радиаторы
        "summerCutoff": 16,
        "summerHyst": 2,
        "roomGain": 2
      }
    }

  ]
};

/* ==================================================================== *
 *                                К О Д                                 *
 *                    (ниже правки обычно не требуются)                 *
 * ==================================================================== */

// Реестр экземпляров хранится в прототипе глобального объекта: он общий
// для всех сценариев и переживает автоперезагрузку файла правил. Без него
// после каждого сохранения скрипта в веб-интерфейсе оставался бы висячий
// таймер, и приводом управляли бы сразу несколько тактовых циклов.
if (!global.__proto__.__wbmixShared) global.__proto__.__wbmixShared = {};

(function () {
  var __defs = {};
  var __cache = {};

  function require(name) {
    if (__cache[name]) return __cache[name].exports;
    if (!__defs[name]) throw new Error('wbmix: модуль не найден: ' + name);
    var m = {
      exports: {},
      filename: name,
      // module.static для инлайн-сборки — общее хранилище в прототипе
      // глобального объекта, чтобы поведение совпадало с обычными модулями
      static: global.__proto__.__wbmixShared
    };
    __cache[name] = m;
    __defs[name](m.exports, m, require);
    return m.exports;
  }

  /* ---------------- модуль wbmix-util ---------------- */
  __defs['wbmix-util'] = function (exports, module, require) {
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

  };

  /* ---------------- модуль wbmix-pid ---------------- */
  __defs['wbmix-pid'] = function (exports, module, require) {
    /**
     * @file wbmix-pid.js
     * @description ПИ(Д)-регулятор для смесительного узла.
     *
     * Отличия от «учебного» ПИД и от wb-scenarios/pid-engine:
     *
     *  1. Регулятор работает как ДОБАВКА к упреждающему сигналу (feed-forward).
     *     Основную позицию клапана считает статическая модель смешения
     *     (см. wbmix-group.js), а ПИ убирает остаточную ошибку.
     *     Поэтому интегратор ограничивается не диапазоном 0..100,
     *     а «остатком» до границ выхода с учётом FF — иначе при FF=80%
     *     интегратор набирает лишние 100% и клапан залипает на упоре.
     *
     *  2. Anti-windup — метод back-calculation (обратный пересчёт):
     *     при насыщении выхода интегратор подтягивается назад
     *     на величину насыщения, деленную на Tt. Это мягче, чем
     *     жёсткое clamping, и не даёт «мёртвого» интегратора.
     *
     *  3. D-составляющая берётся по измерению, а не по ошибке
     *     (нет броска при изменении уставки) и фильтруется.
     *     Для смесительных узлов D по умолчанию = 0: процесс с большим
     *     транспортным запаздыванием, дифференциатор только раскачивает.
     *
     *  4. Зона нечувствительности задаётся не «выключением», а снижением
     *     коэффициента: около уставки регулятор продолжает медленно
     *     компенсировать дрейф, но не дёргает привод.
     */

    var U = require('wbmix-util');

    var D_FILTER_ALPHA = 0.2;
    var DEADBAND_GAIN = 0.15;

    /**
     * @param {Object} cfg { kp, ki, kd, deadband, outMin, outMax, tt }
     *   kp       — %/К    (на сколько % открыть клапан на 1 К ошибки)
     *   ki       — %/(К·с)
     *   kd       — %·с/К
     *   deadband — К, зона пониженного усиления
     *   tt       — с, постоянная времени anti-windup (по умолчанию 1/ki)
     */
    function Pid(cfg) {
      cfg = cfg || {};
      this.kp = U.def(cfg.kp, 4);
      this.ki = U.def(cfg.ki, 0.02);
      this.kd = U.def(cfg.kd, 0);
      this.deadband = U.def(cfg.deadband, 0.3);
      this.outMin = U.def(cfg.outMin, 0);
      this.outMax = U.def(cfg.outMax, 100);
      this.tt = U.def(cfg.tt, 0);

      this.integral = 0;
      this.lastMeas = null;
      this.dFilt = 0;

      this.p = 0;
      this.i = 0;
      this.d = 0;
      this.out = 0;
      this.saturated = false;
    }

    Pid.prototype.setTunings = function (kp, ki, kd) {
      if (U.isNum(kp)) this.kp = kp;
      if (U.isNum(ki)) this.ki = ki;
      if (U.isNum(kd)) this.kd = kd;
    };

    /**
     * Один такт регулирования.
     * @param {number} sp   уставка, °C
     * @param {number} pv   измерение, °C
     * @param {number} dt   период такта, с
     * @param {number} ff   упреждение (feed-forward), % открытия
     * @returns {number}    итоговая позиция клапана, %
     */
    Pid.prototype.compute = function (sp, pv, dt, ff) {
      ff = U.isNum(ff) ? ff : 0;
      var err = sp - pv;

      var gain = Math.abs(err) < this.deadband ? DEADBAND_GAIN : 1.0;

      // --- P ---
      this.p = this.kp * err * gain;

      // --- D по измерению, с фильтром ---
      this.d = 0;
      if (this.lastMeas !== null && dt > 0 && this.kd !== 0) {
        var raw = (pv - this.lastMeas) / dt;
        this.dFilt = (1 - D_FILTER_ALPHA) * this.dFilt + D_FILTER_ALPHA * raw;
        this.d = -this.kd * this.dFilt * gain;
      }
      this.lastMeas = pv;

      // --- I ---
      if (dt > 0) this.integral += this.ki * err * dt * gain;

      var unsat = ff + this.p + this.integral + this.d;
      var sat = U.clamp(unsat, this.outMin, this.outMax);

      // --- Anti-windup: back-calculation ---
      if (sat !== unsat) {
        this.saturated = true;
        var tt = this.tt > 0 ? this.tt : this.ki > 0 ? 1 / this.ki : 0;
        if (tt > 0 && dt > 0) {
          this.integral += ((sat - unsat) * dt) / tt;
        } else {
          this.integral += sat - unsat;
        }
        // страховка: интегратор не должен выходить за размах выхода
        var span = this.outMax - this.outMin;
        this.integral = U.clamp(this.integral, -span, span);
      } else {
        this.saturated = false;
      }

      this.i = this.integral;
      this.out = sat;
      return sat;
    };

    /**
     * Безударный сброс: выставить интегратор так, чтобы выход
     * регулятора равнялся текущей позиции клапана.
     * Вызывается при включении контура и при выходе из ручного режима —
     * иначе клапан рванёт с текущей позиции на 0 или 100 %.
     */
    Pid.prototype.bumplessReset = function (currentPos, ff) {
      this.integral = U.clamp(
        (U.isNum(currentPos) ? currentPos : 0) - (U.isNum(ff) ? ff : 0),
        -(this.outMax - this.outMin),
        this.outMax - this.outMin
      );
      this.p = 0;
      this.d = 0;
      this.dFilt = 0;
      this.lastMeas = null;
      this.saturated = false;
    };

    Pid.prototype.reset = function () {
      this.integral = 0;
      this.lastMeas = null;
      this.dFilt = 0;
      this.p = this.i = this.d = this.out = 0;
      this.saturated = false;
    };

    exports.Pid = Pid;

  };

  /* ---------------- модуль wbmix-actuator ---------------- */
  __defs['wbmix-actuator'] = function (exports, module, require) {
    /**
     * @file wbmix-actuator.js
     * @description Абстракция электропривода трёхходового крана.
     *
     * Один интерфейс — две реализации:
     *
     *   TristateActuator ("фазный" / 3-точечный привод, 230 В или 24 В)
     *       Два дискретных выхода: ОТКРЫТЬ и ЗАКРЫТЬ. Обратной связи по
     *       положению нет. Положение восстанавливается интегрированием
     *       времени работы привода (модель), с периодической
     *       рекалибровкой прогоном на упор.
     *       Типовые приводы: Esbe ARA600/661, Meibes/Watts, Honeywell,
     *       Rommer RVM, Siemens SQK. Время полного хода 30…240 с.
     *
     *   AnalogActuator (0-10 В / 2-10 В / 4-20 мА через WB-MAO4, WBIO-AO-10V-8)
     *       Положение задаётся напряжением, привод сам отрабатывает.
     *       Опционально читается обратная связь по положению.
     *
     * Общий интерфейс:
     *   .kind                     -> "tristate" | "analog"
     *   .getPosition()            -> 0..100 %
     *   .isPositionTrusted()      -> bool (для 3-точечного: откалиброван ли)
     *   .apply(target, budgetMs)  -> отработать шаг регулирования
     *   .halt()                   -> немедленно снять команды (аварии, выключение)
     *   .calibrate(dir, cb)       -> прогон на упор, dir: -1 закрыть, +1 открыть
     *   .isBusy()                 -> идёт калибровка/движение
     *   .stats()                  -> диагностика
     */

    var U = require('wbmix-util');

    /* ================================================================== */
    /*  Трёхточечный (фазный) привод                                       */
    /* ================================================================== */

    /**
     * @param {Object} cfg
     *   open            {string} топик реле "открыть", напр. "wb-mr6c_45/K1"
     *   close           {string} топик реле "закрыть", напр. "wb-mr6c_45/K2"
     *   travelTime      {number} время полного хода 0->100 %, с (паспорт привода)
     *   travelTimeClose {number} время хода 100->0 %, с (если несимметрично)
     *   minPulse        {number} мин. длительность импульса, мс (реле + люфт)
     *   deadband        {number} зона нечувствительности по положению, %
     *   interlock       {number} пауза при реверсе, мс
     *   invert          {bool}   поменять местами «открыть»/«закрыть»
     *   recalibrateAfter{number} накопленный ход в % до авторекалибровки
     *   posMin, posMax  {number} механические ограничения хода, %
     * @param {Object} ctx { log, storage, id }
     */
    function TristateActuator(cfg, ctx) {
      cfg = cfg || {};
      ctx = ctx || {};

      this.kind = 'tristate';
      this.log = ctx.log || log;
      this.id = ctx.id || 'valve';
      this.ps = ctx.storage || null;

      this.openTopic = cfg.open;
      this.closeTopic = cfg.close;
      this.invert = !!cfg.invert;

      this.travelMs = U.def(cfg.travelTime, 120) * 1000;
      this.travelCloseMs = U.def(cfg.travelTimeClose, U.def(cfg.travelTime, 120)) * 1000;
      this.minPulseMs = U.def(cfg.minPulse, 400);
      this.interlockMs = U.def(cfg.interlock, 300);
      this.posMin = U.def(cfg.posMin, 0);
      this.posMax = U.def(cfg.posMax, 100);

      // Зона нечувствительности не может быть меньше, чем шаг,
      // соответствующий минимальному импульсу, иначе привод будет
      // получать команды, которые не может отработать.
      var minStep = (this.minPulseMs / this.travelMs) * 100;
      this.deadband = Math.max(U.def(cfg.deadband, 1.5), minStep);

      this.recalibrateAfter = U.def(cfg.recalibrateAfter, 500); // % накопленного хода

      // --- состояние ---
      this.pos = 0; // оценка положения, %
      this.trusted = false; // была ли калибровка после старта
      this.moving = 0; // -1 закрытие, 0 стоп, +1 открытие
      this.moveStart = 0;
      this.moveTimer = null;
      this.pinTo = null; // куда «прибить» позицию по завершении прогона
      this.travelAcc = 0; // накопленный ход, %
      this.calibrating = false;
      this.calCb = null;
      this.totalMoves = 0;
      this.totalOnMs = 0;
      this.linkFault = false;
      this.linkReason = '';

      this._restore();
      this._writeRelay(this.openTopic, false);
      this._writeRelay(this.closeTopic, false);
    }

    TristateActuator.prototype._restore = function () {
      if (!this.ps) return;
      var p = this.ps['pos'];
      var t = this.ps['travelAcc'];
      if (U.isNum(p)) this.pos = U.clamp(p, 0, 100);
      if (U.isNum(t)) this.travelAcc = t;
      // После рестарта контроллера доверять сохранённой позиции нельзя:
      // привод могли крутить вручную, могло пропасть питание в момент хода.
      this.trusted = false;
    };

    TristateActuator.prototype._save = function () {
      if (!this.ps) return;
      this.ps['pos'] = U.round(this.pos, 2);
      this.ps['travelAcc'] = U.round(this.travelAcc, 1);
    };

    TristateActuator.prototype._writeRelay = function (topic, on) {
      if (!topic) return;
      try {
        dev[topic] = !!on;
      } catch (e) {
        // Запись не прошла — значит командой привод не управляем.
        // Модель положения с этого момента недостоверна.
        this.trusted = false;
        this.linkFault = true;
        this.linkReason = 'ошибка записи ' + topic;
        this.log.error('[{}] не удалось записать {}: {}', this.id, topic, e);
      }
    };

    /**
     * Проверка связи с модулем реле.
     *
     * Для привода без возвратной пружины это обязательная проверка. Кран
     * остаётся там, где его бросили, и единственный способ его сдвинуть —
     * реле. Если модуль реле отвалился с шины:
     *   - команда «стоп» не дойдёт, и привод будет ехать до упора;
     *   - модуль сам обесточит выходы по таймеру безопасного режима
     *     (у WB-MR6C по умолчанию 10 с после последнего пакета Modbus),
     *     но за это время кран успеет сместиться на неизвестную величину.
     * Поэтому при потере связи мы сразу помечаем положение недостоверным:
     * после восстановления связи первый же такт уйдёт в калибровку на упор.
     */
    TristateActuator.prototype._checkLink = function () {
      var topics = [this.openTopic, this.closeTopic];
      for (var i = 0; i < topics.length; i++) {
        var t = topics[i];
        if (!t) continue;
        var err = dev[t + '#error'];
        if (err === null) {
          this._setLinkFault('нет контрола ' + t);
          return false;
        }
        if (err !== undefined && err !== '' && err !== false) {
          this._setLinkFault('нет связи с модулем реле (' + t + ': ' + err + ')');
          return false;
        }
      }
      if (this.linkFault) {
        this.log.info('[{}] связь с модулем реле восстановлена, требуется калибровка', this.id);
        this.linkFault = false;
        this.linkReason = '';
      }
      return true;
    };

    TristateActuator.prototype._setLinkFault = function (reason) {
      if (!this.linkFault) this.log.warning('[{}] {}', this.id, reason);
      this.linkFault = true;
      this.linkReason = reason;
      this.trusted = false;
      // Прерываем текущий ход: учитываем пройденное и пытаемся снять команды.
      // Попытка записи, скорее всего, не пройдёт — это нормально, модуль
      // обесточит выходы сам по таймеру безопасного режима.
      if (this.moving !== 0 || this.calibrating) this.halt();
    };

    TristateActuator.prototype.getFault = function () {
      return this.linkFault ? this.linkReason : null;
    };

    /** Топик реле для направления с учётом инверсии. */
    TristateActuator.prototype._topicFor = function (dir) {
      var openIsOpen = !this.invert;
      if (dir > 0) return openIsOpen ? this.openTopic : this.closeTopic;
      return openIsOpen ? this.closeTopic : this.openTopic;
    };

    /** Учесть пройденный путь и обесточить привод. */
    TristateActuator.prototype._settle = function () {
      if (this.moving !== 0) {
        var elapsed = Date.now() - this.moveStart;
        var full = this.moving > 0 ? this.travelMs : this.travelCloseMs;
        var delta = (elapsed / full) * 100 * this.moving;
        this.pos = U.clamp(this.pos + delta, 0, 100);
        this.travelAcc += Math.abs(delta);
        this.totalOnMs += elapsed;
      }
      this._writeRelay(this.openTopic, false);
      this._writeRelay(this.closeTopic, false);
      this.moving = 0;
      if (this.moveTimer !== null) {
        clearTimeout(this.moveTimer);
        this.moveTimer = null;
      }
    };

    TristateActuator.prototype.halt = function () {
      this._settle();
      if (this.calibrating) {
        this.calibrating = false;
        var cb = this.calCb;
        this.calCb = null;
        if (cb) cb(false);
      }
      this.pinTo = null;
      this._save();
    };

    TristateActuator.prototype.isBusy = function () {
      return this.calibrating || this.moving !== 0;
    };

    TristateActuator.prototype.getPosition = function () {
      // во время движения показываем интерполированное значение
      if (this.moving !== 0) {
        var elapsed = Date.now() - this.moveStart;
        var full = this.moving > 0 ? this.travelMs : this.travelCloseMs;
        return U.clamp(this.pos + (elapsed / full) * 100 * this.moving, 0, 100);
      }
      return this.pos;
    };

    TristateActuator.prototype.isPositionTrusted = function () {
      return this.trusted;
    };

    /**
     * Запустить движение на заданное время.
     * @param {number} dir  -1 | +1
     * @param {number} ms   длительность импульса
     * @param {number|null} pinTo зафиксировать позицию по завершении (для упора)
     */
    TristateActuator.prototype._run = function (dir, ms, pinTo) {
      var self = this;
      this._settle(); // снимаем обе команды и учитываем пройденное

      var start = function () {
        self._writeRelay(self._topicFor(dir), true);
        self.moving = dir;
        self.moveStart = Date.now();
        self.pinTo = pinTo;
        self.totalMoves++;
        self.moveTimer = setTimeout(function () {
          self.moveTimer = null;
          self._settle();
          if (self.pinTo !== null && self.pinTo !== undefined) {
            self.pos = self.pinTo;
            self.travelAcc = 0;
            self.trusted = true;
            self.pinTo = null;
          }
          self._save();
          if (self.calibrating) {
            self.calibrating = false;
            var cb = self.calCb;
            self.calCb = null;
            if (cb) cb(true);
          }
        }, ms);
      };

      // Пауза на реверс: контакторы/симисторы не должны переключаться
      // мгновенно, иначе бросок тока и износ привода.
      if (this.interlockMs > 0) setTimeout(start, this.interlockMs);
      else start();
    };

    /**
     * Прогон на упор с перебегом 20 % — калибровка нуля/сотни.
     * @param {number} dir -1 закрыть, +1 открыть
     * @param {Function} cb callback(success)
     */
    TristateActuator.prototype.calibrate = function (dir, cb) {
      dir = dir >= 0 ? 1 : -1;
      var full = dir > 0 ? this.travelMs : this.travelCloseMs;
      this.calibrating = true;
      this.calCb = cb || null;
      this.log.info(
        '[{}] калибровка: прогон на {} упор, {} с',
        this.id,
        dir > 0 ? 'верхний' : 'нижний',
        U.round((full * 1.2) / 1000, 0)
      );
      this._run(dir, Math.round(full * 1.2), dir > 0 ? 100 : 0);
    };

    /**
     * Отработать такт регулирования.
     * @param {number} target   желаемое положение, %
     * @param {number} budgetMs сколько времени есть до следующего такта
     * @returns {string} что сделали: "idle" | "open" | "close" | "calibrate" | "busy"
     */
    TristateActuator.prototype.apply = function (target, budgetMs) {
      if (!this._checkLink()) return 'link_fault';
      if (this.calibrating) return 'calibrate';
      if (this.moving !== 0) return 'busy';

      target = U.clamp(target, this.posMin, this.posMax);

      // 1. Плановая рекалибровка по накопленному ходу.
      //    Модель положения дрейфует: время хода зависит от температуры,
      //    напряжения, износа. Раз в N % суммарного хода — прогон на упор.
      //    Выбираем ближайший упор, чтобы не гонять кран через весь диапазон.
      if (!this.trusted || this.travelAcc > this.recalibrateAfter) {
        var toClose = target < 50 || !this.trusted;
        this.calibrate(toClose ? -1 : 1, null);
        return 'calibrate';
      }

      var delta = target - this.pos;

      // 2. Прижим к упорам: если требуется полностью закрыть/открыть —
      //    даём перебег и обнуляем накопленную ошибку модели.
      if (target <= this.posMin + 0.5 && this.pos > this.posMin + 0.5) {
        this._run(-1, Math.round(this.travelCloseMs * 1.2), this.posMin);
        return 'close';
      }
      if (target >= this.posMax - 0.5 && this.pos < this.posMax - 0.5) {
        this._run(1, Math.round(this.travelMs * 1.2), this.posMax);
        return 'open';
      }

      // 3. Зона нечувствительности.
      //    Важно: pos НЕ меняем, поэтому рассогласование не теряется —
      //    оно копится и рано или поздно превысит порог. Это и есть
      //    механизм «накопления остатка» без отдельной переменной.
      if (Math.abs(delta) < this.deadband) return 'idle';

      var dir = delta > 0 ? 1 : -1;
      var full = dir > 0 ? this.travelMs : this.travelCloseMs;
      var ms = Math.round((Math.abs(delta) / 100) * full);

      if (ms < this.minPulseMs) return 'idle';
      // Импульс не должен «наезжать» на следующий такт регулирования
      if (budgetMs > 0) ms = Math.min(ms, Math.round(budgetMs * 0.85));

      this._run(dir, ms, null);
      return dir > 0 ? 'open' : 'close';
    };

    TristateActuator.prototype.stats = function () {
      return {
        kind: this.kind,
        pos: U.round(this.getPosition(), 1),
        trusted: this.trusted,
        moving: this.moving,
        travelAcc: U.round(this.travelAcc, 0),
        moves: this.totalMoves,
        onMinutes: U.round(this.totalOnMs / 60000, 1),
        deadband: U.round(this.deadband, 2)
      };
    };

    /* ================================================================== */
    /*  Аналоговый привод 0-10 В                                           */
    /* ================================================================== */

    /**
     * @param {Object} cfg
     *   out       {string} топик выхода, напр. "wb-mao4_21/Channel 1"
     *   outUnits  {string} "mv" (0..10000, WB-MAO4) | "percent" (0..100)
     *   vMin,vMax {number} рабочий диапазон в единицах outUnits
     *                      (для 2-10 В: vMin=2000, vMax=10000)
     *   invert    {bool}   10 В = закрыто
     *   feedback  {string} опциональный топик обратной связи по положению
     *   fbMin,fbMax {number} шкала обратной связи
     *   rateLimit {number} ограничение скорости изменения, %/с (0 = нет)
     *   posMin,posMax {number}
     */
    function AnalogActuator(cfg, ctx) {
      cfg = cfg || {};
      ctx = ctx || {};

      this.kind = 'analog';
      this.log = ctx.log || log;
      this.id = ctx.id || 'valve';

      this.outTopic = cfg.out;
      this.units = U.def(cfg.outUnits, 'mv');
      this.vMin = U.def(cfg.vMin, this.units === 'mv' ? 0 : 0);
      this.vMax = U.def(cfg.vMax, this.units === 'mv' ? 10000 : 100);
      this.invert = !!cfg.invert;
      this.posMin = U.def(cfg.posMin, 0);
      this.posMax = U.def(cfg.posMax, 100);
      this.rateLimit = U.def(cfg.rateLimit, 0);

      this.fbTopic = cfg.feedback || null;
      this.fbMin = U.def(cfg.fbMin, 0);
      this.fbMax = U.def(cfg.fbMax, 10000);

      this.pos = 0;
      // cmd = null, а не 0: иначе при первом такте с расчётным выходом 0 мВ
      // сравнение out !== this.cmd не сработает, и канал никогда не будет
      // записан. После рестарта контроллера на выходе осталось бы старое
      // значение из safe-state модуля, а привод стоял бы не там, где думает
      // регулятор.
      this.cmd = null;
      this.lastApply = 0;
    }

    AnalogActuator.prototype.getPosition = function () {
      if (this.fbTopic) {
        var raw = U.toNum(dev[this.fbTopic]);
        if (U.isNum(raw) && this.fbMax !== this.fbMin) {
          var p = ((raw - this.fbMin) / (this.fbMax - this.fbMin)) * 100;
          return U.clamp(this.invert ? 100 - p : p, 0, 100);
        }
      }
      return this.pos;
    };

    AnalogActuator.prototype.isPositionTrusted = function () {
      return true;
    };

    AnalogActuator.prototype.isBusy = function () {
      return false;
    };

    AnalogActuator.prototype.getFault = function () {
      if (!this.outTopic) return 'не задан аналоговый выход';
      var err = dev[this.outTopic + '#error'];
      if (err === null) return 'нет контрола ' + this.outTopic;
      if (err !== undefined && err !== '' && err !== false)
        return 'нет связи с модулем аналогового вывода (' + this.outTopic + ': ' + err + ')';
      return null;
    };

    AnalogActuator.prototype.apply = function (target, budgetMs) {
      var fault = this.getFault();
      if (fault) {
        if (!this._faultLogged) {
          this.log.warning('[{}] {}', this.id, fault);
          this._faultLogged = true;
        }
        return 'link_fault';
      }
      this._faultLogged = false;

      target = U.clamp(target, this.posMin, this.posMax);

      // Опциональное ограничение скорости — бережёт привод и гидравлику
      if (this.rateLimit > 0 && this.lastApply > 0) {
        var dt = (Date.now() - this.lastApply) / 1000;
        var maxStep = this.rateLimit * dt;
        if (target > this.pos + maxStep) target = this.pos + maxStep;
        if (target < this.pos - maxStep) target = this.pos - maxStep;
      }
      this.lastApply = Date.now();

      var frac = this.invert ? (100 - target) / 100 : target / 100;
      var out = this.vMin + frac * (this.vMax - this.vMin);
      if (this.units === 'mv') out = Math.round(out);
      else out = U.round(out, 1);

      if (out !== this.cmd) {
        try {
          dev[this.outTopic] = out;
          this.cmd = out;
        } catch (e) {
          this.log.error('[{}] не удалось записать {}: {}', this.id, this.outTopic, e);
        }
      }
      this.pos = target;
      return 'set';
    };

    /**
     * Для аналогового привода «halt» = удержание текущего положения.
     * Насильно гнать в 0 нельзя: при аварии закрытие контура ТП
     * иногда опаснее, чем удержание. Решение принимает уровень выше
     * (wbmix-group вызывает apply(failSafePosition)).
     */
    AnalogActuator.prototype.halt = function () {};

    AnalogActuator.prototype.calibrate = function (dir, cb) {
      if (cb) cb(true);
    };

    AnalogActuator.prototype.stats = function () {
      return {
        kind: this.kind,
        pos: U.round(this.getPosition(), 1),
        trusted: true,
        cmd: this.cmd,
        units: this.units
      };
    };

    /* ================================================================== */

    /**
     * Фабрика: создаёт нужную реализацию по cfg.type.
     * @param {Object} cfg  { type: "tristate"|"analog", ... }
     */
    function create(cfg, ctx) {
      var type = (cfg && cfg.type ? cfg.type : 'tristate').toLowerCase();
      if (type === 'analog' || type === '0-10v' || type === 'modulating') {
        return new AnalogActuator(cfg, ctx);
      }
      if (type === 'tristate' || type === '3point' || type === 'floating' || type === 'phase') {
        return new TristateActuator(cfg, ctx);
      }
      throw new Error('wbmix: неизвестный тип привода: ' + type);
    }

    exports.create = create;
    exports.TristateActuator = TristateActuator;
    exports.AnalogActuator = AnalogActuator;

  };

  /* ---------------- модуль wbmix-group ---------------- */
  __defs['wbmix-group'] = function (exports, module, require) {
    /**
     * @file wbmix-group.js
     * @description Виртуальное устройство «Смесительный узел».
     *
     * Задача: на входе узла теплоноситель от котла (например, 60 °C),
     * на выходе нужно держать заданную температуру (тёплый пол 35 °C,
     * радиаторы 50 °C) вне зависимости от того, что происходит на входе.
     *
     * АЛГОРИТМ (двухуровневый, FF + PI):
     *
     *   1) Упреждение по модели смешения (feed-forward).
     *      Трёхходовой смесительный клапан смешивает горячий поток от котла
     *      (T_in) с обраткой контура (T_ret). Для доли открытия k (0..1):
     *
     *          T_mix = k * T_in + (1 - k) * T_ret
     *      =>  k     = (T_sp - T_ret) / (T_in - T_ret)
     *
     *      Это даёт мгновенную реакцию на изменение T_in: котёл ушёл
     *      с 60 на 70 °C — модель сразу прикрыла клапан, не дожидаясь,
     *      пока изменение доедет до датчика после узла. Для контуров
     *      с большим транспортным запаздыванием (тёплый пол — это
     *      десятки секунд на смеситель плюс минуты на петли) это
     *      принципиально: чистый ПИД тут либо медленный, либо
     *      автоколеблется.
     *
     *   2) ПИ-регулятор поверх, по фактической T_mix.
     *      Убирает ошибку модели: неидеальную характеристику клапана
     *      (равнопроцентная/линейная), теплопотери, неточную T_ret.
     *      Интегратор с back-calculation anti-windup, безударный переход
     *      из ручного режима.
     *
     * ЗАЩИТЫ:
     *   - жёсткий верхний предел T_mix (перегрев стяжки) с гистерезисом;
     *   - мягкое ограничение уставки на подходе к пределу;
     *   - внешний аварийный термостат (сухой контакт);
     *   - отказ датчиков -> безопасное положение клапана;
     *   - защита от замерзания;
     *   - выбег насоса, антизалипание насоса и клапана;
     *   - летнее отключение по наружной температуре.
     */

    var U = require('wbmix-util');
    var PID = require('wbmix-pid');
    var ACT = require('wbmix-actuator');

    var MODE_MANUAL = 0;
    var MODE_FIXED = 1;
    var MODE_CURVE = 2;

    var STATE_TITLES = {
      off: 'Выключен',
      standby: 'Ожидание',
      summer: 'Лето (отключен)',
      heating: 'Нагрев',
      ready: 'Уставка держится',
      no_heat: 'Нет тепла на входе',
      limit: 'Ограничение по перегреву',
      manual: 'Ручной режим',
      calibrating: 'Калибровка привода',
      frost: 'Защита от замерзания',
      fault: 'Авария'
    };

    /* ================================================================== */

    /**
     * @param {Object} cfg см. README и /etc/wb-mixing-groups.conf
     */
    function MixingGroup(cfg) {
      this.cfg = cfg;
      this.id = cfg.id;
      this.title = cfg.title || cfg.id;

      var self = this;
      this.log = {
        debug: function () {
          if (cfg.debug) log.debug.apply(null, arguments);
        },
        info: function () {
          log.info.apply(null, arguments);
        },
        warning: function () {
          log.warning.apply(null, arguments);
        },
        error: function () {
          log.error.apply(null, arguments);
        }
      };

      /* ---------- параметры регулирования ---------- */
      var c = cfg.control || {};
      this.periodMs = U.def(c.period, cfg.actuator && cfg.actuator.type === 'analog' ? 5 : 20) * 1000;
      this.spMin = U.def(c.setpointMin, 15);
      this.spMax = U.def(c.setpointMax, 60);
      this.spRamp = U.def(c.setpointRamp, 0); // К/мин, 0 = без ограничения
      this.loopDt = U.def(c.loopDeltaT, 7); // расчётный перепад контура, К
      this.minAuthority = U.def(c.minAuthority, 3); // мин. (T_in - T_ret) для FF, К
      this.useFF = U.def(c.feedForward, true);
      this.readyBand = U.def(c.readyBand, 1.0);

      /* ---------- защиты ---------- */
      var s = cfg.safety || {};
      this.tMax = U.def(s.maxSupply, 45);
      this.tMaxHyst = U.def(s.maxSupplyHyst, 4);
      this.softLimitBand = U.def(s.softLimitBand, 3);
      this.failSafePos = U.def(s.failSafePosition, 0);
      this.frostOn = U.def(s.frostProtect, true);
      this.frostT = U.def(s.frostTemp, 6);
      this.frostPos = U.def(s.frostPosition, 40);
      this.deviationK = U.def(s.deviationAlarm, 8);
      this.deviationSec = U.def(s.deviationAlarmDelay, 900);
      this.extLimitTopic = s.emergencyInput || null;
      this.extLimitInvert = !!s.emergencyInputInvert;

      /* ---------- насос ---------- */
      var p = cfg.pump || {};
      this.pumpTopic = p.topic || null;
      this.pumpPostRun = U.def(p.postRun, 300) * 1000;
      this.pumpAntiStick = U.def(p.antiStickDays, 7);
      this.pumpOffSince = 0;

      /* ---------- запрос тепла источнику ---------- */
      this.demandTopic = (cfg.demand && cfg.demand.topic) || null;
      this.demandBand = U.def(cfg.demand && cfg.demand.band, 1);

      /* ---------- погодозависимая кривая ---------- */
      var w = cfg.curve || {};
      this.curve = {
        tRoom: U.def(w.roomTemp, 20),
        tOutDesign: U.def(w.outdoorDesign, -28),
        tSupDesign: U.def(w.supplyDesign, 35),
        tRetDesign: U.def(w.returnDesign, 28),
        n: U.def(w.exponent, 1.1),
        summerCutoff: U.def(w.summerCutoff, 16),
        summerHyst: U.def(w.summerHyst, 2),
        roomGain: U.def(w.roomGain, 2)
      };
      this.summer = false;

      /* ---------- датчики ---------- */
      var sn = cfg.sensors || {};
      this.sIn = new U.Sensor(sn.supplyIn, { tau: U.def(sn.tau, 5), required: true });
      this.sMix = new U.Sensor(sn.supplyOut, { tau: U.def(sn.tau, 5), required: true });
      this.sRet = new U.Sensor(sn.returnLine, { tau: 60, required: false });
      this.sOut = new U.Sensor(sn.outdoor, { tau: 300, required: false, min: -70, max: 70 });
      this.sRoom = new U.Sensor(sn.room, { tau: 120, required: false, min: -20, max: 60 });

      /* ---------- привод ---------- */
      this.storage = new PersistentStorage('wbmix_' + this.id, { global: true });
      this.act = ACT.create(cfg.actuator || {}, {
        log: this.log,
        id: this.id,
        storage: this.storage
      });

      /* ---------- регулятор ---------- */
      this.pid = new PID.Pid({
        kp: U.def(c.kp, 4),
        ki: U.def(c.ki, 0.02),
        kd: U.def(c.kd, 0),
        deadband: U.def(c.deadband, 0.3),
        outMin: 0,
        outMax: 100
      });

      /* ---------- рабочее состояние ---------- */
      this.lastTick = 0;
      this.state = 'off';
      this.alarms = {};
      this.targetSp = null;
      this.ff = 0;
      this.limitActive = false;
      this.deviationSince = 0;
      this.lastMoveTs = Date.now();
      this.wasEnabled = false;
      this.tickTimer = null;

      this._buildDevice();
      this._defineRules();
      this._start();
    }

    /* ================================================================== */
    /*  Виртуальное устройство                                             */
    /* ================================================================== */

    MixingGroup.prototype._buildDevice = function () {
      var cfg = this.cfg;
      var cells = {};

      cells.enabled = {
        title: { en: 'Enabled', ru: 'Включен' },
        type: 'switch',
        value: U.def(cfg.defaultEnabled, true)
      };

      cells.mode = {
        title: { en: 'Mode', ru: 'Режим' },
        type: 'value',
        value: U.def(cfg.defaultMode, MODE_FIXED),
        enum: {
          0: { en: 'Manual position', ru: 'Ручное положение' },
          1: { en: 'Fixed setpoint', ru: 'Фиксированная уставка' },
          2: { en: 'Weather curve', ru: 'Погодозависимая кривая' }
        }
      };

      cells.setpoint = {
        title: { en: 'Setpoint', ru: 'Уставка подачи' },
        type: 'range',
        value: U.def(cfg.defaultSetpoint, 35),
        min: this.spMin,
        max: this.spMax
      };

      cells.target = {
        title: { en: 'Target (effective)', ru: 'Расчётная уставка' },
        type: 'temperature',
        value: 0,
        readonly: true
      };

      cells.t_in = {
        title: { en: 'Supply from source', ru: 'Вход (от котла)' },
        type: 'temperature',
        value: 0,
        readonly: true
      };

      cells.t_mix = {
        title: { en: 'After mixing unit', ru: 'Выход (после узла)' },
        type: 'temperature',
        value: 0,
        readonly: true
      };

      if (this.sRet.configured) {
        cells.t_ret = {
          title: { en: 'Return', ru: 'Обратка контура' },
          type: 'temperature',
          value: 0,
          readonly: true
        };
      }
      if (this.sOut.configured) {
        cells.t_out = {
          title: { en: 'Outdoor', ru: 'Улица' },
          type: 'temperature',
          value: 0,
          readonly: true
        };
      }
      if (this.sRoom.configured) {
        cells.t_room = {
          title: { en: 'Room', ru: 'Помещение' },
          type: 'temperature',
          value: 0,
          readonly: true
        };
      }

      cells.deviation = {
        title: { en: 'Deviation', ru: 'Рассогласование' },
        type: 'value',
        value: 0,
        readonly: true
      };

      cells.position = {
        title: { en: 'Valve position', ru: 'Положение клапана' },
        type: 'value',
        value: 0,
        readonly: true
      };

      cells.position_cmd = {
        title: { en: 'Manual position', ru: 'Положение (ручное)' },
        type: 'range',
        value: 0,
        min: 0,
        max: 100
      };

      cells.ff = {
        title: { en: 'Feed-forward', ru: 'Упреждение (модель)' },
        type: 'value',
        value: 0,
        readonly: true
      };

      cells.pid_i = {
        title: { en: 'PID integral', ru: 'Интегратор ПИ' },
        type: 'value',
        value: 0,
        readonly: true
      };

      cells.state = {
        title: { en: 'State', ru: 'Состояние' },
        type: 'text',
        value: STATE_TITLES.off,
        readonly: true
      };

      cells.alarm = {
        title: { en: 'Alarm', ru: 'Авария' },
        type: 'switch',
        value: false,
        readonly: true
      };

      cells.alarm_text = {
        title: { en: 'Alarm details', ru: 'Описание аварии' },
        type: 'text',
        value: '',
        readonly: true
      };

      if (this.pumpTopic) {
        cells.pump = {
          title: { en: 'Pump', ru: 'Насос контура' },
          type: 'switch',
          value: false,
          readonly: true
        };
      }

      /* --- настроечные параметры (правятся на лету из веб-интерфейса) --- */

      cells.max_supply = {
        title: { en: 'Max supply limit', ru: 'Предел перегрева' },
        type: 'range',
        value: this.tMax,
        min: 20,
        max: 90
      };

      cells.kp = {
        title: { en: 'Kp, %/K', ru: 'Kp, %/К' },
        type: 'range',
        value: this.pid.kp,
        min: 0,
        max: 30
      };

      // Значение публикуется умноженным на 1000, а правило _wbmix_tunings
      // делит его обратно: ki порядка 0.012 на целочисленном ползунке
      // не задать. Множитель обязан быть в подписи — иначе оператор,
      // следуя инструкции по наладке («поднимайте ki от 0,005»), введёт
      // 0,005, получит округление до нуля и выключенный интегратор.
      cells.ki = {
        title: { en: 'Ki x1000, %/(K*s)', ru: 'Ki × 1000, %/(К·с)' },
        type: 'range',
        value: Math.round(this.pid.ki * 1000),
        min: 0,
        max: 500
      };

      cells.curve_slope = {
        title: { en: 'Curve slope', ru: 'Наклон кривой, %' },
        type: 'range',
        value: 100,
        min: 30,
        max: 200
      };

      cells.curve_shift = {
        title: { en: 'Curve shift, K', ru: 'Сдвиг кривой, К' },
        type: 'range',
        value: 0,
        min: -15,
        max: 15
      };

      cells.calibrate = {
        title: { en: 'Calibrate valve', ru: 'Калибровать привод' },
        type: 'pushbutton'
      };

      cells.reset_alarm = {
        title: { en: 'Reset alarm', ru: 'Сброс аварии' },
        type: 'pushbutton'
      };

      this.vdev = defineVirtualDevice(this.id, {
        title: { en: this.title, ru: this.title },
        cells: cells
      });

      // Порядок отображения в веб-интерфейсе. Поле order в описании cells
      // не документировано, поэтому выставляем сеттером после создания.
      var order = [
        'enabled', 'mode', 'setpoint', 'target',
        't_in', 't_mix', 't_ret', 't_out', 't_room',
        'deviation', 'position', 'position_cmd', 'ff', 'pid_i',
        'state', 'alarm', 'alarm_text', 'pump',
        'max_supply', 'kp', 'ki', 'curve_slope', 'curve_shift',
        'calibrate', 'reset_alarm'
      ];
      for (var i = 0; i < order.length; i++) {
        try {
          this.vdev.getControl(order[i]).setOrder(i + 1);
        } catch (e) {
          /* контрол не создан для этой конфигурации */
        }
      }

      // Единицы измерения для range-контролов задаём сеттерами:
      // в описании cells поля units нет.
      this._setUnits('setpoint', 'deg C');
      this._setUnits('deviation', 'deg C');
      this._setUnits('position', '%');
      this._setUnits('position_cmd', '%');
      this._setUnits('ff', '%');
      this._setUnits('pid_i', '%');
      this._setUnits('max_supply', 'deg C');
      this._setUnits('curve_shift', 'deg C');
    };

    MixingGroup.prototype._setUnits = function (ctrl, units) {
      try {
        this.vdev.getControl(ctrl).setUnits(units);
      } catch (e) {
        /* контрол может отсутствовать в конфигурации — это нормально */
      }
    };

    MixingGroup.prototype._c = function (name) {
      return this.id + '/' + name;
    };

    MixingGroup.prototype._set = function (name, value) {
      try {
        if (dev[this._c(name)] !== value) dev[this._c(name)] = value;
      } catch (e) {
        /* контрол не создан */
      }
    };

    /* ================================================================== */
    /*  Правила на изменение уставок из интерфейса                         */
    /* ================================================================== */

    MixingGroup.prototype._defineRules = function () {
      var self = this;

      defineRule(this.id + '_wbmix_calibrate', {
        whenChanged: this._c('calibrate'),
        then: function () {
          self.log.info('[{}] запрошена калибровка привода', self.id);
          self.act.calibrate(-1, function (ok) {
            self.log.info('[{}] калибровка завершена: {}', self.id, ok);
            self.pid.bumplessReset(self.act.getPosition(), self.ff);
          });
        }
      });

      defineRule(this.id + '_wbmix_reset_alarm', {
        whenChanged: this._c('reset_alarm'),
        then: function () {
          self.alarms = {};
          self.deviationSince = 0;
          self._set('alarm', false);
          self._set('alarm_text', '');
          self.log.info('[{}] аварии сброшены оператором', self.id);
        }
      });

      defineRule(this.id + '_wbmix_tunings', {
        whenChanged: [this._c('kp'), this._c('ki'), this._c('max_supply')],
        then: function () {
          self.pid.setTunings(dev[self._c('kp')], dev[self._c('ki')] / 1000, null);
          self.tMax = dev[self._c('max_supply')];
        }
      });

      // Реакция на смену режима/включение — без ожидания следующего такта
      defineRule(this.id + '_wbmix_mode', {
        whenChanged: [this._c('enabled'), this._c('mode')],
        then: function () {
          self.pid.bumplessReset(self.act.getPosition(), self.ff);
          self._tick();
        }
      });
    };

    /* ================================================================== */
    /*  Погодозависимая кривая                                             */
    /* ================================================================== */

    /**
     * Классический расчёт по характеристике отопительного прибора.
     *
     *   x        = (Tпом - Tнар) / (Tпом - Tнар.расч)   — доля нагрузки
     *   ΔTср     = ΔTср.расч * x^(1/n)                   — средний напор
     *   ΔTконтур = ΔTконтур.расч * x                     — перепад (расход const)
     *   Tподачи  = Tпом + ΔTср + ΔTконтур / 2
     *
     * n — показатель степени теплоотдачи прибора:
     *   1.1 — тёплый пол, 1.3 — стальные/алюминиевые радиаторы,
     *   1.25…1.33 — чугун, 1.4 — конвекторы.
     */
    MixingGroup.prototype._curveSetpoint = function (tOutdoor) {
      var k = this.curve;
      var slope = U.def(dev[this._c('curve_slope')], 100) / 100;
      var shift = U.def(dev[this._c('curve_shift')], 0);

      var span = k.tRoom - k.tOutDesign;
      if (span <= 0) return this.spMin;

      var x = (k.tRoom - tOutdoor) / span;
      if (x <= 0) return this.spMin;
      x = Math.min(x, 1.3);

      var dtLoopDesign = k.tSupDesign - k.tRetDesign;
      var dtMeanDesign = (k.tSupDesign + k.tRetDesign) / 2 - k.tRoom;

      var dtMean = dtMeanDesign * Math.pow(x, 1 / k.n);
      var dtLoop = dtLoopDesign * x;

      var sp = k.tRoom + slope * (dtMean + dtLoop / 2) + shift;

      // Коррекция по фактической температуре помещения (если есть датчик)
      if (this.sRoom.ok()) {
        var corr = U.clamp(k.roomGain * (k.tRoom - this.sRoom.value), -6, 6);
        sp += corr;
      }

      return U.clamp(sp, this.spMin, this.spMax);
    };

    /* ================================================================== */
    /*  Основной такт                                                      */
    /* ================================================================== */

    MixingGroup.prototype._start = function () {
      var self = this;
      this.lastTick = Date.now();
      this.tickTimer = setInterval(function () {
        try {
          self._tick();
        } catch (e) {
          self.log.error('[{}] ошибка такта: {}', self.id, e);
        }
      }, this.periodMs);
      this.log.info(
        '[{}] смесительный узел запущен, привод: {}, период {} с',
        this.id,
        this.act.kind,
        this.periodMs / 1000
      );
    };

    MixingGroup.prototype._alarm = function (key, text) {
      if (!this.alarms[key]) this.log.warning('[{}] АВАРИЯ: {}', this.id, text);
      this.alarms[key] = text;
    };

    MixingGroup.prototype._clearAlarm = function (key) {
      if (this.alarms[key]) delete this.alarms[key];
    };

    MixingGroup.prototype._publishAlarms = function () {
      var list = [];
      for (var k in this.alarms) {
        if (Object.prototype.hasOwnProperty.call(this.alarms, k)) list.push(this.alarms[k]);
      }
      this._set('alarm', list.length > 0);
      this._set('alarm_text', list.join('; '));
    };

    MixingGroup.prototype._tick = function () {
      var now = Date.now();
      var dt = (now - this.lastTick) / 1000;
      if (dt <= 0 || dt > 3600) dt = this.periodMs / 1000;
      this.lastTick = now;

      /* ---------- 1. Опрос датчиков ---------- */
      this.sIn.poll(dt);
      this.sMix.poll(dt);
      this.sRet.poll(dt);
      this.sOut.poll(dt);
      this.sRoom.poll(dt);

      this._set('t_in', U.round(this.sIn.get(0), 1));
      this._set('t_mix', U.round(this.sMix.get(0), 1));
      if (this.sRet.configured) this._set('t_ret', U.round(this.sRet.get(0), 1));
      if (this.sOut.configured) this._set('t_out', U.round(this.sOut.get(0), 1));
      if (this.sRoom.configured) this._set('t_room', U.round(this.sRoom.get(0), 1));

      if (this.sMix.fault) this._alarm('s_mix', 'нет датчика после узла (' + this.sMix.reason + ')');
      else this._clearAlarm('s_mix');
      if (this.sIn.fault) this._alarm('s_in', 'нет датчика на входе (' + this.sIn.reason + ')');
      else this._clearAlarm('s_in');

      /* ---------- 2. Условия работы ---------- */
      var enabled = dev[this._c('enabled')] === true;
      var mode = U.toNum(dev[this._c('mode')]);
      if (!U.isNum(mode)) mode = MODE_FIXED;

      // Внешний аварийный термостат / сухой контакт защиты
      var emergency = false;
      if (this.extLimitTopic) {
        var e = dev[this.extLimitTopic];
        emergency = this.extLimitInvert ? e === false : e === true;
        if (emergency) this._alarm('ext', 'сработал внешний аварийный термостат');
        else this._clearAlarm('ext');
      }

      // Летнее отключение по наружной температуре
      if (this.sOut.ok() && this.curve.summerCutoff !== null) {
        if (!this.summer && this.sOut.value > this.curve.summerCutoff) this.summer = true;
        else if (this.summer && this.sOut.value < this.curve.summerCutoff - this.curve.summerHyst)
          this.summer = false;
      } else {
        this.summer = false;
      }

      var tMix = this.sMix.get(null);

      /* ---------- 3. Приоритетные защиты ---------- */

      // 3.1 Защита от замерзания — выше выключателя
      if (this.frostOn && tMix !== null && tMix < this.frostT) {
        this._alarm('frost', 'защита от замерзания: ' + U.round(tMix, 1) + ' °C');
        this._setState('frost');
        this._pump(true, now);
        this.act.apply(this.frostPos, this.periodMs);
        this._finish(now);
        return;
      }
      this._clearAlarm('frost');

      // 3.2 Внешняя авария
      if (emergency) {
        this._setState('fault');
        this.act.apply(0, this.periodMs);
        this._pump(true, now); // насос гоняем, чтобы снять тепло с контура
        this._finish(now);
        return;
      }

      // 3.3 Выключен / лето
      if (!enabled || this.summer) {
        if (this.wasEnabled) {
          this.pid.reset();
          this.wasEnabled = false;
        }
        this._setState(this.summer && enabled ? 'summer' : 'off');
        this.targetSp = null;
        this.act.apply(0, this.periodMs);
        this._pump(false, now);
        this._demand(false);
        this._antiStick(now);
        this._finish(now);
        return;
      }
      this.wasEnabled = true;

      // 3.4 Отказ основного датчика — в безопасное положение
      if (this.sMix.fault) {
        this._setState('fault');
        this.act.apply(this.failSafePos, this.periodMs);
        this._pump(true, now);
        this.pid.reset();
        this._finish(now);
        return;
      }

      this._pump(true, now);

      /* ---------- 4. Ручной режим ---------- */
      if (mode === MODE_MANUAL) {
        var manual = U.clamp(U.toNum(dev[this._c('position_cmd')]) || 0, 0, 100);
        // Даже в ручном режиме предел перегрева работает
        if (tMix > this.tMax) manual = 0;
        this._setState(this.act.isBusy() ? 'calibrating' : 'manual');
        this.act.apply(manual, this.periodMs);
        this.pid.bumplessReset(this.act.getPosition(), this.ff);
        this._demand(true);
        this._finish(now);
        return;
      }

      /* ---------- 5. Расчёт уставки ---------- */
      var sp;
      if (mode === MODE_CURVE) {
        if (!this.sOut.ok()) {
          this._alarm('s_out', 'нет датчика улицы, кривая недоступна — работаю по резервной уставке');
          sp = U.clamp(U.toNum(dev[this._c('setpoint')]), this.spMin, this.spMax);
        } else {
          this._clearAlarm('s_out');
          sp = this._curveSetpoint(this.sOut.value);
        }
      } else {
        sp = U.clamp(U.toNum(dev[this._c('setpoint')]), this.spMin, this.spMax);
      }

      // 5.1 Мягкое ограничение на подходе к пределу перегрева
      var hardMax = this.tMax;
      var softMax = hardMax - this.softLimitBand;
      if (sp > softMax) sp = softMax;

      // 5.2 Ограничение скорости изменения уставки.
      //     На холодном пуске рампа стартует от фактической температуры
      //     контура, а не от расчётной уставки — иначе ПИ увидит сразу
      //     15..20 К рассогласования, откроет клапан на упор, и контур
      //     получит заброс далеко за уставку (транспортное запаздывание
      //     не даёт вовремя закрыться). Для тёплого пола этот заброс
      //     доходит до предела перегрева и поднимает ложную аварию.
      if (this.spRamp > 0) {
        if (this.targetSp === null) {
          this.targetSp = U.clamp(tMix, this.spMin, sp);
        }
        var maxStep = (this.spRamp * dt) / 60;
        sp = U.clamp(sp, this.targetSp - maxStep, this.targetSp + maxStep);
      }
      this.targetSp = sp;
      this._set('target', U.round(sp, 1));

      /* ---------- 6. Жёсткий предел перегрева ---------- */
      if (tMix >= hardMax) this.limitActive = true;
      else if (tMix < hardMax - this.tMaxHyst) this.limitActive = false;

      if (this.limitActive) {
        this._alarm('overheat', 'перегрев подачи: ' + U.round(tMix, 1) + ' °C, клапан закрыт');
        this._setState('limit');
        this.act.apply(0, this.periodMs);
        // Интегратор подтягиваем к нулю, чтобы после снятия перегрева
        // клапан не рванул обратно
        this.pid.bumplessReset(0, 0);
        this._demand(false);
        this._finish(now);
        return;
      }
      this._clearAlarm('overheat');

      /* ---------- 7. Упреждение по модели смешения ---------- */
      var tIn = this.sIn.get(null);
      var tRet;
      if (this.sRet.ok()) {
        tRet = this.sRet.value;
      } else {
        // Оценка обратки: подача минус расчётный перепад контура.
        // Грубо, но для упреждения достаточно — ошибку доберёт ПИ.
        tRet = tMix - this.loopDt;
      }

      var ff = 0;
      var ffValid = false;
      if (this.useFF && tIn !== null) {
        var authority = tIn - tRet;
        if (authority >= this.minAuthority) {
          ff = U.clamp(((sp - tRet) / authority) * 100, 0, 100);
          ffValid = true;
        } else if (tIn < sp) {
          // Источник холоднее уставки — открываемся полностью,
          // регулировать нечем.
          ff = 100;
          ffValid = true;
        }
      }
      this.ff = ffValid ? ff : this.ff;
      this._set('ff', U.round(this.ff, 1));

      /* ---------- 8. ПИ-коррекция и выдача на привод ---------- */
      // Если привод занят (идёт калибровочный прогон на упор), он физически
      // не может отработать команду. Интегрировать в это время нельзя —
      // за 2 минуты калибровки интегратор наберёт полный ход и клапан
      // после её окончания уйдёт на упор. Поэтому запоминаем интегратор
      // и возвращаем его на место.
      var frozen = this.act.isBusy();
      var savedI = this.pid.integral;

      var pos = this.pid.compute(sp, tMix, dt, ffValid ? ff : 0);
      if (frozen) this.pid.integral = savedI;
      this._set('pid_i', U.round(this.pid.i, 1));

      var err = sp - tMix;
      this._set('deviation', U.round(err, 1));

      var action = this.act.apply(pos, this.periodMs);
      // Пока привод не отрабатывает команды (калибровка, идущий импульс,
      // потеря связи с модулем) — интегрировать нельзя, иначе интегратор
      // наберёт полный ход и после восстановления клапан уйдёт на упор.
      if (action === 'calibrate' || action === 'busy' || action === 'link_fault')
        this.pid.integral = savedI;
      if (action === 'open' || action === 'close') this.lastMoveTs = now;

      /* ---------- 9. Состояние и диагностика ---------- */
      // Потеря связи с модулем привода — отдельная авария. Для привода без
      // возвратной пружины это означает, что кран замер в неизвестном
      // положении: сам он никуда не вернётся.
      var actFault = this.act.getFault ? this.act.getFault() : null;
      if (actFault) this._alarm('actuator', actFault);
      else this._clearAlarm('actuator');

      var noHeat = tIn !== null && tIn < sp - 1 && this.act.getPosition() > 95;
      if (actFault) this._setState('fault');
      else if (this.act.isBusy() && action === 'calibrate') this._setState('calibrating');
      else if (noHeat) this._setState('no_heat');
      else if (Math.abs(err) <= this.readyBand) this._setState('ready');
      else this._setState('heating');

      // Аварийное рассогласование: держится долго и клапан на упоре
      if (Math.abs(err) > this.deviationK) {
        if (this.deviationSince === 0) this.deviationSince = now;
        else if ((now - this.deviationSince) / 1000 > this.deviationSec) {
          this._alarm(
            'deviation',
            'уставка не достигается ' +
              Math.round(this.deviationSec / 60) +
              ' мин (Δ=' +
              U.round(err, 1) +
              ' К)'
          );
        }
      } else {
        this.deviationSince = 0;
        this._clearAlarm('deviation');
      }

      this._demand(true);
      this._antiStick(now);
      this._finish(now);
    };

    MixingGroup.prototype._setState = function (s) {
      this.state = s;
      this._set('state', STATE_TITLES[s] || s);
    };

    MixingGroup.prototype._finish = function () {
      this._set('position', U.round(this.act.getPosition(), 1));
      this._publishAlarms();
    };

    /* ================================================================== */
    /*  Насос, запрос тепла, антизалипание                                 */
    /* ================================================================== */

    MixingGroup.prototype._pump = function (on, now) {
      if (!this.pumpTopic) return;
      if (on) {
        this.pumpOffSince = 0;
        if (dev[this.pumpTopic] !== true) dev[this.pumpTopic] = true;
        this._set('pump', true);
      } else {
        // Выбег: после остановки контура насос ещё работает,
        // чтобы снять остаточное тепло с теплообменника/петель
        if (this.pumpOffSince === 0) this.pumpOffSince = now;
        if (now - this.pumpOffSince >= this.pumpPostRun) {
          if (dev[this.pumpTopic] !== false) dev[this.pumpTopic] = false;
          this._set('pump', false);
        } else {
          this._set('pump', true);
        }
      }
    };

    MixingGroup.prototype._demand = function (on) {
      if (!this.demandTopic) return;
      var want = on;
      if (on && this.targetSp !== null && this.sMix.ok()) {
        // Запрос тепла снимаем, когда уставка держится с запасом
        want = this.sMix.value < this.targetSp + this.demandBand;
      }
      try {
        if (dev[this.demandTopic] !== want) dev[this.demandTopic] = want;
      } catch (e) {
        /* топик может быть недоступен */
      }
    };

    /**
     * Антизалипание: если клапан и насос долго не двигались
     * (лето, длительный простой), раз в N дней прогоняем их.
     * Классическая причина «весной кран закис» — именно отсутствие
     * этой процедуры.
     */
    MixingGroup.prototype._antiStick = function (now) {
      if (this.pumpAntiStick <= 0) return;
      var idleDays = (now - this.lastMoveTs) / 86400000;
      if (idleDays < this.pumpAntiStick) return;

      this.log.info('[{}] антизалипание: прогон клапана и насоса', this.id);
      this.lastMoveTs = now;

      var self = this;
      if (this.pumpTopic) {
        dev[this.pumpTopic] = true;
        setTimeout(function () {
          if (!self.wasEnabled) dev[self.pumpTopic] = false;
        }, 60000);
      }
      this.act.calibrate(1, function () {
        self.act.calibrate(-1, function () {
          self.pid.bumplessReset(0, 0);
        });
      });
    };

    /* ================================================================== */

    MixingGroup.prototype.destroy = function () {
      if (this.tickTimer !== null) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      this.act.halt();
    };

    /**
     * Реестр экземпляров живёт в module.static — он общий для всех
     * сценариев, импортировавших модуль, и переживает автоперезагрузку
     * файла правил. Без него после каждого сохранения сценария
     * в веб-интерфейсе оставался бы «висячий» setInterval, и приводом
     * начинали бы управлять сразу несколько тактовых циклов.
     */
    if (!module.static.instances) module.static.instances = {};

    exports.MixingGroup = MixingGroup;

    exports.create = function (cfg) {
      var reg = module.static.instances;
      if (reg[cfg.id]) {
        try {
          reg[cfg.id].destroy();
        } catch (e) {
          log.error('wbmix: не удалось остановить прежний экземпляр {}: {}', cfg.id, e);
        }
      }
      var g = new MixingGroup(cfg);
      reg[cfg.id] = g;
      return g;
    };

    exports.get = function (id) {
      return module.static.instances[id];
    };
    exports.MODE_MANUAL = MODE_MANUAL;
    exports.MODE_FIXED = MODE_FIXED;
    exports.MODE_CURVE = MODE_CURVE;

  };

  /* ---------------- точка входа ---------------- */

  var GROUP = require('wbmix-group');

  if (!CONFIG || !CONFIG.groups || !CONFIG.groups.length) {
    log.error('wbmix: в CONFIG нет секции "groups"');
    return;
  }

  for (var i = 0; i < CONFIG.groups.length; i++) {
    var g = CONFIG.groups[i];
    if (!g || !g.id) {
      log.error('wbmix: группа #{} без поля "id" — пропущена', i);
      continue;
    }
    try {
      GROUP.create(g);
    } catch (e) {
      log.error('wbmix: не удалось создать узел "{}": {}', g.id, e);
    }
  }

  log.info('wbmix: инициализировано узлов: {}', CONFIG.groups.length);
})();
