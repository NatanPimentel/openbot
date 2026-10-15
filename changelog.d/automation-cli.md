### Added

- `openbot-cli` runs a task on an agent from a terminal or a script and can wait for the answer. It also changes an agent's model or provider account. It uses the Local scripts API, so only agents with **Local scripts** on can be used. See `docs/automation.md`.
- The Local scripts API has two new routes: `GET /v1/agents/:agentId/deliveries/:deliveryId` gives the state of a sent message and the turn's answer, and `POST /v1/agents/:agentId/settings` changes the model, reasoning effort, provider or provider account.
