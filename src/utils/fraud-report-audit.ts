import type { FraudReportStatus } from '../types/fraud-reports.js';

export interface FraudReportStatusAuditEntry {
  actionType: string;
  message: string;
}

function formatAuditLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';

  return value
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function getFraudReportStatusAuditEntry(params: {
  staffName: string;
  reportId: string;
  status: FraudReportStatus;
  reportTitle?: string | null;
}): FraudReportStatusAuditEntry {
  const { staffName, reportId, status, reportTitle } = params;
  const normalizedReportTitle =
    typeof reportTitle === 'string' && reportTitle.trim().length > 0
      ? reportTitle.trim()
      : null;

  if (status === 'resolved') {
    return {
      actionType: 'fraud_report_resolved',
      message: `${staffName} resolved fraud report ${reportId}`,
    };
  }

  if (status === 'rejected') {
    return {
      actionType: 'fraud_report_rejected',
      message: `${staffName} rejected fraud report ${reportId}`,
    };
  }

  if (status === 'open') {
    return {
      actionType: 'fraud_report_marked_open',
      message: `${staffName} opened fraud report ${normalizedReportTitle ?? reportId}`,
    };
  }

  return {
    actionType: 'fraud_report_status_changed',
    message: `${staffName} changed fraud report ${reportId} to ${formatAuditLabel(status)}`,
  };
}
