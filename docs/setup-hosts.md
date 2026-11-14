# The owner's hosts: the GPU marketplaces, the servers and the price table

Plan §AB.10 ("every AI provider configurable"), §AB.17 ("every GPU host and every cheap server,
configurable"). This is the half of that the AI service owns: the rows the owner's Setup tab shows for the
GPU marketplaces and for the servers that run an agent desktop, a Codes runner or a router, and the price
table that ranks them.

The rows live in three namespaces of AI's own settings (openvibe-shared/config):

| Namespace | What it holds | The Setup group |
| --- | --- | --- |
| `ai.gpus` | the GPU marketplaces: the key of each, the address it is sealed to, Salad's organization and project, the monthly cap | GPUs |
| `ai.servers` | the servers: the key of each, the address it is sealed to, and the other fields a host asks for | Servers |
| `ai.accounts` | the AI providers whose credential is more than one value (Vertex AI) | AI providers |

Every row is a field with an `x-owner-input`: what it unlocks, where the key is made, what to press there,
and whether it can be tested. The catalogue of hosts is one file, `server/setup/hosts.js`, so the row, the
test and the price feed of a host are written down together.

## The rows

### The GPU marketplaces (group `gpus`)

| Host | Key page | Test | Live price |
| --- | --- | --- | --- |
| Vast.ai | cloud.vast.ai/manage-keys | the account (its credit) | yes, the market itself |
| RunPod | runpod.io/console/user/settings | the pod list | yes, the price table |
| Lambda Labs | cloud.lambdalabs.com/api-keys | the instance types | with the owner's key |
| Salad | app.salad.com/user-settings/api-keys | the container groups (organization and project too) | yes, the tiers |
| TensorDock | tensordock.com | none (no public API) | yes, the "from" prices |
| Hyperbolic | app.hyperbolic.ai/settings | the model list | no |
| FluidStack | console.fluidstack.io | none (no public API) | no |
| Jarvis Labs | jarvislabs.com/gpu-compute | none (no public API) | no |
| Paperspace | console.paperspace.io/account/keys | none (no public API) | no |
| Akash | akash.network | none (no public API) | no |
| Shadeform | console.shadeform.com | the account | yes, the price page |
| Verda | verda.com/console | the account | yes, the price page |
| Thunder Compute | thundercompute.com | none (no public API) | yes, the price page |
| CoreWeave | cloud.coreweave.com/account/api-keys | none (no public API) | no (a quote only) |

### The servers (group `servers`)

| Host | Key page | Other fields of the row | Test | Live price |
| --- | --- | --- | --- | --- |
| Hetzner Cloud | docs.hetzner.cloud | - | the server list | yes, the price page |
| Hetzner Server Auction | (no key: a price read) | - | - | yes, the auction's floor |
| OVHcloud | api.ovh.com/createToken | application key, consumer key | the account (signed) | yes, the public catalog |
| Vultr | my.vultr.com/settings | - | the account | yes, the plan list |
| DigitalOcean | cloud.digitalocean.com/account/api/tokens | - | the account | with the owner's key |
| Linode (Akamai) | cloud.linode.com/profile/tokens | - | the account | yes, the type list |
| Scaleway | console.scaleway.com/iam/api-keys | - | the projects | no |
| UpCloud | upcloud.com/1.3/apikeys | user name | the server list | with the owner's key |
| Oracle Cloud (free tier) | docs.oracle.com (API signing key) | tenancy, user, fingerprint, region | the instances (signed) | the free tier is free |
| Contabo | contabo.com/en/control-panel | - | none (no public API) | no |
| Netcup | ccp.netcup.net | - | none (no public API) | no |

### The provider accounts (group `ai-providers`)

| Provider | Key page | Other fields of the row | Test |
| --- | --- | --- | --- |
| Vertex AI (Google Cloud) | console.cloud.google.com/iam-admin/serviceaccounts | project id, region | the publisher models of that region (the service account's own key signs the request) |

## The tests

Every test makes **one cheap authenticated read**: the host's own account, its servers, its projects, its
models. Nothing is created, rented or bought, and the key never appears in the answer, a log line or an
error - the provider's own refusal is scrubbed of it and cut to one line. A host with no public API to read
has no test: the row says so rather than pretending.

The rows with more than one field need all of them: OVHcloud's request is signed with the application key
and the consumer key beside the secret, Oracle's with the tenancy, the user, the fingerprint and the region,
Vertex AI's with the project and the region.

## The price table

    GET /api/v1/prices/servers
    GET /api/v1/prices/gpus

Public, cached for an hour, and no token is needed. A row is:

    { provider, plan, vcpu, ram_gb, gpu?, usd_per_hour, usd_per_month, at, source_url }

`at` is the moment the price was read and `source_url` is where it came from. The server table holds one
row per host: the cheapest plan that fits an agent desktop (2 vCPU, 4 GB). The GPU table holds one row per
provider, card and kind.

Where the price comes from:

- the GPU rows are the readings the provisioner already keeps (`server/gpu/market.js`): Vast.ai's public
  offer search, RunPod's price table, Salad's tiers, TensorDock's "from" prices, Shadeform's, Verda's and
  Thunder's - each read from the provider's own page, each marked with the day it was read and whether it is
  stale.
- the server rows are read live from the hosts' own APIs and pages: Vultr's plan list, Linode's type list,
  OVHcloud's public catalog, Hetzner's cloud price page, the Hetzner Server Auction, and - with the owner's
  own key - DigitalOcean's sizes, UpCloud's price list and Lambda's instance types.
- the prices that come in euros are converted with the day's rate from the European Central Bank
  (`api.frankfurter.dev`); the row carries the rate it used.

A provider that publishes no price we can read is simply not in the table. A price is never a guess.

## Why the row's address is written by AI

Every key is sealed to the address it was entered for (`x-bind`): the key only opens for that address, so
it can never be sent to another host. AI writes the address itself; the owner writes the key. The one
exception is Oracle Cloud, whose address depends on the region the owner names: there the key is sealed to
the region, and the request goes to `compute.<region>.oraclecloud.com`.

## The rows in the owner's Setup tab

Network's admin Setup tab (`/admin/ai/setup`) gathers every service's rows and groups them by the group
the row names. A row with more than one field is shown as its own fields today; the grouping of the fields
of one row into one card is Network's own work (plan §AB.18), and the `x-owner-row` annotation on every
field names the row the fields belong to.
