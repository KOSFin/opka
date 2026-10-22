# Итерация 4: публикация исходников и CI

## Статус и следующий шаг

Исходники опубликованы в публичный KOSFin/opka: remote main 28374500e55f827c51f27f286c502c116bc66534 проверен, GitHub подтверждает 15 393 commits и MIT. Полная upstream-история и лицензия сохранены. [PR #1](https://github.com/KOSFin/opka/pull/1) содержит собственный CI. [Второй run](https://github.com/KOSFin/opka/actions/runs/39867244884) полностью green для head 9d05229618b2d76c02c6b46d43599e444d768e6d, включая GUI и aggregate. Финальная сверка расширила regression selection до всех 62 изменённых unit-файлов; следующий шаг — полный CI нового head и только после green aggregate merge. Локальные типы, quality, desktop assets, Swift и 5 hidden journeys прошли. Рабочую Orca, старый сервер, аккаунты, секреты и установленные сервисы не меняем.

## План и границы

1. Проверить исходники и публикационный состав. Не отправлять локальные профили, скриншоты, ключи, логи или частные журналы стенда. Сохранить их локально, не переписывая историю журналов.
2. Восстановить предков upstream v1.4.235. Сохранить исходные commits, лицензию и attribution; добавить изменения форка обычным commit, не squash/reinitialize. Опубликовать main без force push и без upstream release tags.
3. Сохранить upstream workflows как неактивный архив. Не запускать их облачные деплои, секреты, специальные runner fleets и release channels.
4. Создать собственный CI на GitHub-hosted runners: типизация/changed quality, регрессионные тесты форка, сборки desktop assets на поддерживаемых ОС, hidden Electron journeys и компиляция Swift-компонентов на macOS. Существующие скрипты и контракт PR checks passed / pr.yml:verify переиспользовать. Установщики не выпускать до разделения application identity и update channel.
5. Проверить workflow-контракты тестами, выполнить применимые проверки локально. Провести CI-изменения через PR, проверить workflow identity и точный head commit. Ошибки исправлять; не выдавать пропущенные проверки за успешные.
6. Проверить remote refs, CI run и скачиваемые артефакты. Обновить документацию и checkpoint. Не включать автопубликацию релизов, notarization, production update channel или автоустановку по одному факту настройки CI.

## Критерии приёмки

- Предок v1.4.235 доступен в опубликованной истории; SHA опубликованного head совпадает с проверенным.
- Секреты, локальные пути к ключам, настройки аккаунтов и личные evidence не входят в новый commit.
- CI реально выполнен в KOSFin/opka, а не только валидирован как YAML. Обязательный aggregate не скрывает failure/cancelled/skipped required jobs.
- Build artifacts привязаны к commit; unsigned диагностическая сборка не называется stable и не заменяет рабочую установку.
- Старый сервер/рабочая Orca не затронуты.

## Процесс работы

### 2026-10-23 03:18:00 +05:00 Начало публикации

- Пользователь подтвердил исправления и дал апрув исходникам/CI. KOSFin/opka проверен через GitHub API: публичный, пустой, текущая учётная запись имеет ADMIN. Записей в репозиторий пока не делали.
- Локальная база shallow, HEAD — upstream release v1.4.235, изменения предыдущих итераций не закоммичены. Запущен fetch предков именно этого тега, без получения всех refs/tags. Upstream push остаётся отключён.
- Обнаружены многочисленные upstream workflows для частной инфраструктуры. Сохраняем их неактивно; свой CI не будет требовать их secrets или запускать их deploy jobs.
- Private evidence и старые журналы с инфраструктурными деталями исключены из публикации через gitignore, сохранены локально. Историю журналов не редактируем. Новый журнал не содержит адресов стенда или ключей. Параметры remote acceptance будут вынесены в локальную непубликуемую настройку и явные env overrides.

### 2026-10-23 03:29:00 +05:00 Подготовка CI и проверка публикационного состава

- Fetch завершён: checkout больше не shallow, у базового HEAD 15 392 commits в истории. Лицензия и upstream commit остаются неизменными; force push и reinitialize не используются.
- Все 97 upstream workflows перенесены в неактивный архив. Собственный CI не выполняет deployment/release, не запрашивает secrets и использует read-only token.
- Публикационный состав: 266 новых/изменённых файлов проверены на private-key/распространённые credential-паттерны и частные пути стенда; совпадений нет. Это ограниченная проверка изменений, не обещание forensic-аудита всей upstream истории.
- Полная типизация четырёх проектов прошла. Расширенные регрессии выявили хрупкость старого CLI packaging fixture: избыточный glob превышал лимит minimatch, а macOS launcher канонизирует /var. Исправлена тестовая инфраструктура; повторный прогон продолжается.
- План уточнён: CI выпускает desktop assets с provenance на трёх ОС, проверяет Swift и скрытые Electron journeys, но не установщики с upstream bundle identity. Публичные инструкции и remote acceptance теперь переносимы; частные настройки сохранены только в игнорируемом файле с правами 0600.

### 2026-10-23 03:31:00 +05:00 Локальные проверки и первый source commit

- Commit 28374500e5 сохраняет все исходные commits, изменения завершённых итераций, переносимые руководства и inactive workflow archive. Upstream push отключён; origin указывает только на KOSFin/opka. Начата обычная отправка main без tags/force.
- Локально прошли четыре проекта типизации, changed-code quality по всем изменениям от v1.4.235, README link check и контракт единственного PR aggregate. Расширенный набор: 856 passed, 12 skipped в 109 suites (две platform-only suites skipped), плюс 3 Node fixture/config tests. Реальные модели/SSH и рабочие профили не использовались. Ограничение двух test workers устранило конкуренцию временных CLI subprocess checks; проверки не исключались.
- CI вынесен в отдельную ветку codex/ci-builds-tests для обязательной реальной PR-проверки. Публикация исходников не считается подтверждением зелёного CI или готового установщика.

### 2026-10-23 03:34:00 +05:00 Проверка собираемых assets и скрытых journeys

- Полная локальная build:desktop:assets прошла: desktop renderer/main, CLI, WSL relay, web projection, mobile-web bundle; CLI runtime verification — 826 closure files и 5 команд. Ничего не установлено поверх рабочей Orca.
- На CI-ветке прошли все 5 выбранных hidden Electron journeys: пять независимых synthetic PTY workers, nested import/collapse/restart, Source Control navigation, два проекта с одинаковыми task names, полный ручной kanban flow. Git warm-switch — 105 мс и 0 дополнительных base/compare reads. Это protocol fixtures, не доказательство автономной работы настоящей модели.
- Исполнялся background-only Electron из локального тестового каталога, без показа окон. $electron отсутствует в доступном каталоге skills; использованы существующие Playwright/CDP тесты проекта. Production profile и удалённый сервер не использовались.

### 2026-10-23 03:39:00 +05:00 Публикация подтверждена, PR CI выполняется

- GitHub remote main совпал с 28374500e55f827c51f27f286c502c116bc66534; исходный v1.4.235 — его предок, blob LICENSE идентичен upstream. Полная история отправлена обычным push, tags и чужие release workflows не активировались.
- Открыт и прикреплён PR #1, head d7a15cf81f78ce168789d947015fef2cd427d034. GitHub подтвердил реальный pull_request run 39866280495 из .github/workflows/pr.yml; все шесть execution jobs стартовали. Green status/артефакты пока не объявляются.
- Все три локальные Swift-компонента собраны из исходников (computer-use universal, keyboard layout, notification status); Apple toolchain и установленные приложения не менялись.

### 2026-10-23 03:45:00 +05:00 Первый CI выявил хрупкий drag test

- Run 39866280495: типы/quality, regression, desktop assets Linux/macOS/Windows — success. Swift compile — success. Hidden journeys — 4 passed, 1 failed: при втором drag в Done не открылся Complete task dialog. Aggregate тоже failure; PR не слит, failure не обходится.
- На узком CI desktop колонка Done прокручивается автоматически уже после mouse-down. Существующий upstream github-project-board.spec.ts документирует ту же особенность Playwright. Тест теперь заранее прокручивает target, ожидает закрытие Cancel dialog и всегда использует viewport 1000×760. Assertions, реальный drag и flow завершения сохранены; production UI не менялся. В synthetic-only тест включены failure trace/screenshot для следующей диагностики.
- Три повторения узкого kanban сценария локально прошли. Это ещё не green GitHub CI; новый полный прогон обязателен.
- Все три build artifacts первого PR доступны. Linux archive реально скачан: 5 396 файлов, CLI/main/renderer присутствуют, source-commit.txt = 88dddcdd9c579c842ad98dd02969854897f5758a. GitHub подтвердил его родителей: опубликованный main и точный PR head d7a15cf81f78ce168789d947015fef2cd427d034. Это CI merge-ref, не installer и не установленная версия.

### 2026-10-23 03:54:00 +05:00 Полный green и сверка покрытия перед merge

- Run 39867244884 полностью success: все шесть execution jobs и PR checks passed. Head 9d05229618b2d76c02c6b46d43599e444d768e6d; узкий kanban исправил CI drag, остальные проверки не отключались.
- Обнаружен ошибочный filter floating-pane вместо floating-terminal и несколько изменённых unit tests вне selection. Добавлены все недостающие сценарии; сверка diff от v1.4.235 показывает 62 изменённых unit files, missing = 0 (два Node test файла запускаются отдельно). Новый контракт отклоняет фильтры, не соответствующие ни одному test file.
- Локальная промежуточная попытка выделения импортируемого manifest завершилась без Vitest summary из-за пропущенного argv-параметра isDirectInvocation. Это не засчитано за тестирование; вызов исправлен и защищён контрактом. Расширенный прогон действительно выполнился. Единственный сбой suite был ссылкой на перемещённый upstream e2e.yml; исторический контракт теперь читает inactive archive, а активный CLI build проверяется новым fork CI contract.
- Расширенные регрессии и changed quality прошли. Изменения selection требуют нового полного GitHub run; прежний green не разрешает merge нового head.
