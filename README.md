# matchio-scorm-cloud-local

A local stand-in for the [SCORM Cloud API v2](https://cloud.scorm.com/docs/v2/reference/swagger/) for Matchio
development and e2e tests. Zero dependencies, one file: `server.js` (Node 22).

## What it does

- **API** (`/api/v2`), the part the Matchio API uses:
  `GET /ping`, `GET|POST /appManagement/configuration`, `GET|POST /registrations`,
  `GET|DELETE /registrations/{id}`, `POST /registrations/{id}/launchLink`, `POST /registrations/postBackTest`.
  Requests need HTTP basic auth: `APP_ID:SECRET_KEY` when both are set (401 otherwise, like SCORM Cloud),
  any credentials when not.
- **Player**: a launch link opens `/player/{registrationId}`. Opening it starts the course (first access date,
  `INCOMPLETE`); the learner then makes progress ("Progress +25%", up to 75%, stays `INCOMPLETE`) and picks
  the result — passed / failed with a score. "Exit course" saves the session (time tracked, last access date)
  and closes the tab (`redirectOnExitUrl` `closer`) or goes to the given URL.
- **Postback**: on every change — opening, progress, result, exit — the registration (the `RegistrationSchema` JSON) is posted to
  `ApiRollupRegistrationPostBackUrl` from the application configuration, with HTTP basic auth when
  `ApiRollupRegistrationAuthType` is `httpbasic`, like the SCORM Cloud registration rollup.

Every course id is accepted, its title is the id. State is kept in `/data/state.json`.

## Run

```yaml
scorm-cloud:
  image: ghcr.io/oleksandrboichenko92/matchio-scorm-cloud-local:latest
  ports:
    - 3030:3030
  volumes:
    - scorm-cloud-data:/data
  environment:
    - PUBLIC_URL=http://localhost:3030 # the address launch links open in the browser
    - APP_ID=${SCORM_COURSE_APP_ID}
    - SECRET_KEY=${SCORM_COURSE_SECRET_KEY}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3030` | listen port |
| `PUBLIC_URL` | `http://localhost:$PORT` | browser address of the player, used in launch links |
| `DATA_DIR` | `/data` | where `state.json` is kept |
| `APP_ID`, `SECRET_KEY` | — | API credentials to require; without them any basic auth is accepted |

In the Matchio API `.env`: `SCORM_API_BASE_URL=http://scorm-cloud:3030/api/v2`,
`BASE_SERVER_URL=http://app:3000`, `SCORM_COURSE_POSTBACK_URL=/api/scorm/postback`.

## Publishing

Every push to `main` builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/matchio-scorm-cloud-local`
(`latest`, `sha-*`, and `v*` tags) with `.github/workflows/publish.yml`.

## License

[MIT](LICENSE)
