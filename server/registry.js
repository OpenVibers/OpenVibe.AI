'use strict';
/**
 * Registry: providers, models, routing profiles, prompt templates and workflow definitions,
 * plus the audit log every change writes to.
 *
 * Versioning: routes, templates and workflows are append-only per key. createXVersion() inserts
 * version n+1; the previous version stays readable forever so a run can always be traced to the
 * exact definition that produced it. The version a run uses is the newest one whose status is
 * 'active'. Lifecycle changes (deprecate, archive, disable) are status updates on one version,
 * audited, and never change its content.
 */
const { sha256, parseJson, iso, AiError, secretRefValid, resolveSecret } = require('./util');
const schemas = require('./schemas');

const PROVIDER_KINDS = ['stub', 'openai', 'anthropic', 'http', 'whisper'];
const FEATURES = ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'embed', 'vision', 'json', 'transcribe'];
const LIFECYCLE = ['draft', 'active', 'deprecated', 'archived'];
const KEY_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;

function createRegistry(db, { clock = { now: () => Date.now() }, env = process.env } = {}) {
    const now = () => iso(clock.now());

    // ── Audit ──────────────────────────────────────────────
    const insAudit = db.prepare('INSERT INTO audit_log (at, actor, action, target_type, target_id, trace_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)');
    function audit(actor, action, targetType, targetId, { trace = null, metadata = {} } = {}) {
        insAudit.run(now(), actor || 'system', action, targetType || null, targetId == null ? null : String(targetId), trace, JSON.stringify(metadata || {}));
    }
    function listAudit({ action, targetType, targetId, limit = 100, before } = {}) {
        const where = [];
        const args = [];
        if (action) { where.push('action = ?'); args.push(action); }
        if (targetType) { where.push('target_type = ?'); args.push(targetType); }
        if (targetId) { where.push('target_id = ?'); args.push(String(targetId)); }
        if (before) { where.push('id < ?'); args.push(Number(before)); }
        const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, limit));
        return rows.map(r => ({ ...r, metadata: parseJson(r.metadata, {}) }));
    }

    // ── Providers ──────────────────────────────────────────
    function decodeProvider(r) {
        if (!r) return null;
        return {
            key: r.key, display_name: r.display_name, kind: r.kind, status: r.status, base_url: r.base_url,
            auth_mode: r.auth_mode, secret_ref: r.secret_ref, default_model: r.default_model,
            capabilities: parseJson(r.capabilities, []), timeout_ms: r.timeout_ms, priority: r.priority,
            metadata: parseJson(r.metadata, {}), origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
        };
    }
    function getProvider(key) { return decodeProvider(db.prepare('SELECT * FROM providers WHERE key = ?').get(key)); }
    function listProviders() { return db.prepare('SELECT * FROM providers ORDER BY priority, key').all().map(decodeProvider); }

    /** Public view: the secret reference name and whether it resolves — never the value. */
    function publicProvider(p, health) {
        if (!p) return null;
        const hasSecret = p.auth_mode === 'none' ? null : Boolean(resolveSecret(p.secret_ref, env));
        return { ...p, credentials: hasSecret === null ? 'not_required' : hasSecret ? 'configured' : 'missing', health: health || null };
    }

    function checkProvider(p) {
        if (!KEY_RE.test(p.key || '')) throw new AiError(422, 'ai.invalid', 'provider key must be lowercase dotted/dashed');
        if (!PROVIDER_KINDS.includes(p.kind)) throw new AiError(422, 'ai.invalid', `provider kind must be one of ${PROVIDER_KINDS.join(', ')}`);
        if (!['active', 'disabled'].includes(p.status)) throw new AiError(422, 'ai.invalid', 'provider status must be active or disabled');
        if (!['none', 'bearer', 'x-api-key'].includes(p.auth_mode)) throw new AiError(422, 'ai.invalid', 'auth_mode must be none, bearer or x-api-key');
        if (!secretRefValid(p.secret_ref)) throw new AiError(422, 'ai.invalid', "secret_ref must be 'env:NAME' (a reference, never a secret value)");
        if (p.base_url && !/^https?:\/\/[^\s]+$/i.test(p.base_url)) throw new AiError(422, 'ai.invalid', 'base_url must be an http(s) URL');
        if (!Array.isArray(p.capabilities) || p.capabilities.some(f => !FEATURES.includes(f))) throw new AiError(422, 'ai.invalid', `capabilities must be a subset of ${FEATURES.join(', ')}`);
    }

    function upsertProvider(input, { actor = 'system', origin = 'admin', trace = null } = {}) {
        const prev = getProvider(input.key);
        const p = {
            key: input.key,
            display_name: input.display_name || (prev && prev.display_name) || input.key,
            kind: input.kind || (prev && prev.kind),
            status: input.status || (prev && prev.status) || 'active',
            base_url: input.base_url !== undefined ? (input.base_url || null) : (prev ? prev.base_url : null),
            auth_mode: input.auth_mode || (prev && prev.auth_mode) || 'none',
            secret_ref: input.secret_ref !== undefined ? (input.secret_ref || null) : (prev ? prev.secret_ref : null),
            default_model: input.default_model !== undefined ? (input.default_model || null) : (prev ? prev.default_model : null),
            capabilities: input.capabilities || (prev && prev.capabilities) || [],
            timeout_ms: Number.isFinite(Number(input.timeout_ms)) ? Math.max(1000, Math.min(600000, Number(input.timeout_ms))) : (prev ? prev.timeout_ms : 30000),
            priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : (prev ? prev.priority : 100),
            metadata: input.metadata || (prev && prev.metadata) || {},
        };
        checkProvider(p);
        const t = now();
        db.prepare(`INSERT INTO providers (key, display_name, kind, status, base_url, auth_mode, secret_ref, default_model, capabilities, timeout_ms, priority, metadata, origin, created_at, updated_at)
            VALUES (@key, @display_name, @kind, @status, @base_url, @auth_mode, @secret_ref, @default_model, @capabilities, @timeout_ms, @priority, @metadata, @origin, @t, @t)
            ON CONFLICT(key) DO UPDATE SET display_name = excluded.display_name, kind = excluded.kind, status = excluded.status, base_url = excluded.base_url,
              auth_mode = excluded.auth_mode, secret_ref = excluded.secret_ref, default_model = excluded.default_model, capabilities = excluded.capabilities,
              timeout_ms = excluded.timeout_ms, priority = excluded.priority, metadata = excluded.metadata, origin = excluded.origin, updated_at = excluded.updated_at`)
            .run({ ...p, capabilities: JSON.stringify(p.capabilities), metadata: JSON.stringify(p.metadata), origin, t });
        audit(actor, prev ? 'provider.update' : 'provider.create', 'provider', p.key, { trace, metadata: { kind: p.kind, status: p.status, base_url: p.base_url, secret_ref: p.secret_ref, origin } });
        return getProvider(p.key);
    }

    // ── Models ─────────────────────────────────────────────
    function decodeModel(r) {
        if (!r) return null;
        return {
            provider_key: r.provider_key, model_key: r.model_key, display_name: r.display_name, type: r.type, status: r.status,
            context_window: r.context_window, max_output: r.max_output,
            cost: { in_per_mtok: r.cost_in_per_mtok, out_per_mtok: r.cost_out_per_mtok, cached_per_mtok: r.cost_cached_per_mtok },
            supports: { json: !!r.supports_json, tools: !!r.supports_tools, streaming: !!r.supports_streaming, vision: !!r.supports_vision },
            metadata: parseJson(r.metadata, {}), created_at: r.created_at, updated_at: r.updated_at,
        };
    }
    function getModel(providerKey, modelKey) { return decodeModel(db.prepare('SELECT * FROM models WHERE provider_key = ? AND model_key = ?').get(providerKey, modelKey)); }
    function listModels({ provider } = {}) {
        const rows = provider ? db.prepare('SELECT * FROM models WHERE provider_key = ? ORDER BY model_key').all(provider) : db.prepare('SELECT * FROM models ORDER BY provider_key, model_key').all();
        return rows.map(decodeModel);
    }
    function upsertModel(input, { actor = 'system', trace = null } = {}) {
        if (!getProvider(input.provider_key)) throw new AiError(404, 'ai.not_found', `no provider ${input.provider_key}`);
        if (!input.model_key || String(input.model_key).length > 200) throw new AiError(422, 'ai.invalid', 'model_key required');
        const prev = getModel(input.provider_key, input.model_key);
        const type = input.type || (prev && prev.type) || 'chat';
        if (!['chat', 'vision', 'embedding', 'stt'].includes(type)) throw new AiError(422, 'ai.invalid', 'model type must be chat, vision, embedding or stt');
        const status = input.status || (prev && prev.status) || 'active';
        if (!['active', 'disabled'].includes(status)) throw new AiError(422, 'ai.invalid', 'model status must be active or disabled');
        const cost = input.cost || (prev && prev.cost) || {};
        const sup = input.supports || (prev && prev.supports) || {};
        const t = now();
        db.prepare(`INSERT INTO models (provider_key, model_key, display_name, type, status, context_window, max_output, cost_in_per_mtok, cost_out_per_mtok, cost_cached_per_mtok,
                supports_json, supports_tools, supports_streaming, supports_vision, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider_key, model_key) DO UPDATE SET display_name = excluded.display_name, type = excluded.type, status = excluded.status,
              context_window = excluded.context_window, max_output = excluded.max_output, cost_in_per_mtok = excluded.cost_in_per_mtok,
              cost_out_per_mtok = excluded.cost_out_per_mtok, cost_cached_per_mtok = excluded.cost_cached_per_mtok, supports_json = excluded.supports_json,
              supports_tools = excluded.supports_tools, supports_streaming = excluded.supports_streaming, supports_vision = excluded.supports_vision,
              metadata = excluded.metadata, updated_at = excluded.updated_at`)
            .run(input.provider_key, input.model_key, input.display_name || (prev && prev.display_name) || input.model_key, type, status,
                input.context_window ?? (prev && prev.context_window) ?? null, input.max_output ?? (prev && prev.max_output) ?? null,
                cost.in_per_mtok ?? null, cost.out_per_mtok ?? null, cost.cached_per_mtok ?? null,
                sup.json === false ? 0 : 1, sup.tools ? 1 : 0, sup.streaming ? 1 : 0, sup.vision ? 1 : 0,
                JSON.stringify(input.metadata || (prev && prev.metadata) || {}), t, t);
        audit(actor, prev ? 'model.update' : 'model.create', 'model', `${input.provider_key}/${input.model_key}`, { trace, metadata: { status, type } });
        return getModel(input.provider_key, input.model_key);
    }

    // ── Versioned records (routes, templates, workflows) ───
    function nextVersion(table, key) {
        const r = db.prepare(`SELECT MAX(version) AS v FROM ${table} WHERE key = ?`).get(key);
        return (r && r.v ? r.v : 0) + 1;
    }
    function latestAny(table, key) {
        return db.prepare(`SELECT * FROM ${table} WHERE key = ? ORDER BY version DESC LIMIT 1`).get(key);
    }
    function latestActive(table, key) {
        return db.prepare(`SELECT * FROM ${table} WHERE key = ? AND status = 'active' ORDER BY version DESC LIMIT 1`).get(key);
    }

    // Routes
    function decodeRoute(r) {
        if (!r) return null;
        return {
            key: r.key, version: r.version, status: r.status, primary: { provider: r.primary_provider, model: r.primary_model },
            fallbacks: parseJson(r.fallbacks, []), options: parseJson(r.options, {}), max_output_tokens: r.max_output_tokens,
            response_format: r.response_format, timeout_ms: r.timeout_ms, alias_of: r.alias_of, created_by: r.created_by, created_at: r.created_at,
        };
    }
    const routeContent = (r) => sha256({ p: r.primary, f: r.fallbacks, o: r.options, m: r.max_output_tokens, rf: r.response_format, t: r.timeout_ms, a: r.alias_of, s: r.status });
    function createRouteVersion(key, input, { actor = 'system', trace = null } = {}) {
        if (!KEY_RE.test(key || '')) throw new AiError(422, 'ai.invalid', 'route key must be lowercase dotted');
        const prev = decodeRoute(latestAny('routes', key));
        const r = {
            primary: input.primary || (prev && prev.primary),
            fallbacks: input.fallbacks !== undefined ? input.fallbacks : (prev ? prev.fallbacks : []),
            options: input.options !== undefined ? input.options : (prev ? prev.options : {}),
            max_output_tokens: input.max_output_tokens !== undefined ? input.max_output_tokens : (prev ? prev.max_output_tokens : null),
            response_format: input.response_format || (prev && prev.response_format) || 'text',
            timeout_ms: input.timeout_ms !== undefined ? input.timeout_ms : (prev ? prev.timeout_ms : null),
            alias_of: input.alias_of !== undefined ? input.alias_of : (prev ? prev.alias_of : null),
            status: input.status || 'active',
        };
        if (!r.alias_of) {
            if (!r.primary || !r.primary.provider) throw new AiError(422, 'ai.invalid', 'route needs primary.provider');
            for (const c of [r.primary, ...(r.fallbacks || [])]) {
                if (!c || !getProvider(c.provider)) throw new AiError(422, 'ai.invalid', `route references unknown provider ${c && c.provider}`);
            }
        } else if (!latestAny('routes', r.alias_of)) throw new AiError(422, 'ai.invalid', `alias target ${r.alias_of} does not exist`);
        if (!Array.isArray(r.fallbacks)) throw new AiError(422, 'ai.invalid', 'fallbacks must be an array');
        if (!['text', 'json'].includes(r.response_format)) throw new AiError(422, 'ai.invalid', 'response_format must be text or json');
        if (!['active', 'disabled'].includes(r.status)) throw new AiError(422, 'ai.invalid', 'route status must be active or disabled');
        const version = nextVersion('routes', key);
        db.prepare(`INSERT INTO routes (key, version, status, primary_provider, primary_model, fallbacks, options, max_output_tokens, response_format, timeout_ms, alias_of, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(key, version, r.status, r.alias_of ? (r.primary && r.primary.provider) || 'stub' : r.primary.provider, r.primary ? r.primary.model || null : null,
                JSON.stringify(r.fallbacks || []), JSON.stringify(r.options || {}), r.max_output_tokens, r.response_format, r.timeout_ms, r.alias_of, actor, now());
        audit(actor, 'route.version', 'route', key, { trace, metadata: { version, previous: prev ? prev.version : null, status: r.status, alias_of: r.alias_of } });
        return getRoute(key, version);
    }
    function getRoute(key, version) {
        return decodeRoute(version ? db.prepare('SELECT * FROM routes WHERE key = ? AND version = ?').get(key, version) : latestAny('routes', key));
    }
    /** The route a run uses: newest version, which must be active; aliases are followed (max 3 hops). */
    function resolveRoute(key) {
        let k = key;
        for (let hop = 0; hop < 4; hop++) {
            const r = decodeRoute(latestAny('routes', k));
            if (!r) return null;
            if (r.status !== 'active') return { ...r, disabled: true };
            if (!r.alias_of) return r;
            k = r.alias_of;
        }
        return null;
    }
    function listRoutes({ history = false } = {}) {
        const rows = history ? db.prepare('SELECT * FROM routes ORDER BY key, version').all()
            : db.prepare('SELECT r.* FROM routes r JOIN (SELECT key, MAX(version) v FROM routes GROUP BY key) m ON m.key = r.key AND m.v = r.version ORDER BY r.key').all();
        return rows.map(decodeRoute);
    }

    // Templates
    function decodeTemplate(r) {
        if (!r) return null;
        return {
            key: r.key, version: r.version, name: r.name, description: r.description,
            input_schema: parseJson(r.input_schema, {}), output_schema: parseJson(r.output_schema, {}),
            system_prompt: r.system_prompt, user_prompt: r.user_prompt, default_route: r.default_route,
            owner: r.owner, visibility: r.visibility, status: r.status, metadata: parseJson(r.metadata, {}),
            created_by: r.created_by, created_at: r.created_at,
        };
    }
    const templateContent = (t) => sha256({ n: t.name, d: t.description, i: t.input_schema, o: t.output_schema, s: t.system_prompt, u: t.user_prompt, r: t.default_route, v: t.visibility, m: t.metadata });
    function createTemplateVersion(key, input, { actor = 'system', trace = null } = {}) {
        if (!KEY_RE.test(key || '')) throw new AiError(422, 'ai.invalid', 'template key must be lowercase dotted');
        const prev = decodeTemplate(latestAny('templates', key));
        const t = {
            name: input.name || (prev && prev.name) || key,
            description: input.description !== undefined ? input.description : (prev ? prev.description : null),
            input_schema: input.input_schema || (prev && prev.input_schema) || { type: 'object' },
            output_schema: input.output_schema || (prev && prev.output_schema) || {},
            system_prompt: input.system_prompt !== undefined ? String(input.system_prompt) : (prev ? prev.system_prompt : ''),
            user_prompt: input.user_prompt !== undefined ? String(input.user_prompt) : (prev ? prev.user_prompt : ''),
            default_route: input.default_route !== undefined ? input.default_route : (prev ? prev.default_route : null),
            owner: input.owner || (prev && prev.owner) || 'ai',
            visibility: input.visibility || (prev && prev.visibility) || 'internal',
            status: input.status || 'active',
            metadata: input.metadata || (prev && prev.metadata) || {},
        };
        schemas.assertSchema(t.input_schema, 'input_schema');
        schemas.assertSchema(t.output_schema, 'output_schema');
        if (!LIFECYCLE.includes(t.status)) throw new AiError(422, 'ai.invalid', `template status must be one of ${LIFECYCLE.join(', ')}`);
        if (!['public', 'first-party', 'internal'].includes(t.visibility)) throw new AiError(422, 'ai.invalid', 'visibility must be public, first-party or internal');
        const version = nextVersion('templates', key);
        db.prepare(`INSERT INTO templates (key, version, name, description, input_schema, output_schema, system_prompt, user_prompt, default_route, owner, visibility, status, metadata, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(key, version, t.name, t.description, JSON.stringify(t.input_schema), JSON.stringify(t.output_schema), t.system_prompt, t.user_prompt,
                t.default_route, t.owner, t.visibility, t.status, JSON.stringify(t.metadata), actor, now());
        audit(actor, 'template.version', 'template', key, { trace, metadata: { version, previous: prev ? prev.version : null, status: t.status, content_hash: templateContent(t) } });
        return getTemplate(key, version);
    }
    function getTemplate(key, version) {
        return decodeTemplate(version ? db.prepare('SELECT * FROM templates WHERE key = ? AND version = ?').get(key, version) : latestAny('templates', key));
    }
    function activeTemplate(key) { return decodeTemplate(latestActive('templates', key)); }
    function listTemplates({ history = false } = {}) {
        const rows = history ? db.prepare('SELECT * FROM templates ORDER BY key, version').all()
            : db.prepare('SELECT t.* FROM templates t JOIN (SELECT key, MAX(version) v FROM templates GROUP BY key) m ON m.key = t.key AND m.v = t.version ORDER BY t.key').all();
        return rows.map(decodeTemplate);
    }

    // Workflows
    function decodeWorkflow(r) {
        if (!r) return null;
        return {
            key: r.key, version: r.version, name: r.name, description: r.description, namespace: r.namespace,
            input_schema: parseJson(r.input_schema, {}), output_schema: parseJson(r.output_schema, {}),
            steps: parseJson(r.steps, []), default_route: r.default_route, cache_mode: r.cache_mode, cache_ttl_sec: r.cache_ttl_sec,
            status: r.status, metadata: parseJson(r.metadata, {}), created_by: r.created_by, created_at: r.created_at,
        };
    }
    const workflowContent = (w) => sha256({ n: w.name, d: w.description, ns: w.namespace, i: w.input_schema, o: w.output_schema, s: w.steps, r: w.default_route, c: w.cache_mode, ttl: w.cache_ttl_sec, m: w.metadata });
    function createWorkflowVersion(key, input, { actor = 'system', trace = null } = {}) {
        if (!KEY_RE.test(key || '') || key.split('.').length < 2) throw new AiError(422, 'ai.invalid', 'workflow key must be <namespace>.<name>');
        const prev = decodeWorkflow(latestAny('workflows', key));
        const w = {
            name: input.name || (prev && prev.name) || key,
            description: input.description !== undefined ? input.description : (prev ? prev.description : null),
            namespace: input.namespace || (prev && prev.namespace) || key.split('.')[0],
            input_schema: input.input_schema || (prev && prev.input_schema),
            output_schema: input.output_schema || (prev && prev.output_schema),
            steps: input.steps || (prev && prev.steps),
            default_route: input.default_route !== undefined ? input.default_route : (prev ? prev.default_route : null),
            cache_mode: input.cache_mode || (prev && prev.cache_mode) || 'private',
            cache_ttl_sec: input.cache_ttl_sec !== undefined ? input.cache_ttl_sec : (prev ? prev.cache_ttl_sec : null),
            status: input.status || 'active',
            metadata: input.metadata || (prev && prev.metadata) || {},
        };
        schemas.assertSchema(w.input_schema, 'input_schema');
        schemas.assertSchema(w.output_schema, 'output_schema');
        if (!Array.isArray(w.steps) || !w.steps.length) throw new AiError(422, 'ai.invalid', 'workflow needs at least one step');
        for (const s of w.steps) {
            if (!s || !['llm', 'passthrough', 'transcribe', 'embed'].includes(s.kind)) throw new AiError(422, 'ai.invalid', 'step kind must be llm, passthrough, transcribe or embed');
            if (s.kind === 'llm' && !(s.template && latestAny('templates', s.template))) throw new AiError(422, 'ai.invalid', `step references unknown template ${s.template}`);
        }
        if (!['none', 'private', 'service'].includes(w.cache_mode)) throw new AiError(422, 'ai.invalid', 'cache_mode must be none, private or service');
        if (!LIFECYCLE.includes(w.status)) throw new AiError(422, 'ai.invalid', `workflow status must be one of ${LIFECYCLE.join(', ')}`);
        const version = nextVersion('workflows', key);
        db.prepare(`INSERT INTO workflows (key, version, name, description, namespace, input_schema, output_schema, steps, default_route, cache_mode, cache_ttl_sec, status, metadata, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(key, version, w.name, w.description, w.namespace, JSON.stringify(w.input_schema), JSON.stringify(w.output_schema), JSON.stringify(w.steps),
                w.default_route, w.cache_mode, w.cache_ttl_sec, w.status, JSON.stringify(w.metadata), actor, now());
        audit(actor, 'workflow.version', 'workflow', key, { trace, metadata: { version, previous: prev ? prev.version : null, status: w.status, content_hash: workflowContent(w) } });
        return getWorkflow(key, version);
    }
    function getWorkflow(key, version) {
        return decodeWorkflow(version ? db.prepare('SELECT * FROM workflows WHERE key = ? AND version = ?').get(key, version) : latestAny('workflows', key));
    }
    function activeWorkflow(key) { return decodeWorkflow(latestActive('workflows', key)); }
    function listWorkflows({ history = false, namespace } = {}) {
        let rows = history ? db.prepare('SELECT * FROM workflows ORDER BY key, version').all()
            : db.prepare('SELECT w.* FROM workflows w JOIN (SELECT key, MAX(version) v FROM workflows GROUP BY key) m ON m.key = w.key AND m.v = w.version ORDER BY w.key').all();
        if (namespace) rows = rows.filter(r => r.namespace === namespace);
        return rows.map(decodeWorkflow);
    }

    /** Lifecycle change on one version of a template/workflow/route (status only; audited). */
    function setStatus(kind, key, version, status, { actor = 'system', trace = null } = {}) {
        const table = { template: 'templates', workflow: 'workflows', route: 'routes' }[kind];
        if (!table) throw new AiError(400, 'ai.invalid', 'unknown kind');
        const allowed = kind === 'route' ? ['active', 'disabled'] : LIFECYCLE;
        if (!allowed.includes(status)) throw new AiError(422, 'ai.invalid', `status must be one of ${allowed.join(', ')}`);
        const row = db.prepare(`SELECT status FROM ${table} WHERE key = ? AND version = ?`).get(key, version);
        if (!row) throw new AiError(404, 'ai.not_found', `no ${kind} ${key} v${version}`);
        db.prepare(`UPDATE ${table} SET status = ? WHERE key = ? AND version = ?`).run(status, key, version);
        audit(actor, `${kind}.status`, kind, key, { trace, metadata: { version, from: row.status, to: status } });
        return { key, version, status };
    }

    /**
     * Seeding: insert a code-defined record when it is missing, or add a new version when the code
     * changed it and nobody edited it through the admin API since (admin edits always win).
     */
    function seedVersioned(kind, key, def) {
        const [table, create, decode, content] = {
            route: ['routes', createRouteVersion, decodeRoute, routeContent],
            template: ['templates', createTemplateVersion, decodeTemplate, templateContent],
            workflow: ['workflows', createWorkflowVersion, decodeWorkflow, workflowContent],
        }[kind];
        const latest = decode(latestAny(table, key));
        if (!latest) return create(key, def, { actor: 'seed' });
        if (latest.created_by !== 'seed') return latest;
        const merged = { ...latest, ...def };
        if (content(merged) === content(latest) && (def.status || 'active') === latest.status) return latest;
        return create(key, def, { actor: 'seed' });
    }

    return {
        audit, listAudit,
        getProvider, listProviders, upsertProvider, publicProvider,
        getModel, listModels, upsertModel,
        createRouteVersion, getRoute, resolveRoute, listRoutes,
        createTemplateVersion, getTemplate, activeTemplate, listTemplates,
        createWorkflowVersion, getWorkflow, activeWorkflow, listWorkflows,
        setStatus, seedVersioned,
    };
}

module.exports = { createRegistry, PROVIDER_KINDS, FEATURES, LIFECYCLE };
