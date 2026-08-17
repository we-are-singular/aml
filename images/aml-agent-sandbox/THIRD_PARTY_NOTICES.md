# Third-party notices

AML Agent Sandbox includes unmodified third-party packages under their respective licenses. Package sources, versions, integrity hashes, and transitive dependencies are recorded in `package-lock.json` and the published image SBOM.

| Package                           | License                    | Source                                             |
| --------------------------------- | -------------------------- | -------------------------------------------------- |
| `@agentclientprotocol/codex-acp`  | Apache-2.0                 | <https://github.com/agentclientprotocol/codex-acp> |
| `@openai/codex`                   | Apache-2.0                 | <https://github.com/openai/codex>                  |
| `@github/copilot`                 | GitHub Copilot CLI License | <https://github.com/github/copilot-cli>            |
| `glm-acp-agent`                   | Apache-2.0                 | <https://github.com/stefandevo/glm-acp-agent>      |
| `opencode-ai`                     | MIT                        | <https://github.com/anomalyco/opencode>            |
| `pi-acp`                          | MIT                        | <https://github.com/svkozak/pi-acp>                |
| `@earendil-works/pi-coding-agent` | MIT                        | <https://github.com/earendil-works/pi>             |
| `pi-mcp-adapter`                  | MIT                        | <https://github.com/nicobailon/pi-mcp-adapter>     |

GitHub Copilot CLI is included unmodified as one of several Agent runtimes. AML supplies the independent Sandbox, Workspace, ACP orchestration, Tool, structured-output, lifecycle, and compatibility functionality around it. The GitHub Copilot CLI License and retained notices ship at `/usr/share/doc/aml-agent-sandbox/licenses/GitHub-Copilot-CLI-LICENSE.md` and inside the installed package tree.

License files distributed by npm packages remain in their original locations under `/opt/aml-agent-sandbox/node_modules`. This notice is informational and does not replace those license terms.
