# Итерация 5: отдельная установка и обновления Opka

## Статус и следующий шаг

Пользователь выбрал beta: уведомление → скачать и проверить DMG → открыть установщик → вручную подтвердить замену Opka.app. Apple Developer/Developer ID отсутствует; штатный Squirrel auto-install не имитируем. Изменения опубликованы в PR #2, codex/installers-updates. Локальная регрессия, TypeScript, hidden Electron и полная native server qualification прошли. Linux archive собран и проверен по provenance/hash. DMG/ZIP созданы в CI, но проверка outer bundle signature нашла пропуск ad-hoc signing в PR; добавляется явный штатный ad-hoc режим. Installer/release/install/update пока не объявляются готовыми. Следующий шаг — успешный полный pr.yml:verify на новом head, проверка Mac payload, затем выпуск/изолированная установка. Не устанавливать незавершённый вариант поверх пользовательской среды.

## План и границы апрува

1. Переиспользовать существующие updater, release selection, packaging, orcad build/deploy и daemon-preservation механизмы. Проверить все пути к upstream и всё, что может пересечься с рабочей Orca.
2. Отдельная identity Opka: bundle ID, app name, protocol, defaults userData, команда CLI и server profile. Не мигрировать рабочие аккаунты/данные, не заменять глобальную команду orca. Не менять протокол RPC ради переименования.
3. Собственный release feed KOSFin/opka; исключить переход на upstream через fallback/dev channel. До подписанной macOS поставки — честный ручной installer flow, не скрытый небезопасный self-updater.
4. Создать собственный GitHub Actions packaging/release flow на базе существующих скриптов. Отдельные Mac arm64 DMG/ZIP и Linux x64 server package с provenance/checksums, согласованной версией и полноценным deploy template. Не называть JavaScript assets установщиками и не использовать upstream signing team/secrets.
5. Проверить unit/contract, types, quality, hidden Electron и real built payload. Провести изменения через PR; merge только после полного pr.yml:verify на точном head. Проверить реальные CI artifacts, затем собственный prerelease без production deploy hooks.
6. Установка/обновление A→B/rollback — только у Opka и на новом тестовом сервере, с проверкой профилей, restart/reconnect, фоновых PTY и mixed-version compatibility. Не останавливать чужие приложения/сервисы, не отключать Gatekeeper, не снимать quarantine автоматически. Безопасные native-focus проверки оставлять пользователю/изолированному CI display.
7. Документировать запуск, update, rollback, ограничения unsigned Mac beta и следующий шаг. Исходники, build, published release, install и update — отдельные результаты.

## Исключения

- Рабочая Orca на Mac и старый сервер неизменны. NetBird не устанавливаем.
- Apple Developer аккаунт, сертификат и notarization отсутствуют; не обещаем штатное unattended macOS auto-update.
- Не переносим секреты/аккаунты и не устанавливаем сторонние глобальные services как побочный эффект.
- Android, Windows installers, корпоративные проекты и полный автономный task→review workflow не входят в эту итерацию.

## Процесс работы

### 2026-10-24 11:48:00 +05:00 Аудит и уточнение unsigned Mac

- Рабочая копия clean, main b95bdb41af; создана отдельная ветка codex/installers-updates. Curated project memory отсутствует; private historical evidence не публикуется.
- В packaging найден upstream appId/productName/protocol/publish owner и signing team; в updater — отдельные hardcoded stable/fallback/atom URL. orcad defaults используют ~/.orca. Одной замены publish.repo недостаточно для изоляции.
- Прочитан macos-daemon-tcc-attribution.md: signed stable terminal host и launchd labels связаны с app identity. Сохранение терминалов, подпись helper и fallback должны учитывать отдельный форк, не подменять рабочую Orca.
- GitHub Releases/Actions поддерживают хранение и сборку артефактов. Electron/Squirrel требует подпись для штатного macOS auto-update. GitHub signing secrets отсутствуют; пользователь подтвердил отсутствие Apple Developer. Уточнён beta flow с явным ручным installer confirmation, без попытки обойти Gatekeeper.

### 2026-10-24 12:02:25 +05:00 Начальные правки identity и выбор updater

