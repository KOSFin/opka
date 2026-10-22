# Файловые задачи, планы и runtime-журнал

Реализованы файловый формат, валидация, индекс, CLI/RPC и desktop UI поверх тех же документов. Одобрение ревизии плана, привязки к native Run/Task/Dispatch и журнал хранятся в существующей orchestration.db, в добавочных таблицах. Отдельной task-базы, фонового LLM scheduler или процесса на карточку нет. Полный статус приёмки находится в журнале итерации; наличие функции в исходниках не означает установку в рабочую Orca.

## Где это доступно

Код находится в форке, CLI проверяется сборкой build:cli. Рабочая установленная Orca и старый ai-agent не менялись; новый сервер обновляется только в выделенном учебном окружении. Для команд ниже требуется **изолированный runtime из этих же исходников**; в примерах ORCA означает CLI этого профиля, а не глобальную рабочую orca. Сам по себе новый CLI не добавляет методы старому серверу: он вернёт incompatible_runtime.

Desktop UI проверяется скрытым Electron с отдельными HOME/userData. Продуктовый пакет — обычное GUI-приложение со значком, не этот скрытый launcher. Не запускайте экспериментальный пакет в рабочем профиле: upstream identity/default profile ещё общие. Мобильный Tasks UI пока отдельный и файловый source туда не подключён; узкий desktop viewport не считается Android-приёмкой.

Локальный пакет: dist/mac-arm64/Orca.app; актуальная версия и результаты его проверки фиксируются в журнале. Он не установлен поверх рабочей Orca и не notarized. Новый сервер используется только отдельным изолированным учебным runtime для учебной приёмки. Запускать через [изолированный launcher](../testing/portable-testing.md), не напрямую. Полный текущий статус/оставшиеся пункты — в журнале, а не в номере версии пакета.

## Подключить проект

Выберите уже зарегистрированный в Orca workspace. Это может быть общая folder workspace с несколькими репозиториями, а не обязательно Git worktree. Не указывайте произвольный не зарегистрированный путь ради обхода scope.

```sh
ORCA project-task init --worktree id:<workspace-id> --json
```

Команда создаст .orca/project.yaml со стабильным project UUID, источник project в docs/work/tasks, два шаблона в .orca/templates и короткую инструкцию .orca/task-workflow.md. Уже существующая конфигурация/инструкция не перезаписывается. Init не создаёт worker, Git repo, отдельную БД или внешние карточки. Существующий AGENTS.md автоматически не меняется: добавьте ссылку на .orca/task-workflow.md осознанно.

По умолчанию repo alias root обозначает общую папку. Для backend/frontend и отдельных каталогов задач можно передать YAML через init --file project-input.yaml. Пример конфигурации (значение ID — пример; для нового проекта нужен собственный UUID):

```yaml
schema: 1
id: project-11111111-1111-4111-8111-111111111111
repos:
  root: .
  backend: backend
  frontend: frontend
sources:
  - id: common
    path: docs/work/tasks
  - id: frontend
    path: frontend/docs/tasks
```

Источники — существующие/создаваемые при init каталоги внутри owning workspace. После init конфигурацию можно редактировать явно; новые источники перед чтением должны существовать. Нельзя менять project ID для переключения аккаунта или добавлять один source внутрь другого. При ошибке конфигурации чтение/запись прекращаются, fallback к чужому каталогу нет.

## Создать и прочитать задачу

```sh
ORCA project-task create --worktree id:<workspace-id> --source project --slug pipeline --title "Restore pipeline" --detailed --json
ORCA project-task list --worktree id:<workspace-id> --limit 50 --offset 0 --json
ORCA project-task show --worktree id:<workspace-id> --id task-<uuid> --json
ORCA project-task context --worktree id:<workspace-id> --id task-<uuid>
```

Если конфигурация использует источник common, передайте --source common. В create можно вместо --title использовать --file task-input.md: так задаются kind, repos, parent и depends_on. Все ссылки должны уже существовать; сначала создаётся родитель/зависимость, затем дочерняя задача.

