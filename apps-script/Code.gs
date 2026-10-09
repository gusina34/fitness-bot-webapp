/**
 * Google Apps Script для Mini App «Тренировочная Булочек».
 *
 * Что делает:
 *   • дневник веса тела (первый лист таблицы);
 *   • рабочие веса в упражнениях, рекорды и история (лист «Тренировки», создаётся сам);
 *   • список клиентов, открывавших приложение (лист «Клиенты», создаётся сам);
 *   • питание за день: вода, белок, углеводы, потраченные и съеденные калории (лист «Питание», создаётся сам);
 *   • еженедельное напоминание взвеситься — сообщение от бота с кнопкой «Записать вес».
 *
 * Telegram подписывает данные пользователя токеном бота. Скрипт проверяет подпись,
 * поэтому каждый клиент видит и записывает только свои данные.
 *
 * Первая настройка:
 * 1. Откройте Google Таблицу → Расширения → Apps Script, вставьте этот код.
 * 2. Настройки проекта → Свойства скрипта → добавьте BOT_TOKEN = токен бота из @BotFather.
 *    Там же проверьте часовой пояс проекта (например, Москва) — по нему приходят напоминания.
 * 3. Развернуть → Новое развёртывание → Веб-приложение, «Выполнять как: я», «Доступ: все».
 *    Ссылку /exec вставьте в config.googleScriptUrl в data/workouts.js.
 * 4. Напоминания: вверху выберите функцию setupReminders → «Выполнить» → разрешите доступ.
 *
 * После любых изменений кода: Развернуть → Управление развёртываниями → ✏️ → Новая версия.
 *
 * Первый лист (вес тела), первая строка — заголовки: telegram_id | date | weight
 * Это те же столбцы, в которые пишет бот в Leadteh, поэтому замеры из бота и из приложения общие.
 */

const WEIGHT_SHEET = ''; // пусто = первый лист
const LOG_SHEET = 'Тренировки';
const CLIENTS_SHEET = 'Клиенты';
const FOOD_SHEET = 'Питание';
const FOOD_HEADERS = ['telegram_id', 'имя', 'дата', 'вода, мл', 'белок, г', 'углеводы, г', 'потрачено, ккал', 'съедено, ккал'];
const LOG_HEADERS = ['telegram_id', 'имя', 'дата', 'тренировка', 'упражнение', 'подход', 'вес, кг', 'повторы'];
const CLIENT_HEADERS = ['telegram_id', 'имя', 'username', 'первый вход', 'последний вход', 'напоминания'];

// ---- Настройки напоминаний ----
const REMINDER_DAY = 'MONDAY';  // день недели: MONDAY, TUESDAY, … SUNDAY
const REMINDER_HOUR = 9;                       // час (по часовому поясу проекта)
const REMIND_AFTER_DAYS = 6;   // не напоминать, если клиент взвешивался за последние 6 дней
const ACTIVE_DAYS = 45;        // напоминать только тем, кто открывал приложение за последние 45 дней
const APP_WEIGHT_URL = 'https://gusina34.github.io/fitness-bot-webapp/?open=weight';
const REMINDER_TEXT = 'Новая неделя — время взвеситься ⚖️\n\n' +
  'Встань на весы утром натощак, до еды и воды, и запиши результат в дневник 👇';

const MAX_AGE_SECONDS = 24 * 60 * 60; // данные Telegram старше суток не принимаем
const DAY_MS = 24 * 60 * 60 * 1000;

// ================= Приложение =================

function doGet(e) {
  const user = verifyInitData_(e.parameter.initData || '');
  if (!user) return json_({ error: 'unauthorized' });
  if (e.parameter.action === 'progress') return json_(progressFor_(user.id));
  if (e.parameter.action === 'history') return json_(historyFor_(user.id));
  return json_(weightsFor_(user.id));
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'bad request' });
  }
  const user = verifyInitData_(body.initData || '');
  if (!user) return json_({ error: 'unauthorized' });

  const action = body.action || (body.weight ? 'weight' : '');
  if (action === 'weight') return json_(addWeight_(user, body.weight));
  if (action === 'log') return json_(addLog_(user, body.entries));
  if (action === 'hello') return json_(hello_(user));
  if (action === 'day') return json_(saveDay_(user, body.day || {}));
  return json_({ error: 'unknown action' });
}

// ---- Вес тела ----

function weightsFor_(userId) {
  const values = weightSheet_().getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  return values
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])))
    .filter(r => String(r.telegram_id) === String(userId))
    .map(r => {
      const date = parseDate_(r.date);
      return {
        telegram_id: String(r.telegram_id),
        date: date ? date.toISOString() : r.date,
        weight: r.weight
      };
    });
}

function addWeight_(user, value) {
  const weight = Number(value);
  if (!(weight > 20 && weight < 300)) return { error: 'bad weight' };
  withLock_(() => {
    const sheet = weightSheet_();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    sheet.appendRow(headers.map(h => ({ telegram_id: String(user.id), date: new Date(), weight: weight }[h] ?? '')));
  });
  return weightsFor_(user.id);
}

