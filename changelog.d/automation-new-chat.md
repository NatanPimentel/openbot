### Added

- `openbot-cli agent new-chat <agent>` starts a new chat with an agent from a terminal or a script: the agent forgets the conversation and its setup stays, the same as **New chat** in the agent's settings. The Local scripts API has the matching route `POST /v1/agents/:agentId/context/clear`, which answers `409` while the agent works. See `docs/automation.md`.