Создаётся один файл `<source>/<slug>/task.md`. Kind: implementation, investigation, review, integration, documentation или operations. Обязательны schema: 1, id: task-UUID, title, kind; parent по умолчанию null, depends_on и repos — пустые массивы. Пустой/неуказанный repos означает весь проект в пределах зарегистрированных aliases, а не весь хост; непустой массив сохраняет ограничение указанными репозиториями. Прочие frontmatter поля, включая status, отвергаются; произвольные Markdown-секции сохраняются без нормализации.

Шаблоны в .orca/templates доступны существующему Markdown editor. В сыром шаблоне task-<uuid> — явный placeholder, а не автоматически заполненный ID. Create --title генерирует валидный UUID; при ручном создании его нужно заменить. Обычный Markdown вне зарегистрированных roots не становится задачей.

## Безопасно изменить и передать работу

Show возвращает исходный content и SHA256 revision. Сохраните новый текст в отдельный файл, затем:

```sh
ORCA project-task update --worktree id:<workspace-id> --id task-<uuid> --revision <previous-sha256> --file revised-task.md --json
```

Конкурентные managed записи сериализуются общим project lock; устаревшая revision отклоняется. Запись атомарно заменяет файл с сохранением его permission bits, ID не меняется. Произвольные внешние редакторы не обязаны брать этот lock: гонку двух raw shell-writers программа предотвратить не может. После конфликта нужно перечитать документ, не делать force overwrite.

Перед остановкой темы владелец задачи записывает рядом checkpoint.md: текущий результат, проверенные SHA/команды, незавершённые действия и следующий шаг. Notes.md — смысловые решения; reports/ — отдельные отчёты исполнителей. Эти документы optional и автоматически не сочиняются/не перезаписываются. Общий plan.md можно вести ссылками на task IDs; его семантический parser в 3A не реализован.

В новом чате или аккаунте передайте task ID и выполните context. Сводка включает описание, границы/критерии из документа, зависимости, checkpoint и ссылки на notes/reports. До 8 000 символов, checkpoint — до 2 000; truncation обозначается явно. Полный документ доступен через show/исходный путь. Checkpoint всегда freshness: unverified — это авторская запись, не доказательство актуальности кода.

Execution остаётся unknown, approval — unverified. Восстанавливается контекст задачи, не transcript/авторизация старого аккаунта и не право повторно запускать старый процесс. Переноса файлов достаточно для чтения планов, но недостаточно для восстановления runtime authority.

## Ресурсы и ограничения

- Только зарегистрированные roots, task.md и metadata. Нет дискового semantic scan, embeddings, LLM polling или процесса на карточку.
- Индекс до 1 000 документов и 8 MiB UTF-8 текста, документ до 256 KiB, до 16 non-overlapping sources, глубина до 8, до 10 000 directory entries на source. Превышение — явная ошибка, не тихо урезанный список.
- Watch через существующий pool Orca; изменённый task.md перечитывается отдельно, overflow/rename-directory вызывает bounded rescan. Idle list не перепарсивает документы. Show/context дополнительно проверяют выбранный файл, не дожидаясь события.
- Кеш — до 16 project workspaces на runtime; подписанный источник не вытесняется другим окном. После ухода с последнего task view watch сохраняется на 30 секунд простоя; CLI-only источник использует тот же idle timeout. После разрыва watch индекс сверяет файлы, сохраняя разбор неизменившихся документов. Это ограничения индекса, не число агентов. Проверен synthetic benchmark 1 000 задач / 11 000 событий (10 000 явных + 1 000 index facts); цифры и границы измерения — в журнале.
- Duplicate ID, missing refs, parent/dependency cycle и unknown repo дают diagnostics в list. В первой версии любая такая ошибка блокирует show/context/update по всему project index; исходные файлы остаются доступны обычным editor. Автоматического выполнения нет.
- Все мутации проверяют owning host. Native filesystem на самом runtime поддержан, включая размещение runtime на сервере. Desktop не читает SSH-owned path локально: используйте подключение к execution-host runtime. Учебная remote приёмка, child checkout и reconnect проверены на новом audit server; это не проверка корпоративных данных или старого ai-agent.
- --file читает файл на машине CLI. Legacy bridged invocation с ORCA_CLI_CWD, отличным от реального cwd, явно отклоняется, чтобы не прочитать одноимённый файл на другой машине; выполните CLI на execution host. Передача такого input через старый SSH/WSL bridge пока не реализована.
- Cross-platform paths проверяются с учётом Windows reserved names. Реальный запуск Windows и Android в 3A не проверялся.