// ---- Рабочие веса ----

function addLog_(user, entries) {
  if (!Array.isArray(entries)) return { error: 'bad entries' };
  const name = displayName_(user);
  const now = new Date();
  const rows = [];

  entries.slice(0, 50).forEach(entry => {
    const exercise = safe_(String(entry.exercise || '').slice(0, 100));
    if (!exercise) return;
    const workout = safe_(String(entry.workout || '').slice(0, 100));
    let date = new Date(entry.date);
    if (isNaN(date) || date > new Date(now.getTime() + DAY_MS) || date < new Date(now.getTime() - 30 * DAY_MS)) date = now;

    let setNumber = 0;
    (Array.isArray(entry.sets) ? entry.sets.slice(0, 20) : []).forEach(set => {
      const weight = number_(set.weight, 0, 500);
      const reps = number_(set.reps, 0, 1000);
      if (weight === '' && reps === '') return;
      setNumber++;
      rows.push([String(user.id), name, date, workout, exercise, setNumber, weight, reps]);
    });
  });

  if (rows.length) {
    withLock_(() => {
      const sheet = sheetByName_(LOG_SHEET, LOG_HEADERS);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
    });
  }
  return { ok: true, saved: rows.length };
}

// Вся история по упражнениям: { "Ягодичный мост": [{ date, sets: [{ weight, reps }] }, …] } от старых к новым
function progressFor_(userId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sheet) return {};
  const result = {};

  sheet.getDataRange().getValues().slice(1).forEach(r => {
    if (String(r[0]) !== String(userId) || !(r[2] instanceof Date)) return;
    const list = result[r[4]] || (result[r[4]] = []);
    const time = r[2].getTime();
    // Подходы одного упражнения за одну тренировку записаны подряд с одинаковым временем
    let session = list[list.length - 1];
    if (!session || session.time !== time) {
      session = { time: time, date: r[2].toISOString(), sets: [] };
      list.push(session);
    }
    session.sets.push({ weight: r[6], reps: r[7] });
  });

  Object.values(result).forEach(list => {
    list.sort((a, b) => a.time - b.time);
    list.forEach(s => delete s.time);
  });
  return result;
}

// Последняя тренировка по каждому упражнению: { "Ягодичный мост": { date, sets: [{ weight, reps }] } }
function historyFor_(userId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (!sheet) return {};
  const tz = Session.getScriptTimeZone();
  const result = {};

  sheet.getDataRange().getValues().slice(1).forEach(r => {
    if (String(r[0]) !== String(userId) || !(r[2] instanceof Date)) return;
    const exercise = r[4];
    const day = Utilities.formatDate(r[2], tz, 'yyyy-MM-dd');
    const current = result[exercise];
    if (!current || day > current.day) {
      result[exercise] = { day: day, date: r[2].toISOString(), sets: [] };
    }
    if (result[exercise].day === day) result[exercise].sets.push({ weight: r[6], reps: r[7] });
  });

  Object.values(result).forEach(v => delete v.day);
  return result;
}

// ---- Питание за день: одна строка на клиента и дату ----

function saveDay_(user, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) return { error: 'bad date' };
  const values = [
    number_(day.water, 0, 10000),
    number_(day.protein, 0, 1000),
    number_(day.carbs, 0, 2000),
    number_(day.burned, 0, 5000),
    number_(day.kcal, 0, 10000)
  ];
  const tz = Session.getScriptTimeZone();
  withLock_(() => {
    const sheet = sheetByName_(FOOD_SHEET, FOOD_HEADERS);
    // Лист мог быть создан прежней версией без новых столбцов
    if (sheet.getLastColumn() < FOOD_HEADERS.length) {
      sheet.getRange(1, 1, 1, FOOD_HEADERS.length).setValues([FOOD_HEADERS]);
    }
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((r, i) => i > 0 && String(r[0]) === String(user.id) &&
      (r[2] instanceof Date ? Utilities.formatDate(r[2], tz, 'yyyy-MM-dd') : String(r[2])) === day.date);
    if (index === -1) {
      // Апостроф — чтобы таблица хранила дату как текст и не путала часовые пояса
      sheet.appendRow([String(user.id), displayName_(user), "'" + day.date].concat(values));
    } else {
      sheet.getRange(index + 1, 4, 1, values.length).setValues([values]);
    }
  });
  return { ok: true };
}

// ---- Клиенты ----

