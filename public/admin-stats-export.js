'use strict';

/**
 * Admin statistics download. The server sends JSON sheets; this file builds
 * the workbook in the browser with the SheetJS already loaded on the admin page.
 */
(function () {
  function csvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function sheetMatrix(sheet) {
    const rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    return [headers].concat(rows.map((row) => headers.map((key) => (row[key] == null ? '' : row[key]))));
  }

  function downloadBlob(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(sheet, filename) {
    const matrix = sheetMatrix(sheet);
    const csv = '\uFEFF' + matrix.map((row) => row.map(csvCell).join(',')).join('\r\n');
    downloadBlob(filename || 'mapfix-stats.csv', 'text/csv;charset=utf-8', csv);
  }

  function downloadXlsx(sheets, filename) {
    if (!window.XLSX) {
      alert('Бібліотека Excel не завантажилась. Оновіть сторінку.');
      return;
    }
    const wb = window.XLSX.utils.book_new();
    (sheets || []).forEach((sheet) => {
      const matrix = sheetMatrix(sheet);
      const ws = window.XLSX.utils.aoa_to_sheet(matrix.length ? matrix : [['']]);
      window.XLSX.utils.book_append_sheet(wb, ws, String(sheet.name || 'Аркуш').slice(0, 31));
    });
    window.XLSX.writeFile(wb, filename || 'mapfix-stats.xlsx');
  }

  window.MapfixStatsExport = { downloadCsv, downloadXlsx, sheetMatrix };
})();
