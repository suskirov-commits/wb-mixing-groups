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
