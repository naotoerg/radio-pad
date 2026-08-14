const SPREADSHEET_ID = '11onf-5MNSPLI_mGzo-kW3Q7dEO7J1_iUT5_gDJYkZyM';
const SHEET_ID = 1762324501;

function doGet(e) {
  try {
    const callback = e && e.parameter ? e.parameter.callback : '';
    const expected = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
    const received = e && e.parameter ? e.parameter.token : '';
    if (!expected || received !== expected) return jsonResponse({ ok: false, error: 'unauthorized' }, callback);

    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets().find(function(candidate) {
      return candidate.getSheetId() === SHEET_ID;
    });
    if (!sheet) return jsonResponse({ ok: false, error: 'sheet_not_found' }, callback);

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return jsonResponse({ ok: true, letters: [] }, callback);

    const headers = values[0].map(function(value) { return String(value).trim(); });
    const timestampIndex = Math.max(headers.indexOf('タイムスタンプ'), headers.indexOf('Timestamp'), 0);
    const nameIndex = headers.indexOf('ラジオネーム');
    const messageIndex = headers.indexOf('DJへの質問など');
    if (nameIndex < 0 || messageIndex < 0) return jsonResponse({ ok: false, error: 'columns_not_found' }, callback);

    const timeZone = Session.getScriptTimeZone() || 'Asia/Tokyo';
    const letters = values.slice(1).map(function(row, index) {
      const rawTimestamp = timestampIndex >= 0 ? row[timestampIndex] : '';
      const timestamp = rawTimestamp instanceof Date
        ? Utilities.formatDate(rawTimestamp, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX")
        : String(rawTimestamp || '');
      return {
        id: String(index + 2),
        timestamp: timestamp,
        name: String(row[nameIndex] || '').trim(),
        message: String(row[messageIndex] || '').trim()
      };
    }).filter(function(letter) { return letter.name || letter.message; });

    return jsonResponse({ ok: true, letters: letters }, callback);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) }, e && e.parameter ? e.parameter.callback : '');
  }
}

function setupAccessToken() {
  const properties = PropertiesService.getScriptProperties();
  let token = properties.getProperty('ACCESS_TOKEN');
  if (!token) {
    token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    properties.setProperty('ACCESS_TOKEN', token);
  }
  console.log(token);
  return token;
}

function jsonResponse(value, callback) {
  const json = JSON.stringify(value);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