function hello_(user) {
  withLock_(() => {
    const sheet = sheetByName_(CLIENTS_SHEET, CLIENT_HEADERS);
    const ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => String(r[0]));
    const index = ids.indexOf(String(user.id));
    const name = displayName_(user);
    const username = user.username ? '@' + user.username : '';
    const now = new Date();
    if (index === -1) {
      sheet.appendRow([String(user.id), name, username, now, now, 'вкл']);
    } else {
      sheet.getRange(index + 1, 2, 1, 2).setValues([[name, username]]);
      sheet.getRange(index + 1, 5).setValue(now);
    }
  });

  const weights = weightsFor_(user.id)
    .map(w => ({ date: new Date(w.date), weight: Number(String(w.weight).replace(',', '.')) }))
    .filter(w => !isNaN(w.date) && !isNaN(w.weight))
    .sort((a, b) => a.date - b.date);
  const last = weights[weights.length - 1];
  return last ? { lastWeight: last.weight, lastWeightDate: last.date.toISOString() } : {};
}

// ================= Напоминания =================

// Запустите один раз вручную: создаёт еженедельный запуск sendWeeklyReminders
function setupReminders() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendWeeklyReminders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendWeeklyReminders')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[REMINDER_DAY])
    .atHour(REMINDER_HOUR)
    .create();
  Logger.log('Готово: напоминания будут приходить каждую неделю около %s:00 (%s)', REMINDER_HOUR, Session.getScriptTimeZone());
}

function sendWeeklyReminders() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const sheet = sheetByName_(CLIENTS_SHEET, CLIENT_HEADERS);
  const clients = sheet.getDataRange().getValues().slice(1);

  // Дата последнего замера каждого клиента
  const lastWeighIn = {};
  const values = weightSheet_().getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  const idCol = headers.indexOf('telegram_id');
  const dateCol = headers.indexOf('date');
  values.forEach(r => {
    const id = String(r[idCol]);
    const date = parseDate_(r[dateCol]);
    if (date && (!lastWeighIn[id] || date > lastWeighIn[id])) lastWeighIn[id] = date;
  });

  const now = Date.now();
  let sent = 0;
  clients.forEach((row, i) => {
    const id = String(row[0]);
    const lastSeen = row[4];
    if (!id || row[5] !== 'вкл') return;
    if (!(lastSeen instanceof Date) || now - lastSeen > ACTIVE_DAYS * DAY_MS) return;
    if (lastWeighIn[id] && now - lastWeighIn[id] < REMIND_AFTER_DAYS * DAY_MS) return;

    const code = sendReminder_(token, id, row[1]);
    if (code === 200) sent++;
    if (code === 403) sheet.getRange(i + 2, 6).setValue('бот заблокирован');
    Utilities.sleep(50); // лимит Telegram — не больше 30 сообщений в секунду
  });
  Logger.log('Отправлено напоминаний: %s', sent);
}

// Проверка: отправляет напоминание только на ID из свойства скрипта TEST_ID
function testReminder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TEST_ID');
  if (!id) throw new Error('Добавьте свойство скрипта TEST_ID — свой telegram_id из листа «Клиенты»');
  Logger.log('Ответ Telegram: %s', sendReminder_(props.getProperty('BOT_TOKEN'), id, ''));
}

function sendReminder_(token, chatId, name) {
  const firstName = String(name || '').split(' ')[0];
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: chatId,
      text: (firstName ? firstName + ', привет! ' : 'Привет! ') + REMINDER_TEXT,
      reply_markup: { inline_keyboard: [[{ text: '⚖️ Записать вес', web_app: { url: APP_WEIGHT_URL } }]] }
    })
  });
  return response.getResponseCode();
}

// ================= Служебное =================

function weightSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return WEIGHT_SHEET ? ss.getSheetByName(WEIGHT_SHEET) : ss.getSheets()[0];
}

function sheetByName_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name, ss.getSheets().length); // в конец, чтобы первый лист остался весом
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

// Даты из таблицы: объект Date, ISO-строка или «07.10.2026»
function parseDate_(value) {
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const date = m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date(value);
  return isNaN(date) ? null : date;
}

function number_(value, min, max) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(String(value).replace(',', '.'));
  return isFinite(n) && n >= min && n <= max ? n : '';
}

// Защита от формул: текст, начинающийся с = + - @, таблица посчитала бы формулой
function safe_(text) {
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function displayName_(user) {
  return safe_([user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 100));
}

// Проверка подписи: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData_(initData) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token || !initData) return null;

  const params = {};
  initData.split('&').forEach(pair => {
    const i = pair.indexOf('=');
    params[decode_(pair.slice(0, i))] = decode_(pair.slice(i + 1));
  });

  const hash = params.hash;
  delete params.hash;
  const checkString = Object.keys(params).sort().map(k => k + '=' + params[k]).join('\n');

  const secret = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256, toBytes_(token), toBytes_('WebAppData'));
  const signature = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256, toBytes_(checkString), secret);
  const hex = signature.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(params.auth_date) > MAX_AGE_SECONDS) return null;
  return JSON.parse(params.user);
}

function decode_(s) {
  return decodeURIComponent(s.replace(/\+/g, ' '));
}

function toBytes_(s) {
  return Utilities.newBlob(s).getBytes();
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