- В исходниках начато отделение Opka app ID/name/protocol, userData и private CLI, launchd label, локального compatibility contract и release feed от upstream. Убрана upstream signing team: signed release теперь требует явно заданную собственную OPKA_MAC_TEAM_ID. Это незавершённые правки в отдельной ветке, не установленная сборка.
- pnpm tc прошёл: четыре TypeScript проекта, включая renderer/main/CLI. Unit/quality/build/runtime/installer/update-проверки этой итерации пока не выполнены; существующие тестовые expectations для бренда и feed нужно адаптировать и дополнить isolation contract tests.
- Аудит выявил общие installation-home пути ~/.orca и agent-hook registration вне userData. Перед реальной установкой требуется отделить их и проверить, что глобальные настройки CLI и рабочей Orca не меняются. Проектные .orca/project.yaml и wire protocol намеренно не переименовывать.
- Ручная beta установка и собственный self-replacing updater — разные механизмы. После уточнения пользователя отправлен вопрос о выборе, UI и установка до ответа не выполняются. Для будущих узких подписей кнопок прочитан impeccable/clarify и STYLEGUIDE; UI не изменён.
- Новые releases, установщики, SSH подключения, services и изменения установленной Orca/старого сервера не выполнялись. Источники изменения, сборка и публикация остаются отдельными этапами.

### 2026-10-24 12:28:01 +05:00 Выбран ручной beta flow; код и квалификация артефактов

- Пользователь явно выбрал скачивание с подтверждением замены. Добавлен ограниченный по размеру/времени downloader собственных GitHub assets: SHA-256 до открытия, повторная проверка перед открытием, отказ на подмену/symlink, неоднозначные checksums и небезопасные redirects. Это проверка целостности через GitHub HTTPS, не замена Developer ID подписи. Mac beta не вызывает Squirrel download/staging/quitAndInstall и не отключает Gatekeeper.
- UI показывает отдельные действия Download installer/Open installer и поясняет ручную замену. Существующий дизайн сохранён, использован impeccable/clarify. Rendered UI ещё не проверен.
- 18 unit-тестов downloader/private CLI прошли. pnpm tc прошёл повторно после backend/UI/namespace изменений. Первая общая регрессия выявила оставшуюся ссылку devChannelRepo в packaging config; ссылка исправлена, расширенный прогон ещё не завершён.
- Installation-home hooks/credential пути отделены в ~/.opka, managed remote root — ~/.opka-remote, app/CLI defaults — собственные профили. Проектные .orca/project.yaml и протоколы остаются прежними. Автоматическая регистрация user-global hooks на старте отключена, чтобы не переписывать настройки CLI рабочей Orca. Собственные управляемые account/runtime homes продолжают устанавливать hooks; явная ручная настройка глобальных CLI — отдельное действие пользователя.
- Добавлены CI workflows на основе upstream native-slot qualification: полный server template, Mac arm64 DMG/ZIP, Linux x64 package с закреплённым Node, manifest/provenance/checksums и main-only draft-first publication. Упаковка включена в полный PR gate; workflows пока не выполнялись на GitHub. Native dependencies не подменяются upstream binary artifacts.
- Адреса/профили стенда, auth, аккаунты и корпоративные данные не публикуются. Установленные приложения и серверы в этой части работы не запускались/не изменялись.

### 2026-10-24 12:39:56 +05:00 Регрессия и проверки перед PR

- Расширенный pnpm test:fork прошёл: 177 suites passed, 2 skipped; 1842 tests passed, 15 skipped, дополнительно 3 Node fixture tests. Изменённый код прошёл quality gate без новых findings. Impeccable detector по четырём изменённым UI-компонентам вернул пустой список; это не заменяет rendered UI проверку.
- Интеграционные unit-тесты подтвердили: beta download/open не вызывает native Squirrel download/quitAndInstall и не завершает приложение; checksum failure допускает повторное скачивание, повторный in-flight клик не создаёт второй запрос.
- В дополнительной shell-проверке найден старый путь в test fixture; исправлен. Для переноса Codex hook command в ~/.opka его frozen form поднят до 2. Captured form-1 command/hash из реального Codex сохранён без изменений как compatibility fixture, а не переписан под новый путь.
- Проверены дополнительные ownership точки: notifications, computer-use helper, press-and-hold preferences и serve launchd labels переводятся на Opka ID; это исходники/сборочные outputs, не изменения работающей Orca.
- Следующий этап — PR и выполнение packaging workflows на GitHub. Не публиковать beta, не устанавливать runtime и не утверждать install/update parity, пока CI, реальные payloads и изолированные проверки не пройдены.

