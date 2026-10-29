'use strict';
module.exports = {
    id: 'ai', name: 'OpenVibe.AI',
    purpose: 'One API for chat, generation, summaries, extraction and embeddings across model providers, with attributed runs and usage.',
    home: 'https://ai.openvibe.services', api: '/api/v1', openapi: '/openapi.json',
    docs: 'https://openvibe.services/docs/api',
    policy: { auth: ['none', 'Network OIDC', 'bearer'], rateLimit: 'API quotas are scoped to the caller and project; see /api/v1/quotas for your current allowance.' },
};
