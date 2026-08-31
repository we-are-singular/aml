# Third-party notices

AML Agent Sandbox variants include selected unmodified third-party packages under their respective licenses. Package sources, versions, integrity hashes, and transitive dependencies are recorded in `package-lock.json` and each published image SBOM.

| Package                           | License                    | Source                                                      |
| --------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `@agentclientprotocol/codex-acp`  | Apache-2.0                 | <https://github.com/agentclientprotocol/codex-acp>          |
| `@aml-jsx/cli`                    | MIT                        | <https://github.com/we-are-singular/aml/tree/main/apps/cli> |
| `@aml-jsx/sdk`                    | MIT                        | <https://github.com/we-are-singular/aml/tree/main/sdk>      |
| `@openai/codex`                   | Apache-2.0                 | <https://github.com/openai/codex>                           |
| `@github/copilot`                 | GitHub Copilot CLI License | <https://github.com/github/copilot-cli>                     |
| `glm-acp-agent`                   | Apache-2.0                 | <https://github.com/stefandevo/glm-acp-agent>               |
| `opencode-ai`                     | MIT                        | <https://github.com/anomalyco/opencode>                     |
| `pi-acp`                          | MIT                        | <https://github.com/svkozak/pi-acp>                         |
| `@earendil-works/pi-coding-agent` | MIT                        | <https://github.com/earendil-works/pi>                      |
| `pi-mcp-adapter`                  | MIT                        | <https://github.com/nicobailon/pi-mcp-adapter>              |

The `full` and `copilot` variants include GitHub Copilot CLI unmodified. AML supplies the independent Sandbox, Workspace, ACP orchestration, Tool, structured-output, lifecycle, and compatibility functionality around it. Those variants ship the GitHub Copilot CLI License and retained notices at `/usr/share/doc/aml-agent-sandbox/licenses/GitHub-Copilot-CLI-LICENSE.md` and inside the installed package tree.

License files distributed by npm packages remain in their original locations under `/opt/aml-agent-sandbox/node_modules`. This notice is informational and does not replace those license terms.
