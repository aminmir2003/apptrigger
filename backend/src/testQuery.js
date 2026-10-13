import { queryLogs } from './logging.js';

const logs = await queryLogs({ service: process.argv[2], hours: 24, limit: 5 });
console.log(`Fetched ${logs.length} Cloud Run entries`);
console.log(JSON.stringify(logs, null, 2));
