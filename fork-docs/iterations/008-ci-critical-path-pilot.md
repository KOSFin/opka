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
