#!/bin/bash
#
# install.sh (тест) — прогоняет установщик в песочнице через WBMIX_ROOT.
#
# Главное, что проверяем: обновление НИКОГДА не затирает конфигурацию
# объекта. Всё остальное — идемпотентность, откат, удаление.
#
# Запуск: bash test/install.sh

set -u
cd "$(dirname "$0")/.."
SRC=$(pwd)

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = 1 ] || [ "$2" = true ]; then
    pass=$((pass + 1))
    echo "  ✓ $1"
  else
    fail=$((fail + 1))
    echo "  ✗ $1${3:+  -> $3}"
  fi
}
exists() { [ -f "$1" ] && echo 1 || echo 0; }
missing() { [ -f "$1" ] && echo 0 || echo 1; }

run() { WBMIX_ROOT="$SANDBOX" sh "$SRC/install.sh" "$@" >"$SANDBOX/out.txt" 2>&1; }

CONF="$SANDBOX/etc/wb-mixing-groups.conf"
MODS="$SANDBOX/etc/wb-rules-modules"
SCHEMA="$SANDBOX/usr/share/wb-mqtt-confed/schemas/wb-mixing-groups.schema.json"
RULES="$SANDBOX/etc/wb-rules/mixing-groups.js"

echo ""
echo "=== УСТАНОВЩИК ==="
echo ""

echo "1. Чистая установка"
run install
rc=$?
check "скрипт отработал без ошибок" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(tail -3 "$SANDBOX/out.txt")"
check "модуль wbmix-group.js на месте" "$(exists "$MODS/wbmix-group.js")"
check "модуль wbmix-actuator.js на месте" "$(exists "$MODS/wbmix-actuator.js")"
check "модуль wbmix-pid.js на месте" "$(exists "$MODS/wbmix-pid.js")"
check "модуль wbmix-util.js на месте" "$(exists "$MODS/wbmix-util.js")"
check "сценарий на месте" "$(exists "$RULES")"
check "схема настроек на месте" "$(exists "$SCHEMA")"
check "конфигурация создана" "$(exists "$CONF")"
check "эталон сохранён для сравнения" "$(exists "$SANDBOX/usr/share/wbmix/wb-mixing-groups.conf.dist")"
check "записана версия" "$(exists "$SANDBOX/usr/share/wbmix/VERSION")"
check "подсказка про страницу настроек выведена" \
  "$(grep -q 'Настройки' "$SANDBOX/out.txt" && echo 1 || echo 0)"

echo ""
echo "2. Повторный запуск (идемпотентность)"
# правим конфиг «как на объекте»
python3 - "$CONF" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p,encoding='utf-8'))
d['groups'][0]['sensors']['supplyIn']='wb-w1/28-ОБЪЕКТ'
d['groups'][0]['control']['kp']=7.77
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
PY
before=$(md5sum "$CONF" | cut -d' ' -f1)
run install
rc=$?
after=$(md5sum "$CONF" | cut -d' ' -f1)
check "скрипт отработал без ошибок" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(tail -3 "$SANDBOX/out.txt")"
check "конфигурация объекта НЕ перезаписана" "$([ "$before" = "$after" ] && echo 1 || echo 0)"
check "правки на месте (kp=7.77)" "$(grep -q '7.77' "$CONF" && echo 1 || echo 0)"
check "лишний .conf.new не создан" "$(missing "$CONF.new")" "поставка не менялась — .new не нужен"

