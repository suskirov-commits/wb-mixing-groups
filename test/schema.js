/**
 * schema.js — проверка схемы конфигурации для wb-mqtt-confed.
 *
 * Схему нельзя «прогнать» через веб-интерфейс из скрипта, поэтому
 * проверяем всё, что проверяемо машинно:
 *   - схема компилируется как JSON Schema draft-04;
 *   - штатный конфиг ей соответствует;
 *   - конфиг, который вернёт confed (пустые строки вместо null,
 *     отсутствующие необязательные секции), тоже валиден;
 *   - все ключи переводов на месте в обеих локалях;
 *   - все поля схемы реально читаются кодом;
 *   - у топиков стоит формат автодополнения.
 *
 * Запуск: node test/schema.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv-draft-04');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(
  ROOT,
  'usr/share/wb-mqtt-confed/schemas/wb-mixing-groups.schema.json'
);
const CONF_PATH = path.join(ROOT, 'etc/wb-mixing-groups.conf');

let pass = 0,
  fail = 0;
const check = (n, c, d) =>
  c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (d ? ' -> ' + d : '')));

console.log('\n=== СХЕМА КОНФИГУРАЦИИ (wb-mqtt-confed) ===\n');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const conf = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));

console.log('1. Компиляция и валидация');
const ajv = new Ajv({ strict: false, allErrors: true });
let validate = null,
  compileErr = null;
try {
  validate = ajv.compile(schema);
} catch (e) {
  compileErr = e;
}
check('схема компилируется как draft-04', compileErr === null, compileErr && compileErr.message);
check('штатный конфиг валиден', validate && validate(conf), JSON.stringify((validate && validate.errors || [])[0]));

console.log('\n2. Интеграция с confed');
check('указан путь к файлу конфигурации', schema.configFile && schema.configFile.path === '/etc/wb-mixing-groups.conf', JSON.stringify(schema.configFile));
check('указан сервис для перезапуска', schema.configFile && schema.configFile.service === 'wb-rules');

console.log('\n3. Выбор топиков из списка');
const s = JSON.stringify(schema);
const autoCount = (s.match(/wb-autocomplete/g) || []).length;
check('поля топиков используют wb-autocomplete', autoCount >= 10, 'найдено ' + autoCount);
const dataCount = (s.match(/"data":\s*"devices"/g) || []).length;
check('источник списка — devices', dataCount === autoCount, dataCount + ' из ' + autoCount);

function findTopicFields(node, out, p) {
  if (Array.isArray(node)) return node.forEach((v, i) => findTopicFields(v, out, p + '/' + i));
  if (!node || typeof node !== 'object') return out;
  if (node._format === 'wb-autocomplete') out.push(p);
  for (const k of Object.keys(node)) findTopicFields(node[k], out, p + '/' + k);
  return out;
}
const topicFields = findTopicFields(schema, [], '');
const expected = ['supplyIn', 'supplyOut', 'returnLine', 'outdoor', 'room', 'open', 'close', 'out', 'feedback', 'topic', 'emergencyInput'];
for (const name of expected) {
  check('поле «' + name + '» с автодополнением', topicFields.some((f) => f.endsWith('/' + name)), name);
}

console.log('\n4. $ref без соседних ключей (иначе json-editor теряет заголовки)');
const bad = [];
(function walk(n, p) {
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, p + '/' + i));
  if (!n || typeof n !== 'object') return;
  if (n.$ref && Object.keys(n).length > 1) bad.push(p);
  for (const k of Object.keys(n)) walk(n[k], p + '/' + k);
})(schema, '');
check('таких мест нет', bad.length === 0, bad.join(', '));

console.log('\n5. Переводы');
const en = schema.translations.en,
  ru = schema.translations.ru;
const keys = new Set();
(function collect(n) {
  if (Array.isArray(n)) return n.forEach(collect);
  if (!n || typeof n !== 'object') return;
  for (const f of ['title', 'description']) {
    if (typeof n[f] === 'string' && /^[a-z][A-Za-z0-9]*$/.test(n[f])) keys.add(n[f]);
  }
  if (n.options && Array.isArray(n.options.enum_titles)) n.options.enum_titles.forEach((t) => keys.add(t));
  if (n.options && typeof n.options.patternmessage === 'string') keys.add(n.options.patternmessage);
  if (n.options && n.options.inputAttributes && n.options.inputAttributes.placeholder)
    keys.add(n.options.inputAttributes.placeholder);
  for (const k of Object.keys(n)) {
    if (k !== 'translations') collect(n[k]);
  }
})(schema);

const missEn = [...keys].filter((k) => !(k in en));
const missRu = [...keys].filter((k) => !(k in ru));
check('все ключи переведены на английский', missEn.length === 0, missEn.slice(0, 5).join(', '));
check('все ключи переведены на русский', missRu.length === 0, missRu.slice(0, 5).join(', '));
check('ключей в переводе: ' + keys.size, keys.size > 80, String(keys.size));

console.log('\n6. Конфиг «как его вернёт confed»');
// confed пишет пустые строки вместо незаполненных топиков и опускает
// необязательные секции целиком
const minimal = {
  groups: [
    {
      id: 'mix_test',
      title: 'Тест',
      sensors: { supplyIn: 'a/b', supplyOut: 'c/d', returnLine: '', outdoor: '', room: '' },
      actuator: { type: 'tristate', open: 'r/1', close: 'r/2', travelTime: 90 }
    }
  ]
};
check('минимальный конфиг валиден', validate(minimal), JSON.stringify((validate.errors || [])[0]));

const analogMin = {
  groups: [
    {
      id: 'mix_a',
      title: 'Тест 0-10 В',
      sensors: { supplyIn: 'a/b', supplyOut: 'c/d' },
      actuator: { type: 'analog', out: 'ao/ch1', vMin: 2000, vMax: 10000, feedback: '' }
    }
  ]
};
check('конфиг с приводом 0-10 В валиден', validate(analogMin), JSON.stringify((validate.errors || [])[0]));

const noSensor = { groups: [{ id: 'x', title: 'x', sensors: { supplyIn: 'a/b' }, actuator: { type: 'analog', out: 'a/b' } }] };
check('конфиг без обязательного датчика отклоняется', !validate(noSensor));

const badId = { groups: [{ id: 'плохой id', title: 'x', sensors: { supplyIn: 'a/b', supplyOut: 'c/d' }, actuator: { type: 'analog', out: 'a/b' } }] };
check('некорректный id отклоняется', !validate(badId));

const badTopic = { groups: [{ id: 'x', title: 'x', sensors: { supplyIn: 'без слэша', supplyOut: 'c/d' }, actuator: { type: 'analog', out: 'a/b' } }] };
check('топик без слэша отклоняется', !validate(badTopic));

console.log('\n7. Поля схемы совпадают с тем, что читает код');
const groupProps = schema.definitions.group.properties;
const codeSrc = ['wbmix-group', 'wbmix-actuator']
  .map((m) => fs.readFileSync(path.join(ROOT, 'etc/wb-rules-modules', m + '.js'), 'utf8'))
  .join('\n');

const unused = [];
function checkSection(sectionName, props) {
  for (const key of Object.keys(props)) {
    if (key === 'type' && sectionName === 'actuator') continue;
    const re = new RegExp('[.\\[\'"]' + key + '\\b');
    if (!re.test(codeSrc)) unused.push(sectionName + '.' + key);
  }
}
for (const [name, def] of Object.entries(groupProps)) {
  if (def.properties) checkSection(name, def.properties);
  else if (!def.oneOf) checkSection('group', { [name]: def });
}
for (const branch of groupProps.actuator.oneOf) {
  // ветки заданы через $ref на definitions — резолвим
  const def = branch.$ref
    ? schema.definitions[branch.$ref.replace('#/definitions/', '')]
    : branch;
  checkSection('actuator', def.properties);
}
check('все поля схемы читаются кодом', unused.length === 0, unused.join(', '));

console.log('\n--- ИТОГО: ' + pass + ' пройдено, ' + fail + ' провалено ---\n');
process.exit(fail ? 1 : 0);
