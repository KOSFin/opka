# Проверки по затронутым компонентам

CI остаётся в `.github/workflows/pr.yml`. Этот workflow запускается для PR,
основной ветки и вручную. Уникальный aggregate `PR checks passed` остаётся
обязательной точкой допуска; отдельный Android workflow его не заменяет.

## Выбор проверок

Первый job `scope` записывает план и причины в `out/opka-ci/scope.json` и в
GitHub job summary. Изменения определяются по всему push либо по проверяемому
merge commit PR; удаления и обе стороны переименований учитываются.

| Изменение                                                        | Обязательные проверки                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Документация                                                     | Структура, ссылки и качество изменённого кода                              |
| Прямые `config/scripts/*.test.mjs`, `.github/scripts/*.test.mjs` | Типы и регрессии; смешанные изменения проверяются по всем затронутым путям |
| Renderer                                                         | Типы, зависимости unit-тестов, desktop assets, Electron journeys           |
| Mobile unit-тесты                                                | Типы и соответствующие регрессии                                           |
| Mobile runtime / native                                          | Типы, регрессии, настоящий Android acceptance                              |
| Host, CLI, preload, shared, workspace packages                   | Все платформенные проверки                                                 |
| Cloud                                                            | Типы и регрессии, включая push gateway contracts                           |
| Desktop journeys                                                 | Типы, регрессии и Electron; packaged journeys также установщики            |
| Build policy, зависимости, неизвестный путь                      | Полный набор                                                               |

Выбор платформ намеренно консервативный. Внутри regression runner отдельный
граф зависимостей выбирает root/mobile/render тесты, автоматически включая
изменённые тесты. Неизвестные зависимости расширяют набор, а не исключают его.
Ошибки определения базового commit или списка изменений включают полный CI.
Ручной запуск всегда полный.
`full` означает выбор всех компонентных lanes; он не отключает обнаружение
новых тестов. Если diff успешно получен (`comparison_valid`), regression
всегда вызывает `--changed BASE HEAD`: для global-policy изменений planner
использует утверждённый fork baseline плюс новые/изменённые тесты. При
недоступном diff и ручном запуске используется исходный полный fork runner.

Если Android acceptance выбран, PR installer workflow не собирает второй APK:
он проверяет Mac/server, а единственный native candidate строит Android lane.
Отдельный installer aggregate требует Mac/server success и разрешает пропуск
Android/сборки полного release asset set только при явном `build_android: false`.
Release оставляет `build_android: true`, собирает настоящий APK один раз и передаёт
его acceptance без повторной сборки.

## Отсутствие повтора после merge

Успешный aggregate сохраняет маленький artifact `opka-ci-proof-RUN-ATTEMPT`.
После merge job `scope` ищет успешный PR run именно workflow `pr.yml`. Повтор
пропускается только если:

- GitHub независимо подтверждает, что полное Git-дерево PR head равно текущему;
- receipt подтверждает то же проверенное дерево и принадлежит этому run/attempt;
- workflow завершён успешно, событие — PR, репозиторий совпадает;
- единственный aggregate завершён успешно с тем же run/head.

Полное дерево включает исходники, lockfiles, тесты и саму CI policy.
Не совпало дерево, отсутствует receipt, API недоступен или был прямой push —
выполняются проверки изменений. Receipt не превращает пропущенные jobs в
выполненные: summary явно пишет, какой успешный run использован.

## Правдивый aggregate

Aggregate проверяет результат `scope`, полный известный набор зависимостей и
результат каждой выбранной проверки. Требуемый job обязан быть `success`;
невыбранный — `skipped`. Failure, cancellation, потерянный job и необъяснимый
skip блокируют допуск. Изменяя состав jobs, нужно обновить этот контракт.

Успешный CI не означает публикацию. Release отдельно проверяет свою версию,
подпись, provenance и точные artifacts, которые будут доставлены пользователю.

## Проверки реализации

Модули `config/scripts/opka-ci-component-scope.mjs` и
`config/scripts/opka-ci-qualification-proof.mjs` покрываются одноимёнными
unit-тестами: docs/mobile/shared/unknown routing, ошибки и skips aggregate,
чужие workflow/run/attempt/head, несовпадающие деревья и повтор aggregate.
Это описание поведения исходников; прохождение нового workflow подтверждается
отдельным CI run для текущего commit.
