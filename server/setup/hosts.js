'use strict';
/**
 * The GPU hosts and the servers the owner can configure in the guided setup (plan §AB.10, §AB.17).
 *
 * One row per host. A row is a key the owner enters in Network's admin Setup tab, in the group it belongs to:
 * the GPUs group for the GPU marketplaces, the Servers group for the hosts that run an agent desktop, a Codes
 * runner or a router. Every row says what it unlocks, where the key is made, what to press there and how the
 * row is tested (one cheap authenticated read: an account, a server list, a balance - never a rent, never a
 * spend).
 *
 *   group         the Setup group the row belongs to (openvibe-shared's OWNER_INPUT_GROUPS).
 *   origin        the API address the key is sealed to: the key only ever goes to this host, never anywhere else.
 *   keys_page     where the key is made, the provider's own page.
 *   keys_how      one line: what to press there.
 *   unlocks       one line: what the key turns on.
 *   parts         the other fields of the same row (a provider that needs more than one value: OVHcloud's
 *                 application key and consumer key; Oracle's tenancy, user, fingerprint and region; Salad's
 *                 organization and project). They are fields of one row, not rows of their own: the row is the
 *                 host, the parts are what that host asks for besides the key.
 *   test          one cheap read: { url, auth, name, list } - the list is the array in the answer that proves
 *                 the key works (servers, projects, models...). Null when the host has no public API to read
 *                 (its key is only used by its own console).
 *   price         the price feed: { kind, source_url, needs_key }. Null when the host publishes no price we
 *                 can read.
 *
 * The facts here were read on 2026-11-14 from the providers' own pages and APIs (see each row's source), and
 * the prices the estate already recorded are in server/setup/prices.js. Nothing here costs money: a test never
 * creates, rents or buys anything.
 */

/** The Setup group for the GPU marketplaces. */
const GPU_GROUP = 'gpus';
/** The Setup group for the hosts that run agent desktops, Codes runners and routers (plan §AB.17). */
const SERVER_GROUP = 'servers';

/**
 * The GPU marketplaces (plan §AB.10: "the GPUs step lists RunPod, Vast.ai, Lambda, TensorDock, Salad,
 * Hyperbolic, FluidStack, Jarvislabs, Paperspace, Akash, CoreWeave and the rest the research finds").
 *
 * Vast.ai and RunPod were the two the GPU provisioner already rented from (server/gpu/); they keep their rows,
 * their origins and their tests. The rest are rows now: the owner can enter the key, the row can be tested, and
 * the ones with a price we can read also appear in the price table (GET /api/v1/prices/gpus).
 */
