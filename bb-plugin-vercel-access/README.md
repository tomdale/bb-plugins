# Vercel Access migration helper

Relay functionality is built into **Vercel Sandbox**. This retired package runs no bridge, transport, service, or server-access provider and is not needed for new installations.

For an existing installation, build and reload both packages, then run:

```sh
bb vercel-access migrate
bb plugin remove vercel-access
```

Migration copies the connector identity and retained setup receipts server-to-server into Vercel Sandbox. It emits only a success flag, performs no cloud operations, keeps the imported relay disabled, and can be retried after an uncertain reply. The original plugin must remain installed until migration succeeds because uninstalling deletes its secret settings. Worker/relay ownership and cloud allocation records already belong to Vercel Sandbox and do not move.

The integrated controls are in Settings → Vercel Sandbox → Sandbox relay. Enable provisions or reuses the bounded relay, connects it, and selects it for new machines. Disable restores the previous connection and cleans up. Native authentication, machine-only routing, fixed loopback targets, ten-minute lifetime and existing-worker reconnect limits are documented in [Vercel Sandbox](../bb-plugin-vercel-sandbox/README.md).
