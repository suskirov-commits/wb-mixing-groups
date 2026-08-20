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
