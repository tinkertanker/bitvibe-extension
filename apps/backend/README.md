# bit:vibe managed backend

Reference backend for managed mode.

## Endpoints

- `GET /healthz`
- `POST /bitvibe/generate`

## Request/response contract

### `POST /bitvibe/generate` request body

```json
{
  "target": "microbit",
  "request": "Create a simple blinking LED pattern",
  "currentCode": "optional existing JS"
}
```

### Success response

```json
{
  "code": "basic.showIcon(IconNames.Heart)",
  "feedback": ["Optional feedback line"]
}
```

### Error response

```json
{
  "error": "Human-readable error message"
}
```

## Quick start

```bash
cd apps/backend
cp .env.example .env
# set BITVIBE_PROVIDER and a matching API key
npm start
```

Server defaults:

- URL: `http://localhost:8787`
- Provider: `openai`

## Environment variables

- `PORT` (default `8787`)
- `BITVIBE_ALLOW_ORIGIN` (default `*`)
- `BITVIBE_REQUEST_TIMEOUT_MS` (default `60000`)
- `SERVER_APP_TOKEN` (optional bearer token)
- `BITVIBE_PROVIDER` (`openai` | `gemini` | `openrouter`)
- `BITVIBE_MODEL` fallback model
- `BITVIBE_API_KEY` fallback key
- Provider-specific overrides:
  - `BITVIBE_OPENAI_API_KEY`, `BITVIBE_OPENAI_MODEL`
  - `BITVIBE_GEMINI_API_KEY`, `BITVIBE_GEMINI_MODEL`
  - `BITVIBE_OPENROUTER_API_KEY`, `BITVIBE_OPENROUTER_MODEL`
