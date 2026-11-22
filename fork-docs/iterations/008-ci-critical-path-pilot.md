# Итерация 8 — ночной пилот критического пути CI

## План и разрешённый объём

Только worktree `ci-critical-path-pilot`, ветка `codex/ci-critical-path-pilot`, база `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`. Исследовать реальную историю PR/main/release, измерить DAG, сопоставить официальные подходы, реализовать лучший обратимый пилот и открыть draft PR. До двух нативных исполнителей одновременно; затем независимое ревью. Один тяжёлый check через admission helper, без SDK/полной локальной сборки. Не merge, release, services, protections, installed Orca, старый хост, корпоративные проекты или Codex install.

Цель: проверить достижимость 10× push→обязательный exact-head `pr.yml`/`verify` без переноса обязательной работы за merge и без потери платформ/provenance. Измеренное отделять от прогнозов. Существующая итерация 7 не меняется.

## Checkpoint и следующий шаг

История и official-source review делегированы двум лёгким нативным сабагентам. Worktree чистый на заданной базе. Предварительные данные не подтверждают 10×: PR43628616296 занял34m46s, Android критический33m25s; scope28s/verify25s. Пилот: удалить package installation только из aggregate, переиспользуя существующий валидатор без изменения политики. Далее targeted CI, независимое ревью, отчёт.

## Журнал

### 2026-11-23T02:55:04+05:00 — старт и выбор пилота

Прочитаны AGENTS.md, README и активная итерация7. Два нативных сабагента: Actions history/DAG и официальные источники. Фактические gh/python descendants наследуют `/system.slice/opka-ci-audit.scope`: MemoryMax2684354560, SwapMax0, наблюдавшийся MemoryPeak100532224. Диск7.8GiB; установка зависимостей и SDK не выполнялась. Нет открытых PR или активных runs в первой выборке15. Первый полный PR:34m46s; верхняя граница удаления всего scope+verify1.026×. Выбран минимальный обратимый aggregate-пилот; новые skips/affected-эвристики не вводятся.

### 2026-11-23 03:01:00 +05:00 — уточнение PR-first, admission и независимое ревью

Владелец уточнил приоритет PR open/push/re-review→actionable failure/merge gate, matrix событий и отдельно GitLab. Делегировано дополнение реальной event matrix. Admission helper отказал запуску теста: менее8GiB свободного диска, unit не создан; ограничения не обходили и чужие данные не удаляли. Pure validator/policy механически выделены, aggregate больше не требует package installation. Независимое ревью нашло потерянный import isFollowupProof; исправлен до commit. Byte-equivalence validator/policy подтверждена source inspection; node --check и git diff --check прошли. Настоящие тесты локально не запускались. Подготовлен отдельный manual diagnostic в pr.yml, который выполняется ВМЕСТЕ с полным qualification, не заменяет verify и не создаёт proof для PR. Baseline pinned7d7a8ffa, одинаковые dependency inputs, cold no-node_modules и после install, исторический red/green gate replay; это не повтор самих исторических тестов. Далее один dispatch, draft PR и удалённые checks.

### 2026-11-23 03:05:00 +05:00 — публикация draft и первые исполненные результаты

Source commit6f4a8d2cacd12439e60077637b76c836bde5cc6a опубликован в разрешённую ветку. До dispatch проверено отсутствие эквивалентного active run. Единственный manual PR Checks45075379341 выполняет полный qualification и дополнительный aggregate probe на3OS. Draft PR25 открыт, его автоматический PR run содержит skipped jobs и НЕ является merge qualification. Все3 diagnostic jobs уже success; Ubuntu адресные5files выполнялись удалённо. Основные desktop/regression/Electron/installers/Android ещё выполняются. Владелец сообщил о штатной очистке до9GiB; df подтвердил9.0GiB. Нужные проверки уже отправлены в Actions, локально не дублировались. Новая нужная локальная проверка потребует свежего admission.

### 2026-11-23 03:08:00 +05:00 — исполняемая матрица и контрольный предел

Remote diagnostic Linux/macOS/Windows success:2758cases при asserted no-node_modules,2760same-input baseline/candidate cases после install,10routing parity inputs. Linux171tests/5filespassed2.79s. Baseline dependency composite9s/29s/24s соответственно; candidate CLI0s/0s/1s в REST разрешении. Не whole-job latency A/B и не ускорение evaluator; полный CI cold/warm не обещан. Static types/quality текущего full run success. Actual Node descendant подтвердил audit scope2.5GiB/Swap0, memory.peak210694144; это не admitted-heavy-tree proof. Повторное независимое source/report review не нашло blocker; добавлена явная fork-hosted limitation и условие будущего non-draft exact-head PR qualification.

### 2026-11-23 03:12:00 +05:00 — исправление определения first failure

При независимом пересчёте parent обнаружил: сводная first-error статистика брала только последний attempt и теряла первые отказы runs, позже исправленных retry. Исправлено на minimum по всем attempts исходного run, без изменений raw данных: natural cohort n34/p50 4:02/p95 38:41 вместо n31/3:58. Merge-green по-прежнему требует последний attempt. Отчёт и воспроизводимый analyzer исправлены; предыдущие журнальные цифры сохранены как история.

### 2026-11-23 03:13:00 +05:00 — source-level нижний предел Android

Исследован только текущий acceptance controller, без SDK/запуска:2APK×2scenario×60s +2×10s serial idle windows=260s, больше208.6s всего CI, нужных для10× представительного all-lane PR. Это конфигурационный вывод, не benchmark; уменьшать окна было бы потерей качества. APK cache не заменяет OS/native tests. Для карточек Android уже исключён, их isolated n0 не подменяем all-lane выводом.
