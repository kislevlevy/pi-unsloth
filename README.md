# pi-unsloth

A [Pi](https://pi.dev) extension that registers a local **Unsloth** model server as a provider. It talks to the server's OpenAI-compatible API, discovers models from `/models`, and tags models the server has already loaded with `[loaded]`.

## Install

```bash
pi install git:github.com/kislevlevy/pi-unsloth
```

Try it for one run without installing:

```bash
pi -e git:github.com/kislevlevy/pi-unsloth
```

## Configure

`pi install` clones the package to `~/.pi/agent/git/github.com/kislevlevy/pi-unsloth/`, so the example config is at:

```
~/.pi/agent/git/github.com/kislevlevy/pi-unsloth/unsloth.example.json
```

Copy it into Pi's agent directory, then edit it with your server details:

```bash
cp ~/.pi/agent/git/github.com/kislevlevy/pi-unsloth/unsloth.example.json ~/.pi/agent/unsloth.json
chmod 600 ~/.pi/agent/unsloth.json
```

With `pi install --local` the clone is in the project instead, at `.pi/git/github.com/kislevlevy/pi-unsloth/`. If `PI_CODING_AGENT_DIR` is set, use that in place of `~/.pi/agent`.

| Field            | Required | Default | Meaning                                                                               |
| ---------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `baseURL`        | yes      |         | Server's OpenAI-compatible base URL, e.g. `http://192.168.1.20:8000/v1`               |
| `apiKey`         | yes      |         | Bearer token sent to the server                                                       |
| `contextWindow`  | no       | `8192`  | Used when the server doesn't report a model's context length                          |
| `maxTokens`      | no       | `2048`  | Used when the server doesn't report max output tokens                                 |
| `timeoutMs`      | no       | `5000`  | Model discovery timeout                                                               |
| `modelOverrides` | no       |         | Per-model-ID overrides of Pi model settings, e.g. `{"my-model": {"reasoning": true}}` |

Environment variables override the file:

- `UNSLOTH_CONFIG` – path to a different config file
- `UNSLOTH_BASE_URL` – overrides `baseURL`
- `UNSLOTH_API_KEY` – overrides `apiKey`

The config file must still exist (it can be `{}`) when you use only environment variables, because the extension reads it at startup.

## Use

- `/unsloth-model` – refresh and pick an Unsloth model; loaded models are listed first
- `/unsloth-refresh` – re-fetch the model list, then choose with `/model`

If the server is unreachable at startup, Pi shows a warning; run `/unsloth-refresh` once it's up. Discovery is skipped with `--offline` or `PI_OFFLINE=1`.
