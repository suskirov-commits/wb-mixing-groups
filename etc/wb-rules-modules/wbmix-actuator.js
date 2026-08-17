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
