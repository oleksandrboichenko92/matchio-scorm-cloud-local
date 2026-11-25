'use strict';

// Local stand-in for the SCORM Cloud API v2 (https://cloud.scorm.com/api/v2), only the part Matchio uses
// (src/modules/scorm-course/scorm-api.client.ts), plus a player page in place of the real course player.
// Zero dependencies, Node 22.
//
// - The API answers like SCORM Cloud: application configuration, registrations, launch links, postback test.
// - A launch link opens /player/<registrationId>: the learner picks the course result there instead of taking
//   the course or makes progress, the registration is updated and posted to the configured postback URL (HTTP basic auth,
//   JSON, the registration schema), as SCORM Cloud does on every registration rollup.
// - Every course id is accepted; the course title is the id.
// - Requests need HTTP basic auth; with APP_ID and SECRET_KEY set it must be APP_ID:SECRET_KEY, otherwise any
//   credentials are accepted.
// - State is kept in DATA_DIR/state.json.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const port = Number(process.env.PORT || 3030);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = process.env.DATA_DIR || '/data';
const statePath = path.join(dataDir, 'state.json');
const apiPrefix = '/api/v2';
const appCredentials =
  process.env.APP_ID && process.env.SECRET_KEY
    ? `Basic ${Buffer.from(`${process.env.APP_ID}:${process.env.SECRET_KEY}`).toString('base64')}`
    : null;

const completion = { unknown: 'UNKNOWN', completed: 'COMPLETED', incomplete: 'INCOMPLETE' };
const success = { unknown: 'UNKNOWN', passed: 'PASSED', failed: 'FAILED' };

const state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { settings: {}, registrations: {} };
  }
}

