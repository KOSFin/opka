# Итерация 8 — ночной пилот критического пути CI

## План и разрешённый объём

Только worktree `ci-critical-path-pilot`, ветка `codex/ci-critical-path-pilot`, база `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`. Исследовать реальную историю PR/main/release, измерить DAG, сопоставить официальные подходы, реализовать лучший обратимый пилот и открыть draft PR. До двух нативных исполнителей одновременно; затем независимое ревью. Один тяжёлый check через admission helper, без SDK/полной локальной сборки. Не merge, release, services, protections, installed Orca, старый хост, корпоративные проекты или Codex install.

Цель: проверить достижимость 10× push→обязательный exact-head `pr.yml`/`verify` без переноса обязательной работы за merge и без потери платформ/provenance. Измеренное отделять от прогнозов. Существующая итерация 7 не меняется.

## Checkpoint и следующий шаг

Завершено исследование79runs/86attempts и пилот. Полный manual45075379341/attempt1/source6f4a8d2cacsuccess, все6lanes, verify15s, elapsed34:41, runner141.43min с diagnostic3.17. Исторический comparable app-input PR34:46/verify25s; это наблюдение, не controlled full A/B.10× и общая cost saving не доказаны. Diagnostics3OS2758/2760cases,171targeted tests passed; отдельный meaningful diff-quality45076783719passed6files/0findings. Source/scripts и workflow восстановлены byte-identical6f4a8d2cac, независимое review подтверждает. Draft PR25 открыт, current-head PR qualification отсутствует и merge запрещён до будущего non-draft exact-head run. Report, datasets, sources, event matrix, GitLab и CI-v2 оценка в reports/ci-critical-path-pilot/README.md.

Следующий шаг: review отрицательного10× результата и небольшого обратимого aggregate-пилота; затем отдельный согласованный shadow эксперимент на реальном малом PR, измеряющий indirect-input/native result reuse и first-failure порядок. Не запускать повторный полный CI лишь ради docs commits. Не merge/release/install services/protections.

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

### 2026-11-23 03:16:00 +05:00 — обнаружен пустой changed-code diff manual-run

Проверка fallback выявила: workflow_dispatch ставит scope.base=head, а quality script сравнивает с этим HEAD. Поэтому success full static доказывает types, но не новый changed-code diff. Добавлен одноразовый pilot_quality job на synchronize draft pilot после конкретного before=f85636800d: сравнивает с approved7d7a8ffa/реальным PR merge parent. Уже отправленные tests/types/full qualification не повторяются. Последующие report-only pushes не удовлетворяют one-shot before и тяжёлый job не повторяют. Это diagnostic job, не замена verify, на обычные PR/main/release не влияет.

### 2026-11-23 03:18:00 +05:00 — meaningful changed-code gate passed

PR run45076783719/source714525fa4b исполнил только одноразовый quality job137375678104, success; полный qualification не дублировался. Сохранены run/jobs/log receipt и точные findings. Временный pilot_quality удалён из итогового pr.yml, возвращая исходную regular draft admission; merge gate/код/обязательства не менялись. Исторические manual pr.yml diagnostics2runs отдельно стоят7.7167runner-min и не входят в PR/main/release cohorts. Full45075379341 ещё выполняется.

### 2026-11-23 03:19:00 +05:00 — исправление удаления временного job

Source equality check обнаружил ошибку моего substring-удаления temporary job: совпало имя dispatch input aggregate_probe раньше jobs, и YAML header был продублирован в68b326. До дальнейшей проверки файл восстановлен byte-for-byte из уже tested6f4a8d2cac, без изменений production логики. Этот промежуточный head не является валидным qualification. Далее проверяется ровное source equality; full original run не повторяется.

### 2026-11-23 03:21:00 +05:00 — уточнение queue/cost без повторных CI

В выборке одна отмена43095942157 до исполнения: её initial queue переведена из фиктивного0 вnull; natural runner-start queue n45. Cost percentiles теперь по всем attempts каждого run, не только final attempt; totals не менялись. Raw datasets сохранены; исполнялась только лёгкая агрегация JSON, тесты не дублировались.

### 2026-11-23 03:41:00 +05:00 — полный remote qualification завершён

Run45075379341/attempt1/source6f4a8d2cac success:37jobs/33executed/4expectedskips; все6selectedlanes. Verify137381531994success15s; source proof head6f4a8d2cac/tree3ffc6c07a56d3d30f47062130fad008abd9f0a6e/run/attempt/event проверены. Elapsed2081s=34:41, Android2020s=33:40; comparable historical app tree34:46/Android33:25/verify25s. Общий elapsed -5s, не controlled causal claim. Cost141.43runner-min, diagnostic3.17, без diagnostic138.27 vs historical131.80: общего cost saving/10× не доказано. Сохранены raw metadata/step timestamps/artifacts и exact qualification JSON, full watch завершился exit0. Следующий шаг — финальный docs checkpoint/PR description, без повторных tests и merge.

### 2026-11-23T03:44:59+05:00 — финальные данные и draft PR

PR25 описание переписано вокруг результата:10× и cost saving не доказаны, tiny aggregate25→15s, общий34:46→34:41 несинхронно. gh pr edit отказал из-за устаревшего Projects(classic) GraphQL; корректный body/title сохранён и применён через REST PATCH, draft=true. Сохранены exact proof/37job step timestamps/artifacts/cache excerpts, source equality и6OS diagnostics receipts,171tests иmeaningful6file quality. Неверный68b head дал parser failure45076968894/0jobs; исправлен, fullcheck не дублировался. Следующий шаг — review draft и отдельный real-small-PR shadow experiment, без merge/release/changes-to-protections.
