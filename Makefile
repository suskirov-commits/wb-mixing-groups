# wbmix — управление смесительными узлами на Wiren Board
#
#   make test        прогнать все автотесты
#   make build       пересобрать однофайловую версию dist/
#   make install     установить на этой машине (на контроллере)
#   make uninstall   удалить, конфигурацию оставить
#   make deb         собрать .deb для установки на парк контроллеров
#   make deploy HOST=192.168.1.50    залить и установить по ssh

PKG      := wb-mixing-groups
# Версия пакета из git.
#   тег v1.2.3            -> 1.2.3
#   3 коммита после тега  -> 1.2.3+3+gabc1234
#   тегов ещё нет         -> 0.0.0+gabc1234
# Версия в Debian обязана начинаться с цифры, поэтому голый хеш коммита
# (а без тегов git describe отдаёт именно его) не годится.
GITDESC  := $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//; s/-/+/g')
VERSION  := $(shell echo "$(GITDESC)" | grep -qE '^[0-9]' \
              && echo "$(GITDESC)" \
              || echo "0.0.0+$(if $(GITDESC),$(GITDESC),local)")
# Architecture: all — внутри только JavaScript и JSON, один и тот же
# пакет ставится и на WB6/7 (armhf), и на WB8 (arm64)
DEB      := $(PKG)_$(VERSION)_all.deb
BUILD    := build/deb
HOST     ?=
SSHOPTS  ?= -o StrictHostKeyChecking=accept-new

.PHONY: all test build install uninstall purge deb clean deploy help

all: test

help:
	@sed -n '3,10p' Makefile | sed 's/^# \{0,1\}//'

test:
	@node test/actuator.js
	@node test/faults.js
	@node test/bundle.js
	@node test/schema.js
	@bash test/install.sh

sim:
	@node test/sim.js

build:
	@node tools/make-bundle.js

install:
	@./install.sh

uninstall:
	@./install.sh --uninstall

purge:
	@./install.sh --purge

# ------------------------------------------------------------------ deb
#
# Пакет собирается без dh — дерево готовится вручную и упаковывается
# dpkg-deb. Для нашего случая этого достаточно: архитектурно-независимые
# файлы, один конфиг и один postinst.
#
# Ключевое — /etc/wb-mixing-groups.conf объявлен в conffiles. Это значит,
# что dpkg при обновлении НЕ затрёт изменённый на объекте конфиг: если
# файл менялся, он останется, а новый эталон ляжет рядом как .dpkg-dist.

deb: clean
	@mkdir -p $(BUILD)/DEBIAN
	@mkdir -p $(BUILD)/etc/wb-rules-modules
	@mkdir -p $(BUILD)/etc/wb-rules
	@mkdir -p $(BUILD)/usr/share/wb-mqtt-confed/schemas
	@mkdir -p $(BUILD)/usr/share/wbmix
	@install -m 0644 etc/wb-rules-modules/*.js $(BUILD)/etc/wb-rules-modules/
	@install -m 0644 etc/wb-rules/mixing-groups.js $(BUILD)/etc/wb-rules/
	@install -m 0644 etc/wb-mixing-groups.conf $(BUILD)/etc/
	@install -m 0644 usr/share/wb-mqtt-confed/schemas/*.json \
		$(BUILD)/usr/share/wb-mqtt-confed/schemas/
	@install -m 0644 README.md PROMPT.md $(BUILD)/usr/share/wbmix/
	@install -m 0644 etc/wb-mixing-groups.conf.example $(BUILD)/usr/share/wbmix/
	@echo "$(VERSION)" > $(BUILD)/usr/share/wbmix/VERSION
	@printf 'Package: %s\n' "$(PKG)"                        >  $(BUILD)/DEBIAN/control
	@printf 'Version: %s\n' "$(VERSION)"                    >> $(BUILD)/DEBIAN/control
	@printf 'Section: misc\n'                               >> $(BUILD)/DEBIAN/control
	@printf 'Priority: optional\n'                          >> $(BUILD)/DEBIAN/control
	@printf 'Architecture: all\n'                           >> $(BUILD)/DEBIAN/control
	@printf 'Depends: wb-rules (>= 2.0), wb-mqtt-confed\n'   >> $(BUILD)/DEBIAN/control
	@printf 'Maintainer: wbmix <noreply@example.com>\n'     >> $(BUILD)/DEBIAN/control
	@printf 'Description: Mixing group control for Wiren Board\n' >> $(BUILD)/DEBIAN/control
	@printf ' Supply temperature control after a three-way mixing valve.\n' >> $(BUILD)/DEBIAN/control
	@printf ' Supports three-point (floating) and 0-10V actuators.\n' >> $(BUILD)/DEBIAN/control
	@printf ' Settings page is provided via wb-mqtt-confed schema.\n' >> $(BUILD)/DEBIAN/control
	@printf '/etc/wb-mixing-groups.conf\n'                  >  $(BUILD)/DEBIAN/conffiles
	@printf '#!/bin/sh\nset -e\n'                           >  $(BUILD)/DEBIAN/postinst
	@printf 'if [ "$$1" = configure ]; then\n'              >> $(BUILD)/DEBIAN/postinst
	@printf '  deb-systemd-invoke restart wb-rules >/dev/null 2>&1 || \\\n' >> $(BUILD)/DEBIAN/postinst
	@printf '    systemctl restart wb-rules >/dev/null 2>&1 || true\n' >> $(BUILD)/DEBIAN/postinst
	@printf '  systemctl try-restart wb-mqtt-confed >/dev/null 2>&1 || true\n' >> $(BUILD)/DEBIAN/postinst
	@printf 'fi\nexit 0\n'                                  >> $(BUILD)/DEBIAN/postinst
	@printf '#!/bin/sh\nset -e\nexit 0\n'                   >  $(BUILD)/DEBIAN/postrm
	@chmod 0755 $(BUILD)/DEBIAN/postinst $(BUILD)/DEBIAN/postrm
	@dpkg-deb --root-owner-group --build $(BUILD) $(DEB) >/dev/null
	@echo "собран $(DEB)"
	@dpkg-deb -I $(DEB) | sed -n '2,12p'

clean:
	@rm -rf build/deb $(PKG)_*_all.deb

# ------------------------------------------------------------------ deploy

deploy:
	@test -n "$(HOST)" || { echo "укажите HOST=<ip контроллера>"; exit 1; }
	@echo "заливаю на $(HOST)..."
	@ssh $(SSHOPTS) root@$(HOST) 'mkdir -p /opt/wbmix'
	@tar czf - --exclude=node_modules --exclude=.git --exclude=build \
		--exclude='*.deb' . | ssh $(SSHOPTS) root@$(HOST) 'tar xzf - -C /opt/wbmix'
	@ssh $(SSHOPTS) root@$(HOST) '/opt/wbmix/install.sh'
