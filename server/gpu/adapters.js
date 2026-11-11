'use strict';
/**
 * The marketplace adapters, built from the owner's policy options. Every adapter has Vast.ai's
 * interface (searchOffers, createInstance, showInstance, destroyInstance); SaladCloud's job queue
 * has the batch adapter's (submitJob, showJob, cancelJob).
 *
 * A keyed provider without its key builds nothing, so the provisioner's rule 1 still holds: no key,
 * no search, no instance, no money. The reserved server has no key because nothing is rented by an
 * API: the owner registers the machine's endpoint and monthly price.
 */
const { vastAdapter } = require('./vast');
const { runpodAdapter } = require('./runpod');
const { saladAdapter, saladQueueAdapter } = require('./salad');
const { tensordockAdapter } = require('./tensordock');
const { shadeformAdapter } = require('./shadeform');
const { verdaAdapter } = require('./verda');
const { thunderAdapter } = require('./thunder');
const { runpodServerlessAdapter } = require('./runpod-serverless');
const { reservedAdapter } = require('./reserved');

const PROVIDERS = Object.freeze([
    'vast', 'runpod', 'salad', 'tensordock', 'shadeform', 'verda', 'thunder', 'runpod_serverless', 'reserved',
]);
// The ones that can be quoted and rented right now. The owner enables them in the console.
const KEYED = Object.freeze(PROVIDERS.filter((p) => p !== 'reserved'));

/** The string option, or the fallback; policy options are all strings. */
function option(options, name, fallback = '') {
    const value = options && options[name];
    return value == null || value === '' ? fallback : String(value);
}

/**
 * Build one adapter, or null when it cannot run (no key, or the reserved box is not registered).
 *
 *   key      the owner's key from the sealed store
 *   options  the owner's policy options (organization, project, image, template_id, ...)
 */
function createAdapter(provider, { fetchImpl = globalThis.fetch, key = null, options = {} } = {}) {
    switch (provider) {
        case 'vast':
            return key ? vastAdapter({ fetchImpl, key }) : null;
        case 'runpod':
            return key ? runpodAdapter({ fetchImpl, key }) : null;
        case 'salad':
            return key ? saladAdapter({ fetchImpl, key, organization: option(options, 'organization'), project: option(options, 'project'), image: option(options, 'image'), replicas: Number(option(options, 'replicas', '3')) || 3 }) : null;
        case 'salad_queue':
            return key ? saladQueueAdapter({ fetchImpl, key, organization: option(options, 'organization'), project: option(options, 'project'), queue: option(options, 'queue') }) : null;
        case 'tensordock':
            return key ? tensordockAdapter({ fetchImpl, key, image: option(options, 'image'), location: option(options, 'location') }) : null;
        case 'shadeform':
            return key ? shadeformAdapter({ fetchImpl, key }) : null;
        case 'verda':
            return key ? verdaAdapter({ fetchImpl, key, image: option(options, 'image'), location: option(options, 'location') }) : null;
        case 'thunder':
            return key ? thunderAdapter({ fetchImpl, key, template: option(options, 'template', 'ubuntu-22.04') }) : null;
        case 'runpod_serverless':
            // RunPod Serverless shares the RunPod key.
            return key ? runpodServerlessAdapter({ fetchImpl, key, templateId: option(options, 'template_id'), pools: option(options, 'pools') ? option(options, 'pools').split(',').map((p) => p.trim()).filter(Boolean) : [], maxWorkers: Number(option(options, 'max_workers', '3')) || 3 }) : null;
        case 'reserved':
            return option(options, 'endpoint') && option(options, 'monthly_nano')
                ? reservedAdapter({ endpoint: option(options, 'endpoint'), monthlyNano: option(options, 'monthly_nano'), name: option(options, 'name', 'reserved') })
                : null;
        default:
            return null;
    }
}

module.exports = { PROVIDERS, KEYED, createAdapter, option };
