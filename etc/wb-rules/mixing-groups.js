/**
 * @file /etc/wb-rules/mixing-groups.js
 * @description Точка входа: поднимает смесительные узлы по конфигурации.
 *
 * Установка:
 *   /etc/wb-rules-modules/wbmix-util.js
 *   /etc/wb-rules-modules/wbmix-pid.js
 *   /etc/wb-rules-modules/wbmix-actuator.js
 *   /etc/wb-rules-modules/wbmix-group.js
 *   /etc/wb-rules/mixing-groups.js        <- этот файл
 *   /etc/wb-mixing-groups.conf            <- конфигурация
 *
 * После копирования:  service wb-rules restart
 * Логи:               journalctl -fu wb-rules
 */

var GROUP = require('wbmix-group');

var CONF_PATH = '/etc/wb-mixing-groups.conf';

(function () {
  var conf;
  try {
    conf = readConfig(CONF_PATH);
  } catch (e) {
    log.error('wbmix: не удалось прочитать {}: {}', CONF_PATH, e);
    return;
  }

  if (!conf || !conf.groups || !conf.groups.length) {
    log.error('wbmix: в {} нет секции "groups"', CONF_PATH);
    return;
  }

  for (var i = 0; i < conf.groups.length; i++) {
    var g = conf.groups[i];
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

  log.info('wbmix: инициализировано узлов: {}', conf.groups.length);
})();
