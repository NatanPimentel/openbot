### Fixed

- An agent that answers in Discord or Slack no longer stops answering after a restart. Before, a restart could make one Discord or Slack conversation the agent's own chat. Then, after a routine ran there, every new message waited with "OpenBot is working on another request" until OpenBot restarted. An agent in this state gets its own chat again, and the conversation stays in its Discord or Slack thread.