const GPU_HOSTS = Object.freeze([
    {
        id: 'vast', name: 'Vast.ai', group: GPU_GROUP, origin: 'https://console.vast.ai',
        keys_page: 'https://cloud.vast.ai/manage-keys/',
        keys_how: 'Create an API key with the Instance read and write permissions, for the account whose credit pays for the GPUs.',
        unlocks: 'Lets AI rent Vast.ai GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://console.vast.ai/api/v0/users/current/', auth: 'bearer', name: 'Vast.ai', says: 'the account' },
        price: { kind: 'vast', source_url: 'https://console.vast.ai/api/v0/bundles/' },
    },
    {
        id: 'runpod', name: 'RunPod', group: GPU_GROUP, origin: 'https://api.runpod.io',
        keys_page: 'https://www.runpod.io/console/user/settings',
        keys_how: 'Under API Keys create a key with Read/Write access, for the account whose balance pays for the GPUs.',
        unlocks: 'Lets AI rent RunPod GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://api.runpod.io/v2/pods', auth: 'bearer', name: 'RunPod', list: 'pods' },
        price: { kind: 'runpod', source_url: 'https://api.runpod.io/graphql', needs_key: true },
    },
    {
        id: 'lambda', name: 'Lambda Labs', group: GPU_GROUP, origin: 'https://cloud.lambdalabs.com',
        keys_page: 'https://cloud.lambdalabs.com/api-keys',
        keys_how: 'Sign in to the Lambda Cloud console, open API Keys, and create a key for the account that pays for the GPUs.',
        unlocks: 'Lets AI rent Lambda Labs GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://cloud.lambdalabs.com/api/v1/instance-types', auth: 'bearer', name: 'Lambda Labs', list: 'instance types', list_path: 'instance_types' },
        price: { kind: 'lambda', source_url: 'https://cloud.lambdalabs.com/api/v1/instance-types', needs_key: true },
    },
    {
        id: 'salad', name: 'Salad (SaladCloud)', group: GPU_GROUP, origin: 'https://api.salad.com',
        keys_page: 'https://app.salad.com/user-settings/api-keys',
        keys_how: 'Sign in to the Salad Portal, open User Settings, API keys, and create a key for the organization that pays.',
        unlocks: 'Lets AI rent Salad GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        parts: [
            { key: 'organization', title: 'Salad organization name', description: 'The Salad organization the key belongs to, as it is spelled in the portal (a name, not an id). The container list is read inside it.' },
            { key: 'project', title: 'Salad project name', description: 'The project inside that organization the agent\'s own containers belong to, as it is spelled in the portal.' },
        ],
        test: { url: 'https://api.salad.com/api/public/organizations/{organization}/projects/{project}/containers', auth: 'x-api-key', name: 'Salad', list: 'container groups', list_path: 'items' },
        price: { kind: 'recorded', source_url: 'https://salad.com/pricing' },
    },
    {
        id: 'tensordock', name: 'TensorDock', group: GPU_GROUP, origin: 'https://dashboard.tensordock.com',
        keys_page: 'https://www.tensordock.com/',
        keys_how: 'Sign in to the TensorDock console, open API keys, and create a key for the account whose balance pays for the GPUs.',
        unlocks: 'Lets AI rent TensorDock GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        // TensorDock has no public API to read (read 2026-11-14: its console has no API section and
        // /api/v1/… answers 404), so the row has no test: there is nothing cheap to ask.
        test: null,
        price: { kind: 'recorded', source_url: 'https://www.tensordock.com/' },
    },
    {
        id: 'hyperbolic', name: 'Hyperbolic', group: GPU_GROUP, origin: 'https://api.hyperbolic.xyz',
        keys_page: 'https://app.hyperbolic.ai/settings',
        keys_how: 'Sign in to the Hyperbolic console, open Settings, API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Hyperbolic GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://api.hyperbolic.xyz/v1/models', auth: 'bearer', name: 'Hyperbolic', list: 'models', list_path: 'data' },
        price: null,
    },
    {
        id: 'fluidstack', name: 'FluidStack', group: GPU_GROUP, origin: 'https://api.fluidstack.io',
        keys_page: 'https://console.fluidstack.io/',
        keys_how: 'Sign in to the FluidStack console, open Settings, API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent FluidStack GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        // No public account read (read 2026-11-14): their console has no API section and api.fluidstack.io
        // does not answer from here, so there is no cheap read to test the key with.
        test: null,
        price: null,
    },
    {
        id: 'jarvislabs', name: 'Jarvis Labs', group: GPU_GROUP, origin: 'https://api.jarvislabs.com',
        keys_page: 'https://jarvislabs.com/gpu-compute/',
        keys_how: 'Sign in to the Jarvis Labs console, open API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Jarvis Labs GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: null,
        price: null,
    },
    {
        id: 'paperspace', name: 'Paperspace', group: GPU_GROUP, origin: 'https://api.paperspace.io',
        keys_page: 'https://console.paperspace.io/account/keys',
        keys_how: 'Sign in to the Paperspace console, open Account, API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Paperspace GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: null,
        price: null,
    },
    {
        id: 'akash', name: 'Akash', group: GPU_GROUP, origin: 'https://api.akash.network',
        keys_page: 'https://akash.network/',
        keys_how: 'Sign in to the Akash console, open your account settings, and create an API token for the account that pays.',
        unlocks: 'Lets AI rent GPUs on the Akash marketplace to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: null,
        price: { kind: 'recorded', source_url: 'https://akash.network/pricing/gpus' },
    },
    {
        id: 'shadeform', name: 'Shadeform', group: GPU_GROUP, origin: 'https://api.shadeform.ai',
        keys_page: 'https://console.shadeform.com/',
        keys_how: 'Sign in to the Shadeform console, open API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Shadeform GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://api.shadeform.ai/v1/user', auth: 'x-api-key', name: 'Shadeform' },
        price: null,
    },
    {
        id: 'verda', name: 'Verda (DataCrunch)', group: GPU_GROUP, origin: 'https://api.datacrunch.io',
        keys_page: 'https://verda.com/console/',
        keys_how: 'Sign in to the Verda console, open API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Verda GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: { url: 'https://api.datacrunch.io/v1/user', auth: 'bearer', name: 'Verda' },
        price: null,
    },
    {
        id: 'thunder', name: 'Thunder Compute', group: GPU_GROUP, origin: 'https://api.thundercompute.com:8443',
        keys_page: 'https://www.thundercompute.com/',
        keys_how: 'Sign in to the Thunder Compute console, open API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent Thunder Compute GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        // No account read we could find (read 2026-11-14): every path of api.thundercompute.com answers 404.
        test: null,
        price: null,
    },
    {
        id: 'coreweave', name: 'CoreWeave', group: GPU_GROUP, origin: 'https://api.coreweave.com',
        keys_page: 'https://cloud.coreweave.com/account/api-keys',
        keys_how: 'Sign in to the CoreWeave console, open Account, API keys, and create a key for the account that pays.',
        unlocks: 'Lets AI rent CoreWeave GPUs to run open models when they are needed, and for a person\'s own endpoint. Without a GPU key and a monthly cap nothing is rented.',
        test: null,
        price: null,
    },
]);