function saveState() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function now() {
  return new Date().toISOString();
}

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function sendError(res, status, message) {
  send(res, status, { message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// ---------- registrations ----------

function createRegistration(body) {
  const { registrationId, courseId, learner } = body;
  if (!registrationId || !courseId || !learner?.id) {
    return [400, { message: 'registrationId, courseId and learner.id are required' }];
  }
  if (state.registrations[registrationId]) {
    return [400, { message: `Registration ID '${registrationId}' already exists` }];
  }
  const createdAt = now();
  state.registrations[registrationId] = {
    id: registrationId,
    instance: 0,
    xapiRegistrationId: crypto.randomUUID(),
    updated: createdAt,
    registrationCompletion: completion.unknown,
    registrationCompletionAmount: 0,
    registrationSuccess: success.unknown,
    totalSecondsTracked: 0,
    createdDate: createdAt,
    course: { id: courseId, title: courseId, version: 0 },
    learner: {
      id: learner.id,
      email: learner.email,
      firstName: learner.firstName,
      lastName: learner.lastName,
    },
    tags: body.registrationTags || [],
  };
  saveState();
  return [204];
}

function updateRegistration(registration, changes) {
  Object.assign(registration, changes, { updated: now() });
  saveState();
}

// Sends the registration to the application postback URL like SCORM Cloud does on a rollup.
async function postRegistration(registration) {
  const url = state.settings.ApiRollupRegistrationPostBackUrl;
  if (!url) {
    return 'no postback URL configured';
  }
  return postTo(
    {
      url,
      authType: state.settings.ApiRollupRegistrationAuthType,
      userName: state.settings.ApiRollupRegistrationAuthUser,
      password: state.settings.ApiRollupRegistrationAuthPassword,
    },
    registration,
  );
}

async function postTo({ url, authType, userName, password }, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (String(authType).toLowerCase() === 'httpbasic') {
    headers.Authorization = `Basic ${Buffer.from(`${userName}:${password}`).toString('base64')}`;
  }
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = `${url} -> ${response.status}`;
    console.log(`postback ${body.id}: ${result}`);
    return result;
  } catch (error) {
    const result = `${url} -> ${error.cause?.code || error.message}`;
    console.log(`postback ${body.id}: ${result}`);
    return result;
  }
}

// ---------- API ----------

async function handleApi(req, res, route) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Basic ')) {
    return sendError(res, 401, 'Authorization is required');
  }
  if (appCredentials && authorization !== appCredentials) {
    return sendError(res, 401, 'Invalid app id or secret key');
  }

  if (req.method === 'GET' && route === '/ping') {
    return send(res, 200, { apiMessage: 'pong', currentTime: now() });
  }

  if (route === '/appManagement/configuration') {
    if (req.method === 'GET') {
      const settingItems = Object.entries(state.settings).map(([id, value]) => ({
        id,
        effectiveValue: value,
        effectiveValueSource: 'application',
        explicitValue: value,
      }));
      return send(res, 200, { settingItems });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      for (const { settingId, value } of body.settings || []) {
        state.settings[settingId] = value;
      }
      saveState();
      return send(res, 204);
    }
  }

  if (route === '/registrations') {
    if (req.method === 'POST') {
      const [status, body] = createRegistration(await readBody(req));
      return send(res, status, body);
    }
    if (req.method === 'GET') {
      const query = new URL(req.url, publicUrl).searchParams;
      const registrations = Object.values(state.registrations).filter((registration) => {
        return (
          (!query.get('courseId') || registration.course.id === query.get('courseId')) &&
          (!query.get('learnerId') || registration.learner.id === query.get('learnerId'))
        );
      });
      return send(res, 200, { registrations });
    }
  }

  if (req.method === 'POST' && route === '/registrations/postBackTest') {
    const body = await readBody(req);
    await postTo(body, {
      id: 'postback-test',
      registrationCompletion: completion.completed,
      registrationSuccess: success.passed,
      score: { scaled: 100 },
    });
    return send(res, 204);
  }

  const match = route.match(/^\/registrations\/([^/]+)(\/launchLink)?$/);
  if (match) {
    const registrationId = decodeURIComponent(match[1]);
    const registration = state.registrations[registrationId];
    if (!registration) {
      return sendError(res, 404, `Registration '${registrationId}' not found`);
    }
    if (match[2] && req.method === 'POST') {
      const body = await readBody(req);
      const launchUrl = new URL(`${publicUrl}/player/${encodeURIComponent(registrationId)}`);
      launchUrl.searchParams.set('redirectOnExitUrl', body.redirectOnExitUrl || 'closer');
      return send(res, 200, { launchLink: launchUrl.toString() });
    }
    if (!match[2] && req.method === 'GET') {
      return send(res, 200, registration);
    }
    if (!match[2] && req.method === 'DELETE') {
      delete state.registrations[registrationId];
      saveState();
      return send(res, 204);
    }
  }

  return sendError(res, 404, `No mock for ${req.method} ${apiPrefix}${route}`);
}

// ---------- player ----------