echo ""
echo "3. Обновление, в котором изменился эталонный конфиг"
TMPSRC=$(mktemp -d)
cp -r "$SRC"/. "$TMPSRC"/ 2>/dev/null
rm -rf "$TMPSRC/node_modules" "$TMPSRC/.git"
python3 - "$TMPSRC/etc/wb-mixing-groups.conf" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p,encoding='utf-8'))
d['groups'][0]['control']['newParam']=42   # как будто в новой версии добавили параметр
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
PY
before=$(md5sum "$CONF" | cut -d' ' -f1)
WBMIX_ROOT="$SANDBOX" sh "$TMPSRC/install.sh" install >"$SANDBOX/out.txt" 2>&1
rc=$?
after=$(md5sum "$CONF" | cut -d' ' -f1)
check "скрипт отработал без ошибок" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(tail -3 "$SANDBOX/out.txt")"
check "конфигурация объекта всё ещё не тронута" "$([ "$before" = "$after" ] && echo 1 || echo 0)"
check "новый эталон положен рядом как .conf.new" "$(exists "$CONF.new")"
check "в .conf.new есть новый параметр" "$(grep -q 'newParam' "$CONF.new" && echo 1 || echo 0)"
check "в рабочем конфиге нового параметра нет" "$(grep -q 'newParam' "$CONF" && echo 0 || echo 1)"
check "предупреждение показано" "$(grep -q 'conf.new' "$SANDBOX/out.txt" && echo 1 || echo 0)"

echo ""
echo "4. Битая схема в поставке — установка должна прерваться"
cp "$SRC/usr/share/wb-mqtt-confed/schemas/wb-mixing-groups.schema.json" "$SANDBOX/good.json"
echo '{ это не json' >"$TMPSRC/usr/share/wb-mqtt-confed/schemas/wb-mixing-groups.schema.json"
schema_before=$(md5sum "$SCHEMA" | cut -d' ' -f1)
WBMIX_ROOT="$SANDBOX" sh "$TMPSRC/install.sh" install >"$SANDBOX/out.txt" 2>&1
rc=$?
schema_after=$(md5sum "$SCHEMA" | cut -d' ' -f1)
check "установка прервана с ошибкой" "$([ $rc != 0 ] && echo 1 || echo 0)"
check "рабочая схема не испорчена" "$([ "$schema_before" = "$schema_after" ] && echo 1 || echo 0)"
check "в выводе сказано про битый JSON" "$(grep -qi 'json' "$SANDBOX/out.txt" && echo 1 || echo 0)"
rm -rf "$TMPSRC"

echo ""
echo "5. Бэкапы"
n=$(ls -1d "$SANDBOX"/var/backups/wbmix/*/ 2>/dev/null | wc -l)
check "бэкапы создаются" "$([ "$n" -ge 2 ] && echo 1 || echo 0)" "найдено $n"
last=$(ls -1d "$SANDBOX"/var/backups/wbmix/*/ | tail -1)
check "в бэкапе лежит конфигурация" "$(exists "$last/wb-mixing-groups.conf")"
check "в бэкапе лежат модули" "$(exists "$last/wbmix-group.js")"

echo ""
echo "6. Удаление"
run --uninstall
rc=$?
check "скрипт отработал без ошибок" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(tail -3 "$SANDBOX/out.txt")"
check "модули удалены" "$(missing "$MODS/wbmix-group.js")"
check "сценарий удалён" "$(missing "$RULES")"
check "схема удалена" "$(missing "$SCHEMA")"
check "конфигурация ОСТАВЛЕНА" "$(exists "$CONF")"

echo ""
echo "7. Полное удаление"
run --purge
check "конфигурация удалена" "$(missing "$CONF")"

echo ""
echo "8. Удаление пакета: postrm"
# wb-rules не убирает retained-топики устройств удалённого скрипта, и
# карточки узлов оставались в веб-интерфейсе после удаления пакета.
# postrm при remove перезапускает wb-rules и чистит топики узлов из конфига.
STUB="$SANDBOX/stub"
LOG="$SANDBOX/calls.log"
mkdir -p "$STUB" "$SANDBOX/etc"
stub() { printf '#!/bin/sh\necho "%s $*" >>"%s"\nexit %s\n' "$1" "$LOG" "$2" >"$STUB/$1" && chmod +x "$STUB/$1"; }
stub systemctl 0
stub mosquitto_sub 0
cat >"$CONF" <<'EOF'
{
  "groups": [
    { "id": "mix_floor", "title": "Пол" },
    { "id": "mix_rad", "title": "Радиаторы" },
    { "id": "+", "title": "маска «все устройства»" },
    { "id": "a/#", "title": "маска" }
  ]
}
EOF
postrm() {
  : >"$LOG"
  WBMIX_ROOT="$SANDBOX" PATH="$STUB:$PATH" sh "$SRC/debian/postrm" "$@" >"$SANDBOX/out.txt" 2>&1
}
postrm remove
rc=$?
check "postrm remove отработал без ошибок" "$([ $rc = 0 ] && echo 1 || echo 0)" "$(cat "$SANDBOX/out.txt")"
check "работающий wb-rules перезапущен" "$(grep -qx 'systemctl try-restart wb-rules' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
check "retained-топики узлов из конфига удаляются" \
  "$(grep -qF 'mosquitto_sub -t /devices/mix_floor/# -t /devices/mix_rad/# --retained-only --remove-retained' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