### 2026-10-24 13:48:10 +05:00 Первый CI, исправление упаковки и скрытый beta flow

- PR #2 опубликован с сохранённой upstream историей. Run 40075215632 прошёл types/quality, desktop assets macOS/Linux/Windows, hidden Electron и все native server lanes; aggregate закономерно failed: неверный фильтр несуществующего теста и чтение удалённой временной директории template builder при упаковке Linux. Mac packaging ещё не запускался из-за зависимости. Это не успешная доставка.
- Фильтры исправлены/дополнены реальными тестами. Linux package использует существующий полный build-orcad-node в отдельной временной директории; Node размещается рядом со slot по штатному packagedNodeRuntimePath, проверяется hash и smoke-load. Удаляется только созданная этим запуском временная директория.
- Найден и исправлен preload shutdown bug: Open installer раньше мог готовить renderer к выходу до main-handler. Manual flow теперь обходит restart preparation; 11 preload/recovery tests прошли, отдельный hidden Electron сценарий download→open прошёл и подтвердил, что все окна остаются скрытыми. IPC в GUI fixture подменён; это не проверка скачивания настоящего DMG. Downloader checksum/tamper проверки выполнены отдельно unit-тестами.
- Hidden screenshots просмотрены: downloaded card читаема; available screenshot попал в CSS entrance animation, для CI evidence capture добавлено отключение анимации. Из manual beta убрано непроверенное обещание сохранения terminal sessions во время замены unsigned app.
- Повторный pnpm test:fork и pnpm tc прошли, changed-code quality — 0 findings по 275 файлам. Дополнительный аудит обнаружил startup refresh глобального OpenCode plugin: refresh теперь ограничивается profile overlays, не переписывая plugin другой установки. Отдельная проверка этой правки выполняется перед push.
- Рабочая Orca, старый сервер, реальные аккаунты/секреты и сервисы не менялись. Установка на новый сервер ещё не выполнялась; следующий шаг — повторный CI на новом head, реальные release payloads и документированный install/update/rollback.

### 2026-10-24 13:58:00 +05:00 Проверка CLI и границы общей конфигурации агентов

- Последняя полная локальная регрессия: 185 suites passed, 2 skipped; 1967 tests passed, 15 skipped, плюс 3 fixture tests. Дополнительно прошли 9 OpenCode isolation tests, 9 launcher/release/CI contract tests и 40 Codex reconcile/startup/runtime-home tests. Итоговые pnpm tc и changed-code gate повторно прошли; последний gate — 0 findings по 281 файлу.
- В CI добавлен smoke-test CLI из настоящей упакованной Opka.app с disposable HOME/profile. Локальный launcher fixture проверяет symlink, путь с пробелами/кавычками, выбор Opka executable и очистку NODE_OPTIONS. macOS /var→/private/var нормализация учтена в fixture; это не исправление production path.
- Дополнительный аудит выявил отдельный Codex real-home reconciler вне общей startup hook policy. Desktop и orcad теперь явно запрещают ему записи в общий Codex home; тест фиксирует неизменность содержимого/mtime даже при запросе reconcile для launch. Автоматическая установка остальных user-global hooks при старте orcad также исключена. Managed account hooks и OpenCode profile overlays сохраняются; автоматическая настройка system-default CLI hooks не заявляется готовой beta-функцией.
- Новый сервер проверен только read-only: SSH alias сопоставлен с разрешённой пользователем новой машиной, подтверждены Linux x64 и свободное место. Никакие services/users/ports/packages на нём ещё не менялись. Старый ai-agent не запрашивался.
- Добавлено руководство install/update/rollback с явным различием desktop beta version и server content-hash, ручной замены приложения и изменения данных. Повторный CI требуется для нового source head; ранее начатые runs не подтверждают последующие правки.

### 2026-10-24 14:03:00 +05:00 Актуальная регрессия и server startup contract

- На 92002a89eb локально прошли 190 suites, 2012 tests (15 skipped), плюс 3 fixture tests. Changed-code quality — 0 findings по 285 файлам. GitHub types, regression, desktop assets и hidden Electron этого head прошли.
- Native server lanes run 40080111360 остановились на одном устаревшем ожидании orcad-push-startup.test.ts: оно требовало прежней автоматической установки user-global hooks. Тест заменён проверкой запрета этих записей, разрешённого hash observation и сохранённой подписки; suite 7/7 прошла локально. Добавлена в обычный fork gate, чтобы следующий такой drift обнаруживался раньше. Никакой required check не отключён и не обойдён; новый полный CI обязателен.
- Реальные Mac/Linux installer artifacts, published release, установка и A→B ещё ожидают квалификации. Новая серверная директория/пользователь пока отсутствуют; проверено read-only, сервисы не создавались. Следующий шаг — закончить полный packaging gate, не расширяя UI и не меняя рабочую среду.

