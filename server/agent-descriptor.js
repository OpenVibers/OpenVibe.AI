'use strict';
// What OpenVibe.AI tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json (SEO-2).
// Every field is something this site really serves; the purpose is its own llms.txt summary.
module.exports = {
    id: "ai",
    name: "OpenVibe.AI",
    purpose: "One API for chat, summaries, extraction and embeddings across many models, OpenAI-compatible. Every run says which model answered, why and what it cost.",
    home: "https://ai.openvibe.services",
    site: "ai.openvibe.services",
    api: "/api/v1",
    docs: "https://openvibe.services/docs/api",
    policy: {
        auth: ["Network OIDC"],
    },
};