function playerPage(registration, redirectOnExitUrl, postbackResult) {
  const { learner, course } = registration;
  const score = registration.score?.scaled;
  const exitScript =
    redirectOnExitUrl === 'closer' || redirectOnExitUrl === 'blank'
      ? 'window.close(); document.body.innerHTML = "<p>You can close this tab.</p>";'
      : `window.location.href = ${JSON.stringify(redirectOnExitUrl)};`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local SCORM player</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px; color: #1f2937; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
  dt { color: #6b7280; }
  fieldset { border: 1px solid #d1d5db; border-radius: 8px; padding: 16px; margin: 24px 0; }
  button { font: inherit; padding: 8px 16px; margin: 4px 8px 4px 0; border-radius: 6px; border: 1px solid #9ca3af; background: #fff; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .note { color: #6b7280; font-size: 14px; }
</style>
</head>
<body>
<h1>Local SCORM player</h1>
<p class="note">SCORM Cloud mock: pick the course result instead of taking the course.</p>
<dl>
  <dt>Course</dt><dd>${escapeHtml(course.title)}</dd>
  <dt>Learner</dt><dd>${escapeHtml(`${learner.firstName ?? ''} ${learner.lastName ?? ''}`)} (${escapeHtml(learner.email)})</dd>
  <dt>Registration</dt><dd>${escapeHtml(registration.id)}</dd>
  <dt>Completion</dt><dd data-testid="registration-completion">${escapeHtml(registration.registrationCompletion)}</dd>
  <dt>Progress</dt><dd data-testid="registration-progress">${escapeHtml(Math.round((registration.registrationCompletionAmount ?? 0) * 100))}%</dd>
  <dt>Success</dt><dd data-testid="registration-success">${escapeHtml(registration.registrationSuccess)}</dd>
  <dt>Score</dt><dd data-testid="registration-score">${score === undefined ? '—' : escapeHtml(score)}</dd>
  ${postbackResult ? `<dt>Postback</dt><dd>${escapeHtml(postbackResult)}</dd>` : ''}
</dl>
<form method="post">
  <fieldset>
    <legend>Course result</legend>
    <label>Score, % <input name="score" type="number" min="0" max="100" value="${escapeHtml(score ?? 100)}"></label>
    <p>
      <button class="primary" name="outcome" value="passed">Complete: passed</button>
      <button name="outcome" value="failed">Complete: failed</button>
      <button name="outcome" value="progress">Progress +25%</button>
    </p>
  </fieldset>
</form>
<button id="exit" type="button">Exit course</button>
<script>
  document.getElementById('exit').addEventListener('click', async () => {
    // Exiting saves the session like a course does on exit: the API gets one more postback
    await fetch(window.location.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'outcome=exit',
    }).catch(() => {});
    ${exitScript}
  });
</script>
</body>
</html>`;
}

async function handlePlayer(req, res, registrationId) {
  const registration = state.registrations[registrationId];
  if (!registration) {
    return send(res, 404, '<p>Registration not found.</p>');
  }
  const query = new URL(req.url, publicUrl).searchParams;
  const redirectOnExitUrl = query.get('redirectOnExitUrl') || 'closer';
  const timestamp = now();

  if (req.method === 'GET') {
    // Opening the course starts it: the first access date is set and the registration goes incomplete.
    const changes = { lastAccessDate: timestamp };
    if (!registration.firstAccessDate) {
      changes.firstAccessDate = timestamp;
    }
    if (registration.registrationCompletion === completion.unknown) {
      changes.registrationCompletion = completion.incomplete;
    }
    updateRegistration(registration, changes);
    const postbackResult = await postRegistration(registration);
    return send(res, 200, playerPage(registration, redirectOnExitUrl, postbackResult));
  }

  if (req.method === 'POST') {
    const { outcome, score } = await readBody(req);
    const scaled = Math.min(100, Math.max(0, Number(score) || 0));
    const changes = { lastAccessDate: timestamp, totalSecondsTracked: registration.totalSecondsTracked + 60 };
    if (outcome === 'passed' || outcome === 'failed') {
      Object.assign(changes, {
        registrationCompletion: completion.completed,
        registrationCompletionAmount: 1,
        registrationSuccess: outcome === 'passed' ? success.passed : success.failed,
        score: { scaled },
        completedDate: timestamp,
      });
    } else if (outcome === 'progress' && registration.registrationCompletion !== completion.completed) {
      // Intermediate progress the course commits while it is taken; it stops short of completion
      Object.assign(changes, {
        registrationCompletion: completion.incomplete,
        registrationCompletionAmount: Math.min(0.75, (registration.registrationCompletionAmount ?? 0) + 0.25),
      });
    }
    // 'exit' only records the session time and the last access date
    updateRegistration(registration, changes);
    const postbackResult = await postRegistration(registration);
    return send(res, 200, playerPage(registration, redirectOnExitUrl, postbackResult));
  }

  return send(res, 405, '<p>Method not allowed.</p>');
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, publicUrl);
  try {
    if (pathname === '/health') {
      return send(res, 200, { status: 'ok' });
    }
    if (pathname.startsWith(`${apiPrefix}/`)) {
      return await handleApi(req, res, pathname.slice(apiPrefix.length));
    }
    const player = pathname.match(/^\/player\/([^/]+)$/);
    if (player) {
      return await handlePlayer(req, res, decodeURIComponent(player[1]));
    }
    return sendError(res, 404, `No mock for ${req.method} ${pathname}`);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, error.message);
  }
});

server.listen(port, () => {
  console.log(`SCORM Cloud mock on :${port}, API ${publicUrl}${apiPrefix}, player ${publicUrl}/player/<id>`);
});
