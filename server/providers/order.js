'use strict';
const { AiError } = require('../util');
// Orders are ordinary versioned routes; no parallel provider or model catalogue.
const CAPABILITIES = ['chat', 'vision', 'tools', 'image', 'video', 'speech', 'transcribe', 'embed', 'rerank'];
const capabilityFor = operation => ['complete', 'messages', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json'].includes(operation) ? 'chat' : operation;
const keyFor = capability => 'provider-order.' + capability;
function createProviderOrder({ registry }) {
    async function read(capability) {
        capability = capabilityFor(capability);
        if (!CAPABILITIES.includes(capability)) return null;
        const route = await registry.getRoute(keyFor(capability));
        return route?.options?.provider_order === true ? { capability, enabled: route.status === 'active', version: route.version, choices: route.pinned || [] } : null;
    }
    async function list() {
        return Promise.all(CAPABILITIES.map(async capability => await read(capability) || { capability, enabled: false, version: null, choices: [] }));
    }
    async function save(capability, input, actor) {
        if (!CAPABILITIES.includes(capability) || typeof input?.enabled !== 'boolean' || !Array.isArray(input.choices) || input.choices.length > 64)
            throw new AiError(422, 'ai.invalid', 'A supported capability, enabled flag and at most 64 choices are required');
        const choices = [], seen = new Set();
        for (const choice of input.choices) {
            if (!choice || typeof choice.provider !== 'string' || choice.model != null && typeof choice.model !== 'string' || Object.keys(choice).some(k => !['provider', 'model'].includes(k)))
                throw new AiError(422, 'ai.invalid', 'Each choice needs a provider and optional model');
            const provider = await registry.getProvider(choice.provider);
            if (!provider) throw new AiError(422, 'ai.invalid', 'Unknown provider');
            const model = choice.model || provider.default_model || null;
            if (!model || !await registry.getModel(provider.key, model)) throw new AiError(422, 'ai.invalid', 'Model choices must name a registered model');
            const id = provider.key + ':' + model;
            if (seen.has(id)) throw new AiError(422, 'ai.invalid', 'Duplicate choice');
            seen.add(id); choices.push({ provider: provider.key, model });
        }
        await registry.createRouteVersion(keyFor(capability), { capability, pinned: choices, status: input.enabled ? 'active' : 'disabled', options: { provider_order: true } }, actor);
        return read(capability);
    }
    return { read, list, save };
}
function orderedSubset(candidates, choices) {
    return choices.flatMap(choice => candidates.filter(c => c.provider === choice.provider && (choice.model == null || c.model === choice.model)));
}
module.exports = { createProviderOrder, CAPABILITIES, capabilityFor, orderedSubset };
