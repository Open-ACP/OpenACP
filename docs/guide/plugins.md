# Plugins

OpenACP supports installing additional channel adapters as npm packages.

## CLI Commands

```bash
openacp install <package>     # Install a plugin adapter
openacp uninstall <package>   # Remove a plugin
openacp plugins               # List installed plugins with versions
```

## Example

```bash
openacp install @openacp/adapter-discord
```

Then configure in `~/.openacp/config.json`:

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "adapter": "@openacp/adapter-discord",
      "botToken": "YOUR_DISCORD_BOT_TOKEN"
    }
  }
}
```

Plugins are installed to `~/.openacp/plugins/`.

## Creating a Channel Adapter

Implement the `ChannelAdapter` abstract class:

```typescript
import { ChannelAdapter } from '@openacp/cli'

class MyAdapter extends ChannelAdapter {
  async start() { /* connect to platform */ }
  async stop() { /* disconnect */ }
  async sendMessage(sessionId, content) { /* send to user */ }
  async sendPermissionRequest(sessionId, request) { /* show permission UI */ }
  async sendNotification(notification) { /* notify user */ }
  async createSessionThread(sessionId, name) { /* create thread */ }
  async renameSessionThread(sessionId, name) { /* rename thread */ }
}
```

Export an `AdapterFactory`:

```typescript
export const adapterFactory = {
  name: 'my-adapter',
  createAdapter(core, config) {
    return new MyAdapter(core, config)
  }
}
```

OpenACP loads plugins dynamically via `createRequire()` from the plugins directory. It looks for `module.adapterFactory` or `module.default`.
