import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFraudReportStatusAuditEntry } from '../utils/fraud-report-audit.js';

test('getFraudReportStatusAuditEntry returns the opened fraud report copy for open status', () => {
  assert.deepEqual(
    getFraudReportStatusAuditEntry({
      staffName: 'Alexa Joanne Paula San Jose',
      reportId: 'e8f7bcaa-9d3c-4819-b95e-f4ddef7d18c6',
      status: 'open',
      reportTitle: 'Custom Keycaps Keyboard',
    }),
    {
      actionType: 'fraud_report_marked_open',
      message: 'Alexa Joanne Paula San Jose opened fraud report Custom Keycaps Keyboard',
    }
  );
});
