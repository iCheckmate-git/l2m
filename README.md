# Lineage 2M Crystal Ledger

Мини-приложение для учета кристаллов в Lineage 2M:

- приход кристаллов
- расход кристаллов
- покупка кристаллов за реальные деньги
- темный анимированный интерфейс
- хранение данных в PostgreSQL на Render
- локальный fallback на SQLite для разработки

## База данных

Приложение работает в двух режимах:

- если задан `DATABASE_URL` -> используется PostgreSQL
- если `DATABASE_URL` не задан -> используется локальный SQLite файл `data/ledger.db`

Для Render рекомендуется использовать именно `Render Postgres`.

## Локальный запуск

```bash
npm install
npm start
```

После запуска откройте:

```text
http://127.0.0.1:3000
```

## Render Postgres

Для Render:

1. Создайте `Postgres` database в Render
2. Откройте ваш `Web Service`
3. Добавьте environment variable:

```text
DATABASE_URL=<Render Postgres Internal Database URL>
```

При необходимости можно явно управлять SSL:

```text
DATABASE_SSL=true
```

Если используете внутренний Render URL и SSL не нужен:

```text
DATABASE_SSL=false
```

## Демо-данные

По умолчанию приложение не загружает демо-данные.

Если нужно вручную включить стартовые записи:

```bash
SEED_DEMO_DATA=true npm start
```

На Render переменную `SEED_DEMO_DATA` не задавайте, если хотите чистую рабочую базу.

## Структура

- `server.js` - HTTP сервер, API и подключение к БД
- `public/` - интерфейс
- `data/ledger.db` - локальная SQLite база для dev-режима без Postgres
