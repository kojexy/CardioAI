# CardioAI

Локальная исследовательская программа для просмотра цифровой ЭКГ и запуска трёх нейросетей.

| Модель | Выходы |
| --- | --- |
| DeepECG SL / EfficientNetV2 | 77 оценок |
| DeepECG SSL / WCR | 77 оценок |
| ECGFounder | 150 оценок |

Есть профили пациентов с историей ЭКГ, сравнение записей, веб-интерфейс, история локальных расчётов, выгрузка JSON, инженерные самотесты и экспериментальный декодер ECG301 / LE1203. Сервер слушает только `127.0.0.1`.

## Версии программы (2.0)

| Версия | Что работает | Где взять |
| --- | --- | --- |
| **Программа для Windows и macOS** | пациенты, история ЭКГ, сравнение, просмотр файла ECG301; нейросети — если на компьютере есть полная установка с моделями | GitHub → Actions → «Desktop app» → артефакты `CardioAI-Windows`, `CardioAI-macOS-*` (или релиз `v*`) |
| **Веб-версия (сайт)** | пациенты, история, сравнение, импорт результатов нейросетей; данные хранятся в этом браузере | папка `app/` на любом HTTPS-хостинге; workflow «Website» для GitHub Pages |
| **Android** | то же, что веб-версия, в виде приложения | GitHub → Actions → «Android app» → `CardioAI-Android.apk` |

Нейросети (около 3 ГБ, PyTorch) работают только на компьютере. На телефоне и в веб-версии результат расчёта можно прикрепить к ЭКГ файлом JSON.

Перенос данных между устройствами: «Данные» → «Скачать резервную копию» → «Загрузить копию» на другом устройстве.

## Пациенты и сравнение ЭКГ

- **Профиль пациента:** фамилия, имя, отчество, дата рождения, пол (для норм QTc), заметки. Все ЭКГ человека в одной истории.
- **Добавление ЭКГ:** файл прибора ECG301 (дата берётся из номера записи), ручной ввод с бумажной ЭКГ или файл записи CardioAI.
- **Автоматическое сравнение:** новая ЭКГ сравнивается с предыдущей и с исходной (можно отметить одну или несколько «исходных» ЭКГ, тогда берётся их среднее).
- **Сравнение любых двух ЭКГ** — из истории или двух файлов без сохранения.
- **Что сравнивается:** ЧСС, PR, QRS, QT, QTc (Фридеричиа — основной; Базетт прибора — справочно), оси P/QRS/T, угол QRS–T, RV5, SV1, Соколов–Лайон, нерегулярность RR; форма среднего комплекса в 12 отведениях (наложение, корреляция, ST и T); оценки нейросетей (изменение по вероятности и логиту, порог с гистерезисом, согласие двух моделей).
- **Динамика:** графики показателей с полосой нормы; предупреждение об устойчивом росте или снижении 3 раза подряд.
- Пороги и источники: [docs/research/serial-ecg-comparison.md](docs/research/serial-ecg-comparison.md), код правил — `app/js/rules.js`. Часть порогов взята из публикаций (ICH E14, AHA, KORA, Philips), часть — практический выбор; это помечено в программе.

Данные пациентов программы для компьютера: macOS `~/Library/Application Support/CardioAI`, Windows `%APPDATA%\CardioAI` (при запуске из исходников — `outputs/ecg-reader/local-runs/cardioai-store`). В Git они не попадают.

**Важно:** не храните установку моделей (`work/`) в папке, синхронизируемой с iCloud («Документы», «Рабочий стол»). macOS выгружает файлы в облако, и Python зависает при загрузке моделей.

### Сборка

```bash
npm test                                   # тесты сравнения (Node 22+)
python3 desktop/cardioai_desktop.py        # программа из исходников (нужен pip install pywebview)
pyinstaller desktop/cardioai.spec          # сборка программы (pip install -r desktop/requirements-desktop.txt)
npm ci && npx cap add android && npm run android:build   # APK (нужны Android SDK и JDK 21)
```

Программа ищет полную установку с моделями в `CARDIOAI_HOME`, в `settings.json` папки данных (`{"cardioai_home": "..."}`), в `~/CardioAI` и `~/Projects/CardioAI`.

## Установка и запуск

Проверено на macOS ARM64 с Python 3.12. Для установки нужен интернет, примерно 3 ГБ для весов и дополнительное место для Python. Команда `patch` должна быть доступна (на macOS входит в Command Line Tools). Windows пока не проверялся.

