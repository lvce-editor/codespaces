The browser RPC client and filesystem adapter are adapted from lvce-editor/remote-ssh (MIT), commit aab12ca5cda52a7b7882f0b46950666c28c2bf98. The gateway uses the same LVCE WebSocket ticket protocol. Runtime downloads pin remote-ssh v0.10.7 and verify SHA-256.

The experimental browser proof includes Microsoft Dev Tunnels (MIT). Its independent
VS Code IPC adapter follows the MIT sources at commit
a44adf7f53e00964ab890f9f8758a334f1fc15bc. See packages/experimental/README.md for
pinned versions and source references. The proprietary GitHub Codespaces extension
is not included or loaded. Bundled dependencies retain their license notices.
