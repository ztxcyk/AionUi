const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');

it('skips only silent E1032 telemetry while retaining local logging and failure exit', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../resources/windows/installer-errors-sentry.nsh'),
    'utf8'
  );
  const macro = source.match(/!macro AIONUI_FAIL_UX\b([\s\S]*?)!macroend/)[1];
  assert.match(macro, /event=session-end result=fail/);
  assert.match(
    macro,
    /\$\{If\} "\$\{_CODE\}" == "\$\{AIONUI_E_OFFICECLI_INCOMPLETE\}"[\s\S]*?event=report-skipped reason=offline[\s\S]*?\$\{Else\}[\s\S]*?AIONUI_REPORT_TO_SENTRY_NOUI/
  );
  assert.match(macro, /AIONUI_REPORT_TO_SENTRY "\$\{_CODE\}"/);
  assert.match(macro, /SetErrorLevel 2\s+Quit/);
});
