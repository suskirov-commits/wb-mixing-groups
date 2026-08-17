/**
 * make-bundle.js — собирает однофайловую версию для загрузки
 * через веб-интерфейс Wiren Board (вкладка «Правила»).
 *
 * Все модули инлайнятся в один файл со своим мини-загрузчиком,
 * конфигурация вклеивается прямо в код (JSON с комментариями —
 * это валидный литерал объекта JavaScript, так что комментарии
 * в конфиге сохраняются).
 *
 * Запуск: node tools/make-bundle.js   (или make build)
 * Результат: dist/wb-mixing-groups.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD_DIR = path.join(ROOT, 'etc', 'wb-rules-modules');
const OUT_DIR = path.join(ROOT, 'dist');

const MODULES = ['wbmix-util', 'wbmix-pid', 'wbmix-actuator', 'wbmix-group'];

// В однофайловую сборку вклеиваем аннотированный вариант конфигурации:
// комментарии в нём — валидный JavaScript, и в веб-редакторе они помогают
// понять, что за что отвечает. Строгий JSON нужен только варианту с
// wb-mqtt-confed, который переписывает файл сам.
const confPath = path.join(ROOT, 'etc', 'wb-mixing-groups.conf.example');
const conf = fs.readFileSync(
  fs.existsSync(confPath) ? confPath : path.join(ROOT, 'etc', 'wb-mixing-groups.conf'),
  'utf8'
);

// Оставляем только тело объекта конфигурации (файл начинается с шапки-комментария)
const confBody = conf.slice(conf.indexOf('{'));

let out = '';

out += `/**
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

var CONFIG = ${confBody.trim()};

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

`;

for (const name of MODULES) {
  const code = fs.readFileSync(path.join(MOD_DIR, name + '.js'), 'utf8');
  const indented = code
    .split('\n')
    .map((l) => (l.length ? '    ' + l : l))
    .join('\n');
  out += `  /* ---------------- модуль ${name} ---------------- */\n`;
  out += `  __defs['${name}'] = function (exports, module, require) {\n`;
  out += indented;
  out += `\n  };\n\n`;
}

out += `  /* ---------------- точка входа ---------------- */

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
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'wb-mixing-groups.js');
fs.writeFileSync(outPath, out, 'utf8');

const lines = out.split('\n').length;
console.log('Собрано: ' + outPath);
console.log('  строк: ' + lines + ', размер: ' + Math.round(out.length / 1024) + ' КБ');
console.log('  модулей внутри: ' + MODULES.length);
