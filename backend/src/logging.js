import { Logging } from '@google-cloud/logging';

const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) throw new Error('GCP_PROJECT_ID is not set');

// Credentials are picked up from GOOGLE_APPLICATION_CREDENTIALS (ADC).
const logging = new Logging({ projectId });

// Strip characters that could break out of a quoted filter value.
const q = (s) => String(s).replace(/["\\]/g, '');

// Safety cap only, so one huge entry can't blow up a response. Override with MAX_MESSAGE_CHARS.
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS) || 100_000;

// Return the complete log message (structured payloads are turned into a JSON string).
const fullMessage = (data) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data) ?? '';
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text;
};

/**
 * Query Cloud Run logs from Cloud Logging.
 * @param {object} o
 * @param {string} [o.resource=cloud_run_revision] resource type, e.g. cloudsql_database
 * @param {string} [o.service] Cloud Run service name
 * @param {string} [o.revision] Cloud Run revision name
 * @param {string} [o.severity] minimum severity, e.g. ERROR
 * @param {string} [o.search] text to find in the log entries
 * @param {string} [o.filter] extra Logging query language filter
 * @param {string} [o.from] range start (ISO date); overrides hours
 * @param {string} [o.to] range end (ISO date)
 * @param {number} [o.hours=1] lookback window used when from is not given
 * @param {number} [o.limit=50]
 */
export async function queryLogs({ resource = 'cloud_run_revision', service, revision, severity, filter, search, from, to, hours = 1, limit = 50 } = {}) {
  const start = from ? new Date(from) : new Date(Date.now() - hours * 3600 * 1000);
  const end = to ? new Date(to) : null;
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) throw new Error('Invalid from/to date');
  const since = start.toISOString();
  const parts = [`resource.type="${q(resource)}"`, `timestamp>="${since}"`];
  if (end) parts.push(`timestamp<="${end.toISOString()}"`);
  if (service) parts.push(`resource.labels.service_name="${q(service)}"`);
  if (revision) parts.push(`resource.labels.revision_name="${q(revision)}"`);
  if (severity) parts.push(`severity>=${severity.replace(/[^A-Za-z]/g, '')}`);
  if (search) parts.push(`SEARCH("${q(search)}")`);
  if (filter) parts.push(`(${filter})`);

  const [entries] = await logging.getEntries({
    filter: parts.join(' AND '),
    orderBy: 'timestamp desc',
    pageSize: Math.min(Number(limit) || 50, 500),
    autoPaginate: false,
  });

  return entries.map((e) => ({
    timestamp: e.metadata.timestamp,
    severity: e.metadata.severity,
    service: e.metadata.resource?.labels?.service_name,
    revision: e.metadata.resource?.labels?.revision_name,
    httpRequest: e.metadata.httpRequest,
    message: fullMessage(e.data),
  }));
}
