// Saves everything under data/: rounds (one line per round), settings, the current session and
// finished sessions. Writes go through a temporary file so a crash never leaves half a file.
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const file = name => path.join(dir, name);
  const readJson = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  };
  const writeJson = (name, value) => {
    const tmp = file(name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file(name));
  };
  const readLines = name => {
    let text = '';
    try { text = fs.readFileSync(file(name), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {} // A torn last line after a crash is skipped.
    }
    return out;
  };
  const appendLines = (name, rows) => {
    if (rows.length) fs.appendFileSync(file(name), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  };

  return {
    loadRounds: () => readLines('rounds.ndjson').filter(r => [8, 9, 10, 11].includes(r.n)),
    appendRounds: rows => appendLines('rounds.ndjson', rows),
    loadSettings: () => readJson('settings.json', null),
    saveSettings: s => writeJson('settings.json', s),
    loadSession: () => readJson('session.json', null),
    saveSession: s => writeJson('session.json', s),
    addFinishedSession: s => appendLines('sessions.ndjson', [s]),
    loadFinishedSessions: () => readLines('sessions.ndjson'),
    loadTableOdds: () => readJson('odds.json', null),
    saveTableOdds: o => writeJson('odds.json', o),
    loadPractice: () => readJson('practice.json', null),
    savePractice: p => writeJson('practice.json', p),
    loadUrl: () => readJson('meta.json', {}).url || '',
    saveUrl: url => writeJson('meta.json', {url}),
  };
}

module.exports = {createStore};
