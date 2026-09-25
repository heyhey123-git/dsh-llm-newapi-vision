# dsh-llm-newapi-vision

**English** | [中文](README.zh-CN.md)

An independent fork of [`dsh-llm-newapi`](https://github.com/wenzetan/dsh-llm-newapi) that adds **native image input** to the NewAPI (OpenAI-compatible) route, based on host line `0.1.7-rc.1` (upstream plugin revision `v0.3`). Install it **alongside** the original plugin; the two do not collide.

## What the fork changes

| Surface | Upstream `dsh-llm-newapi` | This fork |
| --- | --- | --- |
| Package | `dsh-llm-newapi` | `dsh-llm-newapi-vision` |
| Provider route | `newapi` | `newapi-images` |
| Settings page / namespace | `NewAPI` / `llm-newapi` | `NewAPI Vision` / `llm-newapi-vision` |
| Credential reference | `newapi` | `newapi_images` |
| Model catalog field | — | `supportsImageInput: true` opts one catalog row into native `image_url` input |
| Tool-produced images | — | optional `toolImageMode: user-followup` repeats them as a transient user-role attachment for visual inspection |

The fork shares the original's design, tests and documentation; everything below describes behavior common to both unless it names the image path.

### Image-specific notes

- **Capability is per catalog row and explicit.** A row without `supportsImageInput: true` declares `inputModalities: ['text']`, so the host substitutes deterministic placeholder text for any image instead of sending bytes. Only a row that opts in receives real images, and only `user` and `tool` messages may carry them.
- **Budgeted inline images.** Retained images ride as OpenAI `image_url` base64 data URIs. A request beyond the route budget (100 occurrences / 20 MiB inline) fails with `IMAGE_OFFLOAD_REQUIRED` naming how many of the oldest occurrences the host must permanently offload before retrying, instead of silently dropping pixels.
- **Forced image tool with verified completion.** On a first-person imperative image request (new image → `generate_image`, change the attached image → `edit_image`), the first model step pins `tool_choice` to that tool. If the gateway answers with prose anyway, the adapter withholds the answer and fails with `IMAGE_TOOL_NOT_CALLED` rather than publishing a success claim for an image that was never produced. Questions, negated, hypothetical and past-tense phrasing never trigger it, and the choice is released after the first step so a failing tool is not retried in a loop.
- **Tool images are opt-in.** With `toolImageMode: off` (default) a tool image reaches the model only as a text reference. With `user-followup`, its bytes are repeated to the model as a transient user message after the tool result; the durable conversation is not rewritten.

### Compatibility boundary

This fork requires the dsh `0.1.7-rc.1` line (`>=0.1.7-rc.1 <0.1.8`). Because the image request-budget API (`IMAGE_OFFLOAD_REQUIRED_CODE`, `projectOffloadedImages`, `requiredImageOffload`) does not exist on the `0.1.5` line, a `0.1.5` host fails at module link with a raw `SyntaxError` rather than the version guard's friendly upgrade message; `test/host-compat.mjs` pins that gap to exactly those three symbols. Use upstream `dsh-llm-newapi@0.1.5-rc.3-v0.3` if you are still on the `0.1.5` host line.

Use your NewAPI gateway in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). The plugin adds a **NewAPI Vision settings page** for credentials, model discovery and model parameters, plus streaming text, tool calls and image input. It requires no changes to dsh.

## Choose a compatible version

**Install the host and plugin as a pair.** Status checked on September 24, 2026.

| dsh host | Plugin version line | npm channel | Status |
| --- | --- | --- | --- |
| `0.1.5-rc.3` | `0.1.5-rc.3-v0.3` | — | Published, that line is frozen |
| **`0.1.7-rc.1`** | **`0.1.7-rc.1-v0.x`** | **`latest`** | **Current promoted line** |

On a host line only the last segment increments (`-v0.1` → `-v0.2` → …), so the promoted line is named as `v0.x`. Query the exact version each channel currently points at:

```sh
npm view dsh-llm-newapi dist-tags --json
```

