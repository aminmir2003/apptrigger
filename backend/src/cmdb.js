// Team lookup from CMDBID.xlsx: a value found in a log (for example the X-Consumer-Username
// "PaymentManagement") is matched against the Key column, and that row's Description is the team.
// (The search keys come from GitHub, see githubConfig.js; the team rows stay in this spreadsheet.)

import readXlsxFile from 'read-excel-file/node';
import { fileURLToPath } from 'node:url';

const CMDB_FILE = process.env.CMDB_FILE || fileURLToPath(new URL('../CMDBID.xlsx', import.meta.url));

const text = (v) => (v == null ? '' : String(v).trim());

// Load the sheet as a Map of lower-cased Key -> Description, locating the columns by header name.
// Blank rows and rows without both a Key and a Description are skipped.
async function loadCmdb() {
  const [{ data }] = await readXlsxFile(CMDB_FILE);
  const headerRow = data.findIndex((r) => r.some((c) => text(c).toLowerCase() === 'key'));
  if (headerRow < 0) throw new Error('CMDBID.xlsx has no "Key" column');
  const header = data[headerRow].map((c) => text(c).toLowerCase());
  const keyCol = header.indexOf('key');
  const descCol = header.indexOf('description');
  if (descCol < 0) throw new Error('CMDBID.xlsx has no "Description" column');

  const table = new Map();
  for (const row of data.slice(headerRow + 1)) {
    const key = text(row[keyCol]);
    const description = text(row[descCol]);
    if (key && description) table.set(key.toLowerCase(), description);
  }
  return table;
}

/**
 * For each log, try its identifiers in order and use the first one that has a row in the sheet.
 * If none do, report the first identifier with no team, so the page can still show what was found.
 * @param {{key: string, value: string}[][]} candidates per log, identifiers in priority order
 * @returns {Promise<{id: {key: string, value: string}|null, team: string|null}[]>}
 */
export async function pickTeams(candidates) {
  if (!candidates.some((c) => c.length > 0)) return candidates.map(() => ({ id: null, team: null }));
  const table = await loadCmdb();
  return candidates.map((list) => {
    for (const id of list) {
      const team = table.get(text(id.value).toLowerCase());
      if (team) return { id, team };
    }
    return { id: list[0] ?? null, team: null };
  });
}

/** How many usable rows the sheet has (for the details card). */
export async function cmdbRowCount() {
  return (await loadCmdb()).size;
}