check "id с масками MQTT («+», «#») пропущены — чужие устройства целы" \
  "$(grep -qE '/devices/(\+|a)/' "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"
postrm upgrade 1.0.7
check "при обновлении postrm ничего не трогает" "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
stub systemctl 1
postrm remove
check "wb-rules не перезапустился — топики не трогаем (узел опубликовал бы их заново)" \
  "$(grep -q mosquitto_sub "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"
sh -n "$SRC/debian/postrm" && sh -n "$SRC/debian/postinst"
check "postinst и postrm синтаксически корректны" "$([ $? = 0 ] && echo 1 || echo 0)"

echo ""
echo "9. Синтаксис и deb-пакет"
sh -n "$SRC/install.sh"
check "install.sh синтаксически корректен" "$([ $? = 0 ] && echo 1 || echo 0)"

if command -v dpkg-deb >/dev/null 2>&1; then
  make -C "$SRC" deb >/dev/null 2>&1
  DEB=$(ls "$SRC"/wb-mixing-groups_*_all.deb 2>/dev/null | head -1)
  check "пакет собирается" "$([ -n "$DEB" ] && echo 1 || echo 0)"
  if [ -n "$DEB" ]; then
    check "конфиг объявлен в conffiles (dpkg не затрёт его при обновлении)" \
      "$(dpkg-deb -I "$DEB" conffiles 2>/dev/null | grep -q '/etc/wb-mixing-groups.conf' && echo 1 || echo 0)"
    check "зависимость от wb-rules указана" \
      "$(dpkg-deb -I "$DEB" 2>/dev/null | grep -q 'Depends: wb-rules' && echo 1 || echo 0)"
    check "модули попали в пакет" \
      "$(dpkg-deb -c "$DEB" 2>/dev/null | grep -c 'wb-rules-modules/wbmix-group.js' >/dev/null && echo 1 || echo 0)"
    check "схема настроек попала в пакет" \
      "$(dpkg-deb -c "$DEB" 2>/dev/null | grep -c 'wb-mqtt-confed/schemas/' >/dev/null && echo 1 || echo 0)"
    # Сжатие: контроллер Wiren Board — это Debian со старым dpkg, zstd он
    # не разбирает. Сборочная машина с новым dpkg-deb выбирает zstd сама,
    # и пакет молча получается неустанавливаемым.
    check "control.tar сжат gzip (dpkg на контроллере не знает zstd)" \
      "$(ar t "$DEB" 2>/dev/null | grep -qxF control.tar.gz && echo 1 || echo 0)"
    check "data.tar сжат gzip" \
      "$(ar t "$DEB" 2>/dev/null | grep -qxF data.tar.gz && echo 1 || echo 0)"
    dpkg-deb -I "$DEB" postinst > "$SANDBOX/postinst" 2>/dev/null
    sh -n "$SANDBOX/postinst"
    check "postinst синтаксически корректен" "$([ $? = 0 ] && echo 1 || echo 0)"
    dpkg-deb -I "$DEB" postrm > "$SANDBOX/postrm" 2>/dev/null
    check "postinst и postrm в пакете — из debian/" \
      "$(cmp -s "$SANDBOX/postinst" "$SRC/debian/postinst" && cmp -s "$SANDBOX/postrm" "$SRC/debian/postrm" && echo 1 || echo 0)"
  fi
else
  echo "  (dpkg-deb недоступен, проверка пакета пропущена)"
fi

echo ""
echo "--- ИТОГО: $pass пройдено, $fail провалено ---"
echo ""
[ "$fail" = 0 ] || exit 1
