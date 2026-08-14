const SPREADSHEET_ID = '11onf-5MNSPLI_mGzo-kW3Q7dEO7J1_iUT5_gDJYkZyM';
const SHEET_ID = 1762324501;

function doGet(e) {
  try {
    const expected = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
    const received = e && e.parameter ? e.parameter.token : '';
    if (!expected || received !== expected) return jsonResponse({ ok: false, error: 'unauthorized' });

    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets().find(function(candidate) {
      return candidate.getSheetId() === SHEET_ID;
    });
    if (!sheet) return jsonResponse({ ok: false, error: 'sheet_not_found' });

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return jsonResponse({ ok: true, letters: [] });

    const headers = values[0].map(function(value) { return String(value).trim(); });
    const timestampIndex = headers.indexOf('タイムスタンプ');
    const nameIndex = headers.indexOf('ラジオネーム');
    const messageIndex = headers.indexOf('DJへの質問など');
    if (nameIndex < 0 || messageIndex < 0) return jsonResponse({ ok: false, error: 'columns_not_found' });

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

    return jsonResponse({ ok: true, letters: letters });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) });
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

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
