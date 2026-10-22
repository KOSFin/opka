# До рабочей beta: проверяемый сценарий и отдельная поставка

Дата: 2026-10-23. Это аудит исходников/локальной установки и предложение следующего этапа, не апрув публикации, установки или нового агентного конвейера.

Обновление после апрува: первые три исправления прошли hidden/normal local+SSH проверки navigation5; основной test bundle заменён после закрытия пользователем. A→B→A без лишних base/compare запросов: 94мс local, 102мс SSH. Empty floating action открывает существующую доску; private CLI не меняет глобальный PATH и не наследует чужой remote selection. Точные проверки/оставшиеся ограничения — в [журнале](../iterations/004-publication-and-ci.md). Ниже сохранён исходный аудит, а не описание текущих исходников.

Исходники опубликованы в [KOSFin/opka](https://github.com/KOSFin/opka) с upstream-историей. Настройка и реальные результаты CI ведутся в [итерации 4](../iterations/004-publication-and-ci.md). Upstream application identity/channel пока не менялись; установщиков собственного форка ещё нет. Ниже — исторический аудит до этих изменений, не текущий список незакрытых багов.

## Что действительно можно проверять сейчас

| Сценарий | Подтверждение | Граница |
| --- | --- | --- |
| Навигация, файловые карточки, план, floating board | Hidden GUI и normal package navigation4 от 2026-10-22 | Не полноценная ежедневная работа с моделями |
| Git: staging, commit, diff, история; сохранение presentation при switch | Local synthetic Git GUI от 2026-10-22 | Не доказательство отсутствия всех повторных RPC и промежуточных загрузок |
| Новый SSH host, чтение задач/репозиториев, reconnect | Normal acceptance/receipt от 2026-10-22 | Не новая проверка сервера сегодня; старый ai-agent не используется |
| Связанные попытки, journal/export, hooks | Предыдущие protocol-agent/domain/PTY проверки | Протокольный исполнитель не доказывает качество настоящего Codex/Claude |
| Карточка → план → выполнение → независимое ревью → результат | План card-to-result-workflow.md | Полностью не реализовано и не принято |
| Установка/обновление собственного форка, Android | Не принято | Нет опубликованного fork release/собственной update цепочки |

Сегодня проверены исходники, наличие packaged CLI и состояние системного CLI symlink; GUI/модели/SSH повторно не запускались. Не смешивать это с исторической приёмкой.

## Подтверждённые препятствия

### P1 — Source Control ещё делает mount-time чтения

- `RepositorySourceControl.tsx` создаёт keyed SourceControlPanel. View memory переживает remount, но не весь data pipeline.
- `use-base-ref-default.ts` начинает с null и каждый раз вызывает owner-routed `getRuntimeRepoBaseRefDefault`. Клиент в `runtime-repo-client.ts` выполняет IPC/RPC, без renderer snapshot этого результата.
- Base ref входит в ключ history snapshot. Переход от null к известному base может менять ключ и начинать дополнительные чтения. Это путь по коду; точный waterfall текущей пользовательской сессии ещё не измерен.
- `use-branch-compare.ts` заново создаёт локальные interval/in-flight refs. `installWindowVisibilityInterval` сразу вызывает visible-run; у нового экземпляра lastRunEndedAt=-Infinity, поэтому cached summary не исключает немедленное сравнение.
- Предыдущий патч решает сохранение UI и bounded history cache, но не даёт основания обещать «при переключении вообще ничего не подгружается».

Следующая правка: переиспользовать owner/repo-scoped default-base snapshot и freshness/in-flight механизмы полного Git pipeline. Оставлять предыдущие данные при revalidation. Force Refresh/мутация/HEAD/base/remote change должны обновлять данные. Не скрывать spinner ценой устаревшего состояния и не держать все панели/опросы смонтированными.

Приёмка: instrument IPC/RPC A→B→A на Mac и SSH, фиксировать методы/число запросов/длительности. При свежем неизменённом состоянии возвращение не делает полный холодный каскад и не меняет геометрию; изменённый Git обновляется. Проверять медленный ответ, отключение, deleted/recreated worktree и другой host с тем же path/ID.

### P2 — В пустой плавающей панели нет прямого действия карточек

На пользовательском скрине New Terminal/New Markdown/Open Markdown/New Browser/Minimize. Это соответствует `FloatingTerminalEmptyState.tsx`: действия карточек там нет. Переключатель Project tasks уже существует в header `FloatingTerminalPanelSurface.tsx`, но его недостаточно для понятного empty state.

Следующая правка: добавить видимую кнопку «Открыть задачи» в этот список через существующий setContent('tasks'), не создавать второе окно/вторую доску. Сохранить header switch, выбранный проект, draft и возврат в workspace. При отсутствии проектов показать понятное начало работы. Проверить клавиатуру, небольшой размер панели и обе темы.

### P1 — CLI status нельзя чинить глобальной перерегистрацией тестовой сборки

- Settings → Orca CLI проверяет shell command для внешних терминалов, не логин Codex/Claude. Внутренние терминалы используют штатный bundled launcher.
- В navigation4 есть исполняемый `Contents/Resources/bin/orca`; отсутствие bundled launcher не подтверждено.
- На Mac существует `/usr/local/bin/orca`: root-owned symlink, mode 0700. Readlink для текущего пользователя вернул EACCES. `cli-command-inspection.ts` явно обрабатывает этот случай как stale с предложением регистрации. Сам target не прочитан; не утверждать, к какой установке он ведёт.
- Codex и Claude находятся в PATH. Это не проверка их login, hooks, skills или доступности моделей в isolated HOME.

Следующий этап: отдельное имя команды форка (например, orca-fork), свой user-writable launcher и проверка команды из обычного/встроенного терминала. Существующий глобальный orca не chmod/replace автоматически. Точный набор предупреждений Settings нужно проверить в fork-профиле; credentials не переносить как побочный эффект исправления shell command.

### P1 — Поставка пока использует upstream identity/channel

В config/electron-builder.config.cjs: appId=com.stablyai.orca, productName=Orca, publish owner=stablyai/repo=orca (если нет dev override). Собственного push remote нет, upstream push URL отключён. Release macOS workflow привязан к github.repository == stablyai/orca и upstream runner. Простое копирование workflows не даёт собственный рабочий release pipeline.

До параллельной установки: свой app ID/userData/CLI/update feed, различимый app name и icon, безопасный выбор нового runtime target. Тестовый профиль/оригинал не должны смешиваться. Официальный updater не должен заменить форк upstream-сборкой. Нельзя выдавать подпись helper за подпись/notarization всего приложения.

## Порядок работ

1. **Закрыть UI-beta блокеры:** измеренный Git waterfall, отсутствие повторного холодного каскада, кнопка карточек, ясный CLI status. Без очередного общего редизайна.
2. **Закрепить собственную поставку:** отдельный GitHub repository и минимальная адаптация существующего CI. Сначала PR type/lint/unit, hidden Electron GUI и артефакты Mac arm64 + Linux x64 runtime; без доступа к production. Upstream cloud/deploy/publish workflows не включать автоматически. Сборки других платформ не объявлять проверенными.
3. **Отдельная beta-установка:** свой identity/profile/CLI, собственный manual beta channel. Проверить install → version A → update B → reconnect → сохранение данных/PTY → rollback. Смешанные client/runtime версии проверяются по capabilities; не обновлять любой ценой работающий daemon. Подпись/notarization — отдельный этап с секретами в GitHub Secrets, не в чате/репозитории.
4. **Полный сценарий одной карточки:** реализовать этапы A/B [card-to-result-workflow.md](card-to-result-workflow.md): planner → approved revision → host-owned coordinator/worker → checkpoint/report gate → независимый reviewer → исправление → результат. Технические Run/terminal handles убрать из обычного пользовательского пути. Автоматически не merge/deploy.
5. **Настоящая приёмка:** согласованный аккаунт/модель и тестовый проект. Сначала задача одного repo, затем backend+frontend с разными SHA, затем пять проектов. Проверить отказ ревью, изменение approved plan, закрытие UI, network loss/reconnect, restart VM, повторный клик, отсутствие отчёта, восстановление из нового чата. Отдельно проверить телефон; desktop-тест не заменяет Android journey.

UI-beta можно использовать раньше автоматического конвейера, но называть её «весь сценарий готов» нельзя. Для первого ежедневного использования достаточно узкой рабочей beta; для stable нужны принятые реальные сценарии и проверенный путь обновления/восстановления, не просто версия с другим суффиксом.

## Что нужно от пользователя

- URL отдельного GitHub-репозитория и разрешение публиковать туда код/CI. Это можно делать параллельно реализации workflow, не ждать косметических изменений.
- Позже — согласованные тестовый проект, provider/model и расход на настоящий agent journey. Не копировать рабочие аккаунты/секреты молча.
- Установку своего beta-приложения согласовать отдельно; текущую рабочую Orca и старый сервер сохранить.

## Узкий UI-аудит

Detector по EmptyState/PanelSurface/FolderProjectRepositories: 0 static findings. Это не проверка плавности, a11y, contrast или взаимодействий. Оценку /20 не выставляем: нового rendered/native/mobile аудита сегодня не было. Подтверждённые приоритеты — data lifecycle и доступность нужного действия; стили/примитивы существующего UI переиспользуются.

Для дальнейшего UI-прохода: /impeccable optimize (Git loading), /impeccable clarify (CLI status/empty state), /impeccable polish после функциональных проверок. Сегодня этот проход только диагностический, UI-код не изменён.
