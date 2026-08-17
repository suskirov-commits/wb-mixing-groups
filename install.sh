#!/bin/sh
#
# install.sh — установка и обновление wbmix на контроллере Wiren Board.
#
#   Первая установка:
#     ssh root@<ip> 'apt-get update && apt-get install -y git \
#       && git clone <repo> /opt/wbmix && /opt/wbmix/install.sh'
#
#   Обновление (после установки достаточно одной команды):
#     ssh root@<ip> wbmix-update
#
#   Удаление:
#     ssh root@<ip> '/opt/wbmix/install.sh --uninstall'
#
# Скрипт идемпотентный: запускать можно сколько угодно раз.
# Конфигурация /etc/wb-mixing-groups.conf НИКОГДА не перезаписывается —
# при обновлении рядом кладётся .conf.new, если в поставке что-то изменилось.
#
# POSIX sh: на контроллере это dash, никаких bash-измов.

set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# WBMIX_ROOT позволяет установить в песочницу — используется автотестами
ROOT="${WBMIX_ROOT:-}"

MOD_DIR="$ROOT/etc/wb-rules-modules"
RULES_DIR="$ROOT/etc/wb-rules"
SCHEMA_DIR="$ROOT/usr/share/wb-mqtt-confed/schemas"
SHARE_DIR="$ROOT/usr/share/wbmix"
BIN_DIR="$ROOT/usr/local/bin"
CONF="$ROOT/etc/wb-mixing-groups.conf"
BACKUP_ROOT="$ROOT/var/backups/wbmix"

MODULES="wbmix-util.js wbmix-pid.js wbmix-actuator.js wbmix-group.js"
RULES="mixing-groups.js"
SCHEMA="wb-mixing-groups.schema.json"

RED=''
GRN=''
YEL=''
RST=''
if [ -t 1 ]; then
  RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m')
  YEL=$(printf '\033[33m')
  RST=$(printf '\033[0m')
fi

say() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$RST" "$*"; }
die() {
  printf '%s✗%s %s\n' "$RED" "$RST" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# systemctl трогаем только на реальном контроллере
real_system() { [ -z "$ROOT" ] && have systemctl; }

# ---------------------------------------------------------------- версия

version_string() {
  if [ -d "$SRC/.git" ] && have git; then
    (cd "$SRC" && git describe --tags --always --dirty 2>/dev/null ||
      git rev-parse --short HEAD 2>/dev/null) || echo unknown
  else
    echo "${WBMIX_VERSION:-local}"
  fi
}

# ---------------------------------------------------------------- проверки

check_source() {
  for f in $MODULES; do
    [ -f "$SRC/etc/wb-rules-modules/$f" ] || die "нет файла etc/wb-rules-modules/$f"
  done
  [ -f "$SRC/etc/wb-rules/$RULES" ] || die "нет файла etc/wb-rules/$RULES"
  [ -f "$SRC/usr/share/wb-mqtt-confed/schemas/$SCHEMA" ] || die "нет схемы $SCHEMA"
  [ -f "$SRC/etc/wb-mixing-groups.conf" ] || die "нет эталонной конфигурации"
}

# Проверка JSON до того, как что-либо трогать: битый конфиг или схема
# уронят wb-rules или страницу настроек.
check_json() {
  have python3 || return 0
  python3 - "$1" <<'PY' || die "битый JSON: $1"
import json, sys
json.load(open(sys.argv[1], encoding='utf-8'))
PY
}

check_env() {
  if [ -n "$ROOT" ]; then
    return 0
  fi
  if [ ! -d /etc/wb-rules ]; then
    warn "каталог /etc/wb-rules не найден — это точно контроллер Wiren Board?"
    warn "продолжаю, каталоги будут созданы"
  fi
  if ! have systemctl; then
    warn "нет systemctl — сервис wb-rules придётся перезапустить вручную"
  fi
}

# ---------------------------------------------------------------- бэкап

BACKUP_DIR=""
PREV_DIST=""

# Эталонный конфиг предыдущей установки нужно сохранить ДО того, как
# install_files положит новый: иначе сравнивать «изменилась ли поставка»
# будет не с чем, и .conf.new никогда не появится.
save_prev_dist() {
  if [ -f "$SHARE_DIR/wb-mixing-groups.conf.dist" ]; then
    PREV_DIST=$(mktemp)
    cp "$SHARE_DIR/wb-mixing-groups.conf.dist" "$PREV_DIST"
  fi
}

cleanup_tmp() {
  [ -n "$PREV_DIST" ] && rm -f "$PREV_DIST" || true
}
trap cleanup_tmp EXIT

make_backup() {
  mkdir -p "$BACKUP_ROOT"
  # mktemp, а не просто метка времени: два запуска подряд в одну секунду
  # затирали бы бэкап друг друга, и откатываться было бы некуда
  BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-XXXX")
  for f in $MODULES; do
    [ -f "$MOD_DIR/$f" ] && cp -p "$MOD_DIR/$f" "$BACKUP_DIR/" || true
  done
  [ -f "$RULES_DIR/$RULES" ] && cp -p "$RULES_DIR/$RULES" "$BACKUP_DIR/" || true
  [ -f "$SCHEMA_DIR/$SCHEMA" ] && cp -p "$SCHEMA_DIR/$SCHEMA" "$BACKUP_DIR/" || true
  [ -f "$CONF" ] && cp -p "$CONF" "$BACKUP_DIR/" || true
  # Держим последние 10 бэкапов, остальное чистим
  ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | head -n -10 | while read -r old; do
    rm -rf "$old"
  done
  ok "бэкап: $BACKUP_DIR"
}

restore_backup() {
  [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || return 0
  warn "откатываю на предыдущую версию"
  for f in $MODULES; do
    [ -f "$BACKUP_DIR/$f" ] && cp -p "$BACKUP_DIR/$f" "$MOD_DIR/" || true
  done
  [ -f "$BACKUP_DIR/$RULES" ] && cp -p "$BACKUP_DIR/$RULES" "$RULES_DIR/" || true
  [ -f "$BACKUP_DIR/$SCHEMA" ] && cp -p "$BACKUP_DIR/$SCHEMA" "$SCHEMA_DIR/" || true
  real_system && systemctl restart wb-rules || true
}

# ---------------------------------------------------------------- установка

install_files() {
  mkdir -p "$MOD_DIR" "$RULES_DIR" "$SCHEMA_DIR" "$SHARE_DIR" "$BIN_DIR"

  for f in $MODULES; do
    install -m 0644 "$SRC/etc/wb-rules-modules/$f" "$MOD_DIR/$f"
  done
  ok "модули -> ${MOD_DIR#$ROOT}/"

  install -m 0644 "$SRC/etc/wb-rules/$RULES" "$RULES_DIR/$RULES"
  ok "сценарий -> ${RULES_DIR#$ROOT}/$RULES"

  check_json "$SRC/usr/share/wb-mqtt-confed/schemas/$SCHEMA"
  install -m 0644 "$SRC/usr/share/wb-mqtt-confed/schemas/$SCHEMA" "$SCHEMA_DIR/$SCHEMA"
  ok "схема настроек -> ${SCHEMA_DIR#$ROOT}/$SCHEMA"

  # Эталонный конфиг всегда кладём рядом — по нему видно, что появилось нового
  install -m 0644 "$SRC/etc/wb-mixing-groups.conf" "$SHARE_DIR/wb-mixing-groups.conf.dist"
  [ -f "$SRC/etc/wb-mixing-groups.conf.example" ] &&
    install -m 0644 "$SRC/etc/wb-mixing-groups.conf.example" "$SHARE_DIR/" || true
  [ -f "$SRC/README.md" ] && install -m 0644 "$SRC/README.md" "$SHARE_DIR/" || true
}

install_config() {
  if [ ! -f "$CONF" ]; then
    install -m 0644 "$SRC/etc/wb-mixing-groups.conf" "$CONF"
    ok "конфигурация -> ${CONF#$ROOT} (создана из примера, топики поменяйте под объект)"
    NEW_CONFIG=1
    return 0
  fi

  NEW_CONFIG=0
  check_json "$CONF"

  if cmp -s "$SRC/etc/wb-mixing-groups.conf" "$CONF"; then
    ok "конфигурация не изменилась"
    return 0
  fi

  # Конфиг объекта не трогаем никогда. Кладём рядом .conf.new, только если
  # эталон в поставке отличается от того, что было в прошлой поставке —
  # иначе .conf.new появлялся бы после каждого обновления впустую.
  if [ -n "$PREV_DIST" ] && cmp -s "$SRC/etc/wb-mixing-groups.conf" "$PREV_DIST"; then
    ok "конфигурация объекта сохранена без изменений"
  else
    cp "$SRC/etc/wb-mixing-groups.conf" "$CONF.new"
    warn "конфигурация объекта сохранена; новый эталон положен в ${CONF#$ROOT}.new"
    warn "сравнить: diff ${CONF#$ROOT} ${CONF#$ROOT}.new"
  fi
}

install_updater() {
  # Обновлялка имеет смысл только для git-копии
  [ -d "$SRC/.git" ] || return 0
  cat >"$BIN_DIR/wbmix-update" <<EOF
#!/bin/sh
# Обновление wbmix из git. Создано install.sh, правки будут перезаписаны.
set -eu
cd "$SRC"
echo "wbmix: тяну изменения из git..."
git pull --ff-only
exec "$SRC/install.sh"
EOF
  chmod 0755 "$BIN_DIR/wbmix-update"
  ok "обновлялка -> ${BIN_DIR#$ROOT}/wbmix-update"
}

restart_services() {
  real_system || {
    warn "перезапустите wb-rules вручную: service wb-rules restart"
    return 0
  }

  # Конфиг проверяем ДО перезапуска: с битым JSON сценарий не поднимется
  check_json "$CONF"

  systemctl restart wb-rules || die "не удалось перезапустить wb-rules"
  sleep 2

  if ! systemctl is-active --quiet wb-rules; then
    printf '%s\n' "--- журнал wb-rules ---" >&2
    journalctl -u wb-rules -n 30 --no-pager >&2 || true
    restore_backup
    die "wb-rules не поднялся, выполнен откат"
  fi
  ok "wb-rules перезапущен"

  # confed перечитывает схемы сам; try-restart ничего не делает,
  # если сервис не запущен
  systemctl try-restart wb-mqtt-confed >/dev/null 2>&1 || true
}

check_running() {
  real_system || return 0
  have mosquitto_sub || return 0
  say ""
  say "Созданные виртуальные устройства:"
  timeout 5 mosquitto_sub -t '/devices/+/meta/name' -v 2>/dev/null |
    grep -i 'mix' | sed 's|/devices/||; s|/meta/name||; s|^|  |' || say "  (пока не видно, дайте 10-20 секунд)"
}

do_install() {
  ver=$(version_string)
  say "wbmix $ver — установка"
  say ""
  check_source
  check_env
  save_prev_dist
  make_backup
  install_files
  install_config
  install_updater
  printf '%s\n' "$ver" >"$SHARE_DIR/VERSION"
  restart_services
  say ""
  ok "готово, версия $ver"
  if [ "${NEW_CONFIG:-0}" = 1 ]; then
    say ""
    say "${YEL}Дальше:${RST} веб-интерфейс -> Настройки -> «Смесительные узлы (отопление)»"
    say "Выберите топики датчиков и реле из выпадающих списков и сохраните."
  fi
  [ -f "$BIN_DIR/wbmix-update" ] && say "Обновление в дальнейшем: ${YEL}wbmix-update${RST}" || true
  check_running
}

do_uninstall() {
  purge=${1:-no}
  say "wbmix — удаление"
  for f in $MODULES; do rm -f "$MOD_DIR/$f"; done
  rm -f "$RULES_DIR/$RULES"
  rm -f "$SCHEMA_DIR/$SCHEMA"
  rm -f "$BIN_DIR/wbmix-update"
  rm -rf "$SHARE_DIR"
  ok "файлы удалены"
  if [ "$purge" = purge ]; then
    rm -f "$CONF" "$CONF.new"
    ok "конфигурация удалена"
  else
    say "конфигурация ${CONF#$ROOT} оставлена (--purge чтобы удалить)"
  fi
  real_system && systemctl restart wb-rules || true
  ok "готово"
}

case "${1:-install}" in
install) do_install ;;
--uninstall | uninstall) do_uninstall "${2:-no}" ;;
--purge | purge) do_uninstall purge ;;
--version) version_string ;;
--help | -h)
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  ;;
*) die "неизвестная команда: $1 (см. --help)" ;;
esac