/**
 * The servers for agent desktops, Codes runners and routers (plan §AB.17: "Hetzner (Cloud + Server Auction
 * read), OVH, Contabo, Netcup, Vultr, DigitalOcean, Linode/Akamai, Oracle free tier, Scaleway, UpCloud, the
 * cheapest per job ranked by a live price table").
 *
 * The row's key is what the owner enters; the price table (GET /api/v1/prices/servers) ranks the hosts by the
 * price of the cheapest plan that fits an agent desktop (2 vCPU, 4 GB). The test is always one cheap read:
 * the servers it lists, the projects it owns, the account it belongs to. Nothing is created.
 */
const SERVER_HOSTS = Object.freeze([
    {
        id: 'hetzner', name: 'Hetzner Cloud', group: SERVER_GROUP, origin: 'https://api.hetzner.cloud',
        keys_page: 'https://docs.hetzner.cloud/#authentication',
        keys_how: 'In the Hetzner Cloud console open Project, API Tokens, and create a token for the project that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Hetzner Cloud, the cheapest hosts in the table.',
        test: { url: 'https://api.hetzner.cloud/v1/servers', auth: 'bearer', name: 'Hetzner Cloud', list: 'servers' },
        price: { kind: 'hetzner', source_url: 'https://www.hetzner.com/cloud/cost-optimized/' },
    },
    {
        id: 'hetzner-auction', name: 'Hetzner Server Auction', group: SERVER_GROUP, origin: 'https://www.hetzner.com/sb/', no_key: true,
        keys_page: 'https://www.hetzner.com/sb/',
        keys_how: 'The auction needs no key: it is a public price read, and a server is won on the auction site itself.',
        unlocks: 'Shows the refurbished dedicated servers Hetzner auctions off, so the cheapest per job can be found. Nothing is bought here.',
        // A price read only: the auction has no API key of its own (read 2026-11-14).
        test: null,
        price: { kind: 'hetzner-auction', source_url: 'https://www.hetzner.com/sb/' },
    },
    {
        id: 'ovh', name: 'OVHcloud', group: SERVER_GROUP, origin: 'https://api.ovh.com',
        keys_page: 'https://api.ovh.com/createToken/',
        keys_how: 'Create an application at the OVH token page, then create a token with the read rights you need; copy the application key, the application secret and the consumer key.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on OVHcloud.',
        parts: [
            { key: 'application_key', title: 'OVHcloud application key', description: 'The application key the token belongs to, as the OVH token page shows it (it starts with an app key id). It is not a secret on its own.' },
            { key: 'consumer_key', title: 'OVHcloud consumer key', description: 'The consumer key the token belongs to, as the OVH token page shows it. It is not a secret on its own.' },
        ],
        test: { url: 'https://api.ovh.com/v1/me', auth: 'ovh', name: 'OVHcloud' },
        price: { kind: 'ovh', source_url: 'https://eu.api.ovh.com/1.0/order/catalog/public/vps?ovhSubsidiary=IE' },
    },
    {
        id: 'vultr', name: 'Vultr', group: SERVER_GROUP, origin: 'https://api.vultr.com',
        keys_page: 'https://my.vultr.com/settings/#settingsapi',
        keys_how: 'Open the API settings in your Vultr profile and create an API key for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Vultr.',
        test: { url: 'https://api.vultr.com/v2/account', auth: 'bearer', name: 'Vultr' },
        price: { kind: 'vultr', source_url: 'https://api.vultr.com/v2/plans' },
    },
    {
        id: 'digitalocean', name: 'DigitalOcean', group: SERVER_GROUP, origin: 'https://api.digitalocean.com',
        keys_page: 'https://cloud.digitalocean.com/account/api/tokens',
        keys_how: 'Open the API tokens page in the DigitalOcean account and create a token with read scope for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on DigitalOcean.',
        test: { url: 'https://api.digitalocean.com/v2/account', auth: 'bearer', name: 'DigitalOcean' },
        price: { kind: 'digitalocean', source_url: 'https://api.digitalocean.com/v2/sizes', needs_key: true },
    },
    {
        id: 'linode', name: 'Linode (Akamai)', group: SERVER_GROUP, origin: 'https://api.linode.com',
        keys_page: 'https://cloud.linode.com/profile/tokens',
        keys_how: 'Open the API tokens page in the Linode profile and create a token with read scope for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Linode (Akamai).',
        test: { url: 'https://api.linode.com/v4/account', auth: 'bearer', name: 'Linode' },
        price: { kind: 'linode', source_url: 'https://api.linode.com/v4/linode/types' },
    },
    {
        id: 'scaleway', name: 'Scaleway', group: SERVER_GROUP, origin: 'https://api.scaleway.com',
        keys_page: 'https://console.scaleway.com/iam/api-keys',
        keys_how: 'Sign in to the Scaleway console, open IAM, API keys, and create a key for the project that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Scaleway.',
        test: { url: 'https://api.scaleway.com/account/v3/projects', auth: 'x-auth-token', name: 'Scaleway', list: 'projects' },
        price: { kind: 'recorded', source_url: 'https://www.scaleway.com/en/pricing/' },
    },
    {
        id: 'upcloud', name: 'UpCloud', group: SERVER_GROUP, origin: 'https://api.upcloud.com',
        keys_page: 'https://upcloud.com/1.3/apikeys',
        keys_how: 'Open the API keys page in your UpCloud account and create a key for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on UpCloud.',
        parts: [
            { key: 'user', title: 'UpCloud user name', description: 'The user name the API key belongs to, as the API keys page shows it. UpCloud signs each call with it and the key together.' },
        ],
        test: { url: 'https://api.upcloud.com/1.3/server', auth: 'basic', name: 'UpCloud', list: 'servers' },
        price: { kind: 'upcloud', source_url: 'https://api.upcloud.com/1.3/price', needs_key: true },
    },
    {
        id: 'oracle', name: 'Oracle Cloud (free tier)', group: SERVER_GROUP, origin: 'https://api.oracle.com', bind: 'region',
        keys_page: 'https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm',
        keys_how: 'In the Oracle Cloud console open Identity, Users, the API keys of your user, and add an API signing key; copy the fingerprint and download the private key.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Oracle Cloud, whose free tier costs nothing.',
        parts: [
            { key: 'tenancy', title: 'Oracle Cloud tenancy OCID', description: 'The tenancy OCID of the account the key belongs to, as the Oracle Cloud console shows it under Identity, Domains.' },
            { key: 'user', title: 'Oracle Cloud user OCID', description: 'The user OCID whose API key this is, as the Oracle Cloud console shows it under Identity, Users.' },
            { key: 'fingerprint', title: 'Oracle Cloud key fingerprint', description: 'The fingerprint of the API signing key, as the console shows it next to the key. It is not a secret on its own.' },
            { key: 'region', title: 'Oracle Cloud region', description: 'The region the servers live in, as Oracle names it (for example us-phoenix-1). Set it before the key: the key is sealed to the region it was entered for, so changing the region locks the key until it is entered again.' },
        ],
        test: { url: 'https://compute.{region}.oraclecloud.com/20160918/instances', auth: 'oci', name: 'Oracle Cloud', list: 'servers' },
        price: { kind: 'oracle', source_url: 'https://www.oracle.com/cloud/free/' },
    },
    {
        id: 'contabo', name: 'Contabo', group: SERVER_GROUP, origin: 'https://api.contabo.com',
        keys_page: 'https://contabo.com/en/control-panel/',
        keys_how: 'Sign in to the Contabo control panel, open API, and create an API token for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Contabo.',
        // Contabo has no public API to read (read 2026-11-14: api.contabo.com answers 404), so the row has
        // no test: there is nothing cheap to ask.
        test: null,
        price: null,
    },
    {
        id: 'netcup', name: 'Netcup', group: SERVER_GROUP, origin: 'https://api.netcup.com',
        keys_page: 'https://ccp.netcup.net/',
        keys_how: 'Sign in to the Netcup control panel and create an API key for the account that pays.',
        unlocks: 'Lets OpenVibe run agent desktops, Codes runners and routers on Netcup.',
        test: null,
        price: null,
    },
]);