## Интерфейс и запуск

Tasks → Project tasks — основной экран, отделённый от External trackers и Working copies. Выберите All projects или проект с подписью хоста, а не Git-ветку. Каталог строится по зарегистрированным project homes на owning runtime: дочерний checkout без своей конфигурации использует известный общий project owner. Общий проект и repo-specific task sources читаются по .orca/project.yaml: программа не обходит все корпоративные Markdown. Общий обзор загружается по запросу порциями по 16 проектов, отдельный выбранный проект использует live watch. Недоступные/старые хосты показывают отдельную ошибку без local fallback; лимит каталога 256 homes обозначается явно.

Основной экран — Planned / In progress / Review / Done; list/tree, необязательные source/repo filters, архив и Needs my decision доступны в View & filters. Карточки без managed attempts можно перемещать вручную; Done требует evidence и не утверждает факт CI/deploy. Managed attempts используют прежний runtime lifecycle/review, без ручного обхода перетаскиванием. Одинаковые task IDs на разных хостах/проектах не смешиваются. При возврате bounded renderer snapshot виден сразу, затем данные сверяются с owning host; offline/error обозначаются явно. How tasks work · file locations показывает фактические источники. Working copies сохраняет прежнюю техническую доску checkouts: её main/primary не обозначает задачу или агента. Подробный сценарий: [работа от задачи](vibe-coding-workflow.md).

Карточка открывает закрываемую панель: Plan, Edit plan с полным Markdown и Activity. Несохранённые изменения защищены при закрытии. More actions содержит Rename, Copy resume context, Archive/Restore и Delete. Rename — тоже изменение плана. Конкурентное сохранение отклоняется, черновик остаётся. Delete удаляет только task.md после подтверждения, без notes/reports/чата/ветки/истории; активная или непроверенная попытка и входящие references блокируют его. Plan with agent переиспользует штатный launcher и готовит черновик контекста, не managed attempt; без известного UI workspace на owning host остаётся Copy resume context. Прямое удаление через shell этим API не контролируется.

Approve plan подтверждает точный SHA256. CLI не может одобрить или принять свою задачу через project API: нужен desktop/paired-device caller, установленный транспортом, и UI confirmation. Это не sandbox против пользователя или процесса с полным shell-доступом к той же БД.

Start managed worker в Activity использует **существующий** coordinator terminal и его текущий Run. Сначала создайте/восстановите Run штатной orchestration-командой в координаторе; не подставляйте handle завершённой сессии. Для новой рабочей копии укажите new-child и точный repo ID из Orca. Для существующей — явный worktree selector. Запуск ограничен репозиториями этой задачи и её owning host. Федерация отдельного worker на другой host не подменяется локальным процессом.

CLI для координатора:

```sh
ORCA project-task start --worktree <project-selector> --id <task-id> --revision <sha256> --file launch.json --json
ORCA project-task workflow --worktree <project-selector> --id <task-id> --json
ORCA project-task resume --worktree <project-selector> --id <task-id>
```

launch.json — объект с from (coordinator handle), worktree (placement), optional repo/agent/model/effort/setup/timeoutMs. Отдельного списка жёстко заданных моделей нет: blank model/effort использует настройки провайдера Orca, выбранные значения проверяет существующий worker-start. Подписки/ключи/аккаунты автоматически не копируются. План передаётся как immutable snapshot в native task spec; действует существующий worker prompt budget, а не только 256 KiB файлового формата. Большие исследования держите в notes/reports, а запускаемый план — коротким, со ссылками на owning-host project root.

