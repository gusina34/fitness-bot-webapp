/**
 * Google Apps Script для дневника веса в Mini App.
 *
 * GET  ?initData=...                 — замеры текущего пользователя
 * POST {"initData": "...", "weight"} — добавить замер и вернуть все замеры пользователя
 *
 * Telegram подписывает initData токеном бота. Скрипт проверяет подпись,
 * поэтому каждый видит и записывает только свои данные.
 *
 * Настройка:
 * 1. Откройте Google Таблицу с замерами → Расширения → Apps Script, вставьте этот код.
 * 2. Настройки проекта → Свойства скрипта → добавьте BOT_TOKEN = токен бота из @BotFather.
 * 3. Развернуть → Новое развёртывание → Веб-приложение,
 *    «Выполнять как: я», «Доступ: все». Скопируйте ссылку /exec
 *    в config.googleScriptUrl в data/workouts.js.
 *
 * Столбцы листа (первая строка — заголовки): telegram_id | date | weight
 * Это те же столбцы, в которые пишет бот в Leadteh, так что замеры из бота и из приложения общие.
 */

const SHEET_NAME = ''; // пусто = первый лист
const MAX_AGE_SECONDS = 24 * 60 * 60; // initData старше суток не принимаем

function doGet(e) {
  const user = verifyInitData_(e.parameter.initData || '');
  if (!user) return json_({ error: 'unauthorized' });
  return json_(rowsFor_(user.id));
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

  const weight = Number(body.weight);
  if (!(weight > 20 && weight < 300)) return json_({ error: 'bad weight' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = sheet_();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const row = headers.map(h => ({ telegram_id: String(user.id), date: new Date(), weight: weight }[h] ?? ''));
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return json_(rowsFor_(user.id));
}

function rowsFor_(userId) {
  const values = sheet_().getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  return values
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])))
    .filter(r => String(r.telegram_id) === String(userId))
    .map(r => ({
      date: r.date instanceof Date ? r.date.toISOString() : r.date,
      weight: r.weight
    }));
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
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
