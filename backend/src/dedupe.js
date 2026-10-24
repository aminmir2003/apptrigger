// Collapses repeated log records. Two records are the same when they name the same template
// ("templateName":"FFH_SelfLinkConf") and the same caller (X-Consumer-Username=ECP).

// "key": value, key=value, or the escaped form inside a JSON string (\"key\":\"value\"). A ";" or "-" before the name
// means it is part of a longer name (for example "X-dynaTrace-Application=v=2;appId=...").
export const fieldValue = (text, name) => valueOf(text, name);
const valueOf = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_;-])${escaped}[\\\\"']*\\s*[:=]\\s*[\\\\"']*([\\w.@+-]+)`, 'i').exec(text)?.[1] ?? null;
};

/**
 * What makes a record "the same" as another, or null when it names neither a template nor a caller
 * (such a record is never treated as a repeat).
 * @param {string} message the log message text
 * @returns {string|null}
 */
export function recordKey(message) {
  const template = valueOf(message, 'templateName');
  const consumer = valueOf(message, 'X-Consumer-Username');
  if (!template && !consumer) return null;
  return `${template ?? ''}|${consumer ?? ''}`.toLowerCase();
}

/**
 * Remembers the first (newest) record of each kind and counts the repeats of it.
 * add() returns true when the record is new and should be kept, false when it was only counted.
 * Each kept record gets a "repeats" number: how many identical records it stands for, itself included.
 */
export function uniqueRecords() {
  const seen = new Map();
  return {
    add(result) {
      const key = recordKey(result.message);
      result.repeats = 1;
      if (key === null) return true;
      const first = seen.get(key);
      if (first) {
        first.repeats += 1;
        return false;
      }
      seen.set(key, result);
      return true;
    },
  };
}