/**
 * The AI provider accounts that need more than one value (plan §AB.10: "Vertex AI (Google Cloud: project,
 * region, service account)"). They are not plain API-key providers: the service account is a JSON key, and the
 * project and the region say where the models live. The row is one host with three fields.
 */
const ACCOUNTS = Object.freeze([
    {
        id: 'vertex', name: 'Vertex AI (Google Cloud)', group: 'ai-providers',
        keys_page: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
        keys_how: 'Create a service account in a Google Cloud project, give it the Vertex AI User role, and create a JSON key for it.',
        unlocks: 'Lets AI answer with Vertex AI models. Without a working service account, project and region, Vertex AI is skipped and its requests go to the next provider.',
        parts: [
            { key: 'project', title: 'Google Cloud project id', description: 'The id of the Google Cloud project the service account belongs to, as the console shows it (the project id, not the project name).' },
            { key: 'region', title: 'Vertex AI region', description: 'The region the models are served from, as Vertex names it (for example us-central1). A region may serve a model another does not.' },
        ],
        test: { url: 'https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models', auth: 'google-jwt', name: 'Vertex AI', list: 'publisher models', list_path: 'publisherModels' },
        price: null,
    },
]);

/** Every host of a group, by id. */
const HOSTS_BY_GROUP = Object.freeze({
    [GPU_GROUP]: GPU_HOSTS,
    [SERVER_GROUP]: SERVER_HOSTS,
});

/** The host of a group with this id, or null. */
function hostById(group, id) {
    const list = HOSTS_BY_GROUP[group] || [];
    return list.find((h) => h.id === String(id || '')) || null;
}

/** Every host of every group, GPU marketplaces first. */
function allHosts() {
    return [...GPU_HOSTS, ...SERVER_HOSTS];
}

module.exports = { GPU_GROUP, SERVER_GROUP, GPU_HOSTS, SERVER_HOSTS, ACCOUNTS, HOSTS_BY_GROUP, hostById, allHosts };