```bash
git clone https://github.com/kojexy/CardioAI.git
cd CardioAI
python3.12 -m venv work/deepecg-venv
work/deepecg-venv/bin/python -m pip install -r requirements.txt
work/deepecg-venv/bin/python scripts/setup_models.py
work/deepecg-venv/bin/python outputs/ecg-reader/deepecg_local_server.py --open
```

После установки можно запускать файл `outputs/ecg-reader/Запустить DeepECG.command` на Mac. Просмотр исходной записи также доступен через `outputs/ecg-reader/ECG301-reader.html`, без сервера.

Установщик скачивает закреплённые версии исходников и весов из официальных репозиториев. Проверяет SHA256 архивов, SHA256 и размер каждого веса. Повторный запуск использует уже проверенные файлы; каталог исходников с неизвестным происхождением не перезаписывается. Если загрузка прервалась, запуск нужно повторить (докачка не реализована).

Интернет нужен для установки. Во время локального анализа запись ЭКГ в облако не отправляется. Записи и история сохраняются в `outputs/ecg-reader/local-runs/`, эта папка исключена из Git.

## Входные данные и ограничения

Стандартный вход моделей: 12 отведений, подтверждённые время, амплитудная калибровка и одновременность регистрации, не менее 10 секунд. Подготовленный вход: `signal_mV_250Hz.npy` формы `(2500, 12)` и `provenance.json` с контрольной суммой и подтверждением параметров.

```bash
work/deepecg-venv/bin/python outputs/ecg-reader/deepecg_prepare.py --help
work/deepecg-venv/bin/python outputs/ecg-reader/deepecg_run_local.py --help
work/deepecg-venv/bin/python outputs/ecg-reader/ecgfounder_run_local.py --help
```

Декодер поддерживает только изученный вариант бинарного файла ECG301 размером 39 381 байт; другие форматы не заявлены. Короткая или неподтверждённая запись блокируется для стандартного анализа. Дополнение, повторение и растягивание короткой записи до 10 секунд не используются.

Выходы моделей — исследовательские числовые оценки, не диагноз и не индивидуальная вероятность заболевания. Медицинская валидация на ECG301 не проведена. Встроенный самотест использует синтетический сигнал и проверяет работу программы, а не диагностическую точность.

## Состав

- `outputs/ecg-reader/` — интерфейс, сервер, декодер, адаптеры и тесты.
- `scripts/setup_models.py` — установка моделей и стороннего кода.
- `model-assets/` — версии и контрольные суммы.
- `work/` — автоматически установленная среда, исходники и веса; исключены из Git.

Личные записи ЭКГ, фотографии распечаток, готовые медицинские отчёты и встроенная в исходную HTML-страницу запись не загружены в репозиторий. Модули просмотра прежних отчётов сохранены; без личных файлов соответствующие панели скрыты. Тесты, требующие личную запись, пропускаются с явным пояснением.

## Проверки

После установки моделей (отдельный процесс на модуль, чтобы освобождать память после тяжёлых моделей):

```bash
for test in outputs/ecg-reader/test_*.py; do
  work/deepecg-venv/bin/python "$test" || exit 1
done
```

Самотесты трёх моделей отдельно (отчёты сохраняются только локально):

```bash
work/deepecg-venv/bin/python outputs/ecg-reader/deepecg_run_local.py --model efficientnet --smoke-test --report work/sl-test.json
work/deepecg-venv/bin/python outputs/ecg-reader/deepecg_run_local.py --model wcr --smoke-test --report work/ssl-test.json
work/deepecg-venv/bin/python outputs/ecg-reader/ecgfounder_run_local.py --smoke-test --report work/founder-test.json
```

## Сторонние проекты

- [HeartWise-AI/DeepECG_Docker](https://github.com/HeartWise-AI/DeepECG_Docker), версия `cabf6c06b74731c86b8c5a27ae7101f14db5ec38`.
- [HeartWise-AI/fairseq-signals](https://github.com/HeartWise-AI/fairseq-signals), версия `bb3901447e2175ed5832b03170b89dbbdcf85062`; приложен патч совместимости с Python 3.12.
- [PKUDigitalHealth/ECGFounder](https://github.com/PKUDigitalHealth/ECGFounder), версия `04edac702b61c91face519774ddcc0cd712fef23`.
- Веса: [EfficientNetV2](https://huggingface.co/heartwise/EfficientNetV2_77_Classes), [WCR](https://huggingface.co/heartwise/WCR_77_Classes), [ECGFounder](https://huggingface.co/PKUDigitalHealth/ECGFounder).

Исходники, веса и данные сторонних проектов сохраняют собственные лицензии и условия использования. CardioAI не предоставляет дополнительную лицензию на них. Файлы лицензий сохраняются установщиком вместе с исходниками.