Одна карточка не допускает двух active/unverified attempts. Это не глобальное ограничение одним агентом: разные задачи запускаются отдельно, действуют уже существующие worker/resource limits Orca. Вторая попытка после review требует Request changes с результатом ревью; после известной ошибки/остановки нужно явное повторное одобрение. Автоматического retry на потерю связи нет. Сбой между резервированием и materialized Dispatch оставляет непроверенную попытку: сначала разберите точный native task/Run, не делайте force retry.

Inspect worker показывает существующую host-owned projection: provider/model/host, durable state и отдельный verdict live/unverifiable/exited. Stop worker действует только на Dispatch этой задачи и использует штатное подтверждение остановки. Список попыток — не счётчик живых процессов. Native provider children остаются в существующем agent status/sidebar; новая task-панель пока не объединяет их в отдельный fleet graph.

Связанный native task нельзя повторно запустить прямой командой orchestration worker-start: native handler требует внутренний project admission, не принимаемый из RPC params. Обычные несвязанные Orca tasks сохраняют прежнее поведение. Это не sandbox от произвольного shell/SQL-доступа того же OS user и не запрет координатору писать код — строгие роли относятся к следующей итерации. Глобальные MCP/skills настройки самого Codex/Claude CLI этот этап не фильтрует: короткий task context сам по себе не выключает наследование инструментов.

В Plan относительные ссылки notes/reports открываются через files.open на owning runtime. Переход за project root и неподдерживаемые протоколы блокируются; локального fallback для remote файла нет. HTTP(S) использует существующую настройку открытия ссылок Orca. Изображения автоматически не загружаются. Edit plan содержит полный документ независимо от отображения в Plan.

## Приёмка и восстановление

Worker completion переводит карточку в review, **не done**. Request changes, Integration и Accept result — решения оператора с обязательным текстом результата/проверок/ссылок. Родитель нельзя принять раньше текущих дочерних результатов. CI/MR-ссылки и SHA записываются в план/отчёт; этот этап не проверяет их автоматически и не утверждает, что pipeline зелёный. Изменение approved plan делает прежнее одобрение неприменимым. Автономное независимое review/integration и строгие tool roles — итерация 4.

activity.md автоматически экспортируется из принятых DB facts: последние 200 событий, cursor в БД, атомарная замена файла. Повтор после сбоя не дописывает дубли; export error виден в детали и требует Retry export. Notes/checkpoint/reports автоматически не перезаписываются. Документ индексируется как факт обнаружения, не как утверждение пользователя. Журнал работает на execution host, без открытого task view.

context остаётся файловым консервативным packet (execution unknown, approval unverified). **resume** дополняет его host-owned approval, последними попытками/событиями и указанием recovery. Текст до 8 000 символов; подробный workflow/документ читается отдельно. Checkpoint — авторское утверждение freshness unverified, не доказательство актуального кода. Смена аккаунта не требует копировать старый transcript: передайте task ID/owner и прочитайте resume. Это восстанавливает план, не авторизацию и не старый процесс.

Для полного backup нужны проектные task/config/notes/reports файлы **и согласованный snapshot orchestration.db владельца runtime**. Нельзя копировать один открытый WAL DB-файл без SQLite backup/checkpoint. Проверен online SQLite backup и повторное открытие копии на synthetic fixture. Храните копию вне Git с ограниченными правами и шифрованием; runtime DB может содержать другие проекты/переписку. Файлы и БД не образуют общую атомарную транзакцию: снимайте копию при остановленных правках и сохраняйте совместную метку/manifest. Автоматического backup/restore UI пока нет.

Копия только Markdown переносима для чтения, но не доказывает прежние approval/liveness. Дублирование project UUID в другом canonical root тем же runtime отклоняется; автоматической relocation/migration authority пока нет. Восстановление БД не подтверждает существование старых PTY, authority сначала сверяется на owning host.

История и проверенные результаты: [журнал третьей итерации](../iterations/004-publication-and-ci.md).
