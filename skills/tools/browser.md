# Browser Tool

Control a headless browser for interacting with web pages. Navigate, click, type, extract content, and take screenshots.

## Actions

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `navigate` | Go to a URL | `url` |
| `click` | Click an element | `selector` or `text` |
| `type` | Type into an input field | `selector`, `text` |
| `screenshot` | Capture the current page | `fullPage` (optional) |
| `extract_text` | Get text content from the page | `selector` (optional) |
| `scroll` | Scroll the page | `direction`, `amount` |
| `wait` | Wait for an element or condition | `selector`, `timeout` |

## Navigate

```json
{ "action": "navigate", "url": "https://example.com/dashboard" }
```

Returns the page title and a summary of visible content.

## Click

```json
{ "action": "click", "selector": "button.submit" }
```

Or click by visible text:

```json
{ "action": "click", "text": "Sign In" }
```

## Type

```json
{ "action": "type", "selector": "#search-input", "text": "SwarmClaw documentation" }
```

## Screenshot

```json
{ "action": "screenshot" }
```

Full page:

```json
{ "action": "screenshot", "fullPage": true }
```

Returns an image that you can analyze for layout, content, or visual verification.

## Extract Text

```json
{ "action": "extract_text" }
```

Extracts all visible text from the page. Use `selector` to target a specific element:

```json
{ "action": "extract_text", "selector": "main.content" }
```

## Scroll

```json
{ "action": "scroll", "direction": "down", "amount": 500 }
```

## Wait

```json
{ "action": "wait", "selector": ".results-loaded", "timeout": 10000 }
```

Waits for an element to appear in the DOM. Useful after navigation or after triggering dynamic content.

## Browser vs Execute (curl)

| Scenario | Tool |
|----------|------|
| Static API call, JSON response | **execute** (`curl`) |
| Page requires JavaScript rendering | **browser** |
| Form submission with CSRF tokens | **browser** |
| Downloading a file | **execute** (`curl`) |
| Scraping dynamic content (React/Vue apps) | **browser** |
| Simple GET request for HTML | **execute** (`curl`) |
| Multi-step interaction (login, navigate, click) | **browser** |
| Checking HTTP headers or status codes | **execute** (`curl`) |

## Multi-Step Example

Login and extract dashboard data:

```json
{ "action": "navigate", "url": "https://app.example.com/login" }
```

```json
{ "action": "type", "selector": "#email", "text": "user@example.com" }
```

```json
{ "action": "type", "selector": "#password", "text": "$APP_PASSWORD" }
```

```json
{ "action": "click", "text": "Log In" }
```

```json
{ "action": "wait", "selector": ".dashboard-loaded" }
```

```json
{ "action": "extract_text", "selector": ".metrics-panel" }
```

## Tips

- Always `wait` after `navigate` or `click` if the next action depends on dynamic content loading.
- Use `extract_text` instead of `screenshot` when you need the data programmatically.
- Use `screenshot` when you need to verify visual layout or debug what the page looks like.
- Credentials referenced as `$ENV_VAR` are injected from the agent's credential configuration.
- The browser session persists across tool calls within the same agent turn, so cookies and state are maintained.
- Close the browser when done if you started it just for one task.
