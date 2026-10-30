# Remote agent (bountydesk-agent)

Rust binary that streams the screen of a remote machine to the Venari MCP
viewer over WebSocket. Built with `cargo build --release` from this directory.

## Build

```bash
cd remote-agent
cargo build --release
```

The resulting binary lands in `target/release/bountydesk-agent`.

## Run

The agent is normally launched by Venari itself (via the MCP `agent` tooling);
manual invocation requires the bearer token and MCP URL printed by Venari's
Settings → AI assistant panel.

## License

MIT — same as the rest of Venari.
EOF