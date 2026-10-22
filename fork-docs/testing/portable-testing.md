# Проверки форка

Нужны Node.js 24, pnpm из `packageManager` и зависимости из lockfile. Не используйте рабочий профиль Orca для тестов. Все Electron-проверки запускаются с `ORCA_BACKGROUND_LAUNCH=1`, без показа окон и перехвата фокуса.

```sh
pnpm install --frozen-lockfile
ORCA_BACKGROUND_LAUNCH=1 pnpm tc
ORCA_BACKGROUND_LAUNCH=1 pnpm run test:fork
ORCA_BACKGROUND_LAUNCH=1 pnpm run build:desktop:assets
```

CI: [PR Checks](https://github.com/KOSFin/opka/actions/workflows/pr.yml). Типы и changed-lines quality, регрессии задач/навигации/CLI/Source Control, desktop assets на Linux/macOS/Windows, Swift-компоненты и скрытые Electron journeys на macOS. Проверки не используют реальные модели, аккаунты, SSH-хосты или production-секреты. Это целевой набор регрессий форка, не весь upstream test suite и не обещание полной платформенной приёмки.

Проверки запускаются автоматически при изменении PR и push в main, либо вручную через Run workflow в Actions. Draft PR не запускает дорогие jobs; Ready for review запускает полный набор. Для merge все проверки и единственный `PR checks passed` из `pr.yml:verify` должны пройти на текущем head. Ссылка на старый green run не подтверждает новый commit. Artifacts находятся внизу страницы соответствующего завершённого run; срок хранения — 7 дней.

Артефакты `desktop-assets-*` содержат build outputs и commit provenance. Это не `.app`, DMG, APK или готовый установщик. Не копируйте их поверх рабочей Orca. Подпись, собственный update channel и установщики — следующий отдельный этап.

## Локальная учебная приёмка

`config/scripts/fork-acceptance.mjs` готовит synthetic workspace и отдельный профиль под `.tmp/fork-acceptance`. Для запуска нужен предварительно собранный тестовый пакет. Launcher `Open Fork Test.command` использует локальный проверочный Node, если он доступен, иначе Node из PATH. Этот запуск открывает окно только по явному действию пользователя.

Удалённая приёмка opt-in. Укажите собственный **изолированный** стенд через `ORCA_FORK_AUDIT_SSH_HOST`, `ORCA_FORK_AUDIT_SSH_USER`, `ORCA_FORK_AUDIT_IDENTITY_FILE` (абсолютный путь, не содержимое ключа), `ORCA_FORK_AUDIT_REMOTE_ROOT` (выделенный каталог fixture). Альтернатива — игнорируемый `.tmp/fork-acceptance/remote-config.json` с полями `host`, `username`, `identityFile`, `remoteRoot`, права `0600`. Env имеет приоритет. Не добавляйте этот файл в Git. Скрипт не должен угадывать сервер или ключ и не отключает проверку host key.

`fork-new-server-audit.spec.ts` дополнительно требует явных `ORCA_FORK_AUDIT_ELECTRON`, `ORCA_FORK_AUDIT_TEMPLATE`, `ORCA_FORK_AUDIT_REMOTE_REPO`; для nested-сценария — `ORCA_FORK_AUDIT_NESTED_ROOT`. Без параметров тест пропускается; публичный CI его не запускает.