### 2026-10-24 14:25:30 +05:00 Реальный Linux package и проверка подписи Mac bundle

- Run 40080434229 на ae5a7f9c94 прошёл types, regression, desktop assets, hidden GUI и всю native server matrix, включая Windows x64/arm64 и Intel Mac. Полный template со всеми 9 targets и Linux archive успешно собраны.
- Серверный CI artifact скачан локально: SHA-256 совпал с provenance, source commit совпал с квалифицировавшимся PR merge tree. Проверен inventory: pinned Node, orcad launcher, runtime markers, native PTY, CLI, LICENSE. Это проверка пакета, не установка. Кратковременный TLS timeout GitHub API прошёл при следующем запросе; не смешивать сетевую ошибку с build failure.
- Mac CI создал DMG/ZIP и подтвердил packaged daemon PTY, helper и все server template targets. Финальная codesign --verify --deep --strict отклонила outer bundle: electron-builder специально пропустил signing в PR, оставив устаревшую Electron signature после изменения ресурсов. Проверка не ослаблялась.
- Packaging теперь явно выбирает штатную identity '-' и разрешает только этот ad-hoc signing в PR. Keychain auto-discovery выключен, signing secrets не передаются, Developer ID/notarization по-прежнему отсутствуют. CLI parser локально подтвердил merge config и identity '-'; 8 release/CI contract tests прошли. Требуется повторный полный CI; публикация, установка и пользовательское подтверждение Mac ещё не выполнены.

### 2026-10-24 14:31:30 +05:00 Изолированный запуск Linux package на новом сервере

- Проверенный CI archive A установлен только в отдельный /srv/opka-beta для квалификации; создан приватный disposable HOME/profile, pairing выключен, bind только loopback, порт выбрал OS. Старые каталоги, сервисы и рабочие runtime не изменялись. systemd unit и глобальные CLI не устанавливались.
- Реальный старт подтвердил Linux x64, daemon state live, ownsFreshSessions=true и успешный self-test с coverage pty-spawn. Это реальная межпроцессная проверка PTY, не mock. Runtime завершился штатно, тестовые процессы — exited.
- Первый тестовый harness ошибочно требовал существования уже завершившегося пустого daemon при cleanup; /proc подтвердил ENOENT. Исправлен только приватный harness: подтверждённый exited допустим, чужие/непроверенные PID не завершаются. Повторный запуск и cleanup прошли. Долгоживущий пользовательский терминал этим тестом не проверялся.
- Health standalone запуска сообщил fallback buildVersion 0.0.0-orcad; проверяется отличие caller app version от package/content version перед финальной доставкой. Mac ad-hoc packaging повторяется в run 40081932474. PR пока не merged, release не опубликован, приложение на Mac не установлено.

### 2026-10-24 14:39:30 +05:00 Версии installer, CLI и runtime

- Реальный standalone запуск выявил отсутствие ORCA_VERSION в новом launcher: теперь он читает собственный .version, а не наследует caller/fallback. Shell test подтверждает переопределение чужого значения без запуска настоящего runtime.
- У upstream есть semver thresholds, включая SQLite profile floor 1.4.214. Для доставки сохраняем линию 1.4.x (первая release-кандидатная версия 1.4.236-rc.N), а не обнуляем продукт до 0.1.x. Release admission отклоняет версии ниже source compatibility version. Это не утверждение, что fresh 0.1.x profile уже потерял данные: риск найден по реальному compatibility contract до установки Mac.
- Финальный server-template job получает ту же OPKA_VERSION, что Mac; build-orcad штампует её в CLI package metadata до вычисления content hash. Standalone qualification проверяет совпадение metadata с release version. Собственный content-hash runtime остаётся отдельным идентификатором, не подменяется desktop semver.
- 17 version/release/CI/profile compatibility tests прошли. Следующий полный CI должен проверить этот новый head; старые успешно собранные server archives сохраняются только как изолированный baseline A, не публикуются как готовая beta.
