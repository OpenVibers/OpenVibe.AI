'use strict';
/**
 * Developer apps (ADR-014; capability ai.app.run, docs/capabilities-proposal/).
 *
 * An app token from OpenVibe.Network has sub `app:app_<ULID>`, actor_type `app`, `project_id`
 * `prj_<ULID>`, `env` sandbox|production and ns [project_id, app.<project_id>.*] (OpenVibe.Network
 * server/developer/tokens.js). Here it becomes an app principal whose subject is its PROJECT:
 *
 *   project_key  'p' + the project's ULID in lowercase    prj_01JAB…  -> p01jab…
 *   attribution  { service: 'network', type: 'project', id: 'prj_…' }   the project the spend belongs to
 *   namespaces   app.<project_key>.*                      the only workflow namespace the app may run
 *
 * project_key follows OpenVibe.Events' developer-app rule (p + the lowercased ULID), so an app's AI
 * workflows are `app.<project_key>.*` beside its event types `app.<project_key>.<name>`.
 *
 * The direct operations ai.app.run names (ai.chat | ai.generate | ai.summarize | ai.classify |
 * ai.extract | ai.embed) are fixed workflows, not namespace lookups: they are the operations the
 * capability grants by route. Everything else an app runs must be inside its own namespace.
 */
const capabilities = require('openvibe-contracts').capabilities;

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const APP_SUB_RE = new RegExp(`^app:app_(${ULID})$`);
const PROJECT_RE = new RegExp(`^prj_(${ULID})$`);
const ENVS = ['sandbox', 'production'];
/** The operations ai.app.run grants by route, as workflow keys (POST /api/v1/<op> is a run of ai.<op>). */
const DIRECT_OPS = Object.freeze(['chat', 'generate', 'summarize', 'classify', 'extract', 'embed'].map((op) => `ai.${op}`));

/** 'prj_01JAB…' -> 'p01jab…' (null for anything that is not a project id). */
function projectKey(projectId) {
    const m = PROJECT_RE.exec(String(projectId || ''));
    return m ? `p${m[1].toLowerCase()}` : null;
}

/** The workflow namespaces an app may run: its own, nothing else. */
function namespacesOf(key) { return [`app.${key}.*`]; }

/** The EntityRef an app's runs are attributed to: its project (Network's entity). */
function appAttribution(principal) { return { service: 'network', type: 'project', id: principal.projectId }; }

/**
 * The app principal for verified token claims, or { error } when the claims are not a usable app
 * token (no project, unknown env, project outside the token's namespaces).
 */
function appPrincipal(claims) {
    const m = APP_SUB_RE.exec(String(claims && claims.sub));
    if (!m) return { error: 'not an app token' };
    if (claims.actor_type && claims.actor_type !== 'app') return { error: 'actor_type must be app' };
    if (!PROJECT_RE.test(String(claims.project_id || ''))) return { error: 'app token without a project_id' };
    const env = claims.env === undefined ? 'production' : claims.env;
    if (!ENVS.includes(env)) return { error: `unknown env ${claims.env}` };
    if (Array.isArray(claims.ns) && claims.ns.length && !claims.ns.includes(claims.project_id)) {
        return { error: 'project_id is not in the token namespaces' };
    }
    return {
        sub: claims.sub,
        appId: `app_${m[1]}`,
        projectId: claims.project_id,
        projectKey: projectKey(claims.project_id),
        env,
        onBehalfOf: typeof claims.on_behalf_of === 'string' ? claims.on_behalf_of : null,
    };
}

/** May this app principal run `workflowKey`? Only the direct operations and its own app.<project_key>.*. */
function appMayRun(principal, workflowKey) {
    const key = String(workflowKey || '');
    if (DIRECT_OPS.includes(key)) return true;
    return capabilities.namespaceAllowed(namespacesOf(principal.projectKey), key);
}

module.exports = { projectKey, appPrincipal, appAttribution, appMayRun, namespacesOf, DIRECT_OPS, ENVS };
