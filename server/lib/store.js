import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

await fs.mkdir(config.dataDir, { recursive: true }).catch(() => {});

const cache = new Map();

function fileFor(name) {
  return path.join(config.dataDir, `${name}.json`);
}

export async function load(name, fallback = {}) {
  if (cache.has(name)) return cache.get(name);
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    const data = JSON.parse(raw);
    cache.set(name, data);
    return data;
  } catch {
    cache.set(name, fallback);
    return fallback;
  }
}

let writeQueue = Promise.resolve();
export function save(name, data) {
  cache.set(name, data);
  writeQueue = writeQueue
    .then(() => fs.writeFile(fileFor(name), JSON.stringify(data, null, 2)))
    .catch((err) => console.error('[store] 写入失败', name, err.message));
  return writeQueue;
}
