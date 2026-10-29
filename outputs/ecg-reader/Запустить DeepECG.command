#!/bin/zsh
set -eu
APP_DIR="${0:A:h}"
TASK_PYTHON="${APP_DIR}/../../work/deepecg-venv/bin/python"
if [[ ! -x "$TASK_PYTHON" ]]; then
  print 'Локальное окружение DeepECG не найдено. См. DeepECG-README-ru.md.'
  exit 1
fi
exec "$TASK_PYTHON" "$APP_DIR/deepecg_local_server.py" --open
