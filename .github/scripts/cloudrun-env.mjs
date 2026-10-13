// Writes the Cloud Run environment-variables file for the backend (YAML, one "NAME: value" per line).
// Used by .github/workflows/deploy-cloudrun.yml:  node .github/scripts/cloudrun-env.mjs <output-file>
//
// Why a file and not `--set-env-vars a=1,b=2`: that format breaks when a value contains a comma or an
// equals sign (a client secret easily does). Every value is written as a quoted YAML string instead.
// Empty or missing values are left out, so optional settings simply fall back to the app's defaults.
// Only the names are printed, never the values.
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node cloudrun-env.mjs <output-file>');
  process.exit(1);
}

// [name the app reads, name of the variable this script reads it from, value to use when that is empty]
const SETTINGS = [
  ['NODE_ENV', null, 'production'],

  // Google Cloud Logging project the logs are read from
  ['GCP_PROJECT_ID', 'APP_LOGS_PROJECT_ID'],

  // FuelIX
  ['FUELIX_API_KEY', 'APP_FUELIX_API_KEY'],
  ['FUELIX_ENDPOINT', 'APP_FUELIX_ENDPOINT'],
  ['FUELIX_MODEL', 'APP_FUELIX_MODEL'],

  // Search keys: read from GitHub when GITHUB_REPO is set, else from the config file inside the image
  ['GITHUB_REPO', 'APP_CONFIG_REPO'],
  ['GITHUB_CONFIG_PATH', 'APP_CONFIG_PATH'],
  ['GITHUB_BRANCH', 'APP_CONFIG_BRANCH'],
  ['GITHUB_TOKEN', 'APP_CONFIG_TOKEN'],

  // TELUS SSO (OpenID Connect). The deploy never sets AUTH_DISABLED, so sign-in is always on.
  ['OIDC_ISSUER', 'APP_OIDC_ISSUER'],
  ['OIDC_CLIENT_ID', 'APP_OIDC_CLIENT_ID'],
  ['OIDC_CLIENT_SECRET', 'APP_OIDC_CLIENT_SECRET'],
  ['OIDC_REDIRECT_URI', 'APP_OIDC_REDIRECT_URI'],
  ['OIDC_SCOPE', 'APP_OIDC_SCOPE'],
  ['SESSION_SECRET', 'APP_SESSION_SECRET'],
  // Cloud Run gives each service its own run.app address, and browsers treat those as different sites,
  // so the sign-in cookie has to be allowed across sites. Use "lax" if both are on one custom domain.
  ['SESSION_SAMESITE', 'APP_SESSION_SAMESITE', 'none'],

  // Where the frontend is served from (lets the backend allow it through CORS)
  ['FRONTEND_ORIGIN', 'APP_FRONTEND_URL'],
  ['FRONTEND_URL', 'APP_FRONTEND_URL'],
];

const lines = [];
const names = [];
for (const [name, source, fallback] of SETTINGS) {
  const value = ((source && process.env[source]) || fallback || '').trim();
  if (!value) continue;
  lines.push(`${name}: ${JSON.stringify(value)}`); // a JSON string is a valid double-quoted YAML string
  names.push(name);
}

if (names.includes('AUTH_DISABLED')) throw new Error('refusing to deploy with sign-in switched off');

writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Wrote ${names.length} settings to ${out}: ${names.join(', ')}`);
