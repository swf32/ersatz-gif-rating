# Ersatz GIF Rating

Локальный рендер рейтинга в видео без звука: `JSON -> HTML/CSS/JS -> Playwright frame export -> mp4`.

## Структура

- `web/` — статическая страница с рендером и анимацией рейтинга.
- `leaderboard_video/` — Python-оркестратор: поднимает локальный HTTP-сервер, запускает запись и конвертацию.
- `tools/record_video.mjs` — Playwright-скрипт, который меряет контент, подбирает viewport и пишет PNG-кадры для дальнейшей сборки в MP4.
- `data/example-input.json` — пример входного JSON.
- `runtime/` — временные артефакты рендера.
- `out/` — итоговые `.mp4`.

## Установка

```bash
npm install
npx playwright install chromium
```

Python-зависимостей сейчас нет, достаточно системного `python3`.

## Быстрый старт

```bash
python3 -m leaderboard_video --input data/example-input.json
```

Скрипт вернет абсолютный путь к итоговому `.mp4`.

## Живой preview для верстки

```bash
npm run preview
```

Команда поднимет локальный сервер и напечатает URL preview-страницы. Дальше можно:

- держать страницу открытой в браузере;
- менять `web/styles.css` и `web/app.js`;
- просто обновлять вкладку и сразу видеть результат;
- пользоваться кнопками `Повторить анимацию`, `Показать вчера`, `Показать итог`.

По умолчанию preview использует `data/example-input.json`. Для другого файла:

```bash
python3 -m leaderboard_video.preview \
  --input data/example-input.json \
  --fps 60 \
  --idle-before-ms 1000 \
  --idle-after-ms 1000 \
  --row-animation-frames 26 \
  --row-stagger-frames 10
```

Если JSON лежит внутри репозитория, его изменения тоже подтянутся после обновления страницы. Если файл вне репозитория, preview копирует его в `runtime/preview/` и для обновления данных нужно перезапустить команду.

## CLI

```bash
python3 -m leaderboard_video \
  --input data/example-input.json \
  --headline "Таблица лидеров Игры в бисер на сегодня" \
  --fps 60 \
  --idle-before-ms 1000 \
  --idle-after-ms 1000 \
  --row-animation-frames 26 \
  --row-stagger-frames 10 \
  --crf 24 \
  --preset medium
```

Основные аргументы:

- `--input` — путь до входного JSON.
- `--output-dir` — директория для итогового `.mp4`, по умолчанию `out/`.
- `--headline` — заголовок страницы.
- `--fps` — целевая частота кадров итогового MP4, по умолчанию `60`.
- `--idle-before-ms` — сколько держать исходное состояние до старта анимаций.
- `--idle-after-ms` — сколько держать финальное состояние после завершения анимаций.
- `--row-animation-frames` — длительность анимации одной строки в кадрах, по умолчанию `26`.
- `--row-stagger-frames` — задержка между стартами соседних анимируемых строк в кадрах.
- `--crf` и `--preset` — сжатие итогового MP4 через `ffmpeg`.
- `--max-width` и `--max-height` — верхние ограничения для viewport записи.
- `--keep-artifacts` — не удалять временный `runtime/<job-id>/`.

## Формат JSON

Поддерживается структура вида:

```json
{
  "date": "2026-03-18",
  "tiers": {
    "tier_2": [
      {
        "username": "DrRealPepe",
        "points_yesterday": 26,
        "points_current": 32
      }
    ]
  },
  "today_gains": [
    { "username": "DrRealPepe", "gain": 6 }
  ]
}
```

Поле `today_gains` необязательно: если его нет, дельта считается как `points_current - points_yesterday`.