### Version scheme

The plugin version follows the upstream host: `<dsh version>-v<plugin revision>`. Only the last segment is this plugin's own revision:

| Case | dsh version | Plugin version (npm) | Git tag / Release |
| --- | --- | --- | --- |
| Upstream RC | `0.1.7-rc.1` | `0.1.7-rc.1-v0.1` | `v0.1.7-rc.1-v0.1` |
| Later plugin change on the same host line | `0.1.7-rc.1` | `0.1.7-rc.1-v0.2` | `v0.1.7-rc.1-v0.2` |
| Upstream stable | `0.1.7` | `0.1.7-v0.1` | `v0.1.7-v0.1` |
| Host line changes (revision restarts) | `0.1.7-rc.2` | `0.1.7-rc.2-v0.1` | `v0.1.7-rc.2-v0.1` |

- npm forbids a leading `v` in the version field, so the package reads `0.1.7-rc.1-v0.1` while the Git tag and GitHub Release use `v0.1.7-rc.1-v0.1`.
- **Channel split**: npm `latest` points at the currently promoted host line (the 0.1.7 line today); `next` is reserved for other lines or future previews. Promoting or switching a line is a one-line change (`LATEST_LINE` in CI); a stable `0.1.7` tag (`v0.1.7-v0.x`) also lands on `latest`.
- The older **`0.8.x` series** (dsh `0.1.1-rc.2` / `0.1.2-rc.1` host lines) had its tags removed and is marked deprecated on npm.

### Compatibility and upgrades

Plugin `0.1.7-rc.1-v0.x` supports the **dsh `0.1.7-rc.1` line** and rejects the `0.1.5` host with an explicit upgrade message; `0.1.5-rc.3` users run `0.1.5-rc.3-v0.3`. Compatibility is keyed to the host line rather than one patch: a later `0.1.7-rc` cut is covered as long as its export surface matches — `npm run test:host` compares the installed surface against the checked-in one and fails loudly when it does not, instead of assuming. `0.1.7` replaced the settings architecture (plugin configuration now projects from the profile patch with volatile fields), so this is not a pure dependency bump: see the [compatibility assessment (Chinese)](docs/2026-09-24-dsh-0.1.7-rc.1-assessment.md).

Both lines are GitHub Pre-releases (the plugin has no stable release yet). The host and plugin use `latest` with different meanings, so do not assume they pair — pick a host line from the table and query `dist-tags` for the exact version.

## Install exact versions

You need Node.js, npm and pnpm. Repository CI uses Node.js 24. Install the host with npm, then install the plugin from the npm registry into dsh's `web` profile.

### Current promoted pair (dsh `0.1.7-rc.1`, npm `latest`)

```sh
npm install -g @deepseek-ai/dsh@0.1.7-rc.1
npm install -g pnpm
dsh plugin --profile web add --save-exact "dsh-llm-newapi@$(npm view dsh-llm-newapi dist-tags.latest)"
```

### Previous host pair (dsh `0.1.5-rc.3`, that line is frozen)

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.3
npm install -g pnpm
dsh plugin --profile web add --save-exact dsh-llm-newapi@0.1.5-rc.3-v0.3
```

Choose one pair. The promoted pair resolves the current version through `dist-tags`, so no version needs to be copied by hand; the 0.1.5 line is frozen at `0.1.5-rc.3-v0.3`. `--save-exact` records an exact plugin dependency so a later dependency update does not switch versions automatically. Use `dsh plugin` to manage the profile; installing `dsh-llm-newapi` globally by itself does not register it there.

### Check that the plugin is enabled

Open `$DSH_HOME/profiles/web/package.json`. With no `DSH_HOME` override, this is `.dsh/profiles/web/package.json` under your home directory.

Ensure `dsh.profile.bundles` contains `dsh-llm-newapi`. Recent dsh hosts register installed bundle plugins automatically. On an older host or an existing profile where the entry is missing, append it once and preserve the other entries. This is a JSON fragment to check, **not a replacement for the entire file**:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-llm-newapi"
      ]
    }
  }
}
```

Check the installed versions, then restart dsh Web:

```sh
dsh --version
dsh plugin --profile web list dsh-llm-newapi
dsh web
```

## First use

1. Open **NewAPI** in dsh Web settings.
2. Enter your gateway URL, such as `https://your-gateway.example/v1`, and API key. Include `/v1`; do not enter the full `/chat/completions` path.
3. Click **Fetch models**, select the models you need and add the selected entries.
4. Optionally fetch model information from models.dev. Review context limits, output limits and reasoning efforts before applying values.
5. Click **Save**, then choose a model under the `newapi` provider in the conversation model picker.

Model discovery queries your gateway for available models. models.dev is a public parameter catalog; a match does not establish that your gateway supports a model or feature. Save after applying catalog values.

## Capabilities and limits

| Feature | Behavior |
| --- | --- |
| Text, reasoning content and tool calls | Streaming supported; an explicit reasoning effort is sent as `reasoning_effort` |
| Image input | Real images are sent as `image_url` parts **only** for catalog rows with `supportsImageInput: true`; every other row (and every uncatalogued id) declares text-only input, so the host substitutes placeholder text. Retained images are budgeted inline; an over-budget request asks the host to offload older occurrences first |
| Tool-produced images | Off by default (text reference only); `toolImageMode: user-followup` repeats them to the model as a transient user-role attachment. The durable conversation is never rewritten |
| Image tool completion | An explicit image request pins `tool_choice` for one step and refuses a text-only answer with `IMAGE_TOOL_NOT_CALLED` — the model cannot claim an image it never made |
| Model discovery | Queries `/models` and filters names containing `embed`, `rerank` or `ranker`; this is not a capability probe |
| Model parameters | Edit manually or match against models.dev; verify against your gateway |
| API key | Saved through settings, never echoed; a blank input preserves the stored key |
| Multiple gateways | One `newapi` route and one gateway configuration are currently supported |

## Upgrading and troubleshooting

Check the version table, stop dsh Web and back up your dsh configuration and session data before upgrading. Install the target host and exact plugin version, keep the existing bundle entry and restart. The plugin retains the `newapi` credential reference; configuration now persists through the profile's Cordis patch (see [configuration](docs/configuration.md)).

Host `0.1.7` migrates sessions from V3 to V4 (tool results become tool-role messages, message sources are renamed); older hosts cannot directly read migrated sessions. Reinstalling an older npm version alone is not a complete rollback. See the [upstream migration guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/session/session-format-v3-to-v4/README.md).

| Symptom | Check first |
| --- | --- |
| No NewAPI settings page | The `web` profile, bundle entry, host compatibility and whether Web was restarted |
| Missing credential | Enter and save the key in NewAPI settings; the plugin does not read `NEWAPI_API_KEY` |
| Discovery fails | The `/v1` base URL, API key and gateway support for `/models` |
| Empty model list | Name-based filtering; manually add a model only if it supports chat-completions |
| models.dev download fails | Network and proxy settings; the plugin proxy applies to this download, while dsh also applies environment proxy settings through `dsh-http-proxy` |
| Missing-peer warnings during install | dsh supplies host packages. If installation and startup succeed, do not install duplicate host packages just to silence these warnings; investigate actual startup errors separately |

## Documentation

The detailed guides below are currently in Chinese:

- [Configuration and troubleshooting](docs/configuration.md): fields, model matching, proxies and save failures.
- [Development and RC releases](docs/development.md): builds, test coverage and release checks.
- [Design](DESIGN.md): source map, data flow and implementation decisions.
- [0.1.7-rc.1 assessment](docs/2026-09-24-dsh-0.1.7-rc.1-assessment.md): version inventory, breaking changes and verification.
- [0.1.5-rc.1 assessment](docs/2026-09-10-dsh-0.1.5-rc.1-assessment.md): historical snapshot.

See [GitHub Releases](https://github.com/wenzetan/dsh-llm-newapi/releases) for published changes and downloadable packages.
